// Realtime round-trip for ops/e2e.sh verify: subscribe to INSERTs on a table
// with the anon key, insert a row with the service key, and wait for the
// event. Exits 0 when the event arrives, 1 otherwise. Prints status only,
// never a key.
//
// supabase-js puts the apikey in the websocket URL's query string, which
// Envoy's access log records (Gate 1 finding D), and its realtime `headers`
// option is ignored for websockets. So the socket is a pinned `ws` subclass
// that moves the apikey from the query into a handshake header; the check
// fails if any handshake URL still carries a key.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      REALTIME_TABLE (default e2e_realtime), REALTIME_TIMEOUT_MS (default 60000)
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const table = process.env.REALTIME_TABLE || 'e2e_realtime'
const timeoutMs = Number(process.env.REALTIME_TIMEOUT_MS || 60000)

if (!url || !anonKey || !serviceKey) {
  console.log('realtime: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required')
  process.exit(2)
}

const handshakeUrls = []
class HeaderKeyWebSocket extends WebSocket {
  constructor(address, protocols) {
    const u = new URL(address)
    const apikey = u.searchParams.get('apikey')
    u.searchParams.delete('apikey')
    handshakeUrls.push(u.toString())
    super(u.toString(), protocols, apikey ? { headers: { apikey } } : {})
  }
}

const options = { auth: { persistSession: false, autoRefreshToken: false } }
const listener = createClient(url, anonKey, { ...options, realtime: { transport: HeaderKeyWebSocket } })
const writer = createClient(url, serviceKey, options)
const note = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const started = Date.now()
let inserts = 0
let status = 'none'

const done = (ok, detail) => {
  const leaked = handshakeUrls.some((h) => h.includes(anonKey) || h.includes(serviceKey) || /[?&]apikey=/.test(h))
  if (leaked) {
    ok = false
    detail = `a websocket handshake URL carried an API key; ${detail}`
  } else if (handshakeUrls.length === 0) {
    ok = false
    detail = `no websocket handshake went through the header transport; ${detail}`
  }
  console.log(`realtime: ${ok ? 'event received' : 'FAILED'} - ${detail} (${Date.now() - started}ms)`)
  // Don't wait for sockets to drain.
  process.exit(ok ? 0 : 1)
}

const insert = async () => {
  inserts++
  const { error } = await writer.from(table).insert({ note })
  if (error) done(false, `insert failed: ${error.message}`)
}

setTimeout(() => {
  done(false, status === 'SUBSCRIBED' ? `subscribed, no event after ${inserts} insert(s)` : `channel status ${status}`)
}, timeoutMs)

let reinsert
listener
  .channel(`e2e-${note}`)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table }, (payload) => {
    if (payload.new?.note === note) done(true, `after ${inserts} insert(s)`)
  })
  .subscribe((s, err) => {
    status = s
    if (s === 'SUBSCRIBED' && !reinsert) {
      // The first event after a cold boot can be missed while realtime builds
      // its replication slot, so keep inserting until one arrives.
      insert()
      reinsert = setInterval(insert, 3000)
    } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
      // supabase-js retries the join itself; record why for the timeout line.
      status = `${s}${err?.message ? ` (${err.message})` : ''}`
    }
  })
