import { describe, expect, it, vi } from 'vitest'
import { CloudflareTunnel, previewHostname, type IngressRule, type TunnelConfig } from '@/lib/tunnel'

const ACCOUNT = '168f08e70d05c06f709a477981aec081'
const TUNNEL = '922a109d-fac1-45e0-b80b-5dbd6a2a0cc6'
const TOKEN = 'synthetic-cf-token-do-not-leak'
const DOMAIN = 'vpszone.xyz'

interface Backend {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  getCurrent: () => TunnelConfig
  getCalls: () => Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }>
  recordCall: (input: RequestInfo | URL, init?: RequestInit) => void
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function createBackend(initial: TunnelConfig, delayMs = 0): Backend {
  let current = clone(initial)
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = []
  function recordCall(input: RequestInfo | URL, init?: RequestInit): void {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers
      if (h instanceof Headers) {
        h.forEach((value, key) => { headers[key] = value })
      } else if (Array.isArray(h)) {
        for (const [key, value] of h) headers[key] = value
      } else {
        Object.assign(headers, h)
      }
    }
    const body = typeof init?.body === 'string' ? init.body : null
    calls.push({ method, url, headers, body })
  }
  const defaultImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    recordCall(input, init)
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      // Mirror the real Cloudflare GET response: result.config is the inner
      // config object (no nested `config` key). PUT stores the wrapped body.
      return new Response(JSON.stringify({ success: true, errors: [], messages: [],
        result: { tunnel_id: TUNNEL, version: 1, config: current.config } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'PUT') {
      current = JSON.parse(init!.body as string) as TunnelConfig
      return new Response(JSON.stringify({ success: true, errors: [], messages: [],
        result: { tunnel_id: TUNNEL, version: 2, config: current.config } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('method not allowed', { status: 405 })
  }
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(defaultImpl)
  return {
    fetch: fetchImpl,
    getCurrent: () => clone(current),
    getCalls: () => calls.slice(),
    recordCall,
  }
}

function makeClient(backend: Backend): CloudflareTunnel {
  return new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, domain: DOMAIN,
    fetch: backend.fetch as unknown as typeof fetch })
}

describe('previewHostname', () => {
  it('joins slug and domain', () => {
    expect(previewHostname('preview-foo', 'vpszone.xyz')).toBe('preview-foo.vpszone.xyz')
  })
  it('lowercases both sides', () => {
    expect(previewHostname('Preview-Foo', 'VPSZONE.XYZ')).toBe('preview-foo.vpszone.xyz')
  })
  it('rejects an invalid slug', () => {
    expect(() => previewHostname('a.b', 'vpszone.xyz')).toThrow()
    expect(() => previewHostname('a b', 'vpszone.xyz')).toThrow()
    expect(() => previewHostname('', 'vpszone.xyz')).toThrow()
    expect(() => previewHostname('-leading', 'vpszone.xyz')).toThrow()
    expect(() => previewHostname('trailing-', 'vpszone.xyz')).toThrow()
  })
  it('rejects an invalid domain', () => {
    expect(() => previewHostname('preview-foo', '')).toThrow()
    expect(() => previewHostname('preview-foo', 'bad..domain')).toThrow()
  })
})

describe('CloudflareTunnel', () => {
  it('throws when required configuration is absent', async () => {
    const emptyFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response()) as unknown as typeof fetch
    expect(() => new CloudflareTunnel({ apiToken: TOKEN, domain: DOMAIN, fetch: emptyFetch })).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
    expect(() => new CloudflareTunnel({ account: ACCOUNT, apiToken: TOKEN, domain: DOMAIN, fetch: emptyFetch })).toThrow(/CLOUDFLARE_TUNNEL_ID/)
    expect(() => new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, domain: DOMAIN, fetch: emptyFetch })).toThrow(/CLOUDFLARE_PREVIEW_API_TOKEN/)
    expect(() => new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, fetch: emptyFetch })).toThrow(/PREVIEW_DOMAIN/)
  })

  it('lowercases the configured domain (env case-insensitive)', async () => {
    const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
    const backend = createBackend(initial)
    const client = new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN,
      domain: 'VPSZONE.XYZ', fetch: backend.fetch as unknown as typeof fetch })
    expect(client.domain).toBe('vpszone.xyz')
    await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100')
    expect(backend.getCurrent().config.ingress).toEqual([
      { hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' },
      { service: 'http_status:404' },
    ])
  })

  it('hits the expected endpoint and carries the bearer token', async () => {
    const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
    const backend = createBackend(initial)
    const client = makeClient(backend)
    const config = await client.getConfig()
    expect(config).toEqual(initial)
    expect(backend.fetch).toHaveBeenCalledTimes(1)
    const call = backend.getCalls()[0]
    expect(call.method).toBe('GET')
    expect(call.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`)
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  describe('addPreviewRoute', () => {
    it('inserts immediately before the catch-all and preserves foreign rules byte-for-byte', async () => {
      const foreign1: IngressRule = { service: 'http://legacy.internal:9000' }
      const foreign2: IngressRule = { hostname: 'other.example.com', service: 'https://other.example.com',
        originRequest: { httpHostHeader: 'other.example.com', connectTimeout: 30 } }
      const catchall: IngressRule = { service: 'http_status:404' }
      // The real Cloudflare config uses hyphenated `warp-routing` plus a
      // top-level originRequest default; both must round-trip byte-for-byte.
      const initial: TunnelConfig = { config: {
        ingress: [foreign1, foreign2, catchall],
        'warp-routing': { enabled: false },
        originRequest: { connectTimeout: 30 },
      } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100')

      const current = backend.getCurrent()
      expect(current.config).toEqual({
        ingress: [
          foreign1,
          foreign2,
          { hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' },
          catchall,
        ],
        'warp-routing': { enabled: false },
        originRequest: { connectTimeout: 30 },
      })
      // foreign1, foreign2, catchall must round-trip unchanged.
      expect(current.config.ingress[0]).toEqual(foreign1)
      expect(current.config.ingress[1]).toEqual(foreign2)
      expect(current.config.ingress[3]).toEqual(catchall)
      expect(current.config['warp-routing']).toEqual({ enabled: false })
      expect(current.config.originRequest).toEqual({ connectTimeout: 30 })

      // The PUT body must contain the same ingress order.
      const putCalls = backend.getCalls().filter(c => c.method === 'PUT')
      expect(putCalls).toHaveLength(1)
      const putBody = JSON.parse(putCalls[0].body!) as TunnelConfig
      expect(putBody.config.ingress).toHaveLength(4)
      expect(putBody.config.ingress[2]).toEqual({ hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' })
      expect(putBody.config.ingress[3]).toEqual(catchall)
    })

    it('is idempotent: re-adding the same hostname yields exactly one rule', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100')
      await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100')
      await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28200')

      const ingress = backend.getCurrent().config.ingress
      expect(ingress).toHaveLength(2)
      expect(ingress.filter(r => r.hostname === 'preview-foo.vpszone.xyz')).toEqual([
        { hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28200' },
      ])
      expect(ingress[ingress.length - 1]).toEqual({ service: 'http_status:404' })
    })

    it('keeps foreign rules (non-matching domain) untouched across add', async () => {
      const foreign: IngressRule = { hostname: 'unrelated.example.net', service: 'http://10.0.0.1:8000' }
      const initial: TunnelConfig = { config: { ingress: [foreign, { service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100')

      const ingress = backend.getCurrent().config.ingress
      expect(ingress[0]).toEqual(foreign)
      expect(ingress[1]).toEqual({ hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' })
      expect(ingress[2]).toEqual({ service: 'http_status:404' })
    })

    it('lowercases the hostname parameter before insertion', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await client.addPreviewRoute('Preview-Foo.VPSZONE.XYZ', 'http://127.0.0.1:28100')
      const ingress = backend.getCurrent().config.ingress
      expect(ingress.find(r => r.hostname)).toEqual({ hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' })
    })

    it('throws when the ingress is empty (no catch-all to insert before)', async () => {
      const initial: TunnelConfig = { config: { ingress: [] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100'))
        .rejects.toThrow(/catch-all/)
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(0)
    })

    it('throws when the last rule is not a catch-all (foreign rule would shadow)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ hostname: 'unrelated.example.com', service: 'http://1.1.1.1' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('preview-foo.vpszone.xyz', 'http://127.0.0.1:28100'))
        .rejects.toThrow(/catch-all/)
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(0)
    })
  })

  describe('removePreviewRoute', () => {
    it('drops only the matching rule', async () => {
      const initial: TunnelConfig = { config: { ingress: [
        { hostname: 'preview-a.vpszone.xyz', service: 'http://127.0.0.1:28101' },
        { hostname: 'preview-b.vpszone.xyz', service: 'http://127.0.0.1:28102' },
        { service: 'http_status:404' },
      ] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.removePreviewRoute('preview-a.vpszone.xyz')

      const ingress = backend.getCurrent().config.ingress
      expect(ingress).toEqual([
        { hostname: 'preview-b.vpszone.xyz', service: 'http://127.0.0.1:28102' },
        { service: 'http_status:404' },
      ])
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(1)
    })

    it('is a no-op when the hostname is absent (no PUT issued)', async () => {
      const initial: TunnelConfig = { config: { ingress: [
        { hostname: 'preview-a.vpszone.xyz', service: 'http://127.0.0.1:28101' },
        { service: 'http_status:404' },
      ] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.removePreviewRoute('preview-does-not-exist.vpszone.xyz')

      expect(backend.getCurrent()).toEqual(initial)
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(0)
    })

    it('keeps foreign rules (non-matching domain) untouched across remove', async () => {
      const foreign: IngressRule = { hostname: 'unrelated.example.net', service: 'http://10.0.0.1:8000' }
      const initial: TunnelConfig = { config: { ingress: [
        foreign,
        { hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' },
        { service: 'http_status:404' },
      ] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)

      await client.removePreviewRoute('preview-foo.vpszone.xyz')

      const ingress = backend.getCurrent().config.ingress
      expect(ingress[0]).toEqual(foreign)
      expect(ingress).toHaveLength(2)
      expect(ingress[1]).toEqual({ service: 'http_status:404' })
    })

    it('lowercases the hostname parameter before removal', async () => {
      const initial: TunnelConfig = { config: { ingress: [
        { hostname: 'preview-foo.vpszone.xyz', service: 'http://127.0.0.1:28100' },
        { service: 'http_status:404' },
      ] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await client.removePreviewRoute('Preview-Foo.VPSZONE.XYZ')
      expect(backend.getCurrent().config.ingress).toEqual([{ service: 'http_status:404' }])
    })
  })

  describe('serialization (P4-3)', () => {
    it('serializes 5 concurrent addPreviewRoute calls into 5 distinct rules', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      // A small per-request delay widens the race window so that without the
      // mutex five concurrent writers would lose updates.
      const backend = createBackend(initial, 5)
      const client = makeClient(backend)

      await Promise.all([
        client.addPreviewRoute('preview-1.vpszone.xyz', 'http://127.0.0.1:28101'),
        client.addPreviewRoute('preview-2.vpszone.xyz', 'http://127.0.0.1:28102'),
        client.addPreviewRoute('preview-3.vpszone.xyz', 'http://127.0.0.1:28103'),
        client.addPreviewRoute('preview-4.vpszone.xyz', 'http://127.0.0.1:28104'),
        client.addPreviewRoute('preview-5.vpszone.xyz', 'http://127.0.0.1:28105'),
      ])

      const ingress = backend.getCurrent().config.ingress
      expect(ingress).toHaveLength(6)
      const previews = ingress.filter(r => r.hostname?.endsWith('.vpszone.xyz'))
      expect(previews).toHaveLength(5)
      expect(new Set(previews.map(r => r.hostname)).size).toBe(5)
      expect(previews.map(r => r.hostname).sort()).toEqual([
        'preview-1.vpszone.xyz',
        'preview-2.vpszone.xyz',
        'preview-3.vpszone.xyz',
        'preview-4.vpszone.xyz',
        'preview-5.vpszone.xyz',
      ])
      expect(ingress[ingress.length - 1]).toEqual({ service: 'http_status:404' })

      // Five PUTs must have happened, each preceded by a GET — every add is a
      // full read-modify-write, not a blind set, and the order is serialized.
      const puts = backend.getCalls().filter(c => c.method === 'PUT')
      expect(puts).toHaveLength(5)
      const seenAfterEachPut = puts.map(c => (JSON.parse(c.body!) as TunnelConfig).config.ingress
        .filter(r => r.hostname).map(r => r.hostname).sort())
      // After put 1, exactly 1 preview; after put 2, exactly 2; etc.
      expect(seenAfterEachPut).toEqual([
        ['preview-1.vpszone.xyz'],
        ['preview-1.vpszone.xyz', 'preview-2.vpszone.xyz'],
        ['preview-1.vpszone.xyz', 'preview-2.vpszone.xyz', 'preview-3.vpszone.xyz'],
        ['preview-1.vpszone.xyz', 'preview-2.vpszone.xyz', 'preview-3.vpszone.xyz', 'preview-4.vpszone.xyz'],
        ['preview-1.vpszone.xyz', 'preview-2.vpszone.xyz', 'preview-3.vpszone.xyz', 'preview-4.vpszone.xyz', 'preview-5.vpszone.xyz'],
      ])
    })

    it('serializes 5 concurrent addPreviewRoute calls across two client instances via the module-scope lock', async () => {
      // P2-1: a per-instance lock lets two clients for the same tunnel race
      // and lose writes. The lock map is module-scope on globalThis so that
      // two clients (e.g. an API route + the worker) share the FIFO chain.
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial, 5)
      const client1 = makeClient(backend)
      const client2 = new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, domain: DOMAIN,
        fetch: backend.fetch as unknown as typeof fetch })
      expect(client1).not.toBe(client2)

      await Promise.all([
        client1.addPreviewRoute('preview-1.vpszone.xyz', 'http://127.0.0.1:28101'),
        client2.addPreviewRoute('preview-2.vpszone.xyz', 'http://127.0.0.1:28102'),
        client2.addPreviewRoute('preview-3.vpszone.xyz', 'http://127.0.0.1:28103'),
        client1.addPreviewRoute('preview-4.vpszone.xyz', 'http://127.0.0.1:28104'),
        client2.addPreviewRoute('preview-5.vpszone.xyz', 'http://127.0.0.1:28105'),
      ])

      const ingress = backend.getCurrent().config.ingress
      expect(ingress).toHaveLength(6)
      const previews = ingress.filter(r => r.hostname?.endsWith('.vpszone.xyz'))
      expect(previews).toHaveLength(5)
      expect(new Set(previews.map(r => r.hostname)).size).toBe(5)
      expect(ingress[ingress.length - 1]).toEqual({ service: 'http_status:404' })
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(5)
    })
  })

  describe('token handling', () => {
    it('never appears in an error message thrown to the caller', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      backend.fetch.mockImplementationOnce(async (input, init) => {
        backend.recordCall(input, init)
        return new Response('{"success":false,"errors":[{"message":"boom"}]}', {
          status: 500, headers: { 'content-type': 'application/json' },
        })
      })
      const client = makeClient(backend)
      let thrown: Error | undefined
      try { await client.getConfig() } catch (error) { thrown = error as Error }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown!.message).not.toContain(TOKEN)
      expect(thrown!.message).not.toContain('Bearer')
      // Authorization header did carry the token (positive assertion).
      expect(backend.getCalls()[0].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    })

    it('throws on a non-2xx response without leaking the token', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      backend.fetch.mockImplementationOnce(async (input, init) => {
        backend.recordCall(input, init)
        return new Response('', { status: 503 })
      })
      const client = makeClient(backend)
      let captured: Error | undefined
      try { await client.putConfig(initial) } catch (error) { captured = error as Error }
      expect(captured).toBeInstanceOf(Error)
      expect(captured!.message).toMatch(/503/)
      expect(captured!.message).not.toContain(TOKEN)
    })

    it('surfaces Cloudflare errors[].code and message in the thrown error', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      backend.fetch.mockImplementationOnce(async (input, init) => {
        backend.recordCall(input, init)
        return new Response(JSON.stringify({ success: false,
          errors: [{ code: 1004, message: "Invalid DNS hostname 'bad host'" }] }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      })
      const client = makeClient(backend)
      let thrown: Error | undefined
      try { await client.getConfig() } catch (error) { thrown = error as Error }
      expect(thrown!.message).toMatch(/1004/)
      expect(thrown!.message).toMatch(/Invalid DNS hostname/)
      expect(thrown!.message).not.toContain(TOKEN)
    })

    it('redacts the token from the upstream body even if the body happened to echo it', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      backend.fetch.mockImplementationOnce(async (input, init) => {
        backend.recordCall(input, init)
        return new Response(`{"success":false,"errors":[{"message":"used token ${TOKEN}"}]}`, {
          status: 500, headers: { 'content-type': 'application/json' },
        })
      })
      const client = makeClient(backend)
      let thrown: Error | undefined
      try { await client.getConfig() } catch (error) { thrown = error as Error }
      expect(thrown!.message).not.toContain(TOKEN)
      expect(thrown!.message).toContain('[redacted]')
    })

    it('truncates an oversized upstream body', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const longMessage = 'x'.repeat(2000)
      backend.fetch.mockImplementationOnce(async (input, init) => {
        backend.recordCall(input, init)
        return new Response(JSON.stringify({ success: false,
          errors: [{ code: 9999, message: longMessage }] }), {
          status: 400, headers: { 'content-type': 'application/json' },
        })
      })
      const client = makeClient(backend)
      let thrown: Error | undefined
      try { await client.getConfig() } catch (error) { thrown = error as Error }
      expect(thrown!.message).toContain('[truncated]')
      expect(thrown!.message.length).toBeLessThan(longMessage.length)
    })

    it('is hidden from JSON.stringify(client) (private field, not enumerable)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      const serialized = JSON.stringify(client)
      expect(serialized).not.toContain(TOKEN)
      expect(serialized).not.toContain('Bearer')
      // Positive: other public fields do appear so the test isn't trivially empty.
      expect(serialized).toContain(ACCOUNT)
      expect(serialized).toContain(TUNNEL)
    })

    it('is hidden from for-in enumeration', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      const keys: string[] = []
      for (const key in client) keys.push(key)
      expect(keys).not.toContain('apiToken')
      expect(keys).not.toContain('#apiToken')
      // Public fields still enumerable.
      expect(keys).toContain('account')
      expect(keys).toContain('tunnelId')
      expect(keys).toContain('domain')
    })
  })

  describe('domain enforcement (P4-4)', () => {
    it('rejects hostnames outside the configured domain', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('preview-foo.example.com', 'http://127.0.0.1:28100'))
        .rejects.toThrow(/example\.com/)
      await expect(client.removePreviewRoute('preview-foo.example.com'))
        .rejects.toThrow(/example\.com/)
      expect(backend.getCalls().filter(c => c.method === 'GET')).toHaveLength(0)
      expect(backend.getCalls().filter(c => c.method === 'PUT')).toHaveLength(0)
      expect(backend.getCurrent()).toEqual(initial)
    })

    it('rejects an empty-label hostname (".vpszone.xyz" hides everything via wildcard semantics)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow(/vpszone\.xyz/)
      await expect(client.removePreviewRoute('.vpszone.xyz')).rejects.toThrow(/vpszone\.xyz/)
    })

    it('rejects a wildcard label ("*.vpszone.xyz" would shadow later previews)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('*.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow(/vpszone\.xyz/)
      await expect(client.removePreviewRoute('*.vpszone.xyz')).rejects.toThrow(/vpszone\.xyz/)
    })

    it('rejects a multi-label hostname ("a.b.vpszone.xyz" falls outside Universal SSL)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('a.b.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow(/vpszone\.xyz/)
      await expect(client.removePreviewRoute('a.b.vpszone.xyz')).rejects.toThrow(/vpszone\.xyz/)
    })

    it('rejects a hostname with whitespace in the label', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('a b.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow(/vpszone\.xyz/)
      await expect(client.removePreviewRoute('a b.vpszone.xyz')).rejects.toThrow(/vpszone\.xyz/)
    })

    it('rejects a label that starts or ends with a hyphen', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('-bad.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow()
      await expect(client.addPreviewRoute('bad-.vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow()
    })

    it('rejects the bare domain (no label)', async () => {
      const initial: TunnelConfig = { config: { ingress: [{ service: 'http_status:404' }] } }
      const backend = createBackend(initial)
      const client = makeClient(backend)
      await expect(client.addPreviewRoute('vpszone.xyz', 'http://127.0.0.1:28100')).rejects.toThrow()
    })
  })

  describe('real Cloudflare API shape', () => {
    it('parses a GET response where result.config is the inner config (no nested config key)', async () => {
      // Verified live: result.config is { ingress, "warp-routing" } — no nested
      // `config` wrapper. The adapter wraps the inner on the way out so callers
      // see TunnelConfig regardless of direction.
      let innerConfig: { ingress: IngressRule[]; 'warp-routing'?: { enabled: boolean } } = {
        ingress: [{ service: 'http_status:404' }],
        'warp-routing': { enabled: false },
      }
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
        success: true, errors: [], messages: [],
        result: { tunnel_id: TUNNEL, version: 1, config: innerConfig, source: 'API', created_at: '2026-10-18T00:00:00Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const client = new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, domain: DOMAIN,
        fetch: fetchImpl as unknown as typeof fetch })
      const config = await client.getConfig()
      expect(config).toEqual({ config: innerConfig })
      expect(config.config['warp-routing']).toEqual({ enabled: false })
      expect(config.config.ingress).toEqual([{ service: 'http_status:404' }])
      // Sanity: real response has no nested config key.
      expect(innerConfig).not.toHaveProperty('config')
      // round-trip the next read after mutating the inner to prove the wrap.
      innerConfig = { ingress: [{ hostname: 'preview-1.vpszone.xyz', service: 'http://127.0.0.1:28101' }, { service: 'http_status:404' }] }
      const next = await client.getConfig()
      expect(next.config.ingress).toEqual([
        { hostname: 'preview-1.vpszone.xyz', service: 'http://127.0.0.1:28101' },
        { service: 'http_status:404' },
      ])
    })

    it('throws a named error when the GET response is missing an ingress array', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        success: true, errors: [], messages: [],
        result: { tunnel_id: TUNNEL, version: 1, config: { 'warp-routing': { enabled: false } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const client = new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, domain: DOMAIN,
        fetch: fetchImpl as unknown as typeof fetch })
      await expect(client.getConfig()).rejects.toThrow(/ingress/)
    })

    it('throws when the GET response has a non-array ingress', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        success: true, errors: [], messages: [],
        result: { tunnel_id: TUNNEL, version: 1, config: { ingress: 'oops' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const client = new CloudflareTunnel({ account: ACCOUNT, tunnel: TUNNEL, apiToken: TOKEN, domain: DOMAIN,
        fetch: fetchImpl as unknown as typeof fetch })
      await expect(client.getConfig()).rejects.toThrow(/ingress/)
    })
  })
})