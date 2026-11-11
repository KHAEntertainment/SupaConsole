import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createPreviewService } from '@/lib/previews'
import { normalizePreviewIdentity } from '@/lib/preview-identity'
import type { PreviewRuntime } from '@/lib/preview-runtime'
import { fakeTunnel } from './helpers/fake-tunnel'

let directory: string
let db: PrismaClient

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 't15-worker-retries-'))
  const datasourceUrl = `file:${directory}/test.db`
  execFileSync(process.execPath, ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: datasourceUrl },
    stdio: 'pipe',
  })
  db = new PrismaClient({ datasourceUrl: `${datasourceUrl}?connection_limit=1` })
})

afterEach(async () => {
  await db.project.deleteMany()
  await db.user.deleteMany()
})

afterAll(async () => {
  await db?.$disconnect()
  await fs.rm(directory, { recursive: true, force: true })
})

function identity(branch: string) {
  return normalizePreviewIdentity({ repository: 'acme/worker-retries', branch })
}

function runtime(provision: PreviewRuntime['provision'] = async (_project, _tarball, _ports, persist) => {
  await persist({ ANON_KEY: 'test-anon', SUPABASE_PUBLIC_URL: 'https://preview.test' })
}): PreviewRuntime {
  return { provision: vi.fn(provision), destroy: vi.fn(async () => {}) }
}

function transactionFaultDb(
  transactionFailure: (transactionNumber: number) => Error | undefined,
) {
  let transactionNumber = 0
  const client = new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (...args: unknown[]) => {
          const current = ++transactionNumber
          const failure = transactionFailure(current)
          if (failure) return Promise.reject(failure)
          const transaction = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>
          return transaction.apply(target, args)
        }
      }
      return Reflect.get(target, property, target)
    },
  }) as PrismaClient
  return { client, transactionCount: () => transactionNumber }
}

function prismaFailure(code: string) {
  return Object.assign(new Error(`temporary prisma failure ${code}`), { code })
}

it('retries a transient initial provisioning transition and completes the preview as ready', async () => {
  let injected = false
  const wrapped = transactionFaultDb(transactionNumber => {
    if (transactionNumber === 3 && !injected) {
      injected = true
      return prismaFailure('P1008')
    }
    return undefined
  })
  const stack = runtime()
  const service = createPreviewService(wrapped.client, stack, { tunnel: fakeTunnel() })

  const operation = await service.ensure(identity('initial-transition-retry'), Buffer.from('bundle'))
  await service.idle()

  const stored = await db.operation.findUniqueOrThrow({ where: { id: operation.id } })
  expect(injected).toBe(true)
  expect(wrapped.transactionCount()).toBeGreaterThanOrEqual(3)
  expect(stored).toMatchObject({ state: 'ready', error: null })
  expect(stored.startedAt).not.toBeNull()
  expect(stored.finishedAt).not.toBeNull()
  expect(stack.provision).toHaveBeenCalledTimes(1)
  expect(await service.status('acme/worker-retries', operation.id)).toMatchObject({ state: 'ready', anonKey: 'test-anon' })
  expect(await service.destroy('acme/worker-retries', operation.id)).toBe(true)
})

it('retains failed settlement work after persistent writes fail, then settles and destroys when the database recovers', async () => {
  let databaseUnavailable = true
  const wrapped = transactionFaultDb(transactionNumber =>
    databaseUnavailable && transactionNumber >= 4 ? prismaFailure('P2028') : undefined,
  )
  const stack = runtime(async () => { throw new Error('provisioning failed') })
  const service = createPreviewService(wrapped.client, stack, { tunnel: fakeTunnel() })

  const operation = await service.ensure(identity('failed-settlement-retry'), Buffer.from('bundle'))
  await service.idle()

  const pending = await db.operation.findUniqueOrThrow({ where: { id: operation.id } })
  expect(wrapped.transactionCount()).toBe(8)
  expect(pending.state).toBe('provisioning')
  expect(stack.destroy).not.toHaveBeenCalled()

  databaseUnavailable = false
  const status = await service.status('acme/worker-retries', operation.id)
  expect(status).toMatchObject({ state: 'failed', error: 'Preview provisioning, import or health failed' })
  const settled = await db.operation.findUniqueOrThrow({ where: { id: operation.id } })
  expect(settled.state).toBe('failed')
  expect(settled.startedAt).not.toBeNull()
  expect(settled.finishedAt).not.toBeNull()

  expect(await service.destroy('acme/worker-retries', operation.id)).toBe(true)
  expect(stack.destroy).toHaveBeenCalledTimes(1)
  expect(await db.project.findUnique({ where: { id: operation.projectId } })).toBeNull()
})

it('logs only operation id, import stage, and code when an import failure carries secrets in its cause', async () => {
  const { ImportError } = await import('@/lib/import-pipeline')
  const rawCause = Object.assign(new Error('private failure details'), {
    code: 'E2BIG',
    stdout: 'PRIVATE_STDOUT_PAYLOAD',
    env: { PRIVATE_ENV_KEY: 'PRIVATE_ENV_VALUE' },
  })
  const stage = 'delta:20261008000600_large.sql'
  const stack = runtime(async () => { throw new ImportError(stage, rawCause) })
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})

  try {
    const operation = await service.ensure(identity('safe-import-log'), Buffer.from('bundle'))
    await service.idle()

    expect(log).toHaveBeenCalledWith('Preview worker failed', {
      operationId: operation.id,
      stage,
      code: 'E2BIG',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_STDOUT_PAYLOAD')
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_ENV_VALUE')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private failure details')
  } finally {
    log.mockRestore()
  }
})
