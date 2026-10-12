import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'

let directory: string
let db: import('@prisma/client').PrismaClient
let ownerEmail: string
let loginPost: typeof import('@/app/api/auth/login/route').POST
let registerPost: typeof import('@/app/api/auth/register/route').POST
let createPreviewRoutes: typeof import('@/lib/preview-routes').createPreviewRoutes
let issuePreviewToken: typeof import('@/lib/preview-tokens').issuePreviewToken
let requirePreviewToken: typeof import('@/lib/preview-auth').requirePreviewToken
let PreviewConflictError: typeof import('@/lib/previews').PreviewConflictError

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 't15-owner-auth-'))
  const datasourceUrl = `file:${directory}/test.db`
  process.env.DATABASE_URL = datasourceUrl
  delete process.env.ALLOW_REGISTRATION
  execFileSync(process.execPath, ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: datasourceUrl },
    stdio: 'pipe',
  })

  const [{ prisma }, loginRoute, registerRoute, routeLib, tokenLib, authLib, previewsLib] = await Promise.all([
    import('@/lib/db'),
    import('@/app/api/auth/login/route'),
    import('@/app/api/auth/register/route'),
    import('@/lib/preview-routes'),
    import('@/lib/preview-tokens'),
    import('@/lib/preview-auth'),
    import('@/lib/previews'),
  ])
  db = prisma
  ownerEmail = previewsLib.PREVIEW_OWNER_EMAIL
  loginPost = loginRoute.POST
  registerPost = registerRoute.POST
  createPreviewRoutes = routeLib.createPreviewRoutes
  issuePreviewToken = tokenLib.issuePreviewToken
  requirePreviewToken = authLib.requirePreviewToken
  PreviewConflictError = previewsLib.PreviewConflictError
})

beforeEach(async () => {
  await db.session.deleteMany()
  await db.previewToken.deleteMany()
  await db.user.deleteMany()
})

afterAll(async () => {
  await db?.$disconnect()
  await fs.rm(directory, { recursive: true, force: true })
})

it('denies login and session validation for the service owner even when its password is a valid bcrypt hash', async () => {
  const password = 'a-real-password-that-must-not-enable-login'
  const passwordHash = await bcrypt.hash(password, 4)
  const owner = await db.user.create({ data: { email: ownerEmail, name: 'Preview service', password: passwordHash } })
  expect(await bcrypt.compare(password, owner.password)).toBe(true)

  const login = await loginPost(new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password }),
  }))
  expect(login.status).toBe(401)
  expect(await login.json()).toEqual({ error: 'Invalid credentials' })
  expect(await db.session.count({ where: { userId: owner.id } })).toBe(0)

  const { createSession, validateSession } = await import('@/lib/auth')
  const token = await createSession(owner.id)
  expect(await validateSession(token)).toBeNull()
})

it('rejects registration of the reserved service-owner address without creating an account', async () => {
  const response = await registerPost(new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail.toUpperCase(), password: 'never-store-this' }),
  }))

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Email is reserved' })
  expect(await db.user.count()).toBe(0)
})

it('allows the first regular account when the only existing user is the service owner', async () => {
  await db.user.create({ data: { email: ownerEmail, name: 'Preview service', password: '!disabled-preview-service' } })

  const response = await registerPost(new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'First.User@Example.com', password: 'correct-horse-battery', name: 'First User' }),
  }))

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ user: { email: 'first.user@example.com', name: 'First User' } })
  expect(await db.user.count({ where: { email: { not: ownerEmail } } })).toBe(1)
  expect(await db.user.count()).toBe(2)
})

it('authenticates preview API requests against token repository scope and maps service/input failures', async () => {
  const issued = await issuePreviewToken({ name: 'route-test', repository: 'acme/app' })
  const service = {
    ensure: vi.fn(async () => ({ id: 'operation-1', state: 'queued' })),
    status: vi.fn(async (repository: string) => repository === 'acme/app' ? { operationId: 'operation-1', state: 'ready' } : null),
    destroy: vi.fn(async () => true),
  }
  const routes = createPreviewRoutes(() => service as never, requirePreviewToken)
  const authHeader = { authorization: `Bearer ${issued.token}` }
  const formRequest = (repository = 'ACME/App') => {
    const form = new FormData()
    form.set('tarball', new Blob(['bundle']), 'bundle.tar.gz')
    const query = new URLSearchParams({ repository, branch: 'main' })
    return new NextRequest(`http://localhost/api/previews/ensure?${query}`, { method: 'POST', headers: authHeader, body: form })
  }

  const accepted = await routes.ensure(formRequest())
  expect(accepted.status).toBe(202)
  expect(await accepted.json()).toEqual({ operationId: 'operation-1', state: 'queued' })
  expect(service.ensure).toHaveBeenCalledTimes(1)

  expect((await routes.ensure(formRequest('other/repo'))).status).toBe(401)
  expect(service.ensure).toHaveBeenCalledTimes(1)
  expect((await routes.ensure(new NextRequest('http://localhost/api/previews/ensure?repository=acme%2Fapp&branch=main', {
    method: 'POST', headers: authHeader, body: JSON.stringify({ repository: 'acme/app' }),
  }))).status).toBe(400)

  const noRepository = new NextRequest('http://localhost/api/previews/status?operationId=operation-1', { headers: authHeader })
  expect((await routes.status(noRepository)).status).toBe(400)

  const wrongScopeStatus = await routes.status(new NextRequest('http://localhost/api/previews/status?repository=other%2Frepo&operationId=operation-1', {
    headers: { authorization: `Bearer ${issued.token}` },
  }))
  expect(wrongScopeStatus.status).toBe(401)
  expect(service.status).not.toHaveBeenCalled()

  const scopedStatus = await routes.status(new NextRequest('http://localhost/api/previews/status?repository=acme%2Fapp&operationId=operation-1', {
    headers: authHeader,
  }))
  expect(scopedStatus.status).toBe(200)
  expect(service.status).toHaveBeenCalledWith('acme/app', 'operation-1')

  expect((await routes.destroy(new NextRequest('http://localhost/api/previews/destroy?repository=acme%2Fapp', {
    method: 'POST', headers: authHeader, body: '{invalid json',
  }))).status).toBe(400)
  const destroyed = await routes.destroy(new NextRequest('http://localhost/api/previews/destroy?repository=ACME%2FApp', {
    method: 'POST', headers: authHeader, body: JSON.stringify({ operationId: 'operation-1' }),
  }))
  expect(destroyed.status).toBe(200)
  expect(service.destroy).toHaveBeenCalledWith('acme/app', 'operation-1')

  service.ensure.mockRejectedValueOnce(new PreviewConflictError('Identity already exists'))
  expect((await routes.ensure(formRequest())).status).toBe(409)
  service.ensure.mockRejectedValueOnce(new Error('database details'))
  const failed = await routes.ensure(formRequest())
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'Preview request failed' })
})
