import { NextRequest, NextResponse } from 'next/server'
import { revokePreviewToken } from '@/lib/preview-tokens'
import { validateSession } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

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

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await requireSession(request)
  if (!auth.ok) return auth.response

  const { id } = await params
  const revoked = await revokePreviewToken(id)
  if (!revoked) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({
    id: revoked.id,
    name: revoked.name,
    repository: revoked.repository,
    createdAt: revoked.createdAt,
    revokedAt: revoked.revokedAt,
    expiresAt: revoked.expiresAt,
  })
}
