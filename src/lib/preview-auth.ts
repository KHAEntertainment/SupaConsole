import { NextRequest, NextResponse } from 'next/server'
import {
  extractBearerToken,
  normalizeRepository,
  verifyPreviewToken,
  type PreviewTokenRecord,
} from './preview-tokens'

export type RequirePreviewTokenResult =
  | { ok: true; token: PreviewTokenRecord }
  | { ok: false; response: NextResponse }

export async function requirePreviewToken(
  request: NextRequest,
  repository: string,
): Promise<RequirePreviewTokenResult> {
  const normalizedRepository = normalizeRepository(repository)
  if (!normalizedRepository) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'repository required' }, { status: 400 }),
    }
  }

  const header = request.headers.get('authorization')
  const presented = extractBearerToken(header)
  if (!presented) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'missing token' }, { status: 401 }),
    }
  }

  const record = await verifyPreviewToken(presented, normalizedRepository)
  if (!record) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid token' }, { status: 401 }),
    }
  }

  return { ok: true, token: record }
}
