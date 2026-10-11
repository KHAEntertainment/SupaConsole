import { NextRequest, NextResponse } from 'next/server'
import { requirePreviewToken } from '@/lib/preview-auth'

export async function GET(request: NextRequest) {
  const repository = request.nextUrl.searchParams.get('repository')?.trim() ?? ''
  const auth = await requirePreviewToken(request, repository)
  if (!auth.ok) return auth.response
  return NextResponse.json({
    ok: true,
    repository: auth.token.repository,
    tokenId: auth.token.id,
  })
}
