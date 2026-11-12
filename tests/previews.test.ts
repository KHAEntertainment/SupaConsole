import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createPreviewService, PREVIEW_OWNER_EMAIL, PREVIEW_OPERATION_KIND } from '@/lib/previews'
import { previewHostname } from '@/lib/tunnel'
import { createPreviewRoutes } from '@/lib/preview-routes'
import { normalizePreviewIdentity } from '@/lib/preview-identity'
import { verifyPassword } from '@/lib/auth'
import type { PreviewRuntime } from '@/lib/preview-runtime'
import { fakeTunnel } from './helpers/fake-tunnel'
import { buildTarball } from './helpers/build-tar'

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
// Valid bundles for anything that must take the update path: an update claim
// requires validated content (T20 review 9), so successful updates never use
// garbage-byte fixtures.
function bundle(sql: string) { return buildTarball([{ name: 'supabase/migrations/0001_change.sql', body: sql }]) }
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
// Wrap a Prisma client so delegate calls can be gated mid-flight. Used
// instead of vi.spyOn on Prisma delegates (spy restore on them is
// unreliable and leaks recursion); the gated client is passed to one
// service only, so nothing carries into other tests.
function gatedDb(gate: {
  findUnique?: (args: unknown) => Promise<void>
  findMany?: (args: unknown) => Promise<void>
  beforeProjectDelete?: () => Promise<void>
}): PrismaClient {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'project' || prop === 'projectEnvVar') {
        const delegate = Reflect.get(target, prop, target) as object
        return new Proxy(delegate, {
          get(d, m) {
            const value = Reflect.get(d, m, d)
            if (typeof value !== 'function') return value
            const fn = (value as (...args: unknown[]) => unknown).bind(d)
            // Only the gated methods become plain async functions; every
            // other method must keep returning a PrismaPromise (array-form
            // $transaction requires them).
            const gated = (prop === 'project' && ((m === 'findUnique' && gate.findUnique) || (m === 'delete' && gate.beforeProjectDelete)))
              || (prop === 'projectEnvVar' && m === 'findMany' && gate.findMany)
            if (!gated) return fn
            return async (...args: unknown[]) => {
              if (prop === 'project' && m === 'delete' && gate.beforeProjectDelete) await gate.beforeProjectDelete()
              const result = await fn(...args)
              if (prop === 'project' && m === 'findUnique' && gate.findUnique) await gate.findUnique(args[0])
              if (prop === 'projectEnvVar' && m === 'findMany' && gate.findMany) await gate.findMany(args[0])
              return result
            }
          },
        })
      }
      return Reflect.get(target, prop, target)
    },
  }) as PrismaClient
}
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
  const updated = await service.ensure(identity('latch'), bundle('alter table replacement;'))
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
  const retry = await service.ensure(identity('broken'), bundle('alter table retry;'))
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
  const firstBundle = bundle('alter table one;')
  const secondBundle = bundle('alter table two;')
  const first = await service.ensure(identity('update'), firstBundle)
  await service.idle()
  const before = await service.status('acme/app', first.id)
  const second = await service.ensure(identity('update'), secondBundle)
  await service.idle()
  expect(second.id).not.toBe(first.id)
  expect(second.projectId).toBe(first.projectId)
  // The rebuilt environment comes from the second bundle (T20).
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(vi.mocked(stack.provision).mock.calls[1][1]).toEqual(secondBundle)
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
  const firstBundle = bundle('alter table serial a;')
  const secondBundle = bundle('alter table serial b;')
  const first = await service.ensure(identity('serial'), firstBundle)
  const second = await service.ensure(identity('serial'), secondBundle)
  await service.idle()
  expect(second.id).not.toBe(first.id)
  expect(stack.provision).toHaveBeenCalledTimes(2)
  expect(maxInFlight).toBe(1)
  // The last bundle wins: the second update is what the environment ends on.
  expect(vi.mocked(stack.provision).mock.calls[1][1]).toEqual(secondBundle)
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
  const first = await service.ensure(identity('race'), bundle('alter table race a;'))
  await service.idle()
  expect(tunnel.routes()).toHaveLength(1)
  updating = true
  const second = await service.ensure(identity('race'), bundle('alter table race b;'))
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

it('destroy waits for every registering update and leaves nothing behind (T20 review 1)', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const bundleA = bundle('alter table a;')
  const bundleB = bundle('alter table b;')
  // Seam: stall each update's ports lookup mid-registration (accepted,
  // job not yet registered).
  const portsA = latch(); const gateA = latch()
  const portsB = latch(); const gateB = latch()
  let reads = 0
  // Seam: hold destroy at its row deletion until the end.
  const deleteEntered = latch(); const deleteGate = latch()
  const service = createPreviewService(gatedDb({
    findMany: async () => {
      const read = ++reads
      if (read === 1) { portsA.release(); await gateA.promise }
      if (read === 2) { portsB.release(); await gateB.promise }
    },
    beforeProjectDelete: async () => { deleteEntered.release(); await deleteGate.promise },
  }), stack, { tunnel })
  const first = await service.ensure(identity('set-race'), bundle('select 0;'))
  await service.idle()
  const marker = path.join(directory, 'set-race-marker')
  const enteredB = latch(); const finishB = latch()
  stack.provision = vi.fn(async (_project, tarball, _ports, persist) => {
    await persist({ ANON_KEY: 'synthetic', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
    await fs.writeFile(marker, 'provisioned')
    if (tarball.equals(bundleB)) { enteredB.release(); await finishB.promise }
  })
  stack.destroy = vi.fn(async () => { await fs.rm(marker, { force: true }) })
  const updateA = service.ensure(identity('set-race'), bundleA)
  const updateB = service.ensure(identity('set-race'), bundleB)
  await portsA.promise
  gateA.release()
  await updateA
  await portsB.promise
  // B is accepted and mid-registration (53c1fac: A's cleanup already
  // dropped B's ownership of the shared Set entry).
  const deletion = service.destroy('acme/app', first.id)
  gateB.release()
  await updateB
  await enteredB.promise
  finishB.release()
  await service.idle()
  await deleteEntered.promise
  // Destroy must have joined the surviving update: the marker its provision
  // wrote is gone. (53c1fac: destroy never waits and the marker survives.)
  expect(await fs.access(marker).then(() => true, () => false)).toBe(false)
  deleteGate.release()
  expect(await deletion).toBe(true)
  expect(await db.project.findUnique({ where: { id: first.projectId } })).toBeNull()
})

it('settling an older failed attempt keeps the newer job tracked for destroy (T20 review 2)', async () => {
  const bundleA = bundle('alter table a;')
  const bundleB = bundle('alter table b;')
  const failA = latch(); const enteredA = latch(); const enteredB = latch(); const finishB = latch()
  const marker = path.join(directory, 'unfinished-survivor')
  let injectFailure = false
  const wrapped = new Proxy(db, { get(target, prop) {
    if (prop === '$transaction') return (...args: unknown[]) => {
      if (injectFailure) { injectFailure = false; return Promise.reject(new Error('failure settlement unavailable')) }
      return (target.$transaction as (...values: unknown[]) => Promise<unknown>)(...args)
    }
    return Reflect.get(target, prop, target)
  } }) as PrismaClient
  const stack: PreviewRuntime = {
    provision: vi.fn(async (_p, tarball, _ports, persist) => {
      if (tarball.equals(bundleA)) { enteredA.release(); await failA.promise; injectFailure = true; throw new Error('import failed') }
      await persist({ ANON_KEY: 'synthetic', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
      enteredB.release(); await finishB.promise
      await fs.writeFile(marker, 'b')
    }),
    destroy: vi.fn(async () => { await fs.rm(marker, { force: true }) }),
  }
  const service = createPreviewService(wrapped, stack, { tunnel: fakeTunnel() })
  const a = await service.ensure(identity('unfinished-race'), bundleA)
  await enteredA.promise
  await service.ensure(identity('unfinished-race'), bundleB)
  failA.release()
  await enteredB.promise
  expect((await db.operation.findUniqueOrThrow({ where: { id: a.id } })).state).toBe('provisioning')
  expect(await service.status('acme/app', a.id)).toMatchObject({ state: 'failed' })
  const deletion = service.destroy('acme/app', a.id)
  finishB.release()
  expect(await deletion).toBe(true)
  await service.idle()
  expect(await db.project.findUnique({ where: { id: a.projectId } })).toBeNull()
  // The surviving update's marker must be gone. (53c1fac: settleUnfinished
  // dropped B's job from destroy tracking and the marker outlives the row.)
  expect(await fs.access(marker).then(() => true, () => false)).toBe(false)
})

it('an old ready operation exposes no credentials while its replacement is unready or failed (T20 review 3)', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const service = createPreviewService(db, stack, { tunnel })
  const first = await service.ensure(identity('stale-creds'), bundle('select 1;'))
  await service.idle()
  expect(await service.status('acme/app', first.id)).toMatchObject({ state: 'ready', anonKey: 'synthetic-anon' })
  const entered = latch(); const finish = latch()
  const failReplacement = { value: false }
  stack.provision = vi.fn(async (_p, _t, _ports, persist) => {
    await persist({ ANON_KEY: 'replacement-not-ready', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
    entered.release(); await finish.promise
    if (failReplacement.value) throw new Error('health failed')
  })
  const second = await service.ensure(identity('stale-creds'), bundle('select 2;'))
  await entered.promise
  expect(tunnel.routes()).toHaveLength(0)
  const mid = await service.status('acme/app', first.id)
  expect(mid).toMatchObject({ state: 'ready' })
  expect(mid).not.toHaveProperty('anonKey')
  expect(mid).not.toHaveProperty('url')
  expect(mid).not.toHaveProperty('hostname')
  expect(await service.status('acme/app', second.id)).toMatchObject({ state: 'provisioning' })
  // A failing replacement keeps the old operation credential-less too.
  failReplacement.value = true
  finish.release()
  await service.idle()
  const after = await service.status('acme/app', first.id)
  expect(after).toMatchObject({ state: 'ready' })
  expect(after).not.toHaveProperty('anonKey')
  expect(await service.status('acme/app', second.id)).toMatchObject({ state: 'failed' })
  await service.destroy('acme/app', first.id)
})

it('a late same-hash re-ensure cannot re-route a rebuilding preview (T20 review 4)', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const bundleA = bundle('select 1;')
  const bundleB = bundle('select 2;')
  const captured = latch(); const resume = latch()
  const arm = { value: false }; let intercepted = false
  const service = createPreviewService(gatedDb({ findUnique: async (args) => {
    const where = (args as { where?: { repository_branch?: unknown } })?.where
    if (arm.value && where?.repository_branch && !intercepted) { intercepted = true; captured.release(); await resume.promise }
  } }), stack, { tunnel })
  const first = await service.ensure(identity('late-reassert'), bundleA)
  await service.idle()
  expect(tunnel.routes()).toHaveLength(1)
  arm.value = true
  const stale = service.ensure(identity('late-reassert'), bundleA)
  await captured.promise
  const entered = latch(); const finish = latch()
  stack.provision = vi.fn(async () => { entered.release(); await finish.promise })
  const update = await service.ensure(identity('late-reassert'), bundleB)
  await entered.promise
  expect(tunnel.routes()).toHaveLength(0)
  resume.release()
  await stale
  expect((await db.operation.findUniqueOrThrow({ where: { id: update.id } })).state).toBe('provisioning')
  // The stale request must not have reopened the route mid-rebuild.
  // (53c1fac: it re-asserted the route while the update was provisioning.)
  expect(tunnel.routes()).toHaveLength(0)
  finish.release()
  await service.idle()
  await service.destroy('acme/app', first.id)
})

it('a late re-ensure of the claiming bundle neither re-routes nor reclaims (T20 review 4)', async () => {
  const stack = runtime()
  const tunnel = fakeTunnel()
  const bundleB = bundle('select 2;')
  const captured = latch(); const resume = latch()
  const arm = { value: false }; let intercepted = false
  const service = createPreviewService(gatedDb({ findUnique: async (args) => {
    const where = (args as { where?: { repository_branch?: unknown } })?.where
    if (arm.value && where?.repository_branch && !intercepted) { intercepted = true; captured.release(); await resume.promise }
  } }), stack, { tunnel })
  const first = await service.ensure(identity('late-reclaim'), bundle('select 1;'))
  await service.idle()
  arm.value = true
  const stale = service.ensure(identity('late-reclaim'), bundleB)
  await captured.promise
  const entered = latch(); const finish = latch()
  stack.provision = vi.fn(async () => { entered.release(); await finish.promise })
  const update = await service.ensure(identity('late-reclaim'), bundleB)
  await entered.promise
  resume.release()
  // The stale request is identical to the claiming bundle: it must resolve
  // to that claim without re-routing or claiming a second rebuild. Only the
  // update's provision runs on the replaced stub.
  expect((await stale).id).toBe(update.id)
  expect(stack.provision).toHaveBeenCalledTimes(1)
  expect(tunnel.routes()).toHaveLength(0)
  finish.release()
  await service.idle()
  await service.destroy('acme/app', first.id)
})

it('two simultaneous re-ensures of the same bundle claim exactly one rebuild (T20 review 5)', async () => {
  const stack = runtime()
  const bundleB = bundle('alter table b;')
  const both = latch(); let reads = 0
  const arm = { value: false }
  const service = createPreviewService(gatedDb({ findUnique: async (args) => {
    const where = (args as { where?: { repository_branch?: unknown } })?.where
    if (arm.value && where?.repository_branch && ++reads <= 2) { if (reads === 2) both.release(); await both.promise }
  } }), stack, { tunnel: fakeTunnel() })
  await service.ensure(identity('duplicate-update'), bundle('alter table a;'))
  await service.idle()
  arm.value = true
  const [a, b] = await Promise.all([
    service.ensure(identity('duplicate-update'), bundleB),
    service.ensure(identity('duplicate-update'), bundleB),
  ])
  await service.idle()
  // One claim, one rebuild on top of the initial provision.
  // (53c1fac: two operations and two rebuilds.)
  expect(a.id).toBe(b.id)
  expect(stack.provision).toHaveBeenCalledTimes(2)
  await service.destroy('acme/app', a.id)
})

it('an older unsettled attempt cannot override the current ready environment (T20 review 6)', async () => {
  const bundleA = bundle('alter table a;')
  const bundleB = bundle('alter table b;')
  const entered = latch(); const fail = latch(); let inject = false
  const wrapped = new Proxy(db, { get(target, prop) {
    if (prop === '$transaction') return (...args: unknown[]) => {
      if (inject) { inject = false; return Promise.reject(new Error('settlement unavailable')) }
      return (target.$transaction as (...values: unknown[]) => Promise<unknown>)(...args)
    }
    return Reflect.get(target, prop, target)
  } }) as PrismaClient
  const stack = runtime()
  stack.provision = vi.fn(async (_p, tarball, _ports, persist) => {
    if (tarball.equals(bundleA)) { entered.release(); await fail.promise; inject = true; throw new Error('import failed') }
    await persist({ ANON_KEY: 'new-ready', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
  })
  const tunnel = fakeTunnel()
  const service = createPreviewService(wrapped, stack, { tunnel })
  const a = await service.ensure(identity('wrong-owner'), bundleA)
  await entered.promise
  const b = await service.ensure(identity('wrong-owner'), bundleB)
  expect(b.id).not.toBe(a.id)
  fail.release()
  await service.idle()
  expect((await db.operation.findUniqueOrThrow({ where: { id: b.id } })).state).toBe('ready')
  // The ready attempt owns the status write (53c1fac: left 'provisioning').
  expect((await db.project.findUniqueOrThrow({ where: { id: b.projectId } })).status).toBe('active')
  const again = await service.ensure(identity('wrong-owner'), bundleB)
  // Same-hash lookup returns the owning attempt and the late settlement of
  // the older one cannot flip the project to failed.
  // (53c1fac: returns a.id and flips the status to 'failed'.)
  expect(again.id).toBe(b.id)
  expect((await db.project.findUniqueOrThrow({ where: { id: b.projectId } })).status).toBe('active')
  expect(tunnel.routes()).toHaveLength(1)
  await service.destroy('acme/app', b.id)
})

it('startup recovery does not fail a project whose owner moved on (T20 review 6)', async () => {
  const owner = await db.user.findUniqueOrThrow({ where: { email: PREVIEW_OWNER_EMAIL } })
  const project = await db.project.create({ data: { ...identity('recover-owner'), name: 'owner', slug: 'recover-owner',
    ownerId: owner.id, environmentType: 'preview', status: 'active', currentOperationId: 'op-current',
    operations: { create: [
      { id: 'op-old', kind: PREVIEW_OPERATION_KIND, state: 'provisioning' },
      { id: 'op-current', kind: PREVIEW_OPERATION_KIND, state: 'ready' },
    ] } } })
  const service = createPreviewService(db, runtime(), { tunnel: fakeTunnel() })
  expect(await service.start()).toBe(1)
  expect(await db.operation.findUniqueOrThrow({ where: { id: 'op-old' } })).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
  // Recovery may only fail a project the interrupted attempt owned.
  // (53c1fac: marks every project with a failed operation 'failed'.)
  expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('active')
  await service.destroy('acme/app', 'op-current')
})

it('an invalid replacement never tears down a healthy preview (T20 review 9)', async () => {
  const marker = path.join(directory, 'invalid-replacement-stack')
  const tunnel = fakeTunnel()
  const stack: PreviewRuntime = {
    provision: vi.fn(async (_p, _t, _ports, persist) => {
      await persist({ ANON_KEY: 'healthy-anon', SUPABASE_PUBLIC_URL: 'https://preview.example.invalid' })
      await fs.writeFile(marker, 'stack')
    }),
    destroy: vi.fn(async () => { await fs.rm(marker, { force: true }) }),
  }
  const service = createPreviewService(db, stack, { tunnel })
  const first = await service.ensure(identity('invalid-replacement'), bundle('select 1;'))
  await service.idle()
  expect(await fs.access(marker).then(() => true, () => false)).toBe(true)
  // Garbage and migration-free bundles have no validated contents...
  const broken = await service.ensure(identity('invalid-replacement'), Buffer.from('invalid-one'))
  const empty = await service.ensure(identity('invalid-replacement'), buildTarball([{ name: 'supabase/seed.sql', body: 'insert into a;' }]))
  await service.idle()
  // ...so they record failed operations and leave the live stack, route and
  // recorded hash untouched (53c1fac: each one tore the healthy stack down).
  expect(broken.id).not.toBe(first.id)
  expect(empty.id).not.toBe(first.id)
  expect(await service.status('acme/app', broken.id)).toMatchObject({ state: 'failed' })
  expect(await service.status('acme/app', empty.id)).toMatchObject({ state: 'failed' })
  expect(stack.destroy).not.toHaveBeenCalled()
  expect(await fs.access(marker).then(() => true, () => false)).toBe(true)
  expect(tunnel.routes()).toHaveLength(1)
  expect(await service.status('acme/app', first.id)).toMatchObject({ state: 'ready', anonKey: 'healthy-anon' })
  await service.destroy('acme/app', first.id)
  expect(stack.destroy).toHaveBeenCalledTimes(1)
  expect(await fs.access(marker).then(() => true, () => false)).toBe(false)
})

it('a pre-upgrade preview with no recorded hash rebuilds exactly once (T20 P3)', async () => {
  const stack = runtime()
  const service = createPreviewService(db, stack, { tunnel: fakeTunnel() })
  const healthy = bundle('select 1;')
  const first = await service.ensure(identity('null-hash'), healthy)
  await service.idle()
  // Simulate a row provisioned before the T20 migration: the old bundle's
  // content is unknown, so the incoming hash is never silently adopted.
  await db.project.update({ where: { id: first.projectId }, data: { bundleHash: null } })
  const rebuilt = await service.ensure(identity('null-hash'), healthy)
  expect(rebuilt.id).not.toBe(first.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(2)
  const again = await service.ensure(identity('null-hash'), healthy)
  expect(again.id).toBe(rebuilt.id)
  await service.idle()
  expect(stack.provision).toHaveBeenCalledTimes(2)
  await service.destroy('acme/app', rebuilt.id)
})
