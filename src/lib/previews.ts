import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createProjectWithPorts } from './ports'
import { recoverInterruptedOperations, transitionOperation } from './operations'
import type { PreviewIdentity } from './preview-identity'
import { PREVIEW_CORE_REF, type PreviewRuntime } from './preview-runtime'
import { PREVIEW_OWNER_EMAIL } from './preview-owner'
import { ImportError } from './import-pipeline'
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
  const reasserting = new Map<string, Promise<void>>()
  const start = () => startup ??= recoverInterruptedOperations(db, { kind: PREVIEW_OPERATION_KIND })
  async function recordFailure(operationId: string) {
    await retryWrite(() => db.$transaction(async tx => {
      let operation = await tx.operation.findUniqueOrThrow({ where: { id: operationId } })
      if (operation.state === 'queued') operation = await transitionOperation(tx, operationId, 'provisioning')
      if (operation.state === 'provisioning') {
        await transitionOperation(tx, operationId, 'failed', { error: 'Preview provisioning, import or health failed' })
        await tx.project.update({ where: { id: operation.projectId }, data: { status: 'failed' } })
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
      include: { operations: { where: { kind: PREVIEW_OPERATION_KIND }, orderBy: { createdAt: 'desc' }, take: 1 } } })
    if (!project) return null
    if (project.environmentType !== 'preview' || !project.operations[0]) throw new PreviewConflictError('Identity belongs to a different environment')
    if (unfinished.has(project.id)) {
      await settleUnfinished(project.id)
      return db.operation.findUniqueOrThrow({ where: { id: project.operations[0].id } })
    }
    return project.operations[0]
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
  return {
    start,
    async ensure(identity: PreviewIdentity, tarball: Buffer) {
      await start()
      const previous = await existing(identity)
      if (previous) {
        if (previous.state === 'ready') await reassertRoute(previous.projectId)
        return previous
      }
      const owner = await db.user.upsert({ where: { email: PREVIEW_OWNER_EMAIL }, update: {},
        create: { email: PREVIEW_OWNER_EMAIL, name: 'Preview service', password: '!disabled-preview-service' } })
      await options.beforeInsert?.()
      let created: Awaited<ReturnType<typeof createProjectWithPorts>>
      try {
        created = await createProjectWithPorts(db, {
          ...identity, name: `${identity.repository} / ${identity.branch}`, slug: `preview-${randomUUID()}`,
          ownerId: owner.id, environmentType: 'preview', status: 'provisioning', supabaseRef: PREVIEW_CORE_REF,
          operations: { create: { kind: PREVIEW_OPERATION_KIND } },
        }, ['API_GW_HTTP_PORT'])
      } catch (error) {
        const winner = await existing(identity)
        if (winner) return winner
        throw error
      }
      const operation = await db.operation.findFirstOrThrow({ where: { projectId: created.project.id, kind: PREVIEW_OPERATION_KIND } })
      const job = queue.then(async () => {
        let stage = 'claim'
        let routed: string | undefined
        try {
          await retryWrite(() => transitionOperation(db, operation.id, 'provisioning'))
          stage = 'provision-import-health'
          await runtime.provision(created.project, tarball, created.ports, async env => {
            await retryWrite(() => db.$transaction(Object.entries(env).map(([key, value]) => db.projectEnvVar.upsert({
              where: { projectId_key: { projectId: created.project.id, key } },
              create: { projectId: created.project.id, key, value }, update: { value },
            }))))
          })
          // Ready means the public hostname answers through the tunnel, so the
          // route is added only after the health gate and before ready.
          stage = 'route-add'
          const host = previewHostname(created.project.slug, domain)
          await tunnel.addPreviewRoute(host, gatewayOrigin(created.ports['API_GW_HTTP_PORT']))
          routed = host
          stage = 'ready-persistence'
          await retryWrite(() => db.$transaction(async tx => {
            await transitionOperation(tx, operation.id, 'ready')
            await tx.project.update({ where: { id: created.project.id }, data: { status: 'active' } })
          }))
        } catch (error) {
          console.error('Preview worker failed', { operationId: operation.id,
            stage: error instanceof ImportError ? error.stage : stage,
            code: error instanceof ImportError ? error.code : 'PREVIEW_WORKER_FAILED' })
          // A failed preview is never publicly routed; destroy retries removal.
          if (routed) await tunnel.removePreviewRoute(routed).catch(() => {
            console.error('Preview route removal failed', { operationId: operation.id, hostname: routed, stage: 'route-remove' })
          })
          await recordFailure(operation.id)
        }
      })
      const settled = job.catch(() => { unfinished.set(created.project.id, operation.id) }).finally(() => {
        if (!unfinished.has(created.project.id)) jobs.delete(created.project.id)
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
