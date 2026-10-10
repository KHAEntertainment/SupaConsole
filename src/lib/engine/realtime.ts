// Realtime probe: open the gateway's realtime websocket, join a channel with a
// postgres_changes INSERT subscription on the probe table, insert a row and
// wait for its event. Speaks the Phoenix v1 JSON protocol directly over the
// pinned `ws` package: Node's global WebSocket needs a runtime flag on Node 20
// (the Docker image's runtime), and `ws` also lets the apikey travel as a
// handshake header.
import WebSocket from 'ws'
//
// The first subscriber after a fresh boot can miss its event while realtime
// is still creating its replication slot (Gate 1 finding C), so the insert is
// repeated until the event arrives or the attempt times out. A pass therefore
// also leaves realtime warmed for the project's first real client.

export const PROBE_SCHEMA = 'public'
export const PROBE_TABLE = 'supaconsole_health'

export interface PhoenixMessage {
  topic: string
  event: string
  payload: Record<string, unknown>
  ref: string | null
  join_ref?: string | null
}

export function joinMessage(topic: string, accessToken: string, ref: string): PhoenixMessage {
  return {
    topic,
    event: 'phx_join',
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: '' },
        postgres_changes: [{ event: 'INSERT', schema: PROBE_SCHEMA, table: PROBE_TABLE }],
        private: false,
      },
      access_token: accessToken,
    },
    ref,
    join_ref: ref,
  }
}

export function heartbeatMessage(ref: string): PhoenixMessage {
  return { topic: 'phoenix', event: 'heartbeat', payload: {}, ref }
}

export function parseMessage(data: unknown): PhoenixMessage | null {
  if (typeof data !== 'string') return null
  try {
    const msg = JSON.parse(data) as PhoenixMessage
    return msg && typeof msg.event === 'string' ? msg : null
  } catch {
    return null
  }
}

// The probe value carried by a postgres_changes INSERT event, if this is one.
export function insertedProbe(msg: PhoenixMessage): string | null {
  if (msg.event !== 'postgres_changes') return null
  const data = msg.payload.data as { type?: string; table?: string; record?: { probe?: unknown } } | undefined
  if (!data || data.type !== 'INSERT' || data.table !== PROBE_TABLE) return null
  return typeof data.record?.probe === 'string' ? data.record.probe : null
}

// The subset of the WebSocket API the probe uses (`ws`, or a fake in tests).
// The second constructor argument carries handshake headers, so the apikey
// travels as a header instead of in the URL, where Envoy's access log would
// record it (Gate 1 finding D).
export interface ProbeSocket {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}
export type ProbeSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => ProbeSocket

// `ws` takes (url, protocols, options); adapt it to the (url, init) shape.
class HeaderWebSocket extends WebSocket {
  constructor(url: string, init?: { headers?: Record<string, string> }) {
    super(url, { headers: init?.headers, handshakeTimeout: 10000 })
  }
}
const defaultSocket = HeaderWebSocket as unknown as ProbeSocketCtor

export interface RealtimeProbeInput {
  // ws://host:port of the gateway, without a path.
  baseUrl: string
  apikey: string
  // Inserts a probe row whose `probe` column holds `value`. It must stop (and
  // settle) promptly once `signal` is aborted: the probe cancels every insert
  // still running when it settles, and waits for them before resolving.
  insert: (value: string, signal: AbortSignal) => Promise<void>
  timeoutMs: number
  // Aborting ends the probe at once (closing the socket) and keeps it from
  // opening one if it is already aborted.
  signal?: AbortSignal
  reinsertMs?: number
  socket?: ProbeSocketCtor
}

export interface ProbeOutcome {
  ok: boolean
  detail: string
}

// How long the probe waits, after cancelling them, for in-flight inserts to
// wind down before it resolves anyway.
const INSERT_DRAIN_MS = 5000

export function realtimeProbe(input: RealtimeProbeInput): Promise<ProbeOutcome> {
  const Socket = input.socket ?? defaultSocket
  if (input.timeoutMs <= 0 || input.signal?.aborted) {
    return Promise.resolve({ ok: false, detail: 'no time left for the realtime probe' })
  }

  const nonce = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const topic = `realtime:supaconsole-health-${nonce}`
  const url = `${input.baseUrl}/realtime/v1/websocket?vsn=1.0.0`
  const reinsertMs = input.reinsertMs ?? 3000

  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false
    let joined = false
    let inserts = 0
    let ref = 1
    const timers: ReturnType<typeof setTimeout>[] = []
    let ws: ProbeSocket
    // Inserts are fired without awaiting them (the event can arrive before
    // the insert's process exits, and reinserts overlap), so they are tracked
    // and cancelled together when the probe settles.
    const inserting = new AbortController()
    const inflight = new Set<Promise<void>>()

    const finish = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      input.signal?.removeEventListener('abort', onAbort)
      clearInterval(heartbeat)
      clearInterval(reinsert)
      try {
        ws.close()
      } catch {
        // already closed
      }
      inserting.abort(new Error('realtime probe finished'))
      if (inflight.size === 0) {
        resolve({ ok, detail })
        return
      }
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      const drained = Promise.allSettled([...inflight]).then(() => undefined)
      const capped = new Promise<void>((r) => {
        drainTimer = setTimeout(r, INSERT_DRAIN_MS)
      })
      void Promise.race([drained, capped]).then(() => {
        clearTimeout(drainTimer)
        resolve({ ok, detail })
      })
    }

    const onAbort = () => finish(false, 'aborted: health deadline reached')
    input.signal?.addEventListener('abort', onAbort, { once: true })

    const doInsert = () => {
      if (settled) return
      inserts++
      const work = input.insert(nonce, inserting.signal).catch((error: unknown) => {
        finish(false, `probe insert failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      inflight.add(work)
      void work.finally(() => inflight.delete(work))
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let reinsert: ReturnType<typeof setInterval> | undefined

    timers.push(
      setTimeout(() => {
        finish(
          false,
          !joined
            ? 'timed out before the postgres_changes subscription was confirmed'
            : `subscribed, but no INSERT event after ${inserts} insert(s)`
        )
      }, input.timeoutMs)
    )

    try {
      ws = new Socket(url, { headers: { apikey: input.apikey } })
    } catch (error) {
      for (const t of timers) clearTimeout(t)
      input.signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, detail: `websocket: ${error instanceof Error ? error.message : String(error)}` })
      return
    }

    ws.onopen = () => {
      ws.send(JSON.stringify(joinMessage(topic, input.apikey, String(ref++))))
      heartbeat = setInterval(() => ws.send(JSON.stringify(heartbeatMessage(String(ref++)))), 20000)
    }
    ws.onerror = () => {
      // The close event that follows carries the reason; an error with no
      // close still ends in the timeout above.
    }
    ws.onclose = (ev) => {
      finish(false, `websocket closed${ev?.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : ''}${joined ? '' : ' before subscribing'}`)
    }
    ws.onmessage = (ev) => {
      const msg = parseMessage(ev.data)
      if (!msg || msg.topic !== topic) return
      if (msg.event === 'phx_reply' && msg.payload.status === 'error') {
        finish(false, `join refused: ${JSON.stringify(msg.payload.response ?? {})}`)
        return
      }
      if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        finish(false, `channel ${msg.event}`)
        return
      }
      // Realtime confirms the postgres_changes subscription with a system
      // message once the listener is in place; inserting earlier can't work.
      if (msg.event === 'system' && msg.payload.extension === 'postgres_changes') {
        if (msg.payload.status !== 'ok') {
          finish(false, `postgres_changes subscription failed: ${String(msg.payload.message ?? msg.payload.status)}`)
          return
        }
        if (!joined) {
          joined = true
          doInsert()
          reinsert = setInterval(doInsert, reinsertMs)
        }
        return
      }
      if (insertedProbe(msg) === nonce) {
        finish(true, `INSERT event received after ${inserts} insert(s)`)
      }
    }
  })
}
