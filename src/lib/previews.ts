import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createProjectWithPorts } from './ports'
import { recoverInterruptedOperations, transitionOperation } from './operations'
import type { PreviewIdentity } from './preview-identity'
import { PREVIEW_CORE_REF, type PreviewRuntime } from './preview-runtime'
import { PREVIEW_OWNER_EMAIL } from './preview-owner'
import { ImportError } from './import-pipeline'

export { PREVIEW_OWNER_EMAIL } from './preview-owner'
export const PREVIEW_OPERATION_KIND = 'preview-ensure'

export class PreviewConflictError extends Error {}

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

export function createPreviewService(db: PrismaClient, runtime: PreviewRuntime, options: { beforeInsert?: () => Promise<void> } = {}) {
  let startup: Promise<number> | undefined
  let queue = Promise.resolve()
  const jobs = new Map<string, Promise<void>>()
  const unfinished = new Map<string, string>()
  const destroying = new Set<string>()
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
  return {
    start,
    async ensure(identity: PreviewIdentity, tarball: Buffer) {
      await start()
      const previous = await existing(identity)
      if (previous) return previous
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
        try {
          await retryWrite(() => transitionOperation(db, operation.id, 'provisioning'))
          stage = 'provision-import-health'
          await runtime.provision(created.project, tarball, created.ports, async env => {
            await retryWrite(() => db.$transaction(Object.entries(env).map(([key, value]) => db.projectEnvVar.upsert({
              where: { projectId_key: { projectId: created.project.id, key } },
              create: { projectId: created.project.id, key, value }, update: { value },
            }))))
          })
          stage = 'ready-persistence'
          await retryWrite(() => db.$transaction(async tx => {
            await transitionOperation(tx, operation.id, 'ready')
            await tx.project.update({ where: { id: created.project.id }, data: { status: 'active' } })
          }))
        } catch (error) {
          console.error('Preview worker failed', { operationId: operation.id,
            stage: error instanceof ImportError ? error.stage : stage,
            code: error instanceof ImportError ? error.code : 'PREVIEW_WORKER_FAILED' })
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
        ...(operation.state === 'ready' ? { url: env.SUPABASE_PUBLIC_URL, anonKey: env.ANON_KEY } : {}) }
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
        const current = await db.operation.findUniqueOrThrow({ where: { id: operation.id } })
        if (current.state === 'queued' || current.state === 'provisioning') throw new PreviewConflictError('Operation is running in another worker')
        await runtime.destroy(operation.project)
        await db.project.delete({ where: { id: operation.projectId } })
        return true
      } finally { destroying.delete(operation.projectId) }
    },
    async idle() { await queue },
  }
}

export type PreviewService = ReturnType<typeof createPreviewService>
