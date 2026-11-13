import { randomUUID } from 'node:crypto'
import type { PrismaClient, Operation, Project } from '@prisma/client'
import { createProjectWithPorts, PORT_KEYS } from './ports'
import { recoverInterruptedOperations, transitionOperation } from './operations'
import type { PreviewIdentity } from './preview-identity'
import { PREVIEW_CORE_REF, type PreviewRuntime } from './preview-runtime'
import { PREVIEW_OWNER_EMAIL } from './preview-owner'
import { ImportError } from './import-pipeline'
import { bundleContentHash, type BundleContentHash } from './bundle-ingest'
import { previewHostname, type CloudflareTunnel } from './tunnel'

export { PREVIEW_OWNER_EMAIL } from './preview-owner'
export const PREVIEW_OPERATION_KIND = 'preview-ensure'

export class PreviewConflictError extends Error {}

// A pending route-cleanup target (T20 review R3-1): the project to inspect
// and the claim key its immutable identity maps to.
interface RouteCleanup {
  projectId: string
  claimKey: string | null
}

// The slice of the tunnel adapter the worker drives; tests inject a stub.
export type PreviewTunnel = Pick<CloudflareTunnel, 'domain' | 'addPreviewRoute' | 'removePreviewRoute'>

export interface PreviewServiceOptions {
  tunnel: PreviewTunnel
  beforeInsert?: () => Promise<void>
}

// P4-2: the gateway is published on loopback; cloudflared on the same host
// is the only public path to it.
function gatewayOrigin(port: string) { return `http://127.0.0.1:${port}` }

async function retryWrite<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() } catch (error) {
      const failure = error as { code?: string; message?: string }
      const transient = ['P1008', 'P2028', 'P2034'].includes(failure.code ?? '') || /database is locked|SQLITE_BUSY/i.test(failure.message ?? '')
      if (!transient || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export function createPreviewService(db: PrismaClient, runtime: PreviewRuntime, options: PreviewServiceOptions) {
  const { tunnel } = options
  const domain = tunnel.domain
  let startup: Promise<number> | undefined
  let queue = Promise.resolve()
  // projectId -> the newest job entry; entries carry their operation id so
  // a finished job can only ever delete its own entry (T20 review finding 2).
  const jobs = new Map<string, { operationId: string; promise: Promise<void> }>()
  // projectId -> operations whose job settled without reaching a terminal
  // state record (their failure persistence itself failed). Several can
  // pile up per project, one per attempt.
  const unfinished = new Map<string, Set<string>>()
  const destroying = new Set<string>()
  // projectId -> registration tokens for ensures that passed their
  // `destroying` check but have not yet registered their job. Each ensure
  // owns its token and releases only that, so overlapping registrations
  // cannot clear each other (T20 review finding 1); destroy drains the
  // whole set so teardown never interleaves with a starting provision.
  const ensuring = new Map<string, Set<symbol>>()
  // (repository, branch) -> tail of the claim critical section: re-read,
  // hash compare and claim run serialized per preview so two identical
  // bundles cannot both claim a rebuild (T20 review finding 5).
  const claims = new Map<string, Promise<unknown>>()
  const reasserting = new Map<string, Promise<void>>()
  // Interrupted operations whose tunnel route could not be removed yet
  // (operationId -> cleanup target: the project and the claim key derived
  // from its immutable identity). They stay non-terminal so cleanup is
  // retryable.
  const pendingRoutes = new Map<string, RouteCleanup>()
  // Remove each interrupted preview's route before its operation is marked
  // failed; returns the operation ids whose cleanup is done (route gone,
  // never possible, or not theirs to remove). Ownership is re-checked on
  // every attempt (T20 review R2-3): the hostname is per project, so a
  // superseded attempt must never remove the route its project's current
  // owner is serving on. Only the current attempt, or a legacy row without
  // a recorded owner, is cleaned up; route removal still happens before the
  // attempt is marked failed, and a failed removal stays retryable.
  //
  // The ownership re-read and the tunnel removal are ONE step under the
  // project's claim lock (T20 review R3-1) - the same lock that serializes
  // claims and same-hash re-asserts - so no newer owner can be installed
  // between the check and the removal and a stale retry can never remove a
  // fresh route. Lock order (no cycles): the claim lock is only held across
  // one DB read and one tunnel removal call (both bounded) and is never
  // nested - `start()`/`retryPendingRoutes` finish before any claim begins,
  // `reassertRoute`, `startUpdate` and `settleUnfinished` take no locks
  // inside a claim, and `destroy` never holds the claim lock (it only meets
  // this sweep through `start()`, as before). A removal failure releases
  // the lock and keeps the entry for the next retry.
  async function clearInterruptedRoutes(entries: Array<[string, RouteCleanup]>): Promise<string[]> {
    const cleared: string[] = []
    for (const [operationId, cleanup] of entries) {
      const attempt = async () => {
        const project = await db.project.findUnique({ where: { id: cleanup.projectId }, select: { slug: true, currentOperationId: true } })
        if (!project || (project.currentOperationId !== null && project.currentOperationId !== operationId)) {
          pendingRoutes.delete(operationId)
          cleared.push(operationId)
          return
        }
        let hostname: string
        try { hostname = previewHostname(project.slug, domain) } catch { pendingRoutes.delete(operationId); cleared.push(operationId); return }
        try {
          await tunnel.removePreviewRoute(hostname)
          pendingRoutes.delete(operationId)
          cleared.push(operationId)
        } catch {
          pendingRoutes.set(operationId, cleanup)
          console.error('Preview route removal failed', { operationId, hostname, stage: 'route-remove-recovery' })
        }
      }
      // A row without a stored identity cannot be claimed by any ensure
      // (existing() only matches repository + branch), so it needs no lock.
      if (cleanup.claimKey === null) await attempt()
      else await claimLock(cleanup.claimKey, attempt)
    }
    return cleared
  }
  async function recover(): Promise<number> {
    const interrupted = await db.operation.findMany({ where: { kind: PREVIEW_OPERATION_KIND, state: { in: ['queued', 'provisioning'] } },
      include: { project: { select: { id: true, repository: true, branch: true } } } })
    const cleared = await clearInterruptedRoutes(interrupted.map(operation => [operation.id, {
      projectId: operation.project.id,
      claimKey: claimKeyFor(operation.project.repository, operation.project.branch),
    }]))
    return recoverInterruptedOperations(db, { kind: PREVIEW_OPERATION_KIND, ids: cleared })
  }
  async function retryPendingRoutes() {
    if (pendingRoutes.size === 0) return
    const cleared = await clearInterruptedRoutes([...pendingRoutes])
    await recoverInterruptedOperations(db, { kind: PREVIEW_OPERATION_KIND, ids: cleared })
  }
  const start = async () => {
    // The call that runs the sweep does not retry in the same breath; later
    // calls (every ensure/status/destroy) retry whatever is still pending.
    const first = !startup
    const recovered = await (startup ??= recover())
    if (!first) await retryPendingRoutes()
    return recovered
  }
  async function recordFailure(operationId: string, message = 'Preview provisioning, import or health failed') {
    await retryWrite(() => db.$transaction(async tx => {
      let operation = await tx.operation.findUniqueOrThrow({ where: { id: operationId } })
      if (operation.state === 'queued') operation = await transitionOperation(tx, operationId, 'provisioning')
      if (operation.state === 'provisioning') {
        await transitionOperation(tx, operationId, 'failed', { error: message })
        // Only the owning attempt writes project status (T20 review finding
        // 6): a late settlement of an older attempt must never overwrite the
        // current environment's status.
        await tx.project.updateMany({ where: { id: operation.projectId, currentOperationId: operationId },
          data: { status: 'failed' } })
      }
    }))
  }
  async function settleUnfinished(projectId: string) {
    const pending = unfinished.get(projectId)
    if (!pending) return
    // Drain the live Set one id at a time (T20 review R2-1): a failure
    // appended while we await must be settled too, and only the ids
    // actually settled leave the Set. Deleting the whole entry here would
    // strand the newcomer and clear its job tracking with it.
    while (pending.size > 0) {
      const operationId = pending.values().next().value as string
      await recordFailure(operationId)
      pending.delete(operationId)
      // Delete only the settled operation's own job entry; a newer
      // attempt's job must stay tracked for destroy (T20 review finding 2).
      const tracked = jobs.get(projectId)
      if (tracked && tracked.operationId === operationId) jobs.delete(projectId)
    }
    if (unfinished.get(projectId) === pending) unfinished.delete(projectId)
  }
  async function existing(identity: PreviewIdentity) {
    const project = await db.project.findUnique({ where: { repository_branch: { repository: identity.repository, branch: identity.branch } },
      include: { operations: { where: { kind: PREVIEW_OPERATION_KIND }, orderBy: { createdAt: 'desc' }, take: 3 } } })
    if (!project) return null
    if (project.environmentType !== 'preview') throw new PreviewConflictError('Identity belongs to a different environment')
    // The recorded owner is authoritative and resolved by id (T20 review
    // R2-2): rejected or superseded attempts can push it out of any
    // recent-history window, and a recorded owner is never silently
    // substituted by another attempt. Only rows without a recorded owner
    // (pre-claim legacy data) fall back to the newest attempt.
    let operation: Operation | null = null
    if (project.currentOperationId !== null) {
      operation = await db.operation.findFirst({ where: { id: project.currentOperationId,
        projectId: project.id, kind: PREVIEW_OPERATION_KIND } })
      if (!operation) throw new PreviewConflictError('Current operation record is missing')
    } else {
      operation = project.operations.find(candidate => candidate.state === 'queued' || candidate.state === 'provisioning')
        ?? project.operations[0] ?? null
      if (!operation) throw new PreviewConflictError('Identity belongs to a different environment')
    }
    if (unfinished.has(project.id)) {
      await settleUnfinished(project.id)
      return { project, operation: await db.operation.findUniqueOrThrow({ where: { id: operation.id } }) }
    }
    return { project, operation }
  }
  // pullRequestNumber is metadata, not identity (decision 1): a re-ensure
  // from another PR onto the same branch updates the stored number on the
  // existing environment instead of forking a second one. Only a different
  // non-null number is written; a missing one leaves the stored value.
  function metadataPatch(project: { pullRequestNumber: number | null }, identity: PreviewIdentity) {
    return identity.pullRequestNumber != null && identity.pullRequestNumber !== project.pullRequestNumber
      ? { pullRequestNumber: identity.pullRequestNumber }
      : {}
  }
  // Ports are allocated once, at create time, and persist as env vars across
  // re-provisions, so the slug (hostname) and the gateway origin stay
  // stable across an update (decision 2).
  async function projectPorts(projectId: string): Promise<Record<string, string>> {
    const rows = await db.projectEnvVar.findMany({ where: { projectId, key: { in: [...PORT_KEYS] } } })
    const ports = Object.fromEntries(rows.map(row => [row.key, row.value]))
    if (!ports['API_GW_HTTP_PORT']) throw new Error('Preview has no allocated gateway port')
    return ports
  }
  function claimKey(identity: PreviewIdentity) { return `${identity.repository}\u0000${identity.branch}` }
  // The claim key of a project row: repository/branch are immutable and
  // stored normalized, so this matches claimKey(identity) for that preview
  // (T20 review R3-1). Null when the row has no stored identity.
  function claimKeyFor(repository: string | null, branch: string | null): string | null {
    return repository !== null && branch !== null ? `${repository}\u0000${branch}` : null
  }
  // Serialize the re-read -> compare -> claim critical section per preview
  // (T20 review finding 5). The create path stays outside: its uniqueness
  // latch is the serialization there.
  function claimLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const tail = (claims.get(key) ?? Promise.resolve()).catch(() => undefined)
    const run = tail.then(work)
    const settled = run.then(() => undefined, () => undefined)
    claims.set(key, settled)
    return run.finally(() => { if (claims.get(key) === settled) claims.delete(key) })
  }
  // Register a provision job: chained on the serial queue and tracked per
  // project until it settles, so destroy can wait out everything that is
  // still running for its project (T20 review findings 1 and 2).
  function schedule(projectId: string, operationId: string, task: () => Promise<void>) {
    const job = queue.then(task)
    const settled = job.catch(() => {
      const pending = unfinished.get(projectId) ?? new Set<string>()
      pending.add(operationId)
      unfinished.set(projectId, pending)
    }).finally(() => {
      const pending = unfinished.get(projectId)
      if (!pending?.has(operationId) && jobs.get(projectId)?.operationId === operationId) jobs.delete(projectId)
    })
    jobs.set(projectId, { operationId, promise: settled })
    queue = settled
    return settled
  }
  // Re-ensure of a ready preview re-asserts its route, reconciling a tunnel
  // that lost the rule (e.g. the process died between route add and ready
  // persistence on an earlier attempt). addPreviewRoute replaces an exact
  // hostname match, so this never duplicates the rule. Destroy waits for an
  // in-flight re-assert and blocks new ones, so a route cannot outlive its row.
  function reassertRoute(projectId: string): Promise<void> {
    if (destroying.has(projectId)) return Promise.resolve()
    const work = (reasserting.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const project = await db.project.findUnique({ where: { id: projectId },
        include: { envVars: { where: { key: 'API_GW_HTTP_PORT' } } } })
      const port = project?.envVars[0]?.value
      if (!project || !port) return
      // Only a ready current attempt may open the route (T20 review finding
      // 4): a late re-assert carrying a stale snapshot must not re-route a
      // preview whose update has claimed or is rebuilding.
      const owner = project.currentOperationId === null
        ? null
        : await db.operation.findUnique({ where: { id: project.currentOperationId } })
      if (owner && owner.state !== 'ready') return
      await tunnel.addPreviewRoute(previewHostname(project.slug, domain), gatewayOrigin(port))
    })
    reasserting.set(projectId, work)
    return work.finally(() => { if (reasserting.get(projectId) === work) reasserting.delete(projectId) })
  }
  // The provision pipeline shared by create and update. `teardown` is the
  // T20 update path: the DB row (and its slug and ports) survives, the
  // route is pulled before the old stack goes down and re-added only after
  // the health gate passes, so a routed hostname always answers (T17).
  async function runWorker(operation: { id: string }, project: Project, ports: Record<string, string>, tarball: Buffer, teardown: boolean) {
    let stage = 'claim'
    let routed: string | undefined
    let host: string | undefined
    try {
      await retryWrite(() => transitionOperation(db, operation.id, 'provisioning'))
      host = previewHostname(project.slug, domain)
      if (teardown) {
        stage = 'route-remove'
        // A re-assert landing after removal would reopen the route mid-
        // rebuild; wait for it the way destroy does. Removal itself is
        // idempotent and must never block teardown.
        await reasserting.get(project.id)?.catch(() => undefined)
        try { await tunnel.removePreviewRoute(host) } catch {
          console.error('Preview route removal failed', { operationId: operation.id, hostname: host, stage: 'route-remove' })
        }
        stage = 'teardown'
        await runtime.destroy(project)
      }
      stage = 'provision-import-health'
      await runtime.provision(project, tarball, ports, async env => {
        await retryWrite(() => db.$transaction(Object.entries(env).map(([key, value]) => db.projectEnvVar.upsert({
          where: { projectId_key: { projectId: project.id, key } },
          create: { projectId: project.id, key, value }, update: { value },
        }))))
      })
      // Ready means the public hostname answers through the tunnel, so the
      // route is added only after the health gate and before ready.
      stage = 'route-add'
      await tunnel.addPreviewRoute(host, gatewayOrigin(ports['API_GW_HTTP_PORT']))
      routed = host
      stage = 'ready-persistence'
      await retryWrite(() => db.$transaction(async tx => {
        await transitionOperation(tx, operation.id, 'ready')
        // Only the owning attempt writes project status (T20 review finding 6).
        await tx.project.updateMany({ where: { id: project.id, currentOperationId: operation.id }, data: { status: 'active' } })
      }))
    } catch (error) {
      console.error('Preview worker failed', { operationId: operation.id,
        stage: error instanceof ImportError ? error.stage : stage,
        code: error instanceof ImportError ? error.code : 'PREVIEW_WORKER_FAILED' })
      // A failed preview is never publicly routed; destroy retries removal.
      // On the update path the rule may predate this job (its teardown
      // removal failed), so it is retried here as well.
      const leftover = routed ?? (teardown ? host : undefined)
      if (leftover) await tunnel.removePreviewRoute(leftover).catch(() => {
        console.error('Preview route removal failed', { operationId: operation.id, hostname: leftover, stage: 'route-remove' })
      })
      await recordFailure(operation.id)
    }
  }
  // T20 update: re-provision an existing preview from a changed bundle under
  // the same project row. The row keeps its slug and allocated ports, so the
  // hostname is unchanged; the old stack is torn down first because the
  // import pipeline restores from empty and is not re-runnable on a live
  // database.
  async function startUpdate(project: Project, identity: PreviewIdentity, tarball: Buffer, hash: string): Promise<Operation> {
    // Destroy owns the end state: an update must not start against a
    // preview that is being torn down.
    if (destroying.has(project.id)) throw new PreviewConflictError('Destroy already in progress')
    const token = Symbol('ensure-registration')
    const tokens = ensuring.get(project.id) ?? new Set<symbol>()
    tokens.add(token)
    ensuring.set(project.id, tokens)
    try {
      const ports = await projectPorts(project.id)
      const operation = await retryWrite(() => db.$transaction(async tx => {
        const created = await tx.operation.create({ data: { projectId: project.id, kind: PREVIEW_OPERATION_KIND } })
        // The claim is atomic (T20): hash, owner and status move together,
        // so only this attempt may write project status from here on.
        await tx.project.update({ where: { id: project.id }, data: {
          status: 'provisioning', bundleHash: hash, currentOperationId: created.id,
          ...metadataPatch(project, identity) } })
        return created
      }))
      // The serial queue runs one provision at a time: a second ensure with
      // another bundle queues behind the running one instead of racing it.
      schedule(project.id, operation.id, () => runWorker(operation, project, ports, tarball, true))
      return operation
    } finally {
      // Release only this registration's token (T20 review finding 1).
      const owned = ensuring.get(project.id)
      owned?.delete(token)
      if (owned && owned.size === 0) ensuring.delete(project.id)
    }
  }
  // Resolve an ensure against an existing preview. Called under the claim
  // lock with an authoritative re-read, so the hash comparison and the
  // claim are atomic per preview (T20 review finding 5).
  async function resolveExisting(project: Project, operation: Operation, identity: PreviewIdentity,
    tarball: Buffer, bundle: BundleContentHash): Promise<Operation> {
    const patch = metadataPatch(project, identity)
    if (bundle.hash === project.bundleHash) {
      // This exact bundle is already applied, being applied, or already
      // failed: same-hash ensures never start new work, and a failed
      // attempt stays failed — the fix that recovers it changes the hash.
      if (Object.keys(patch).length > 0) {
        await retryWrite(() => db.project.update({ where: { id: project.id }, data: patch }))
      }
      if (operation.state === 'ready') await reassertRoute(project.id)
      return operation
    }
    if (!bundle.valid) {
      // A bundle with no validated contents (T20 review finding 9): ingest
      // would reject it, so it must never claim a rebuild or tear down a
      // running preview. Record the failed attempt instead; the live stack,
      // route and the recorded bundleHash stay untouched. A failed
      // replacement never becomes the owner and never writes project status.
      // Retries of the same invalid bytes resolve to the same failed
      // operation (T20 review R2-6): the rejected digest is recorded on the
      // attempt, so identical retries never append history.
      const rejected = await db.operation.findFirst({ where: { projectId: project.id,
        kind: PREVIEW_OPERATION_KIND, state: 'failed', bundleHash: bundle.hash },
        orderBy: { createdAt: 'desc' } })
      if (rejected) {
        if (Object.keys(patch).length > 0) {
          await retryWrite(() => db.project.update({ where: { id: project.id }, data: patch }))
        }
        return rejected
      }
      const failure = await retryWrite(() => db.$transaction(async tx => {
        const created = await tx.operation.create({ data: { projectId: project.id, kind: PREVIEW_OPERATION_KIND, bundleHash: bundle.hash } })
        if (Object.keys(patch).length > 0) await tx.project.update({ where: { id: project.id }, data: patch })
        return created
      }))
      await recordFailure(failure.id, 'Bundle failed validation or has no migrations; the existing preview was left untouched')
      return db.operation.findUniqueOrThrow({ where: { id: failure.id } })
    }
    return startUpdate(project, identity, tarball, bundle.hash)
  }
  function lockedResolve(identity: PreviewIdentity, tarball: Buffer, bundle: BundleContentHash): Promise<Operation> {
    return claimLock(claimKey(identity), async () => {
      const fresh = await existing(identity)
      if (!fresh) throw new PreviewConflictError('Preview was destroyed during the request')
      return resolveExisting(fresh.project, fresh.operation, identity, tarball, bundle)
    })
  }
  return {
    start,
    async ensure(identity: PreviewIdentity, tarball: Buffer) {
      await start()
      // Change detection (decision 3): a hash of the validated bundle
      // contents. A repacked tarball with identical files never counts as
      // a change; any real content change re-provisions.
      const bundle = await bundleContentHash(tarball)
      const previous = await existing(identity)
      if (previous) return lockedResolve(identity, tarball, bundle)
      const owner = await db.user.upsert({ where: { email: PREVIEW_OWNER_EMAIL }, update: {},
        create: { email: PREVIEW_OWNER_EMAIL, name: 'Preview service', password: '!disabled-preview-service' } })
      await options.beforeInsert?.()
      let created: Awaited<ReturnType<typeof createProjectWithPorts>>
      // The operation id is generated up front so the project row can name
      // its owner in the same write (T20 review finding 6).
      const operationId = randomUUID()
      try {
        created = await createProjectWithPorts(db, {
          ...identity, name: `${identity.repository} / ${identity.branch}`, slug: `preview-${randomUUID()}`,
          ownerId: owner.id, environmentType: 'preview', status: 'provisioning', supabaseRef: PREVIEW_CORE_REF,
          bundleHash: bundle.hash, currentOperationId: operationId,
          operations: { create: { id: operationId, kind: PREVIEW_OPERATION_KIND } },
        }, ['API_GW_HTTP_PORT'])
      } catch (error) {
        const winner = await existing(identity)
        if (winner) return lockedResolve(identity, tarball, bundle)
        throw error
      }
      const operation = await db.operation.findFirstOrThrow({ where: { id: operationId, projectId: created.project.id, kind: PREVIEW_OPERATION_KIND } })
      schedule(created.project.id, operation.id, () => runWorker(operation, created.project, created.ports, tarball, false))
      return operation
    },
    async status(repository: string, operationId: string) {
      await start()
      let operation = await db.operation.findFirst({ where: { id: operationId, kind: PREVIEW_OPERATION_KIND,
        project: { repository, environmentType: 'preview' } }, include: { project: { include: { envVars: true } } } })
      if (!operation) return null
      if (unfinished.has(operation.projectId)) {
        await settleUnfinished(operation.projectId)
        operation = await db.operation.findUniqueOrThrow({ where: { id: operation.id }, include: { project: { include: { envVars: true } } } })
      }
      const env = Object.fromEntries(operation.project.envVars.map(entry => [entry.key, entry.value]))
      // Connection details describe the PROJECT's live environment, not one
      // operation's historical state (T20 review finding 3): while a newer
      // attempt is rebuilding or has failed, an old ready operation exposes
      // no url, anonKey or hostname.
      const owner = operation.project.currentOperationId === null
        ? null
        : await db.operation.findUnique({ where: { id: operation.project.currentOperationId } })
      const live = owner ? owner.state === 'ready' : operation.state === 'ready'
      return { operationId: operation.id, state: operation.state, error: operation.error,
        ...(operation.state === 'ready' && live ? { url: env.SUPABASE_PUBLIC_URL, anonKey: env.ANON_KEY,
          hostname: previewHostname(operation.project.slug, domain) } : {}) }
    },
    async destroy(repository: string, operationId: string) {
      await start()
      const operation = await db.operation.findFirst({ where: { id: operationId, kind: PREVIEW_OPERATION_KIND,
        project: { repository, environmentType: 'preview' } }, include: { project: true } })
      if (!operation) return false
      if (destroying.has(operation.projectId)) throw new PreviewConflictError('Destroy already in progress')
      destroying.add(operation.projectId)
      try {
        // Ensures that passed their own destroying check just before this
        // one landed are still registering; wait out EVERY registration and
        // then the newest tracked job, which chains all earlier ones (T20
        // review findings 1 and 2). After the drain no new registration can
        // be accepted, so the tracked job is the complete chain.
        while ((ensuring.get(operation.projectId)?.size ?? 0) > 0) await new Promise(resolve => setImmediate(resolve))
        const tracked = jobs.get(operation.projectId)
        if (tracked) await tracked.promise
        await settleUnfinished(operation.projectId)
        await reasserting.get(operation.projectId)?.catch(() => undefined)
        const current = await db.operation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.state === 'queued' || current.state === 'provisioning') throw new PreviewConflictError('Operation is running in another worker')
        // Route removal is idempotent and must not block teardown; a rule left
        // behind is logged by hostname so it can be removed by hand.
        let hostname: string | undefined
        try {
          hostname = previewHostname(operation.project.slug, domain)
          await tunnel.removePreviewRoute(hostname)
        } catch {
          console.error('Preview route removal failed', { operationId: operation.id, hostname, stage: 'route-remove' })
        }
        await runtime.destroy(operation.project)
        await db.project.delete({ where: { id: operation.projectId } })
        return true
      } finally { destroying.delete(operation.projectId) }
    },
    async idle() { await queue },
  }
}

export type PreviewService = ReturnType<typeof createPreviewService>
