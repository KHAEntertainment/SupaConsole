import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { assertSqlOnly } from './import-sql'
import { generateJWT, generateRandomString } from './project-secrets'
import { run, type RunResult } from './engine/run'
import type { IngestBundleResult } from './bundle-ingest'

export interface SeedUser {
  email: string
  password: string
  user_metadata?: Record<string, unknown>
}

export interface ImportOptions {
  bundle: IngestBundleResult
  databaseUrl: string
  baselineVersion: string
  /** Must establish worker or network egress isolation before any SQL runs. */
  fence: () => Promise<void>
  seedUsers?: SeedUser[]
  auth?: { url: string; serviceRoleKey: string }
  rolesSql?: string
  schemaSql?: string
  readinessTimeoutMs?: number
  execute?: (sql: string) => Promise<RunResult>
  fetch?: typeof fetch
}

export type ImportResult =
  | { status: 'ready'; baseline: string[]; delta: string[]; seeded: boolean; usersCreated: number }
  | { status: 'failed'; stage: string; error: string; failure: ImportError }

export const DEFAULT_PRIVILEGE_PRELUDE = `create extension if not exists pg_cron;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;`

export const QUIESCE_SQL = `select cron.alter_job(jobid, active := false) from cron.job where active;
do $$ begin
  if to_regclass('net.http_request_queue') is not null then
    delete from net.http_request_queue;
    delete from net._http_response;
  end if;
end $$;`

export function filterRoleDump(sql: string): string {
  return sql.replace(/^\s*GRANT SET ON PARAMETER\s+"?log_min_messages"?\s+TO\s+"?supabase_realtime_admin"?\s*;\s*$/gim, '')
}

export function previewEnvironment(host: string, redirectPattern: string): Record<string, string> {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes('..')) {
    throw new Error('Invalid preview host')
  }
  if (!/^https:\/\/[^\s\r\n]+$/.test(redirectPattern)) throw new Error('Invalid preview redirect pattern')
  const url = `https://${host}`
  return {
    API_EXTERNAL_URL: url, SITE_URL: url, SUPABASE_PUBLIC_URL: url, SAML_EXTERNAL_URL: url,
    ADDITIONAL_REDIRECT_URLS: redirectPattern, ENABLE_EMAIL_AUTOCONFIRM: 'true',
    ENABLE_EMAIL_SIGNUP: 'true', ENABLE_PHONE_SIGNUP: 'false', ENABLE_PHONE_AUTOCONFIRM: 'true',
    SMTP_HOST: '', SMTP_PORT: '25', SMTP_USER: '', SMTP_PASS: '', SMTP_ADMIN_EMAIL: '',
    SAML_ENABLED: 'false', SAML_PRIVATE_KEY: '', OPENAI_API_KEY: '',
    GOTRUE_EXTERNAL_GOOGLE_ENABLED: 'false', GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: '',
    GOTRUE_EXTERNAL_GOOGLE_SECRET: '', SMS_PROVIDER: '',
  }
}

export function databaseEnvironment(connectionUrl: string): Record<string, string> {
  const url = new URL(connectionUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.get('sslmode') !== 'disable') {
    throw new Error('Import requires an explicit PostgreSQL URL with sslmode=disable')
  }
  return {
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
    PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '5',
  }
}

export async function importBundle(options: ImportOptions): Promise<ImportResult> {
  let stage = 'fence'
  try {
    await options.fence()
    const env = databaseEnvironment(options.databaseUrl)
    const adapter = options.execute ?? (async (sql: string) =>
      run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-f', '-'], {
        env, timeout: 60000, input: sql,
      }))
    const execute = (sql: string) => {
      assertSqlOnly(sql)
      return adapter(sql)
    }
    stage = 'readiness'
    const deadline = Date.now() + (options.readinessTimeoutMs ?? 60000)
    while (true) {
      try { await execute('select 1;'); break } catch (cause) {
        if (Date.now() >= deadline) throw new Error('Database readiness timed out', { cause })
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))))
      }
    }
    stage = 'prelude'
    await execute(DEFAULT_PRIVILEGE_PRELUDE)
    await execute(QUIESCE_SQL)
    if (options.rolesSql) {
      stage = 'roles'
      await execute(filterRoleDump(options.rolesSql))
      await execute(QUIESCE_SQL)
    }
    const migrations = (await fs.readdir(options.bundle.migrationsDir)).filter(name => name.endsWith('.sql')).sort()
    if (!migrations.length) throw new Error('No SQL migrations found')
    stage = 'manifest'
    if (!/^\d{14}$/.test(options.baselineVersion) ||
      migrations.some(name => !/^\d{14}_.+\.sql$/.test(name)) ||
      !migrations.some(name => name.startsWith(`${options.baselineVersion}_`))) {
      throw new Error('Invalid baseline migration boundary')
    }
    const baseline = migrations.filter(name => name.slice(0, 14) <= options.baselineVersion)
    const delta = migrations.filter(name => name.slice(0, 14) > options.baselineVersion)
    if (options.schemaSql) {
      stage = 'schema'
      await execute(options.schemaSql)
      await execute(QUIESCE_SQL)
    } else {
      for (const name of baseline) {
        stage = `baseline:${name}`
        await execute(await fs.readFile(path.join(options.bundle.migrationsDir, name), 'utf8'))
        await execute(QUIESCE_SQL)
      }
    }
    for (const name of delta) {
      stage = `delta:${name}`
      await execute(await fs.readFile(path.join(options.bundle.migrationsDir, name), 'utf8'))
      await execute(QUIESCE_SQL)
    }
    stage = 'seed'
    if (options.bundle.seedPath) {
      await execute(await fs.readFile(options.bundle.seedPath, 'utf8'))
      await execute(QUIESCE_SQL)
    }
    stage = 'users'
    const users = options.seedUsers ?? []
    if (users.length && !options.auth) throw new Error('Auth admin connection required for seed users')
    for (const user of users) {
      const response = await (options.fetch ?? fetch)(`${options.auth!.url.replace(/\/$/, '')}/auth/v1/admin/users`, {
        method: 'POST', headers: {
          apikey: options.auth!.serviceRoleKey, Authorization: `Bearer ${options.auth!.serviceRoleKey}`,
          'Content-Type': 'application/json',
        }, body: JSON.stringify({ ...user, email_confirm: true }), signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error(`Auth admin request failed (${response.status})`)
    }
    stage = 'verify'
    await execute(QUIESCE_SQL)
    const { stdout } = await execute(`select count(*) from cron.job where active;
do $$ begin if to_regclass('net.http_request_queue') is not null then
  if exists (select from net.http_request_queue) then raise exception 'Net queue not empty'; end if;
end if; end $$;
select 0;`)
    if (stdout.trim() !== '0\n0') throw new Error('Background work remains active')
    return { status: 'ready', baseline, delta, seeded: options.bundle.seedPath !== null, usersCreated: users.length }
  } catch (cause) {
    const failure = new ImportError(stage, cause)
    return { status: 'failed', stage, error: failure.message, failure }
  }
}

export class ImportError extends Error {
  readonly code: string
  constructor(readonly stage: string, cause: unknown) {
    super(`Import failed during ${stage}`, { cause })
    this.name = 'ImportError'
    const code = (cause as { code?: unknown } | null)?.code
    this.code = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
      ? code : typeof code === 'number' ? `PROCESS_EXIT_${code}` : 'IMPORT_STEP_FAILED'
  }
}

export const PINNED_RUNTIME_MAIN_DIGEST = '7464729ba0730678d41c58e14068b3484fb8793ffc2f89a630d9461a97be104c'

export async function runtimeTreeDigest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(dir: string, relative: string): Promise<void> {
    for (const entry of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, entry)
      const name = relative ? `${relative}/${entry}` : entry
      const stat = await fs.lstat(file)
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', name]))
        await visit(file, name)
      } else if (stat.isFile()) {
        const data = await fs.readFile(file)
        hash.update(JSON.stringify(['file', name, data.length]))
        hash.update(data)
      } else throw new Error('Runtime dispatcher must contain only regular files and directories')
    }
  }
  await visit(directory, '')
  return hash.digest('hex')
}

const PREVIEW_SETTINGS = new Set([
  'POSTGRES_PORT', 'API_GW_HTTP_PORT', 'KONG_HTTP_PORT', 'KONG_HTTPS_PORT',
  'POOLER_PROXY_PORT_TRANSACTION', 'POOLER_DEFAULT_POOL_SIZE', 'POOLER_MAX_CLIENT_CONN', 'POOLER_DB_POOL_SIZE',
  'PGRST_DB_SCHEMAS', 'PGRST_DB_MAX_ROWS', 'PGRST_DB_EXTRA_SEARCH_PATH',
  'FUNCTIONS_VERIFY_JWT', 'IMGPROXY_AUTO_WEBP',
])

function freshPreviewEnvironment(input: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    POSTGRES_HOST: 'db', POSTGRES_DB: 'postgres', POSTGRES_PORT: '5432', API_GW_HTTP_PORT: '8000',
    POOLER_PROXY_PORT_TRANSACTION: '6543', POOLER_DEFAULT_POOL_SIZE: '20', POOLER_MAX_CLIENT_CONN: '100',
    POOLER_DB_POOL_SIZE: '5', JWT_EXPIRY: '3600', DISABLE_SIGNUP: 'false', ENABLE_ANONYMOUS_USERS: 'false',
    PGRST_DB_SCHEMAS: 'public,storage,graphql_public', PGRST_DB_MAX_ROWS: '1000', PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
    FUNCTIONS_VERIFY_JWT: 'true', IMGPROXY_AUTO_WEBP: 'true', DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
    STUDIO_DEFAULT_ORGANIZATION: 'Preview', STUDIO_DEFAULT_PROJECT: 'Preview',
    REGION: 'local', GLOBAL_S3_BUCKET: 'stub', DASHBOARD_USERNAME: 'supabase', MINIO_ROOT_USER: 'supabase',
    MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify', MAILER_URLPATHS_INVITE: '/auth/v1/verify',
    MAILER_URLPATHS_RECOVERY: '/auth/v1/verify', MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
    SMTP_SENDER_NAME: '', GOOGLE_PROJECT_ID: '', GOOGLE_PROJECT_NUMBER: '', CERTBOT_EMAIL: '',
    JWT_KEYS: '[]', JWT_JWKS: '', ANON_KEY_ASYMMETRIC: '', SERVICE_ROLE_KEY_ASYMMETRIC: '',
  }
  for (const [key, value] of Object.entries(input)) if (PREVIEW_SETTINGS.has(key)) env[key] = value
  for (const [key, length] of Object.entries({
    JWT_SECRET: 64, POSTGRES_PASSWORD: 32, SECRET_KEY_BASE: 64, VAULT_ENC_KEY: 32,
    REALTIME_DB_ENC_KEY: 16, PG_META_CRYPTO_KEY: 32, DASHBOARD_PASSWORD: 32, MINIO_ROOT_PASSWORD: 32,
    S3_PROTOCOL_ACCESS_KEY_ID: 24, S3_PROTOCOL_ACCESS_KEY_SECRET: 64,
    LOGFLARE_PUBLIC_ACCESS_TOKEN: 64, LOGFLARE_PRIVATE_ACCESS_TOKEN: 64,
  })) env[key] = generateRandomString(length)
  env.SUPABASE_PUBLISHABLE_KEY = `sb_publishable_${generateRandomString(32)}`
  env.SUPABASE_SECRET_KEY = `sb_secret_${generateRandomString(64)}`
  env.ANON_KEY = generateJWT('anon', env.JWT_SECRET, Date.now())
  env.SERVICE_ROLE_KEY = generateJWT('service_role', env.JWT_SECRET, Date.now())
  env.POOLER_TENANT_ID = `preview-${generateRandomString(24)}`
  env.STORAGE_TENANT_ID = env.POOLER_TENANT_ID
  return env
}

export async function preparePreviewImport(options: {
  bundle: IngestBundleResult
  dockerDir: string
  host: string
  redirectPattern: string
  environment: Record<string, string>
  runtimeMainPath: string
  runtimeMainDigest: string
}): Promise<Record<string, string>> {
  const env = { ...freshPreviewEnvironment(options.environment), ...previewEnvironment(options.host, options.redirectPattern) }
  env.PROXY_DOMAIN = env.SUPABASE_PUBLIC_URL
  const lines = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid preview environment entry')
    return `${key}='${value.replace(/'/g, "\\'")}'`
  })
  const mount = path.join(options.dockerDir, 'volumes', 'functions')
  const runtimeMain = await fs.realpath(options.runtimeMainPath)
  await fs.mkdir(options.bundle.functionsMountPath, { recursive: true })
  const bundleRoot = await fs.realpath(options.bundle.functionsMountPath)
  const relative = path.relative(bundleRoot, runtimeMain)
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Trusted runtime dispatcher must come from outside the bundle')
  }
  if (!/^[a-f0-9]{64}$/.test(options.runtimeMainDigest)) throw new Error('Expected pinned runtime digest is required')
  const staging = await fs.mkdtemp(path.join(options.bundle.projectDir, '.runtime-'))
  try {
    const trustedMain = path.join(staging, 'trusted-main')
    await fs.cp(runtimeMain, trustedMain, { recursive: true })
    if (await runtimeTreeDigest(trustedMain) !== options.runtimeMainDigest) throw new Error('Trusted runtime dispatcher digest mismatch')
    const tree = path.join(staging, 'functions')
    try { await fs.cp(mount, tree, { recursive: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await fs.mkdir(tree, { recursive: true })
    }
    for (const entry of await fs.readdir(bundleRoot)) {
      if (entry === 'main') continue
      await fs.rm(path.join(tree, entry), { recursive: true, force: true })
      await fs.cp(path.join(bundleRoot, entry), path.join(tree, entry), { recursive: true })
    }
    await fs.rm(path.join(tree, 'main'), { recursive: true, force: true })
    await fs.cp(trustedMain, path.join(tree, 'main'), { recursive: true })
    if (await runtimeTreeDigest(path.join(tree, 'main')) !== options.runtimeMainDigest) throw new Error('Restored runtime dispatcher digest mismatch')
    await fs.mkdir(path.dirname(mount), { recursive: true })
    await fs.rm(mount, { recursive: true, force: true })
    await fs.rename(tree, mount)
    const envFile = path.join(staging, 'preview.env')
    await fs.writeFile(envFile, lines.join('\n') + '\n', { mode: 0o600 })
    await fs.rename(envFile, path.join(options.dockerDir, '.env'))
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
  return env
}
