import { randomUUID } from 'node:crypto'
import type { PrismaClient, Operation, Project } from '@prisma/client'
import { createProjectWithPorts, PORT_KEYS } from './ports'
import { recoverInterruptedOperations, transitionOperation } from './operations'
import type { PreviewIdentity } from './preview-identity'
import { PREVIEW_CORE_REF, type PreviewRuntime } from './preview-runtime'
import { PREVIEW_OWNER_EMAIL } from './preview-owner'
import { ImportError } from './import-pipeline'
import { bundleContentHash } from './bundle-ingest'
import { previewHostname, type CloudflareTunnel } from './tunnel'

export { PREVIEW_OWNER_EMAIL } from './preview-owner'
export const PREVIEW_OPERATION_KIND = 'preview-ensure'

export class PreviewConflictError extends Error {}

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
  const jobs = new Map<string, Promise<void>>()
  const unfinished = new Map<string, string>()
  const destroying = new Set<string>()
  // Ensures that passed their `destroying` check but have not yet
  // registered their job. Destroy waits these out, so teardown can never
  // interleave with a provision that is just starting (T20).
  const ensuring = new Set<string>()
  const reasserting = new Map<string, Promise<void>>()
  // Interrupted operations whose tunnel route could not be removed yet
  // (operationId -> slug). They stay non-terminal so cleanup is retryable.
  const pendingRoutes = new Map<string, string>()
  // Remove each interrupted preview's route before its operation is marked
  // failed; returns the operation ids whose route is gone (or never possible).
  async function clearInterruptedRoutes(entries: Array<[string, string]>): Promise<string[]> {
    const cleared: string[] = []
    for (const [operationId, slug] of entries) {
      let hostname: string
      try { hostname = previewHostname(slug, domain) } catch { pendingRoutes.delete(operationId); cleared.push(operationId); continue }
      try {
        await tunnel.removePreviewRoute(hostname)
        pendingRoutes.delete(operationId)
        cleared.push(operationId)
      } catch {
        pendingRoutes.set(operationId, slug)
        console.error('Preview route removal failed', { operationId, hostname, stage: 'route-remove-recovery' })
      }
    }
    return cleared
  }
  async function recover(): Promise<number> {
    const interrupted = await db.operation.findMany({ where: { kind: PREVIEW_OPERATION_KIND, state: { in: ['queued', 'provisioning'] } },
      include: { project: { select: { slug: true } } } })
    const cleared = await clearInterruptedRoutes(interrupted.map(operation => [operation.id, operation.project.slug]))
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
  async function recordFailure(operationId: string) {
    await retryWrite(() => db.$transaction(async tx => {
      let operation = await tx.operation.findUniqueOrThrow({ where: { id: operationId } })
      if (operation.state === 'queued') operation = await transitionOperation(tx, operationId, 'provisioning')
      if (operation.state === 'provisioning') {
        await transitionOperation(tx, operationId, 'failed', { error: 'Preview provisioning, import or health failed' })
        // Only the last standing attempt owns the project status: while a
        // newer update is still queued the project stays 'provisioning'.
        const other = await tx.operation.findFirst({ where: { projectId: operation.projectId,
          kind: PREVIEW_OPERATION_KIND, state: { in: ['queued', 'provisioning'] } } })
        if (!other) await tx.project.update({ where: { id: operation.projectId }, data: { status: 'failed' } })
      }
    }))
  }
  async function settleUnfinished(projectId: string) {
    const operationId = unfinished.get(projectId)
    if (!operationId) return
    await recordFailure(operationId)
    unfinished.delete(projectId)
    jobs.delete(projectId)
  }
  async function existing(identity: PreviewIdentity) {
    const project = await db.project.findUnique({ where: { repository_branch: { repository: identity.repository, branch: identity.branch } },
      include: { operations: { where: { kind: PREVIEW_OPERATION_KIND }, orderBy: { createdAt: 'desc' }, take: 3 } } })
    if (!project) return null
    if (project.environmentType !== 'preview' || !project.operations[0]) throw new PreviewConflictError('Identity belongs to a different environment')
    // The operation that currently owns the environment: an in-flight one
    // when there is one (an update queued behind an earlier attempt), else
    // the most recent attempt.
    const operation = project.operations.find(candidate => candidate.state === 'queued' || candidate.state === 'provisioning') ?? project.operations[0]
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
        // Only the last standing attempt owns the project status: while a
        // newer update is queued the project stays 'provisioning'.
        const other = await tx.operation.findFirst({ where: { projectId: project.id,
          kind: PREVIEW_OPERATION_KIND, state: { in: ['queued', 'provisioning'] } } })
        if (!other) await tx.project.update({ where: { id: project.id }, data: { status: 'active' } })
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
    ensuring.add(project.id)
    try {
      const ports = await projectPorts(project.id)
      const operation = await retryWrite(() => db.$transaction(async tx => {
        const created = await tx.operation.create({ data: { projectId: project.id, kind: PREVIEW_OPERATION_KIND } })
        await tx.project.update({ where: { id: project.id }, data: {
          status: 'provisioning', bundleHash: hash, ...metadataPatch(project, identity) } })
        return created
      }))
      // The serial queue runs one provision at a time: a second ensure with
      // another bundle queues behind the running one instead of racing it.
      const job = queue.then(() => runWorker(operation, project, ports, tarball, true))
      const settled = job.catch(() => { unfinished.set(project.id, operation.id) }).finally(() => {
        if (!unfinished.has(project.id) && jobs.get(project.id) === settled) jobs.delete(project.id)
      })
      jobs.set(project.id, settled)
      queue = settled
      return operation
    } finally {
      ensuring.delete(project.id)
    }
  }
  return {
    start,
    async ensure(identity: PreviewIdentity, tarball: Buffer) {
      await start()
      // Change detection (decision 3): a hash of the validated bundle
      // contents. A repacked tarball with identical files never counts as
      // a change; any real content change re-provisions.
      const hash = await bundleContentHash(tarball)
      const previous = await existing(identity)
      if (previous) {
        const { project, operation } = previous
        if (hash !== project.bundleHash) return startUpdate(project, identity, tarball, hash)
        // This exact bundle is already applied, being applied, or already
        // failed: same-hash ensures never start new work, and a failed
        // attempt stays failed — the fix that recovers it changes the hash.
        const patch = metadataPatch(project, identity)
        if (Object.keys(patch).length > 0) {
          await retryWrite(() => db.project.update({ where: { id: project.id }, data: patch }))
        }
        if (operation.state === 'ready') await reassertRoute(project.id)
        return operation
      }
      const owner = await db.user.upsert({ where: { email: PREVIEW_OWNER_EMAIL }, update: {},
        create: { email: PREVIEW_OWNER_EMAIL, name: 'Preview service', password: '!disabled-preview-service' } })
      await options.beforeInsert?.()
      let created: Awaited<ReturnType<typeof createProjectWithPorts>>
      try {
        created = await createProjectWithPorts(db, {
          ...identity, name: `${identity.repository} / ${identity.branch}`, slug: `preview-${randomUUID()}`,
          ownerId: owner.id, environmentType: 'preview', status: 'provisioning', supabaseRef: PREVIEW_CORE_REF,
          bundleHash: hash,
          operations: { create: { kind: PREVIEW_OPERATION_KIND } },
        }, ['API_GW_HTTP_PORT'])
      } catch (error) {
        const winner = await existing(identity)
        if (winner) {
          if (hash === winner.project.bundleHash) return winner.operation
          return startUpdate(winner.project, identity, tarball, hash)
        }
        throw error
      }
      const operation = await db.operation.findFirstOrThrow({ where: { projectId: created.project.id, kind: PREVIEW_OPERATION_KIND } })
      const job = queue.then(() => runWorker(operation, created.project, created.ports, tarball, false))
      const settled = job.catch(() => { unfinished.set(created.project.id, operation.id) }).finally(() => {
        if (!unfinished.has(created.project.id) && jobs.get(created.project.id) === settled) jobs.delete(created.project.id)
      })
      jobs.set(created.project.id, settled)
      queue = settled
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
      return { operationId: operation.id, state: operation.state, error: operation.error,
        ...(operation.state === 'ready' ? { url: env.SUPABASE_PUBLIC_URL, anonKey: env.ANON_KEY,
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
        // An ensure that passed its own destroying check just before this
        // one landed is still registering its job; wait it out so teardown
        // cannot interleave with a provision that is starting (T20).
        while (ensuring.has(operation.projectId)) await new Promise(resolve => setImmediate(resolve))
        await jobs.get(operation.projectId)
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
