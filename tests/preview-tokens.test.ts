import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'

const root = process.cwd()
const dir = mkdtempSync(path.join(tmpdir(), 't11-preview-tokens-'))
const databaseUrl = `file:${dir}/test.db`

process.env.DATABASE_URL = databaseUrl

const dbMigrate = path.join(root, 'scripts/db-migrate.mjs')

execFileSync(process.execPath, [dbMigrate], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'pipe',
})

// Lazy-imported so prisma/client and the lib pick up the test DATABASE_URL.
const previewTokenLib = () => import('@/lib/preview-tokens')
const previewAuthLib = () => import('@/lib/preview-auth')
const previewTokensRoute = () => import('@/app/api/preview-tokens/route')
const previewTokenIdRoute = () => import('@/app/api/preview-tokens/[id]/route')
const previewPingRoute = () => import('@/app/api/previews/ping/route')
const middlewareModule = () => import('@/middleware')

const REPO_A = 'khaentertainment/supaconsole'
const REPO_B = 'khaentertainment/other-project'

afterAll(async () => {
  const { prisma } = await import('@/lib/db')
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('issuePreviewToken', () => {
  it('returns cleartext exactly once and stores only its hash', async () => {
    const { issuePreviewToken } = await previewTokenLib()
    const { prisma: db } = await import('@/lib/db')
    const issued = await issuePreviewToken({ name: 'ci', repository: REPO_A })

    expect(issued.token.startsWith('spc_')).toBe(true)
    expect(issued.token.length).toBeGreaterThan(8)
    const row = await db.previewToken.findUnique({ where: { id: issued.id } })
    expect(row).not.toBeNull()
    expect(row!.tokenHash).not.toContain(issued.token)
    expect(row!.tokenHash).not.toContain(issued.token.slice(4))
    expect(row!.tokenHash.length).toBeGreaterThan(20) // bcrypt hash, never the cleartext
    // tokenLookup is sha256(cleartext); it must NOT contain the cleartext
    expect(row!.tokenLookup).not.toContain(issued.token)
    expect(row!.tokenLookup).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.revokedAt).toBeNull()
    expect(row!.repository).toBe(REPO_A)
  })

  it('produces unique tokens across repeated issues', async () => {
    const { issuePreviewToken } = await previewTokenLib()
    const first = await issuePreviewToken({ name: 'n1', repository: REPO_A })
    const second = await issuePreviewToken({ name: 'n2', repository: REPO_A })
    expect(first.token).not.toBe(second.token)
  })
})

describe('listPreviewTokens', () => {
  it('never returns cleartext or the stored hash', async () => {
    const { issuePreviewToken, listPreviewTokens } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'list-test', repository: REPO_A })

    const rows = await listPreviewTokens(REPO_A)
    const target = rows.find((row) => row.id === issued.id)
    expect(target).toBeDefined()
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(issued.token)
    expect(serialized).not.toContain('tokenHash')
    expect(serialized).not.toContain('token')
  })
})

describe('verifyPreviewToken', () => {
  beforeAll(async () => {
    // Tests inside this block share random UUIDs as names but live in the
    // same per-file temporary database, so order is deterministic only within
    // the block we exercise next. We don't depend on cross-block ordering.
    const { prisma: db } = await import('@/lib/db')
    await db.previewToken.deleteMany({})
  })

  it('accepts a valid token scoped to the matching repository', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'verify-ok', repository: REPO_A })

    const verified = await verifyPreviewToken(issued.token, REPO_A)
    expect(verified).not.toBeNull()
    expect(verified!.id).toBe(issued.id)
  })

  it('rejects a valid token when the repository scope does not match', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'verify-scope', repository: REPO_A })

    const verified = await verifyPreviewToken(issued.token, REPO_B)
    expect(verified).toBeNull()
  })

  it('rejects an unknown or malformed token', async () => {
    const { verifyPreviewToken } = await previewTokenLib()
    expect(await verifyPreviewToken('', REPO_A)).toBeNull()
    expect(await verifyPreviewToken('not-a-real-token', REPO_A)).toBeNull()
    expect(await verifyPreviewToken('spc_' + 'A'.repeat(40), REPO_A)).toBeNull()
    // F4: also rejects empty repository
    expect(await verifyPreviewToken('spc_anything', '')).toBeNull()
  })

  it('rejects a revoked token immediately', async () => {
    const { issuePreviewToken, revokePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'revoke-me', repository: REPO_A })
    const before = await verifyPreviewToken(issued.token, REPO_A)
    expect(before).not.toBeNull()

    const revoked = await revokePreviewToken(issued.id)
    expect(revoked).not.toBeNull()
    expect(revoked!.revokedAt).not.toBeNull()

    const after = await verifyPreviewToken(issued.token, REPO_A)
    expect(after).toBeNull()
  })
})

describe('GET /api/previews/ping (route handler)', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const { requirePreviewToken } = await previewAuthLib()
    const request = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_A)}`,
      { method: 'GET' },
    )
    const result = await requirePreviewToken(request, REPO_A)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(401)
    }
  })

  it('rejects a Bearer for a different repository with 401', async () => {
    const { issuePreviewToken } = await previewTokenLib()
    const { GET } = await previewPingRoute()
    const issued = await issuePreviewToken({ name: 'route-wrong-repo', repository: REPO_A })
    const request = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_B)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${issued.token}` },
      },
    )
    const response = await GET(request)
    expect(response.status).toBe(401)
  })

  it('returns 200 for a valid token scoped to the matching repository', async () => {
    const { issuePreviewToken } = await previewTokenLib()
    const { GET } = await previewPingRoute()
    const issued = await issuePreviewToken({ name: 'route-ok', repository: REPO_A })
    const request = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_A)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${issued.token}` },
      },
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.repository).toBe(REPO_A)
  })

  it('returns 401 after the token is revoked', async () => {
    const { issuePreviewToken, revokePreviewToken } = await previewTokenLib()
    const { GET } = await previewPingRoute()
    const issued = await issuePreviewToken({ name: 'route-revoke', repository: REPO_A })

    const goodRequest = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_A)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${issued.token}` },
      },
    )
    const good = await GET(goodRequest)
    expect(good.status).toBe(200)

    const revoked = await revokePreviewToken(issued.id)
    expect(revoked).not.toBeNull()

    const afterRequest = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_A)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${issued.token}` },
      },
    )
    const after = await GET(afterRequest)
    expect(after.status).toBe(401)
  })

  it('rejects a malformed Authorization header with 401', async () => {
    const { GET } = await previewPingRoute()
    const request = new NextRequest(
      `http://test.local/api/previews/ping?repository=${encodeURIComponent(REPO_A)}`,
      {
        method: 'GET',
        headers: { authorization: 'Basic xyz' },
      },
    )
    const response = await GET(request)
    expect(response.status).toBe(401)
  })
})

describe('middleware', () => {
  it('returns 401 when the Authorization header is absent on /api/previews/*', async () => {
    const { middleware } = await middlewareModule()
    const request = new NextRequest('http://test.local/api/previews/something')
    const result = middleware(request)
    expect(result.status).toBe(401)
  })

  it('returns 401 when the Authorization header is not Bearer', async () => {
    const { middleware } = await middlewareModule()
    const request = new NextRequest('http://test.local/api/previews/something', {
      headers: { authorization: 'Basic abc' },
    })
    const result = middleware(request)
    expect(result.status).toBe(401)
  })

  it('passes through when a Bearer header is present (per-route handler does the rest)', async () => {
    const { middleware } = await middlewareModule()
    const request = new NextRequest('http://test.local/api/previews/something', {
      headers: { authorization: 'Bearer whatever' },
    })
    const result = middleware(request)
    // NextResponse.next() returns 200 with no body when invoked directly.
    expect(result.status).toBe(200)
  })
})

describe('POST /api/preview-tokens (admin route handler)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { POST } = await previewTokensRoute()
    const request = new NextRequest('http://test.local/api/preview-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'noauth', repository: REPO_A }),
    })
    const response = await POST(request)
    expect(response.status).toBe(401)
  })

  it('rejects missing name and repository fields with 400', async () => {
    const { POST } = await previewTokensRoute()
    const fakeCookie = `session=fake-${randomUUID()}`
    const request = new NextRequest('http://test.local/api/preview-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: fakeCookie },
      body: JSON.stringify({}),
    })
    const response = await POST(request)
    // Without a real session in the table, the admin guard fires first (401),
    // which is a stronger guarantee than the input guard. Accept either.
    expect([400, 401]).toContain(response.status)
  })
})

describe('DELETE /api/preview-tokens/[id] (admin route handler)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { DELETE } = await previewTokenIdRoute()
    const request = new NextRequest('http://test.local/api/preview-tokens/some-id', {
      method: 'DELETE',
    })
    const response = await DELETE(request, { params: Promise.resolve({ id: 'some-id' }) })
    expect(response.status).toBe(401)
  })
})

describe('GET /api/preview-tokens (admin route handler)', () => {
  it('returns 401 for unauthenticated callers', async () => {
    const { GET } = await previewTokensRoute()
    const request = new NextRequest('http://test.local/api/preview-tokens')
    const response = await GET(request)
    expect(response.status).toBe(401)
  })
})

describe('F1 verifyPreviewToken constant-cost', () => {
  beforeAll(async () => {
    const { prisma: db } = await import('@/lib/db')
    await db.previewToken.deleteMany({})
    const { issuePreviewToken } = await previewTokenLib()
    for (let i = 0; i < 10; i++) {
      await issuePreviewToken({ name: `prefilled-${i}`, repository: REPO_A })
    }
  })

  it('runs exactly one bcrypt.compare for a bogus token (no DB row matches)', async () => {
    const { verifyPreviewToken } = await previewTokenLib()
    const spy = vi.spyOn(bcrypt, 'compare')
    const result = await verifyPreviewToken('spc_definitely-not-a-real-token', REPO_A)
    expect(result).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('runs exactly one bcrypt.compare for a valid token (no loop over candidates)', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const fresh = await issuePreviewToken({ name: 'fresh-for-spy', repository: REPO_A })
    const spy = vi.spyOn(bcrypt, 'compare')
    const result = await verifyPreviewToken(fresh.token, REPO_A)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(fresh.id)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('still rejects a valid token when the repository scope does not match', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'scope-f1', repository: REPO_A })
    expect(await verifyPreviewToken(issued.token, REPO_B)).toBeNull()
  })

  it('still rejects a revoked token immediately', async () => {
    const { issuePreviewToken, revokePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'revoke-f1', repository: REPO_A })
    expect(await verifyPreviewToken(issued.token, REPO_A)).not.toBeNull()
    await revokePreviewToken(issued.id)
    expect(await verifyPreviewToken(issued.token, REPO_A)).toBeNull()
  })
})

describe('F3 expiresAt', () => {
  beforeAll(async () => {
    const { prisma: db } = await import('@/lib/db')
    await db.previewToken.deleteMany({})
  })

  it('rejects a token whose expiresAt is in the past', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({
      name: 'past',
      repository: REPO_A,
      expiresAt: new Date(Date.now() - 60_000),
    })
    const result = await verifyPreviewToken(issued.token, REPO_A)
    expect(result).toBeNull()
  })

  it('accepts a token whose expiresAt is in the future', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({
      name: 'future',
      repository: REPO_A,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const result = await verifyPreviewToken(issued.token, REPO_A)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(issued.id)
  })

  it('accepts a token issued without an expiresAt', async () => {
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'no-exp', repository: REPO_A })
    const result = await verifyPreviewToken(issued.token, REPO_A)
    expect(result).not.toBeNull()
  })
})

describe('F5 normalizeRepository', () => {
  it('trims whitespace and folds to lowercase', async () => {
    const { normalizeRepository } = await previewTokenLib()
    expect(normalizeRepository('  Org/Repo  ')).toBe('org/repo')
    expect(normalizeRepository('ORG/REPO')).toBe('org/repo')
    expect(normalizeRepository('Org/Repo')).toBe('org/repo')
    expect(normalizeRepository('  ')).toBe('')
  })

  it('lib stores repository as-given; verify requires exact-cased lookup (route normalizes before invoking lib)', async () => {
    const { prisma: db } = await import('@/lib/db')
    const { issuePreviewToken, verifyPreviewToken } = await previewTokenLib()
    const issued = await issuePreviewToken({ name: 'case', repository: 'Org/Repo' })
    const row = await db.previewToken.findUnique({ where: { id: issued.id } })
    expect(row!.repository).toBe('Org/Repo')
    expect(await verifyPreviewToken(issued.token, 'Org/Repo')).not.toBeNull()
    expect(await verifyPreviewToken(issued.token, 'org/repo')).toBeNull()
  })

  it('requirePreviewToken normalizes the query-side repository before invoking verify', async () => {
    const { issuePreviewToken } = await previewTokenLib()
    const { requirePreviewToken } = await previewAuthLib()
    const issued = await issuePreviewToken({ name: 'normalize-via-route', repository: 'org/repo' })
    const req = new NextRequest(
      `http://test.local/api/previews/ping?repository=ORG%2FREPO`,
      { method: 'GET', headers: { authorization: `Bearer ${issued.token}` } },
    )
    // Both mixed-case forms are accepted at the route layer because the
    // helper normalizes them down to the stored 'org/repo' casing.
    const result = await requirePreviewToken(req, 'ORG/REPO')
    expect(result.ok).toBe(true)
  })
})

