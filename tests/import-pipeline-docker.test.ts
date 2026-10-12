import { expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { run } from '@/lib/engine/run'
import { importBundle, preparePreviewImport, PINNED_RUNTIME_MAIN_DIGEST } from '@/lib/import-pipeline'

it.skipIf(process.env.T14_DOCKER_TEST !== '1')('replays fixture on an internal-network Supabase DB, rejects broken SQL and destroys the project', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 't14-docker-'))
  const name = `t14-${Date.now()}`
  const network = `${name}-internal`
  try {
    await run('docker', ['network', 'create', '--internal', network])
    await run('docker', ['run', '-d', '--name', name, '--network', network,
      '-e', 'POSTGRES_PASSWORD=t14-synthetic-only',
      'supabase/postgres:17.6.1.136', 'postgres', '-c', 'config_file=/etc/postgresql/postgresql.conf',
      '-c', 'cron.launch_active_jobs=off'])
    const supabaseDir = path.join(projectDir, 'supabase')
    await fs.cp('fixtures/preview-sample/supabase', supabaseDir, { recursive: true })
    const bundle = { projectDir, supabaseDir, migrationsDir: path.join(supabaseDir, 'migrations'),
      functionsMountPath: path.join(supabaseDir, 'functions'), configPath: null,
      seedPath: path.join(supabaseDir, 'seed.sql'), extracted: [] }
    const dockerDir = path.join(projectDir, 'docker')
    await fs.mkdir(dockerDir)
    const env = await preparePreviewImport({ bundle, dockerDir, host: 't14.example.invalid',
      redirectPattern: 'https://*.example.invalid/**', environment: {},
      runtimeMainDigest: PINNED_RUNTIME_MAIN_DIGEST, runtimeMainPath: path.join(process.env.T14_CORE_DOCKER_DIR ?? 'supabase-core/docker', 'volumes/functions/main') })
    expect(env.API_EXTERNAL_URL).toBe('https://t14.example.invalid')
    const execute = async (sql: string) => run('docker', ['exec', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres',
      '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql], { timeout: 15000 })
    const fence = async () => {
      const { stdout } = await run('docker', ['network', 'inspect', network, '--format', '{{.Internal}}'])
      expect(stdout.trim()).toBe('true')
    }
    const options = { bundle, databaseUrl: 'postgresql://postgres:t14-synthetic-only@localhost:5432/postgres?sslmode=disable', baselineVersion: '20261008000400', fence, execute }
    const result = await importBundle(options)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'ready', seeded: true })
    expect((await execute('select count(*) from public.sample_catalog;')).stdout.trim()).toBe('301')
    expect((await execute('select count(*) from cron.job where active; select count(*) from net.http_request_queue;')).stdout.trim()).toBe('0\n0')
    expect((await execute("select count(*) from net._http_response where status_code is not null;")).stdout.trim()).toBe('0')
    await fs.writeFile(path.join(bundle.migrationsDir, '20261008000100_catalog.sql'), 'this is deliberately invalid SQL;')
    const broken = await importBundle(options)
    expect(broken).toMatchObject({ status: 'failed', stage: 'baseline:20261008000100_catalog.sql' })
  } finally {
    await run('docker', ['rm', '-f', '-v', name]).catch(() => {})
    await run('docker', ['network', 'rm', network]).catch(() => {})
    await fs.rm(projectDir, { recursive: true, force: true })
  }
  expect((await run('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim()).toBe('')
}, 120000)
