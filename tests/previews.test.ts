import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createPreviewService, PREVIEW_OWNER_EMAIL } from '@/lib/previews'
import { previewHostname } from '@/lib/tunnel'
import { createPreviewRoutes } from '@/lib/preview-routes'
import { normalizePreviewIdentity } from '@/lib/preview-identity'
import { verifyPassword } from '@/lib/auth'
import type { PreviewRuntime } from '@/lib/preview-runtime'
import { fakeTunnel } from './helpers/fake-tunnel'

let directory: string
let db: PrismaClient
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 't15-service-'))
  const datasourceUrl = `file:${directory}/test.db`
  execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { env: { ...process.env, DATABASE_URL: datasourceUrl }, stdio: 'pipe' })
  db = new PrismaClient({ datasourceUrl: `${datasourceUrl}?connection_limit=1` })
})
afterAll(async () => {
  await db?.$disconnect()
  await fs.rm(directory, { recursive: true, force: true })
})
function identity(branch: string) { return normalizePreviewIdentity({ repository: 'Acme/App', branch, pullRequestNumber: 42 }) }
function runtime(): PreviewRuntime {
  return { provision: vi.fn(async (_project, _tarball, _ports, persist) => {
    await persist({ ANON_KEY: 'synthetic-anon', SERVICE_ROLE_KEY: 'never-return-this', POSTGRES_PASSWORD: 'never-return-this', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
  }), destroy: vi.fn(async () => {}) }
}

it('returns one operation at a uniqueness latch, queues one provision, persists credentials and scopes status', async () => {
  const stack = runtime()
  let arrivals = 0
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel(), beforeInsert: async () => {
    if (++arrivals === 2) release()
    await latch
  } })
  const [a, b] = await Promise.all([service.ensure(identity('latch'), Buffer.from('bundle')), service.ensure(identity('latch'), Buffer.from('bundle'))])
  expect(a.id).toBe(b.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(1)
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'latch' } })).toBe(1)
  // A changed bundle updates the existing preview under the same project
  // row (T20): a new operation for the new bundle, still one environment.
  const updated = await service.ensure(identity('latch'), Buffer.from('replacement'))
  expect(updated.id).not.toBe(a.id)
  expect(updated.projectId).toBe(a.projectId)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'latch' } })).toBe(1)
  expect(await service.status('acme/app', a.id)).toEqual({ operationId: a.id, state: 'ready', error: null, url: 'https://preview.example.invalid', anonKey: 'synthetic-anon',
    hostname: `${(await db.project.findUniqueOrThrow({ where: { id: a.projectId } })).slug}.preview.example.invalid` })
  expect(await service.status('other/app', a.id)).toBeNull()
  expect(await service.destroy('other/app', a.id)).toBe(false)
  const owner = await db.user.findUniqueOrThrow({ where: { email: PREVIEW_OWNER_EMAIL } })
  expect(await verifyPassword('!disabled-preview-service', owner.password)).toBe(false)
  expect(await service.destroy('acme/app', a.id)).toBe(true)
  expect(await db.allocatedPort.count({ where: { projectId: a.projectId } })).toBe(0)
})

it('returns queued immediately, withholds credentials until ready, and destroy joins active work', async () => {
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  const stack = runtime()
  stack.provision = vi.fn(async (_project, _bundle, _ports, persist) => {
    await persist({ ANON_KEY: 'private-until-ready', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
    await latch
  })
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const operation = await service.ensure(identity('active'), Buffer.from('bundle'))
  expect(operation.state).toBe('queued')
  expect(await service.status('acme/app', operation.id)).not.toHaveProperty('anonKey')
  const deletion = service.destroy('acme/app', operation.id)
  expect(stack.destroy).not.toHaveBeenCalled()
  release()
  expect(await deletion).toBe(true)
  expect(await service.status('acme/app', operation.id)).toBeNull()
})

it('retains failed stacks without exposing diagnostics, then removes them', async () => {
  const stack = runtime()
  stack.provision = vi.fn(async () => { throw new Error('raw stderr containing a secret') })
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const operation = await service.ensure(identity('broken'), Buffer.from('bundle'))
  await service.idle()
  const status = await service.status('acme/app', operation.id)
  expect(status).toMatchObject({ state: 'failed' })
  expect(JSON.stringify(status)).not.toContain('secret')
  expect(status).not.toHaveProperty('url')
  expect(stack.destroy).not.toHaveBeenCalled()
  // Same-hash retry: stays failed, no retry loop, no new provision (T20).
  expect((await service.ensure(identity('broken'), Buffer.from('bundle'))).id).toBe(operation.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(1)
  // Changed-hash retry (the fix push) re-provisions under the same row.
  const retry = await service.ensure(identity('broken'), Buffer.from('retry'))
  expect(retry.id).not.toBe(operation.id)
  expect(retry.projectId).toBe(operation.projectId)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(await service.status('acme/app', retry.id)).toMatchObject({ state: 'failed' })
  // Destroy removes the stack the update rebuilt before failing.
  await service.destroy('acme/app', operation.id)
  expect(stack.destroy).toHaveBeenCalledTimes(2)
})

it('applies a changed bundle to the existing preview and keeps the hostname', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const service = createPreviewService(db, stack, { tunnel })
  const first = await service.ensure(identity('update'), Buffer.from('update-first'))
  await service.idle()
  const before = await service.status('acme/app', first.id)
  const second = await service.ensure(identity('update'), Buffer.from('update-second'))
  await service.idle()
  expect(second.id).not.toBe(first.id)
  expect(second.projectId).toBe(first.projectId)
  // The rebuilt environment comes from the second bundle (T20).
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(vi.mocked(stack.provision).mock.calls[1][1]).toEqual(Buffer.from('update-second'))
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'update' } })).toBe(1)
  const after = await service.status('acme/app', second.id)
  expect(after).toMatchObject({ state: 'ready' })
  expect(after?.hostname).toBe(before?.hostname)
  expect(tunnel.routes()).toHaveLength(1)
  await service.destroy('acme/app', second.id)
})

it('leaves the preview untouched when the same bundle is ensured again', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const service = createPreviewService(db, stack, { tunnel })
  const first = await service.ensure(identity('unchanged'), Buffer.from('unchanged-bundle'))
  await service.idle()
  const again = await service.ensure(identity('unchanged'), Buffer.from('unchanged-bundle'))
  expect(again.id).toBe(first.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(1)
  expect(stack.destroy).not.toHaveBeenCalled()
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'unchanged' } })).toBe(1)
  expect(tunnel.routes()).toHaveLength(1)
  await service.destroy('acme/app', first.id)
})

it('keeps one environment and updates the pull request number on re-ensure', async () => {
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const first = await service.ensure(identity('pr-meta'), Buffer.from('pr-meta-bundle'))
  await service.idle()
  const second = await service.ensure(normalizePreviewIdentity({ repository: 'Acme/App', branch: 'pr-meta', pullRequestNumber: 43 }), Buffer.from('pr-meta-bundle'))
  expect(second.id).toBe(first.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(1)
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'pr-meta' } })).toBe(1)
  expect(await db.project.findUniqueOrThrow({ where: { id: first.projectId } })).toMatchObject({ pullRequestNumber: 43 })
  await service.destroy('acme/app', first.id)
})

it('serializes two ensures with different bundles instead of provisioning concurrently', async () => {
  const stack = runtime()
  let inFlight = 0
  let maxInFlight = 0
  stack.provision = vi.fn(async (_project, _tarball, _ports, persist) => {
    await persist({ ANON_KEY: 'serial-anon', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 10))
    inFlight--
  })
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const first = await service.ensure(identity('serial'), Buffer.from('serial-first'))
  const second = await service.ensure(identity('serial'), Buffer.from('serial-second'))
  await service.idle()
  expect(second.id).not.toBe(first.id)
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(maxInFlight).toBe(1)
  // The last bundle wins: the second update is what the environment ends on.
  expect(vi.mocked(stack.provision).mock.calls[1][1]).toEqual(Buffer.from('serial-second'))
  expect(await db.project.count({ where: { repository: 'acme/app', branch: 'serial' } })).toBe(1)
  await service.destroy('acme/app', second.id)
})

it('ends destroyed with no leftovers when destroy arrives during an update', async () => {
  const stack = runtime()
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  let updating = false
  stack.provision = vi.fn(async (_project, _tarball, _ports, persist) => {
    await persist({ ANON_KEY: 'race-anon', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
    if (updating) await latch
  })
  const tunnel = fakeTunnel()
  const service = createPreviewService(db, stack, { tunnel })
  const first = await service.ensure(identity('race'), Buffer.from('race-first'))
  await service.idle()
  expect(tunnel.routes()).toHaveLength(1)
  updating = true
  const second = await service.ensure(identity('race'), Buffer.from('race-second'))
  expect(second.id).not.toBe(first.id)
  const deletion = service.destroy('acme/app', first.id)
  // Destroy joins the in-flight update instead of tearing down under it.
  expect(stack.destroy).not.toHaveBeenCalled()
  release()
  expect(await deletion).toBe(true)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(2)
  // The update's own teardown, then destroy's teardown of the rebuilt stack.
  expect(stack.destroy).toHaveBeenCalledTimes(2)
  expect(vi.mocked(stack.destroy).mock.calls[1][0].id).toBe(first.projectId)
  expect(tunnel.routes()).toHaveLength(0)
  expect(await db.project.count({ where: { id: first.projectId } })).toBe(0)
})

it('recovers queued and provisioning operations on startup and permits destroy', async () => {
  const owner = await db.user.findUniqueOrThrow({ where: { email: PREVIEW_OWNER_EMAIL } })
  for (const state of ['queued', 'provisioning']) {
    const project = await db.project.create({ data: { ...identity(`recover-${state}`), name: 'interrupted', slug: `recover-${state}`,
      ownerId: owner.id, environmentType: 'preview', operations: { create: { kind: 'preview-ensure', state } } }, include: { operations: true } })
    const service = createPreviewService(db, runtime(), { tunnel: fakeTunnel() })
    expect(await service.start()).toBe(1)
    expect(await service.start()).toBe(1)
    expect(await service.status('acme/app', project.operations[0].id)).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
    await service.destroy('acme/app', project.operations[0].id)
  }
})

async function interruptedPreview(slug: string) {
  const owner = await db.user.findUniqueOrThrow({ where: { email: PREVIEW_OWNER_EMAIL } })
  return db.project.create({ data: { ...identity(slug), name: 'interrupted', slug,
    ownerId: owner.id, environmentType: 'preview', operations: { create: { kind: 'preview-ensure', state: 'provisioning' } } },
  include: { operations: true } })
}

it('removes an interrupted preview route before marking its operation failed', async () => {
  const tunnel = fakeTunnel()
  const project = await interruptedPreview('route-recover-ok')
  const host = previewHostname(project.slug, tunnel.domain)
  await tunnel.addPreviewRoute(host, 'http://127.0.0.1:9')
  expect(tunnel.routes()).toHaveLength(1)
  const service = createPreviewService(db, runtime(), { tunnel })
  expect(await service.start()).toBe(1)
  expect(tunnel.routes()).toHaveLength(0)
  expect(await service.status('acme/app', project.operations[0].id)).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
  await service.destroy('acme/app', project.operations[0].id)
})

it('leaves an interrupted operation retryable when route removal fails', async () => {
  const tunnel = fakeTunnel()
  const project = await interruptedPreview('route-recover-retry')
  const operationId = project.operations[0].id
  await tunnel.addPreviewRoute(previewHostname(project.slug, tunnel.domain), 'http://127.0.0.1:9')
  const remove = vi.spyOn(tunnel, 'removePreviewRoute').mockRejectedValueOnce(new Error('tunnel unavailable'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const service = createPreviewService(db, runtime(), { tunnel })
  expect(await service.start()).toBe(0)
  expect(await db.operation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ state: 'provisioning' })
  expect(tunnel.routes()).toHaveLength(1)
  // The next call retries the pending removal and only then marks it failed.
  await service.start()
  expect(remove).toHaveBeenCalledTimes(2)
  expect(tunnel.routes()).toHaveLength(0)
  expect(await db.operation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
  vi.restoreAllMocks()
  await service.destroy('acme/app', operationId)
})

it('keeps database state when cleanup fails so destroy can be retried', async () => {
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const operation = await service.ensure(identity('cleanup-retry'), Buffer.from('bundle'))
  await service.idle()
  vi.mocked(stack.destroy).mockRejectedValueOnce(new Error('cleanup failure'))
  await expect(service.destroy('acme/app', operation.id)).rejects.toThrow('cleanup failure')
  expect(await service.status('acme/app', operation.id)).not.toBeNull()
  await service.destroy('acme/app', operation.id)
})

it('authenticates every route, validates input, normalizes identity and prevents cross-repository reads', async () => {
  const service = createPreviewService(db, runtime(), { tunnel: fakeTunnel() })
  const authenticate = vi.fn(async (request: NextRequest, repository: string) => {
    if (request.headers.get('authorization') !== 'Bearer synthetic' || repository !== 'acme/app') {
      return { ok: false as const, response: NextResponse.json({ error: 'invalid token' }, { status: 401 }) }
    }
    return { ok: true as const, token: { id: 'test', name: 'test', repository, createdAt: new Date(), revokedAt: null, expiresAt: null } }
  })
  const routes = createPreviewRoutes(() => service, authenticate)
  function ensureRequest(branch = '  route  ', pr = '42') {
    const form = new FormData()
    form.set('tarball', new Blob(['bundle']), 'bundle.tar.gz')
    const query = new URLSearchParams({ repository: '  ACME/App  ', branch, pullRequestNumber: pr })
    return new NextRequest(`http://localhost/api/previews/ensure?${query}`, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: form })
  }
  const response = await routes.ensure(ensureRequest())
  expect(response.status).toBe(202)
  const { operationId } = await response.json()
  await service.idle()
  expect(await db.project.findFirst({ where: { branch: 'route' } })).toMatchObject({ repository: 'acme/app', branch: 'route', pullRequestNumber: 42 })
  const query = `http://localhost/api/previews/status?repository=acme/app&operationId=${operationId}`
  expect((await routes.status(new NextRequest(query))).status).toBe(401)
  const status = await routes.status(new NextRequest(query, { headers: { authorization: 'Bearer synthetic' } }))
  expect(status.status).toBe(200)
  expect(JSON.stringify(await status.json())).not.toContain('never-return-this')
  expect((await routes.ensure(ensureRequest('bad', '-1'))).status).toBe(400)
  expect((await routes.ensure(ensureRequest('  '))).status).toBe(400)
  const denied = await routes.destroy(new NextRequest('http://localhost/api/previews/destroy?repository=other%2Fapp', { method: 'POST', headers: { authorization: 'Bearer synthetic' },
    body: JSON.stringify({ operationId }) }))
  expect(denied.status).toBe(401)
  const removed = await routes.destroy(new NextRequest('http://localhost/api/previews/destroy?repository=acme%2Fapp', { method: 'POST', headers: { authorization: 'Bearer synthetic' },
    body: JSON.stringify({ operationId }) }))
  expect(removed.status).toBe(200)
  expect(authenticate).toHaveBeenCalledTimes(7)
})
