import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHmac } from 'crypto'
import { assertSqlOnly } from '@/lib/import-sql'
import { importBundle, preparePreviewImport, runtimeTreeDigest } from '@/lib/import-pipeline'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 't14-security-'))
  dirs.push(projectDir)
  const supabaseDir = path.join(projectDir, 'supabase')
  const functionsMountPath = path.join(supabaseDir, 'functions')
  const migrationsDir = path.join(supabaseDir, 'migrations')
  await fs.mkdir(functionsMountPath, { recursive: true })
  await fs.mkdir(migrationsDir)
  await fs.writeFile(path.join(migrationsDir, '20261008000400_baseline.sql'), 'select 4;')
  const dockerDir = path.join(projectDir, 'docker')
  const runtimeMainPath = path.join(projectDir, 'trusted/main')
  await fs.mkdir(runtimeMainPath, { recursive: true })
  await fs.writeFile(path.join(runtimeMainPath, 'index.ts'), 'trusted dispatcher')
  const bundle = { projectDir, supabaseDir, functionsMountPath, migrationsDir, seedPath: null, configPath: null, extracted: [] }
  return { bundle, dockerDir, runtimeMainPath, runtimeMainDigest: await runtimeTreeDigest(runtimeMainPath),
    host: 'pr-1.example.invalid', redirectPattern: 'https://*.example.invalid/**', environment: {} }
}
const connection = { databaseUrl: 'postgresql://postgres:local@localhost/postgres?sslmode=disable', baselineVersion: '20261008000400', fence: async () => {} }
it.each(['select 1; \\! touch /tmp/PWNED', 'select 1;   \\i evil', 'select 1; \\copy t to program\'evil\'',
  'select 1; \\o evil', 'select 1; \\w evil', 'select 1; \\g', 'select 1; \\connect evil',
  '-- comment\r\\! touch evil', '\\restrict abc'])('rejects unquoted psql commands: %s', sql => {
  expect(() => assertSqlOnly(sql)).toThrow()
})
it.each([
  "select 'a\\b', 'it''s \\! safe';", 'select "a\\b", "double""quote";',
  "select E'a\\\'b\\!';", 'select $$ \\! $$;', 'select $body$ \\i evil $body$;',
  '-- \\! comment\nselect 1;', '/* outer /* \\! nested */ \\i */ select 1;',
])('allows backslashes within SQL quoting and comments: %s', sql => {
  expect(() => assertSqlOnly(sql)).not.toThrow()
})
it('rejects dangerous migration content before any adapter executes it', async () => {
  const { bundle } = await fixture()
  const dangerous = 'select 1; \\! touch /tmp/PWNED'
  await fs.writeFile(path.join(bundle.migrationsDir, '20261008000400_baseline.sql'), dangerous)
  const execute = vi.fn<(sql: string) => Promise<{ stdout: string; stderr: string }>>().mockResolvedValue({ stdout: '', stderr: '' })
  const result = await importBundle({ ...connection, bundle, execute })
  expect(result).toMatchObject({ status: 'failed', failure: { code: 'PSQL_METACOMMAND' } })
  expect(execute.mock.calls.some(args => args[0] === dangerous)).toBe(false)
})
it('preserves existing runtime functions and overrides a bundled dispatcher with digest-verified main', async () => {
  const options = await fixture()
  const mount = path.join(options.dockerDir, 'volumes/functions')
  await fs.mkdir(path.join(mount, 'health'), { recursive: true })
  await fs.writeFile(path.join(mount, 'health/index.ts'), 'runtime health')
  await fs.mkdir(path.join(options.bundle.functionsMountPath, 'main'))
  await fs.writeFile(path.join(options.bundle.functionsMountPath, 'main/index.ts'), 'malicious dispatcher')
  await fs.mkdir(path.join(options.bundle.functionsMountPath, 'echo'))
  await fs.writeFile(path.join(options.bundle.functionsMountPath, 'echo/index.ts'), 'bundle echo')
  await preparePreviewImport(options)
  expect(await fs.readFile(path.join(mount, 'health/index.ts'), 'utf8')).toBe('runtime health')
  expect(await fs.readFile(path.join(mount, 'echo/index.ts'), 'utf8')).toBe('bundle echo')
  expect(await runtimeTreeDigest(path.join(mount, 'main'))).toBe(options.runtimeMainDigest)
})
it('restores a trusted dispatcher when ingestion and the runtime share a mount', async () => {
  const options = await fixture()
  const mount = path.join(options.dockerDir, 'volumes/functions')
  await fs.mkdir(path.join(mount, 'main'), { recursive: true })
  await fs.writeFile(path.join(mount, 'main/index.ts'), 'uploaded dispatcher')
  options.bundle.functionsMountPath = mount
  await expect(preparePreviewImport({ ...options, runtimeMainPath: path.join(mount, 'main') })).rejects.toThrow('outside the bundle')
  await preparePreviewImport(options)
  expect(await runtimeTreeDigest(path.join(mount, 'main'))).toBe(options.runtimeMainDigest)
})
it('fails closed on a tampered trusted dispatcher before touching the runtime or env', async () => {
  const options = await fixture()
  await fs.writeFile(path.join(options.runtimeMainPath, 'index.ts'), 'tampered source')
  await expect(preparePreviewImport(options)).rejects.toThrow('digest mismatch')
  await expect(fs.access(path.join(options.dockerDir, '.env'))).rejects.toThrow()
})
it('drops production env values, creates fresh credentials and signs working destination JWTs', async () => {
  const options = await fixture()
  const secretKeys = ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SECRET_KEY_BASE', 'VAULT_ENC_KEY',
    'POSTGRES_PASSWORD', 'DASHBOARD_PASSWORD', 'POOLER_TENANT_ID', 'LOGFLARE_PRIVATE_ACCESS_TOKEN',
    'REALTIME_DB_ENC_KEY', 'PG_META_CRYPTO_KEY', 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'MINIO_ROOT_PASSWORD',
    'SUPABASE_SECRET_KEY', 'JWT_KEYS', 'JWT_JWKS', 'SERVICE_ROLE_KEY_ASYMMETRIC']
  const source = Object.fromEntries(secretKeys.map(key => [key, 'production-secret']))
  const first = await preparePreviewImport({ ...options, environment: { ...source, GOOGLE_SECRET: 'production-secret',
    UNKNOWN_PROVIDER_API_KEY: 'production-secret', API_GW_HTTP_PORT: '8001' } })
  const second = await preparePreviewImport({ ...options, environment: source })
  expect(Object.values(first)).not.toContain('production-secret')
  expect(first.API_GW_HTTP_PORT).toBe('8001')
  expect(first.GOOGLE_SECRET).toBeUndefined()
  for (const key of secretKeys.slice(0, 9)) expect(first[key]).not.toBe(second[key])
  for (const [key, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']]) {
    const [header, payload, signature] = first[key].split('.')
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).role).toBe(role)
    expect(signature).toBe(createHmac('sha256', first.JWT_SECRET).update(`${header}.${payload}`).digest('base64url'))
  }
})
it('uses an explicit timestamp boundary with arbitrary numbers of migrations', async () => {
  const { bundle } = await fixture()
  for (const version of ['20261008000100', '20261008000500', '20261008000600']) {
    await fs.writeFile(path.join(bundle.migrationsDir, `${version}_extra.sql`), 'select 1;')
  }
  const result = await importBundle({ ...connection, bundle, execute: async sql => ({ stdout: sql.startsWith('select count(*)') ? '0\n0' : '', stderr: '' }) })
  expect(result).toMatchObject({ status: 'ready', baseline: ['20261008000100_extra.sql', '20261008000400_baseline.sql'],
    delta: ['20261008000500_extra.sql', '20261008000600_extra.sql'] })
})
it('retains an internal cause and safe code without serializing diagnostic secrets', async () => {
  const { bundle } = await fixture()
  const cause = Object.assign(new Error('production-secret'), { code: 3 })
  const result = await importBundle({ ...connection, bundle, rolesSql: 'create role custom;',
    execute: async sql => { if (sql.startsWith('create role')) throw cause; return { stdout: '', stderr: '' } } })
  expect(result).toMatchObject({ status: 'failed', failure: { code: 'PROCESS_EXIT_3' } })
  if (result.status === 'failed') expect(result.failure.cause).toBe(cause)
  expect(JSON.stringify(result)).not.toContain('production-secret')
})
