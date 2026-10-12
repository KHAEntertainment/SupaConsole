import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { filterRoleDump, importBundle, databaseEnvironment, preparePreviewImport, runtimeTreeDigest } from '@/lib/import-pipeline'
import type { IngestBundleResult } from '@/lib/bundle-ingest'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
async function bundle(): Promise<IngestBundleResult> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-test-'))
  dirs.push(projectDir)
  const supabaseDir = path.join(projectDir, 'supabase')
  await fs.cp('fixtures/preview-sample/supabase', supabaseDir, { recursive: true })
  return { projectDir, supabaseDir, migrationsDir: path.join(supabaseDir, 'migrations'),
    functionsMountPath: path.join(supabaseDir, 'functions'), seedPath: path.join(supabaseDir, 'seed.sql'),
    configPath: path.join(supabaseDir, 'config.toml'), extracted: [] }
}
const databaseUrl = 'postgresql://postgres.preview:never-log-me@127.0.0.1:5432/postgres?sslmode=disable'
describe('import pipeline', () => {
  it('uses session pooler identity without putting credentials in a URL', () => {
    expect(databaseEnvironment(databaseUrl)).toMatchObject({ PGUSER: 'postgres.preview', PGSSLMODE: 'disable', PGPASSWORD: 'never-log-me' })
  })
  it('filters only the managed parameter grant', () => {
    expect(filterRoleDump('CREATE ROLE custom;\nGRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";\nGRANT custom TO postgres;')).toBe('CREATE ROLE custom;\n\nGRANT custom TO postgres;')
  })
  it('fences first, retries readiness, resets privileges, replays baseline/delta and uses admin API', async () => {
    const calls: string[] = []
    let attempts = 0
    const execute = vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === 'select 1;' && attempts++ === 0) throw new Error('restart')
      return { stdout: sql.startsWith('select count(*)') ? '0\n0\n' : '', stderr: '' }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await importBundle({ bundle: await bundle(), databaseUrl, baselineVersion: '20261008000400',
      fence: async () => { calls.push('fence') }, execute, fetch: fetcher,
      seedUsers: [{ email: 'test@example.invalid', password: 'synthetic' }],
      auth: { url: 'http://localhost:8000', serviceRoleKey: 'synthetic' } })
    expect(result).toMatchObject({ status: 'ready', usersCreated: 1, seeded: true })
    if (result.status === 'ready') { expect(result.baseline).toHaveLength(4); expect(result.delta).toHaveLength(1) }
    expect(calls[0]).toBe('fence')
    expect(calls[3]).toContain('alter default privileges')
    expect(calls[4]).toContain('cron.alter_job')
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:8000/auth/v1/admin/users')
  })
  it('fails immediately on a broken migration without seeding or becoming ready', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('create table public.sample_categories')) throw new Error('never-log-me')
      return { stdout: '', stderr: '' }
    })
    const result = await importBundle({ bundle: await bundle(), databaseUrl, baselineVersion: '20261008000400', fence: async () => {}, execute })
    expect(result).toMatchObject({ status: 'failed', stage: 'baseline:20261008000100_catalog.sql' })
    expect(JSON.stringify(result)).not.toContain('never-log-me')
    expect(execute.mock.calls.some(([sql]) => sql.includes('insert into public.sample_categories'))).toBe(false)
  })

  it('requires a successful egress fence and never starts SQL when it fails', async () => {
    const execute = vi.fn()
    expect(await importBundle({ bundle: await bundle(), databaseUrl, baselineVersion: '20261008000400', execute,
      fence: async () => { throw new Error('No isolation') } })).toMatchObject({ status: 'failed', stage: 'fence' })
    expect(execute).not.toHaveBeenCalled()
  })
  it('pipes a migration larger than 128 KiB to the default psql adapter stdin', async () => {
    const input = await bundle()
    const payload = 'large-sql-payload-'.repeat(9000)
    await fs.writeFile(path.join(input.migrationsDir, '20261008000600_large_delta.sql'),
      `create table public.stdin_import_probe (payload text not null);\ninsert into public.stdin_import_probe(payload) values ('${payload}');\n`)
    const psqlDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-psql-'))
    dirs.push(psqlDir)
    const logPath = path.join(psqlDir, 'calls.jsonl')
    const psqlPath = path.join(psqlDir, 'psql')
    await fs.writeFile(psqlPath, `#!/usr/bin/env node
let sql = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => sql += chunk);
process.stdin.on('end', () => {
  require('node:fs').appendFileSync(process.env.PSQL_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), sql }) + '\\n');
  if (sql.includes('select count(*) from cron.job where active;')) process.stdout.write('0\\n0');
});
`)
    await fs.chmod(psqlPath, 0o755)
    const originalPath = process.env.PATH
    const originalLogPath = process.env.PSQL_TEST_LOG
    process.env.PATH = `${psqlDir}${path.delimiter}${originalPath ?? ''}`
    process.env.PSQL_TEST_LOG = logPath

    try {
      const result = await importBundle({ bundle: input, databaseUrl, baselineVersion: '20261008000400', fence: async () => {} })

      expect(result).toMatchObject({ status: 'ready' })
      const calls = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; sql: string })
      const largeCall = calls.find(call => call.sql.includes(payload))
      expect(largeCall).toBeDefined()
      expect(largeCall?.args).toContain('-f')
      expect(largeCall?.args).toContain('-')
      expect(largeCall?.args).not.toContain(payload)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalLogPath === undefined) delete process.env.PSQL_TEST_LOG
      else process.env.PSQL_TEST_LOG = originalLogPath
    }
  })
  it('restores filtered roles and schema after privilege reset, then applies only delta without optional seed', async () => {
    const input = await bundle()
    const execute = vi.fn(async (sql: string) => ({ stdout: sql.startsWith('select count(*)') ? '0\n0' : '', stderr: '' }))
    expect(await importBundle({ bundle: { ...input, seedPath: null }, databaseUrl, baselineVersion: '20261008000400', fence: async () => {}, execute,
      rolesSql: 'CREATE ROLE custom;\nGRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
      schemaSql: "select 'restoring schema';" })).toMatchObject({ status: 'ready', seeded: false, usersCreated: 0 })
    const calls = execute.mock.calls.map(([sql]) => sql)
    expect(calls[1]).toContain('alter default privileges')
    expect(calls[3]).toBe('CREATE ROLE custom;\n')
    expect(calls[4]).toContain('cron.alter_job')
    expect(calls.some(sql => sql.includes('create table public.sample_categories'))).toBe(false)
    expect(calls.some(sql => sql.includes('alter table public.sample_catalog add column'))).toBe(true)
  })
  it('writes preview URLs, strips provider secrets and mounts functions before startup', async () => {
    const input = await bundle()
    const dockerDir = path.join(input.projectDir, 'docker')
    await fs.mkdir(path.join(dockerDir, 'volumes/functions/main'), { recursive: true })
    await fs.writeFile(path.join(dockerDir, 'volumes/functions/main/index.ts'), 'trusted runtime')
    const runtimeMainPath = path.join(dockerDir, 'volumes/functions/main')
    const runtimeMainDigest = await runtimeTreeDigest(runtimeMainPath)
    const env = await preparePreviewImport({ bundle: input, dockerDir, runtimeMainPath, runtimeMainDigest, host: 'pr-1.example.com',
      redirectPattern: 'https://*.example.com/**', environment: { POSTGRES_PASSWORD: 'local', EXTERNAL_GITHUB_SECRET: 'production', SMTP_PASS: 'production' } })
    expect(env).toMatchObject({ API_EXTERNAL_URL: 'https://pr-1.example.com', SAML_EXTERNAL_URL: 'https://pr-1.example.com', ENABLE_EMAIL_AUTOCONFIRM: 'true', SMTP_PASS: '' })
    expect(await fs.readFile(path.join(dockerDir, '.env'), 'utf8')).not.toContain('production')
    expect(await fs.readdir(path.join(dockerDir, 'volumes/functions'))).toContain('echo')
  })
})
