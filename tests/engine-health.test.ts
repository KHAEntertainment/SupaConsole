import { describe, expect, it, vi } from 'vitest'
import type { ServiceState } from '@/lib/engine/compose'
import {
  DEADLINE_REACHED,
  describeFailure,
  evaluateContainers,
  gatewayPort,
  probeHost,
  runHealth,
  type HealthDeps,
} from '@/lib/engine/health'
import {
  PROBE_TABLE,
  insertedProbe,
  joinMessage,
  realtimeProbe,
  type ProbeSocket,
} from '@/lib/engine/realtime'

vi.mock('@/lib/engine/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/engine/run')>()),
  docker: vi.fn(),
  run: vi.fn(),
}))

const svc = (Service: string, State = 'running', Health = 'healthy'): ServiceState => ({
  Name: `p-${Service}-1`,
  Service,
  State,
  Health,
})

const STACK = ['db', 'api-gw', 'auth', 'rest', 'realtime', 'supavisor'].map((s) => svc(s))
const ENV = { API_GW_HTTP_PORT: '8123', ANON_KEY: 'anon', POOLER_TENANT_ID: 'tenant-1', POSTGRES_PASSWORD: 'pw' }

// A clock that only moves when the code sleeps (or a dep advances it), so
// deadlines are exact.
function deps(overrides: Partial<HealthDeps> = {}): HealthDeps & { clock: { t: number } } {
  const clock = { t: 0 }
  return {
    clock,
    services: vi.fn(async () => STACK),
    psql: vi.fn(async () => ''),
    fetch: vi.fn(async () => ({ status: 200 })),
    realtime: vi.fn(async () => ({ ok: true, detail: 'INSERT event received after 1 insert(s)' })),
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
    ...overrides,
  }
}

describe('evaluateContainers', () => {
  it('passes when every container is running and healthy or has no healthcheck', () => {
    expect(evaluateContainers([svc('db'), svc('imgproxy', 'running', '')]).ok).toBe(true)
  })

  it('names services that are starting, unhealthy or not running', () => {
    const r = evaluateContainers([svc('db'), svc('auth', 'restarting', ''), svc('rest', 'running', 'starting'), svc('storage', 'running', 'unhealthy')])
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('auth: restarting, rest: starting, storage: unhealthy')
  })

  it('fails with no containers', () => {
    expect(evaluateContainers([]).ok).toBe(false)
  })
})

describe('gatewayPort / probeHost', () => {
  it('prefers API_GW_HTTP_PORT, falls back to KONG_HTTP_PORT', () => {
    expect(gatewayPort({ API_GW_HTTP_PORT: '8100', KONG_HTTP_PORT: '8200' })).toBe(8100)
    expect(gatewayPort({ KONG_HTTP_PORT: '8200' })).toBe(8200)
    expect(gatewayPort({ API_GW_HTTP_PORT: 'x' })).toBeNull()
  })

  it('defaults the probe host to loopback and accepts hostnames and IPs', () => {
    expect(probeHost(undefined)).toBe('127.0.0.1')
    expect(probeHost('  ')).toBe('127.0.0.1')
    expect(probeHost('host.docker.internal')).toBe('host.docker.internal')
    expect(probeHost('172.17.0.1')).toBe('172.17.0.1')
    expect(probeHost('[::1]')).toBe('[::1]')
  })

  it('rejects probe hosts that would change the URL beyond the host', () => {
    for (const bad of ['evil.com/x', 'a@b', 'h:1', 'h?x', '-h']) expect(() => probeHost(bad)).toThrow()
  })
})

describe('runHealth', () => {
  it('passes every check on a healthy stack and polls the DB through the pooler', async () => {
    const d = deps()
    const result = await runHealth(ENV, d, { timeoutMs: 60000 })
    expect(result.healthy).toBe(true)
    expect(result.failed).toEqual([])
    expect(result.checks.map((c) => c.name)).toEqual(['containers', 'database', 'gateway', 'auth', 'rest', 'realtime'])
    expect(d.psql).toHaveBeenCalledWith('p-db-1', 'select 1', expect.objectContaining({ timeoutMs: 30000, pooler: { tenantId: 'tenant-1', password: 'pw' } }))
    expect(d.fetch).toHaveBeenCalledWith('http://127.0.0.1:8123/auth/v1/health', expect.objectContaining({ timeoutMs: 10000, headers: { apikey: 'anon' } }))
    expect(d.realtime).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'ws://127.0.0.1:8123', apikey: 'anon', timeoutMs: 20000 }))
  })

  it('probes the configured host (containerized SupaConsole)', async () => {
    const d = deps()
    await runHealth(ENV, d, { timeoutMs: 60000, probeHost: 'host.docker.internal' })
    expect(d.fetch).toHaveBeenCalledWith('http://host.docker.internal:8123/', expect.anything())
    expect(d.realtime).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'ws://host.docker.internal:8123' }))
  })

  it('polls the DB directly when the profile has no pooler', async () => {
    const d = deps({ services: vi.fn(async () => STACK.filter((s) => s.Service !== 'supavisor')) })
    await runHealth(ENV, d, { timeoutMs: 60000 })
    expect(d.psql).toHaveBeenCalledWith('p-db-1', 'select 1', expect.objectContaining({ timeoutMs: 30000, pooler: undefined }))
  })

  it('retries until a check passes within the deadline', async () => {
    let calls = 0
    const d = deps({ services: vi.fn(async () => (++calls < 3 ? [svc('db'), svc('auth', 'running', 'starting')] : STACK)) })
    const result = await runHealth(ENV, d, { timeoutMs: 60000, intervalMs: 1000 })
    expect(result.healthy).toBe(true)
    expect(result.checks[0]).toMatchObject({ name: 'containers', ok: true, attempts: 3, ms: 2000 })
  })

  it('reports unhealthy, naming the failing check, when one service stays broken', async () => {
    const broken = [...STACK.filter((s) => s.Service !== 'auth'), svc('auth', 'restarting', '')]
    const d = deps({
      services: vi.fn(async () => broken),
      fetch: vi.fn(async (url: string) => ({ status: url.endsWith('/auth/v1/health') ? 503 : 200 })),
    })
    const result = await runHealth(ENV, d, { timeoutMs: 10000, intervalMs: 1000 })
    expect(result.healthy).toBe(false)
    expect(result.ms).toBe(10000)
    // The containers check used the whole budget, so nothing after it ran.
    expect(result.failed).toEqual(['containers', 'database', 'gateway', 'auth', 'rest', 'realtime'])
    expect(result.checks[0]).toMatchObject({ attempts: 10, detail: 'auth: restarting' })
    expect(result.checks.slice(1).every((c) => c.attempts === 0 && c.detail === DEADLINE_REACHED)).toBe(true)
    expect(d.psql).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
    expect(d.realtime).not.toHaveBeenCalled()
  })

  it('names a failing check that is reached in time', async () => {
    const d = deps({ fetch: vi.fn(async (url: string) => ({ status: url.endsWith('/auth/v1/health') ? 503 : 200 })) })
    const result = await runHealth(ENV, d, { timeoutMs: 10000, intervalMs: 1000 })
    expect(result.failed).toEqual(['auth', 'rest', 'realtime'])
    expect(describeFailure(result)).toBe(
      `auth (/auth/v1/health HTTP 503); rest (${DEADLINE_REACHED}); realtime (${DEADLINE_REACHED})`
    )
  })

  it('treats the timeout as a hard deadline when time passes during awaited I/O', async () => {
    // Each operation takes 30ms of (fake) time; the whole budget is 50ms.
    const d = deps()
    const slow = <T>(value: T) => async (...args: unknown[]) => {
      void args
      d.clock.t += 30
      return value
    }
    d.services = vi.fn(slow(STACK))
    d.psql = vi.fn(slow(''))
    d.fetch = vi.fn(slow({ status: 200 }))
    const result = await runHealth(ENV, d, { timeoutMs: 50, intervalMs: 1000 })
    expect(result.ms).toBeLessThanOrEqual(80)
    // containers (0->30); database starts with 20ms left: select 1 (30->60),
    // then no budget for the probe-table setup, so it fails without running it.
    expect(d.services).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 50 }))
    expect(d.psql).toHaveBeenCalledTimes(1)
    expect((d.psql as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ timeoutMs: 20 })
    expect(result.checks.map((c) => [c.name, c.attempts])).toEqual([
      ['containers', 1], ['database', 1], ['gateway', 0], ['auth', 0], ['rest', 0], ['realtime', 0],
    ])
    expect(d.fetch).not.toHaveBeenCalled()
    expect(d.realtime).not.toHaveBeenCalled()
  })

  it('gives realtime only the remaining budget', async () => {
    const d = deps()
    d.fetch = vi.fn(async () => {
      d.clock.t += 1000
      return { status: 200 }
    })
    await runHealth(ENV, d, { timeoutMs: 3500 })
    // gateway, auth, rest each took 1s of the 3.5s budget.
    expect(d.realtime).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 500 }))
  })

  it('returns within the timeout in real time even if a dependency hangs', async () => {
    const d = deps({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    d.services = vi.fn(() => new Promise<ServiceState[]>(() => {}))
    const t0 = Date.now()
    const result = await runHealth(ENV, d, { timeoutMs: 150, intervalMs: 20 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(result.checks[0]).toMatchObject({ name: 'containers', ok: false, attempts: 1 })
    expect(result.checks[0].detail).toMatch(/health deadline reached/)
    expect(result.checks.slice(1).every((c) => c.attempts === 0)).toBe(true)
  })

  it('does not probe REST or realtime when the database never became ready', async () => {
    const d = deps({
      psql: vi.fn(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'psql: error: connection refused' })
      }),
    })
    const result = await runHealth(ENV, d, { timeoutMs: 3000, intervalMs: 1000 })
    expect(result.failed).toEqual(['database', 'gateway', 'auth', 'rest', 'realtime'])
    expect(result.checks[1]).toMatchObject({ attempts: 3, detail: 'psql: error: connection refused' })
    expect(d.realtime).not.toHaveBeenCalled()
  })

  it('names realtime when the websocket probe gets no event', async () => {
    const d = deps({ realtime: vi.fn(async () => ({ ok: false, detail: 'websocket closed (code 1006) before subscribing' })) })
    const result = await runHealth(ENV, d, { timeoutMs: 5000, intervalMs: 1000 })
    expect(result.failed).toEqual(['realtime'])
  })
})

// A fake realtime server: confirms the subscription, then emits an INSERT
// event for the Nth insert (the earlier ones are "missed", as after a cold boot).
function fakeSocket(opts: { deliverOnInsert?: number; refuse?: boolean; closeOnOpen?: boolean }) {
  const sent: unknown[] = []
  let inserts = 0
  let instance: ProbeSocket & { url: string; init?: { headers?: Record<string, string> } }
  class FakeSocket {
    onopen: ProbeSocket['onopen'] = null
    onmessage: ProbeSocket['onmessage'] = null
    onerror: ProbeSocket['onerror'] = null
    onclose: ProbeSocket['onclose'] = null
    constructor(public url: string, public init?: { headers?: Record<string, string> }) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      instance = this
      setTimeout(() => (opts.closeOnOpen ? this.onclose?.({ code: 1006 }) : this.onopen?.({})), 0)
    }
    send(data: string) {
      const msg = JSON.parse(data)
      sent.push(msg)
      if (msg.event !== 'phx_join') return
      const reply = (payload: unknown, event = 'phx_reply') =>
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ topic: msg.topic, event, payload, ref: msg.ref }) }), 0)
      if (opts.refuse) return reply({ status: 'error', response: { reason: 'unauthorized' } })
      reply({ status: 'ok', response: {} })
      reply({ status: 'ok', extension: 'postgres_changes', message: 'Subscribed to PostgreSQL' }, 'system')
    }
    close() {}
  }
  const insert = async (value: string) => {
    inserts++
    if (inserts >= (opts.deliverOnInsert ?? 1)) {
      const topic = (sent[0] as { topic: string }).topic
      setTimeout(
        () =>
          instance.onmessage?.({
            data: JSON.stringify({
              topic,
              event: 'postgres_changes',
              payload: { data: { type: 'INSERT', table: PROBE_TABLE, record: { probe: value } } },
              ref: null,
            }),
          }),
        0
      )
    }
  }
  return { FakeSocket, insert, sent, get instance() { return instance } }
}

describe('realtimeProbe', () => {
  it('subscribes, inserts and passes on the matching INSERT event; apikey travels as a header', async () => {
    const f = fakeSocket({})
    const r = await realtimeProbe({ baseUrl: 'ws://127.0.0.1:8123', apikey: 'anon', insert: f.insert, timeoutMs: 2000, socket: f.FakeSocket })
    expect(r).toEqual({ ok: true, detail: 'INSERT event received after 1 insert(s)' })
    expect(f.instance.url).toBe('ws://127.0.0.1:8123/realtime/v1/websocket?vsn=1.0.0')
    expect(f.instance.url).not.toContain('anon')
    expect(f.instance.init).toEqual({ headers: { apikey: 'anon' } })
  })

  it('re-inserts until a missed first event arrives (cold-boot warm-up)', async () => {
    const f = fakeSocket({ deliverOnInsert: 3 })
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: f.insert, timeoutMs: 2000, reinsertMs: 20, socket: f.FakeSocket })
    expect(r).toEqual({ ok: true, detail: 'INSERT event received after 3 insert(s)' })
  })

  it('fails when the join is refused', async () => {
    const f = fakeSocket({ refuse: true })
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: f.insert, timeoutMs: 2000, socket: f.FakeSocket })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('join refused')
  })

  it('fails when the socket closes before subscribing (e.g. gateway 503, missing realtime alias)', async () => {
    const f = fakeSocket({ closeOnOpen: true })
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: f.insert, timeoutMs: 2000, socket: f.FakeSocket })
    expect(r).toEqual({ ok: false, detail: 'websocket closed (code 1006) before subscribing' })
  })

  it('stops at once, closing the socket, when its signal is aborted', async () => {
    const f = fakeSocket({ deliverOnInsert: 1000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    const t0 = Date.now()
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: f.insert, timeoutMs: 5000, reinsertMs: 10, signal: controller.signal, socket: f.FakeSocket })
    expect(r).toEqual({ ok: false, detail: 'aborted: health deadline reached' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('does not open a socket when already aborted', async () => {
    const ctor = vi.fn()
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: async () => {}, timeoutMs: 5000, signal: AbortSignal.abort(), socket: ctor as never })
    expect(r.ok).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('times out when no event ever arrives', async () => {
    const f = fakeSocket({ deliverOnInsert: 1000 })
    const r = await realtimeProbe({ baseUrl: 'ws://x', apikey: 'anon', insert: f.insert, timeoutMs: 100, reinsertMs: 30, socket: f.FakeSocket })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/^subscribed, but no INSERT event after \d+ insert\(s\)$/)
  })
})

describe('phoenix messages', () => {
  it('builds a join with an INSERT postgres_changes subscription on the probe table', () => {
    const m = joinMessage('realtime:t', 'anon', '1')
    expect(m.event).toBe('phx_join')
    expect((m.payload.config as { postgres_changes: unknown[] }).postgres_changes).toEqual([
      { event: 'INSERT', schema: 'public', table: PROBE_TABLE },
    ])
  })

  it('ignores events for other tables', () => {
    expect(
      insertedProbe({ topic: 't', event: 'postgres_changes', ref: null, payload: { data: { type: 'INSERT', table: 'other', record: { probe: 'x' } } } })
    ).toBeNull()
  })
})

describe('realtimeProbe over the real ws transport', () => {
  it('passes against a Phoenix-speaking server; apikey arrives as a header, never in the URL', async () => {
    const { WebSocketServer } = await import('ws')
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((r) => server.once('listening', r))
    const port = (server.address() as { port: number }).port
    const seen: { url?: string; apikey?: string } = {}
    let channel = ''
    let client: import('ws').WebSocket | undefined
    server.on('connection', (socket, req) => {
      client = socket
      seen.url = req.url
      seen.apikey = req.headers.apikey as string
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.event !== 'phx_join') return
        channel = msg.topic
        socket.send(JSON.stringify({ topic: channel, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: msg.ref }))
        socket.send(JSON.stringify({ topic: channel, event: 'system', payload: { status: 'ok', extension: 'postgres_changes' }, ref: null }))
      })
    })
    try {
      const r = await realtimeProbe({
        baseUrl: `ws://127.0.0.1:${port}`,
        apikey: 'secret-anon-key',
        timeoutMs: 5000,
        insert: async (value) => {
          client?.send(JSON.stringify({
            topic: channel,
            event: 'postgres_changes',
            payload: { data: { type: 'INSERT', table: PROBE_TABLE, record: { probe: value } } },
            ref: null,
          }))
        },
      })
      expect(r).toEqual({ ok: true, detail: 'INSERT event received after 1 insert(s)' })
      expect(seen.url).toBe('/realtime/v1/websocket?vsn=1.0.0')
      expect(seen.apikey).toBe('secret-anon-key')
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
