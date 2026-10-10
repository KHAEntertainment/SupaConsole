// Post-deploy health: a project is healthy only when its containers are up
// and a client can actually use it through the gateway. Checks run in order
// against one shared, hard deadline: each is retried until it passes or the
// budget runs out, every operation is given only the remaining budget, and a
// check reached after the deadline is recorded as not run instead of starting
// more I/O. A failing result therefore names the broken pieces and returns
// within the timeout.
import { promises as fs } from 'fs'
import * as path from 'path'
import { docker, DeadlineExceededError } from './run'
import { ps, type ServiceState } from './compose'
import type { ComposeTarget } from './layout'
import { PROBE_SCHEMA, PROBE_TABLE, realtimeProbe, type ProbeOutcome } from './realtime'

export const HEALTH_FILE = '.supaconsole-health.json'

export type HealthCheckName = 'containers' | 'database' | 'gateway' | 'auth' | 'rest' | 'realtime'

export interface HealthCheck {
  name: HealthCheckName
  ok: boolean
  // Wall time spent on this check, all attempts included.
  ms: number
  // 0 when the deadline had passed before the check could start.
  attempts: number
  detail: string
}

export interface HealthResult {
  healthy: boolean
  checkedAt: string
  ms: number
  // Names of the checks that failed, in order.
  failed: HealthCheckName[]
  checks: HealthCheck[]
}

export interface HealthOptions {
  timeoutMs?: number
  intervalMs?: number
  // Address the gateway's published port is reached at from where this
  // process runs. 127.0.0.1 for a host-run SupaConsole; a containerized one
  // needs the Docker host (e.g. host.docker.internal). See SUPACONSOLE_PROBE_HOST.
  probeHost?: string
}

// The budget one operation may use. `signal` is aborted when the attempt's
// budget expires: an operation must not start a process, request or socket
// once it is aborted, and must stop any it has running.
export interface OpLimits {
  timeoutMs: number
  signal: AbortSignal
}

// What the checks need from the outside world; injectable for tests.
export interface HealthDeps {
  services: (limits: OpLimits) => Promise<ServiceState[]>
  // Runs psql in the project's db container. `pooler` routes through the
  // Supavisor session pooler instead of the local socket.
  psql: (
    db: string,
    sql: string,
    opts: OpLimits & { pooler?: { tenantId: string; password: string } }
  ) => Promise<string>
  fetch: (url: string, opts: OpLimits & { headers?: Record<string, string> }) => Promise<{ status: number }>
  realtime: (input: OpLimits & {
    baseUrl: string
    apikey: string
    insert: (v: string, signal: AbortSignal) => Promise<void>
  }) => Promise<ProbeOutcome>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type Attempt = (budgetMs: number, signal: AbortSignal) => Promise<ProbeOutcome>

export const DEFAULT_HEALTH_TIMEOUT_MS = 300000
export const DEFAULT_PROBE_HOST = '127.0.0.1'
// Per-operation ceilings, further capped by the remaining budget.
const SERVICES_MAX_MS = 60000
const PSQL_MAX_MS = 30000
const FETCH_MAX_MS = 10000
const REALTIME_ATTEMPT_MAX_MS = 20000

export const DEADLINE_REACHED = 'not run: health deadline reached'

// Containers: every service compose created must be running, and healthy if
// it declares a healthcheck. "starting" is not a pass yet.
export function evaluateContainers(states: ServiceState[]): ProbeOutcome {
  if (states.length === 0) return { ok: false, detail: 'no containers' }
  const bad = states
    .filter((s) => s.State !== 'running' || (s.Health !== undefined && s.Health !== '' && s.Health !== 'healthy'))
    .map((s) => `${s.Service}: ${s.State !== 'running' ? s.State : s.Health}`)
  return bad.length === 0
    ? { ok: true, detail: `${states.length} running` }
    : { ok: false, detail: bad.join(', ') }
}

// Idempotent: the probe table the REST and realtime checks use. Anon may read
// it (RLS on, select-only policy) and it is in the realtime publication.
export const PROBE_SETUP_SQL = `
create table if not exists ${PROBE_SCHEMA}.${PROBE_TABLE} (
  id bigint generated always as identity primary key,
  probe text not null,
  created_at timestamptz not null default now()
);
comment on table ${PROBE_SCHEMA}.${PROBE_TABLE} is 'SupaConsole health probe; safe to ignore, recreated on deploy';
alter table ${PROBE_SCHEMA}.${PROBE_TABLE} enable row level security;
revoke all on ${PROBE_SCHEMA}.${PROBE_TABLE} from anon, authenticated;
grant select on ${PROBE_SCHEMA}.${PROBE_TABLE} to anon;
drop policy if exists supaconsole_health_read on ${PROBE_SCHEMA}.${PROBE_TABLE};
create policy supaconsole_health_read on ${PROBE_SCHEMA}.${PROBE_TABLE} for select to anon using (true);
delete from ${PROBE_SCHEMA}.${PROBE_TABLE} where created_at < now() - interval '1 hour';
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = '${PROBE_SCHEMA}' and tablename = '${PROBE_TABLE}'
  ) then
    alter publication supabase_realtime add table ${PROBE_SCHEMA}.${PROBE_TABLE};
  end if;
end $$;
notify pgrst, 'reload schema';
`

const PROBE_VALUE_RE = /^[a-z0-9-]+$/
// A hostname, an IPv4 address or a bracketed IPv6 address; nothing that could
// add a path, credentials or another port to the probe URL.
const PROBE_HOST_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:.]+\])$/

export function gatewayPort(env: Record<string, string>): number | null {
  const raw = env.API_GW_HTTP_PORT || env.KONG_HTTP_PORT || ''
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

export function probeHost(value: string | undefined): string {
  const host = (value ?? '').trim()
  if (!host) return DEFAULT_PROBE_HOST
  if (!PROBE_HOST_RE.test(host)) throw new Error(`Invalid probe host: ${JSON.stringify(host)}`)
  return host
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error.message
    return text.split('\n').slice(-3).join(' ').slice(0, 300)
  }
  return String(error)
}

const DeadlineError = DeadlineExceededError

// Runs one attempt with `ms` of budget. The attempt's signal is aborted
// whenever the attempt settles - success, failure or expiry - so nothing it
// started (a process, request, socket or fire-and-forget insert) outlives it,
// and nothing new can start. On expiry the attempt is reported as timed out
// without waiting for it to wind down; the abort kills what is left.
function withinBudget<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`timed out: health deadline reached after ${ms}ms`)), ms)
  })
  return Promise.race([work(controller.signal), expired]).finally(() => {
    clearTimeout(timer)
    controller.abort(new DeadlineError('health attempt settled'))
  })
}

export async function runHealth(
  env: Record<string, string>,
  deps: HealthDeps,
  options: HealthOptions = {}
): Promise<HealthResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 3000
  const started = deps.now()
  const deadline = started + timeoutMs
  const remaining = () => deadline - deps.now()
  const checks: HealthCheck[] = []

  const poll = async (name: HealthCheckName, attempt: Attempt): Promise<boolean> => {
    const t0 = deps.now()
    let attempts = 0
    let outcome: ProbeOutcome = { ok: false, detail: DEADLINE_REACHED }
    for (;;) {
      const budget = remaining()
      if (budget <= 0) break
      attempts++
      try {
        outcome = await withinBudget((signal) => attempt(budget, signal), budget)
      } catch (error) {
        outcome = { ok: false, detail: errorText(error) }
      }
      if (outcome.ok || remaining() <= 0) break
      await deps.sleep(Math.min(intervalMs, remaining()))
    }
    checks.push({ name, ok: outcome.ok, ms: deps.now() - t0, attempts, detail: outcome.detail })
    return outcome.ok
  }

  let dbContainer = ''
  let runningServices: string[] = []
  await poll('containers', async (budget, signal) => {
    const states = await deps.services({ timeoutMs: Math.min(budget, SERVICES_MAX_MS), signal })
    dbContainer = states.find((s) => s.Service === 'db' && s.State === 'running')?.Name ?? ''
    runningServices = states.filter((s) => s.State === 'running').map((s) => s.Service)
    return evaluateContainers(states)
  })

  // Database readiness through the session pooler when the project runs one
  // (user postgres.<tenant>, sslmode=disable; the pooler restarts once after
  // configuring itself, so this polls), else straight to Postgres. Then the
  // probe table the later checks need.
  const tenantId = env.POOLER_TENANT_ID ?? ''
  const password = env.POSTGRES_PASSWORD ?? ''
  const viaPooler = () => runningServices.includes('supavisor') && tenantId !== '' && password !== ''
  const psqlBudget = () => {
    const budget = Math.min(remaining(), PSQL_MAX_MS)
    if (budget <= 0) throw new DeadlineError(DEADLINE_REACHED)
    return budget
  }
  let probeReady = false
  await poll('database', async (_budget, signal) => {
    if (!dbContainer) return { ok: false, detail: 'db container is not running' }
    const pooled = viaPooler()
    await deps.psql(dbContainer, 'select 1', { timeoutMs: psqlBudget(), signal, pooler: pooled ? { tenantId, password } : undefined })
    await deps.psql(dbContainer, PROBE_SETUP_SQL, { timeoutMs: psqlBudget(), signal })
    probeReady = true
    return { ok: true, detail: pooled ? 'ready via pooler' : 'ready (direct; no pooler in this profile)' }
  })

  // The gateway is probed at its published port. Persistent projects publish
  // on all interfaces, so the configured probe host (loopback, or the Docker
  // host from inside a container) reaches it. Preview projects publish on
  // 127.0.0.1 only, which a containerized SupaConsole cannot reach that way;
  // Phase 3 needs a different probe path for them (e.g. joining the
  // project's network and probing api-gw:8000 directly).
  const port = gatewayPort(env)
  const anon = env.ANON_KEY ?? ''
  const host = probeHost(options.probeHost)
  const base = port ? `http://${host}:${port}` : ''
  const noGateway = { ok: false, detail: 'no gateway port in the project env' }
  const fetchBudget = (budget: number) => Math.min(budget, FETCH_MAX_MS)

  await poll('gateway', async (budget, signal) => {
    if (!base) return noGateway
    const res = await deps.fetch(`${base}/`, { timeoutMs: fetchBudget(budget), signal })
    // Any answer from Envoy itself means the gateway is up; 502/503 come from
    // Envoy too, but only when a route's upstream is down, never for `/`.
    return { ok: res.status < 500, detail: `HTTP ${res.status}` }
  })

  await poll('auth', async (budget, signal) => {
    if (!base) return noGateway
    const res = await deps.fetch(`${base}/auth/v1/health`, { timeoutMs: fetchBudget(budget), signal, headers: { apikey: anon } })
    return { ok: res.status === 200, detail: `/auth/v1/health HTTP ${res.status}` }
  })

  await poll('rest', async (budget, signal) => {
    if (!base) return noGateway
    if (!probeReady) return { ok: false, detail: 'probe table not set up (database check failed)' }
    const res = await deps.fetch(`${base}/rest/v1/${PROBE_TABLE}?select=id&limit=1`, {
      timeoutMs: fetchBudget(budget),
      signal,
      headers: { apikey: anon },
    })
    return { ok: res.status === 200, detail: `anon GET /rest/v1/${PROBE_TABLE} HTTP ${res.status}` }
  })

  await poll('realtime', async (budget, signal) => {
    if (!base) return noGateway
    if (!probeReady) return { ok: false, detail: 'probe table not set up (database check failed)' }
    return deps.realtime({
      baseUrl: base.replace(/^http/, 'ws'),
      apikey: anon,
      timeoutMs: Math.min(budget, REALTIME_ATTEMPT_MAX_MS),
      signal,
      insert: async (value, insertSignal) => {
        if (!PROBE_VALUE_RE.test(value)) throw new Error('invalid probe value')
        await deps.psql(dbContainer, `insert into ${PROBE_SCHEMA}.${PROBE_TABLE} (probe) values ('${value}')`, {
          timeoutMs: psqlBudget(),
          // Cancelled when the probe settles or the attempt ends, whichever is first.
          signal: AbortSignal.any([signal, insertSignal]),
        })
      },
    })
  })

  const failed = checks.filter((c) => !c.ok).map((c) => c.name)
  return {
    healthy: failed.length === 0,
    checkedAt: new Date(started).toISOString(),
    ms: deps.now() - started,
    failed,
    checks,
  }
}

function realDeps(target: ComposeTarget): HealthDeps {
  return {
    // Each operation gets an absolute deadline (re-checked before any process
    // starts) plus the attempt's signal (refuses to start / kills on abort).
    services: ({ timeoutMs, signal }) => ps(target, { timeout: timeoutMs, deadline: Date.now() + timeoutMs, signal }),
    psql: async (db, sql, { timeoutMs, signal, pooler }) => {
      const args = ['exec']
      let env: Record<string, string> | undefined
      if (pooler) {
        // `-e NAME` with no value hands the variable from this process's env
        // to the container, so the password never appears in an argv.
        args.push('-e', 'PGPASSWORD')
        env = { PGPASSWORD: pooler.password }
      }
      args.push(db, 'psql', '-v', 'ON_ERROR_STOP=1', '-qtA')
      if (pooler) {
        const connect = Math.max(Math.min(Math.floor(timeoutMs / 1000), 5), 1)
        args.push(`host=supavisor port=5432 dbname=postgres user=postgres.${pooler.tenantId} sslmode=disable connect_timeout=${connect}`)
      } else {
        args.push('-U', 'postgres', '-d', 'postgres')
      }
      args.push('-c', sql)
      const { stdout } = await docker(args, { timeout: timeoutMs, deadline: Date.now() + timeoutMs, signal, env })
      return stdout
    },
    fetch: async (url, { timeoutMs, signal, headers }) => {
      signal.throwIfAborted()
      const res = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: 'manual' })
      await res.arrayBuffer().catch(() => undefined)
      return { status: res.status }
    },
    realtime: (input) => realtimeProbe(input),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

// Health of a deployed project. `env` is the project's environment (the
// values its .env was written from).
export function health(target: ComposeTarget, env: Record<string, string>, options?: HealthOptions): Promise<HealthResult> {
  return runHealth(env, realDeps(target), options)
}

export async function writeHealth(dockerDir: string, result: HealthResult): Promise<void> {
  await fs.writeFile(path.join(dockerDir, HEALTH_FILE), JSON.stringify(result, null, 2) + '\n', 'utf8')
}

export async function readHealth(dockerDir: string): Promise<HealthResult | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dockerDir, HEALTH_FILE), 'utf8')) as HealthResult
  } catch {
    return null
  }
}

// One line naming each failed check, for error messages and the UI.
export function describeFailure(result: HealthResult): string {
  return result.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name} (${c.detail})`)
    .join('; ')
}
