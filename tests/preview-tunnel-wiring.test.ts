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

const DOMAIN = 'preview.example.invalid'
let directory: string
let db: PrismaClient

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 't17-tunnel-wiring-'))
  const datasourceUrl = `file:${directory}/test.db`
  execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { env: { ...process.env, DATABASE_URL: datasourceUrl }, stdio: 'pipe' })
  db = new PrismaClient({ datasourceUrl: `${datasourceUrl}?connection_limit=1` })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await db.project.deleteMany()
})
afterAll(async () => {
  await db?.$disconnect()
  await fs.rm(directory, { recursive: true, force: true })
})

function identity(branch: string) { return normalizePreviewIdentity({ repository: 'acme/tunnel', branch }) }
function runtime(): PreviewRuntime {
  return { provision: vi.fn(async (_project, _tarball, _ports, persist) => {
    await persist({ ANON_KEY: 'synthetic-anon', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
  }), destroy: vi.fn(async () => {}) }
}
async function project(projectId: string) {
  return db.project.findUniqueOrThrow({ where: { id: projectId }, include: { envVars: { where: { key: 'API_GW_HTTP_PORT' } } } })
}

it('adds the loopback gateway route after provision and before ready, and status returns the hostname', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const stack = runtime()
  const states: string[] = []
  const original = tunnel.addPreviewRoute.bind(tunnel)
  const add = vi.spyOn(tunnel, 'addPreviewRoute').mockImplementationOnce(async (hostname, origin) => {
    expect(stack.provision).toHaveBeenCalledTimes(1)
    states.push((await db.operation.findFirstOrThrow({ where: { project: { branch: 'routed' } } })).state)
    await original(hostname, origin)
  })
  const service = createPreviewService(db, stack, { tunnel })
  const operation = await service.ensure(identity('routed'), Buffer.from('bundle'))
  await service.idle()

  const { slug, envVars } = await project(operation.projectId)
  const hostname = `${slug}.${DOMAIN}`
  expect(states).toEqual(['provisioning'])
  expect(add).toHaveBeenCalledWith(hostname, `http://127.0.0.1:${envVars[0].value}`)
  expect(tunnel.routes()).toEqual([{ hostname, service: `http://127.0.0.1:${envVars[0].value}` }])
  expect(await service.status('acme/tunnel', operation.id)).toEqual({ operationId: operation.id, state: 'ready', error: null,
    url: 'https://preview.example.invalid', anonKey: 'synthetic-anon', hostname })
})

it('fails the operation and project through recordFailure when the route add fails', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  vi.spyOn(tunnel, 'addPreviewRoute').mockRejectedValueOnce(new Error('Cloudflare tunnel config PUT failed: 500'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const service = createPreviewService(db, runtime(), { tunnel })
  const operation = await service.ensure(identity('route-add-fails'), Buffer.from('bundle'))
  await service.idle()

  const status = await service.status('acme/tunnel', operation.id)
  expect(status).toEqual({ operationId: operation.id, state: 'failed', error: 'Preview provisioning, import or health failed' })
  expect((await project(operation.projectId)).status).toBe('failed')
  expect(log).toHaveBeenCalledWith('Preview worker failed', { operationId: operation.id, stage: 'route-add', code: 'PREVIEW_WORKER_FAILED' })
  expect(tunnel.routes()).toEqual([])
})

it('removes the route again when ready persistence fails after the route was added', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  let failNextTransaction = false
  const faulty = new Proxy(db, { get(target, property) {
    if (property === '$transaction' && failNextTransaction) {
      failNextTransaction = false
      return () => Promise.reject(new Error('ready persistence failed'))
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as PrismaClient
  const add = tunnel.addPreviewRoute.bind(tunnel)
  vi.spyOn(tunnel, 'addPreviewRoute').mockImplementationOnce(async (hostname, origin) => {
    await add(hostname, origin)
    expect(tunnel.routes()).toHaveLength(1)
    failNextTransaction = true
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const service = createPreviewService(faulty, runtime(), { tunnel })
  const operation = await service.ensure(identity('ready-persist-fails'), Buffer.from('bundle'))
  await service.idle()

  expect(await service.status('acme/tunnel', operation.id)).toMatchObject({ state: 'failed' })
  expect(tunnel.routes()).toEqual([])
})

it('re-ensure of a ready preview re-asserts the route without duplicating it', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const service = createPreviewService(db, runtime(), { tunnel })
  const operation = await service.ensure(identity('reassert'), Buffer.from('bundle'))
  await service.idle()
  const routed = tunnel.routes()
  expect(routed).toHaveLength(1)

  expect((await service.ensure(identity('reassert'), Buffer.from('bundle'))).id).toBe(operation.id)
  expect((await service.ensure(identity('reassert'), Buffer.from('bundle'))).id).toBe(operation.id)
  expect(tunnel.routes()).toEqual(routed)

  // The tunnel lost the rule (e.g. died between route add and ready persistence).
  await tunnel.removePreviewRoute(routed[0].hostname!)
  expect(tunnel.routes()).toEqual([])
  await service.ensure(identity('reassert'), Buffer.from('bundle'))
  expect(tunnel.routes()).toEqual(routed)
})

it('does not re-assert routes for failed previews', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const stack = runtime()
  stack.provision = vi.fn(async () => { throw new Error('health failed') })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const add = vi.spyOn(tunnel, 'addPreviewRoute')
  const service = createPreviewService(db, stack, { tunnel })
  const operation = await service.ensure(identity('failed-no-route'), Buffer.from('bundle'))
  await service.idle()
  expect((await service.ensure(identity('failed-no-route'), Buffer.from('bundle'))).id).toBe(operation.id)
  expect(add).not.toHaveBeenCalled()
})

it('destroy removes the route and deletes the row', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel })
  const operation = await service.ensure(identity('destroy-route'), Buffer.from('bundle'))
  await service.idle()
  const { slug } = await project(operation.projectId)
  const remove = vi.spyOn(tunnel, 'removePreviewRoute')

  expect(await service.destroy('acme/tunnel', operation.id)).toBe(true)
  expect(remove).toHaveBeenCalledWith(`${slug}.${DOMAIN}`)
  expect(remove.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stack.destroy).mock.invocationCallOrder[0])
  expect(tunnel.routes()).toEqual([])
  expect(await db.project.findUnique({ where: { id: operation.projectId } })).toBeNull()
})

it('destroy still tears down and deletes the row when route removal throws, without logging the token', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel })
  const operation = await service.ensure(identity('destroy-remove-fails'), Buffer.from('bundle'))
  await service.idle()
  const { slug } = await project(operation.projectId)
  vi.spyOn(tunnel, 'removePreviewRoute').mockRejectedValueOnce(new Error('Cloudflare down synthetic-token'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})

  expect(await service.destroy('acme/tunnel', operation.id)).toBe(true)
  expect(stack.destroy).toHaveBeenCalledTimes(1)
  expect(await db.project.findUnique({ where: { id: operation.projectId } })).toBeNull()
  expect(log).toHaveBeenCalledWith('Preview route removal failed', { operationId: operation.id, hostname: `${slug}.${DOMAIN}`, stage: 'route-remove' })
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-token')
})

it('destroy waits for an in-flight re-assert so the route cannot outlive the row', async () => {
  const tunnel = fakeTunnel(DOMAIN)
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel })
  const operation = await service.ensure(identity('reassert-race'), Buffer.from('bundle'))
  await service.idle()
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  const add = tunnel.addPreviewRoute.bind(tunnel)
  vi.spyOn(tunnel, 'addPreviewRoute').mockImplementationOnce(async (hostname, origin) => {
    await latch
    await add(hostname, origin)
  })

  const reensure = service.ensure(identity('reassert-race'), Buffer.from('bundle'))
  await vi.waitFor(() => expect(tunnel.addPreviewRoute).toHaveBeenCalled())
  const destroyed = service.destroy('acme/tunnel', operation.id)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(stack.destroy).not.toHaveBeenCalled()
  release()
  await reensure
  expect(await destroyed).toBe(true)
  expect(tunnel.routes()).toEqual([])
})

it('preview worker requires the Cloudflare account and tunnel ids', async () => {
  const { getPreviewService } = await import('@/lib/preview-worker')
  const holder = globalThis as typeof globalThis & { previewService?: unknown }
  delete holder.previewService
  vi.stubEnv('PREVIEW_DOMAIN', DOMAIN)
  vi.stubEnv('SUPACONSOLE_PREVIEW_BASELINE_VERSION', '20261008000400')
  vi.stubEnv('CLOUDFLARE_PREVIEW_API_TOKEN', 'synthetic-token')
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '')
  vi.stubEnv('CLOUDFLARE_TUNNEL_ID', 'tunnel')
  expect(() => getPreviewService()).toThrow('CLOUDFLARE_ACCOUNT_ID is required')
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account')
  vi.stubEnv('CLOUDFLARE_TUNNEL_ID', '')
  expect(() => getPreviewService()).toThrow('CLOUDFLARE_TUNNEL_ID is required')
  vi.stubEnv('CLOUDFLARE_TUNNEL_ID', 'tunnel')
  vi.stubEnv('CLOUDFLARE_PREVIEW_API_TOKEN', '')
  expect(() => getPreviewService()).toThrow('CLOUDFLARE_PREVIEW_API_TOKEN is required')
  expect(holder.previewService).toBeUndefined()
  vi.stubEnv('CLOUDFLARE_PREVIEW_API_TOKEN', 'synthetic-token')
  expect(getPreviewService()).toBe(holder.previewService)
  delete holder.previewService
})
