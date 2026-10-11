import { NextRequest, NextResponse } from 'next/server'
import { issuePreviewToken, listPreviewTokens, normalizeRepository } from '@/lib/preview-tokens'
import { validateSession } from '@/lib/auth'

async function requireSession(request: NextRequest) {
  const cookieToken = request.cookies.get('session')?.value
  const session = cookieToken ? await validateSession(cookieToken) : null
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  return { ok: true as const }
}

export async function POST(request: NextRequest) {
  const auth = await requireSession(request)
  if (!auth.ok) return auth.response

  let payload: { name?: unknown; repository?: unknown; expiresAt?: unknown }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const repository = typeof payload.repository === 'string' ? normalizeRepository(payload.repository) : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!repository) {
    return NextResponse.json({ error: 'repository is required' }, { status: 400 })
  }

  let expiresAt: Date | null = null
  if (payload.expiresAt !== undefined && payload.expiresAt !== null) {
    if (typeof payload.expiresAt !== 'string') {
      return NextResponse.json({ error: 'expiresAt must be ISO 8601 string' }, { status: 400 })
    }
    const parsed = new Date(payload.expiresAt)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'expiresAt must be ISO 8601 string' }, { status: 400 })
    }
    expiresAt = parsed
  }

  const issued = await issuePreviewToken({ name, repository, expiresAt })
  return NextResponse.json({
    id: issued.id,
    name: issued.name,
    repository: issued.repository,
    createdAt: issued.createdAt,
    revokedAt: issued.revokedAt,
    expiresAt: issued.expiresAt,
    token: issued.token,
  }, { status: 201 })
}

export async function GET(request: NextRequest) {
  const auth = await requireSession(request)
  if (!auth.ok) return auth.response

  const rawRepository = request.nextUrl.searchParams.get('repository')
  const repository = rawRepository ? normalizeRepository(rawRepository) : undefined
  const rows = await listPreviewTokens(repository)
  return NextResponse.json({
    tokens: rows.map((row) => ({
      id: row.id,
      name: row.name,
      repository: row.repository,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
    })),
  })
}
