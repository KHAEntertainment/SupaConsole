import { NextRequest, NextResponse } from 'next/server'
import { expect, it, vi } from 'vitest'
import { createPreviewRoutes, MAX_PREVIEW_DESTROY_BYTES, MAX_PREVIEW_REQUEST_BYTES, MAX_PREVIEW_TARBALL_BYTES } from '@/lib/preview-routes'
import type { PreviewService } from '@/lib/previews'

const auth = vi.fn(async (request: NextRequest, repository: string) => {
  if (request.headers.get('authorization') === 'Bearer valid' && repository === 'acme/app') {
    return { ok: true as const, token: { id: 'token', name: 'test', repository, createdAt: new Date(), revokedAt: null, expiresAt: null } }
  }
  return { ok: false as const, response: NextResponse.json({ error: 'invalid token' }, { status: 401 }) }
})
const service = {
  ensure: vi.fn(async () => ({ id: 'operation-1', state: 'queued' })),
  status: vi.fn(async () => null),
  destroy: vi.fn(async () => true),
} as unknown as PreviewService
const routes = createPreviewRoutes(() => service, auth)

function endlessRequest(path: string, contentLength?: string, authorization: string | null = 'Bearer valid', chunkSize = 1024 * 1024) {
  const tracker = { bytesRead: 0, pulls: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      tracker.pulls++
      const chunk = new Uint8Array(chunkSize)
      tracker.bytesRead += chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() { tracker.cancelled = true },
  }, { highWaterMark: 0 })
  const headers = new Headers({
    'content-type': 'multipart/form-data; boundary=not-parsed',
    ...(authorization === null ? {} : { authorization }),
  })
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  const request = new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers, body, duplex: 'half',
  } as ConstructorParameters<typeof NextRequest>[1])
  return { request, tracker }
}

function multipartFileRequest(fileBytes: number) {
  const boundary = 'preview-test-boundary'
  const prefix = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="bundle.tar.gz"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ].join(''))
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([prefix, Buffer.alloc(fileBytes), suffix])
  return new NextRequest('http://localhost/api/previews/ensure?repository=acme%2Fapp&branch=main', {
    method: 'POST',
    headers: { authorization: 'Bearer valid', 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
}

it('rejects missing bearer authorization without reading the upload stream', async () => {
  auth.mockClear()
  vi.mocked(service.ensure).mockClear()
  const { request, tracker } = endlessRequest('/api/previews/ensure?repository=acme%2Fapp&branch=main', undefined, null)

  const response = await routes.ensure(request)

  expect(response.status).toBe(401)
  expect(tracker.pulls).toBe(0)
  expect(tracker.cancelled).toBe(false)
  expect(auth).not.toHaveBeenCalled()
  expect(service.ensure).not.toHaveBeenCalled()
})

it.each([
  ['without Content-Length', undefined],
  ['with a forged small Content-Length', '1'],
])('cancels streamed oversize input %s before consuming unbounded data', async (_label, contentLength) => {
  auth.mockClear()
  vi.mocked(service.ensure).mockClear()
  const { request, tracker } = endlessRequest('/api/previews/ensure?repository=acme%2Fapp&branch=main', contentLength)

  const response = await routes.ensure(request)

  expect(response.status).toBe(413)
  expect(tracker.cancelled).toBe(true)
  expect(tracker.bytesRead).toBeGreaterThan(MAX_PREVIEW_REQUEST_BYTES)
  expect(tracker.bytesRead).toBeLessThanOrEqual(MAX_PREVIEW_REQUEST_BYTES + 1024 * 1024)
  expect(auth).toHaveBeenCalledTimes(1)
  expect(service.ensure).not.toHaveBeenCalled()
})

it('rejects a declared request above the request cap before reading its body', async () => {
  auth.mockClear()
  vi.mocked(service.ensure).mockClear()
  const { request, tracker } = endlessRequest('/api/previews/ensure?repository=acme%2Fapp&branch=main', String(MAX_PREVIEW_REQUEST_BYTES + 1))

  const response = await routes.ensure(request)

  expect(response.status).toBe(413)
  expect(tracker.pulls).toBe(0)
  expect(auth).toHaveBeenCalledTimes(1)
  expect(service.ensure).not.toHaveBeenCalled()
})

it('enforces the 64 MiB tarball cap even when the complete request is within its 65 MiB cap', async () => {
  auth.mockClear()
  vi.mocked(service.ensure).mockClear()
  const response = await routes.ensure(multipartFileRequest(MAX_PREVIEW_TARBALL_BYTES + 1))

  expect(response.status).toBe(413)
  expect(auth).toHaveBeenCalledTimes(1)
  expect(service.ensure).not.toHaveBeenCalled()
})

it.each([
  ['ensure', '/api/previews/ensure?repository=acme%2Fapp&branch=main', 'Bearer invalid'],
  ['ensure wrong repository scope', '/api/previews/ensure?repository=other%2Fapp&branch=main', 'Bearer valid'],
  ['destroy', '/api/previews/destroy?repository=acme%2Fapp', 'Bearer invalid'],
  ['destroy wrong repository scope', '/api/previews/destroy?repository=other%2Fapp', 'Bearer valid'],
])('%s rejects authorization before consuming a streamed body', async (_label, path, authorization) => {
  auth.mockClear()
  vi.mocked(service.ensure).mockClear()
  vi.mocked(service.destroy).mockClear()
  const { request, tracker } = endlessRequest(path, undefined, authorization)
  const response = path.includes('/destroy') ? await routes.destroy(request) : await routes.ensure(request)

  expect(response.status).toBe(401)
  expect(tracker.pulls).toBe(0)
  expect(tracker.cancelled).toBe(false)
  expect(auth).toHaveBeenCalledTimes(1)
  expect(service.ensure).not.toHaveBeenCalled()
  expect(service.destroy).not.toHaveBeenCalled()
})

it('caps authenticated destroy JSON and cancels streamed bodies above 4 KiB', async () => {
  auth.mockClear()
  vi.mocked(service.destroy).mockClear()
  const { request, tracker } = endlessRequest('/api/previews/destroy?repository=acme%2Fapp', undefined, 'Bearer valid', 1024)

  const response = await routes.destroy(request)

  expect(response.status).toBe(413)
  expect(tracker.cancelled).toBe(true)
  expect(tracker.bytesRead).toBeGreaterThan(MAX_PREVIEW_DESTROY_BYTES)
  expect(tracker.bytesRead).toBeLessThanOrEqual(MAX_PREVIEW_DESTROY_BYTES + 1024)
  expect(auth).toHaveBeenCalledTimes(1)
  expect(service.destroy).not.toHaveBeenCalled()
})
