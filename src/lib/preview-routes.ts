import { NextRequest, NextResponse } from 'next/server'
import { requirePreviewToken } from './preview-auth'
import { normalizePreviewIdentity, normalizeRepository } from './preview-identity'
import { PreviewConflictError, type PreviewService } from './previews'
import { extractBearerToken } from './preview-tokens'

class InvalidPreviewRequest extends Error {}
class PreviewUploadTooLarge extends Error {}
export const MAX_PREVIEW_TARBALL_BYTES = 64 * 1024 * 1024
export const MAX_PREVIEW_REQUEST_BYTES = MAX_PREVIEW_TARBALL_BYTES + 1024 * 1024
export const MAX_PREVIEW_DESTROY_BYTES = 4096

async function boundedBody(request: NextRequest, limit: number): Promise<Buffer<ArrayBuffer>> {
  const length = request.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new PreviewUploadTooLarge()
  if (!request.body) throw new InvalidPreviewRequest()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw new PreviewUploadTooLarge()
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
async function boundedFormData(request: NextRequest) {
  return new Response(await boundedBody(request, MAX_PREVIEW_REQUEST_BYTES), { headers: { 'content-type': request.headers.get('content-type') ?? '' } })
    .formData().catch(() => { throw new InvalidPreviewRequest() })
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidPreviewRequest()
  return value
}
function failure(error: unknown) {
  const status = error instanceof PreviewUploadTooLarge ? 413 : error instanceof InvalidPreviewRequest ? 400 : error instanceof PreviewConflictError ? 409 : 500
  return NextResponse.json({ error: status === 413 ? 'Preview upload too large' : status === 400 ? 'Invalid preview request' : error instanceof PreviewConflictError ? error.message : 'Preview request failed' }, { status })
}

export function createPreviewRoutes(service: () => PreviewService, authenticate = requirePreviewToken) {
  return {
    async ensure(request: NextRequest) {
      try {
        if (!extractBearerToken(request.headers.get('authorization'))) return NextResponse.json({ error: 'missing token' }, { status: 401 })
        const query = request.nextUrl.searchParams
        const repository = normalizeRepository(query.get('repository'))
        if (!repository) throw new InvalidPreviewRequest()
        const auth = await authenticate(request, repository)
        if (!auth.ok) return auth.response
        const branch = text(query.get('branch'))
        const pr = query.get('pullRequestNumber')
        if (pr !== null && (typeof pr !== 'string' || !/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) throw new InvalidPreviewRequest()
        let identity
        try {
          identity = normalizePreviewIdentity({ repository, branch, pullRequestNumber: pr === null ? null : Number(pr),
            prTitle: query.get('prTitle'), prAuthor: query.get('prAuthor') })
        } catch { throw new InvalidPreviewRequest() }
        const bundle = (await boundedFormData(request)).get('tarball')
        if (!(bundle instanceof Blob) || bundle.size === 0) throw new InvalidPreviewRequest()
        if (bundle.size > MAX_PREVIEW_TARBALL_BYTES) throw new PreviewUploadTooLarge()
        const operation = await service().ensure(identity, Buffer.from(await bundle.arrayBuffer()))
        return NextResponse.json({ operationId: operation.id, state: operation.state }, { status: 202 })
      } catch (error) { return failure(error) }
    },
    async status(request: NextRequest) {
      try {
        const repository = normalizeRepository(request.nextUrl.searchParams.get('repository'))
        const operationId = request.nextUrl.searchParams.get('operationId')
        if (!repository || !operationId) throw new InvalidPreviewRequest()
        const auth = await authenticate(request, repository)
        if (!auth.ok) return auth.response
        const result = await service().status(repository, operationId)
        return NextResponse.json(result ?? { error: 'Preview not found' }, { status: result ? 200 : 404 })
      } catch (error) { return failure(error) }
    },
    async destroy(request: NextRequest) {
      try {
        if (!extractBearerToken(request.headers.get('authorization'))) return NextResponse.json({ error: 'missing token' }, { status: 401 })
        const repository = normalizeRepository(request.nextUrl.searchParams.get('repository'))
        if (!repository) throw new InvalidPreviewRequest()
        const auth = await authenticate(request, repository)
        if (!auth.ok) return auth.response
        let body
        try { body = JSON.parse((await boundedBody(request, MAX_PREVIEW_DESTROY_BYTES)).toString('utf8')) } catch (error) {
          if (error instanceof PreviewUploadTooLarge) throw error
          throw new InvalidPreviewRequest()
        }
        if (!body || typeof body !== 'object') throw new InvalidPreviewRequest()
        const operationId = text(body.operationId)
        if (!operationId) throw new InvalidPreviewRequest()
        await service().destroy(repository, operationId)
        return NextResponse.json({ destroyed: true })
      } catch (error) { return failure(error) }
    },
  }
}
