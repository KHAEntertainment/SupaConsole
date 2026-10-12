import { expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { docker } from '@/lib/engine/run'
import { up, down, listServices } from '@/lib/engine/compose'
import { renderOverride } from '@/lib/engine/override'
import { removeProjectDir } from '@/lib/engine/files'
import { importBundle, preparePreviewImport, PINNED_RUNTIME_MAIN_DIGEST } from '@/lib/import-pipeline'

it.skipIf(process.env.T14_DOCKER_STACK_TEST !== '1')('starts the preview runtime with the environment template and imports through an isolated DB', async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 't14-stack-'))
  const projectDir = temporaryDir.toLowerCase()
  if (temporaryDir !== projectDir) await fs.rename(temporaryDir, projectDir)
  const name = path.basename(projectDir)
  const dockerDir = path.join(projectDir, 'docker')
  const target = { layout: 'override' as const, profile: 'preview' as const, dockerDir, projectName: name,
    files: ['docker-compose.yml', 'supaconsole.override.yml', 'import-fence.yml'] }
  try {
    const core = process.env.T14_CORE_DOCKER_DIR ?? 'supabase-core/docker'
    await fs.cp(core, dockerDir, { recursive: true })
    const supabaseDir = path.join(projectDir, 'supabase')
    await fs.cp('fixtures/preview-sample/supabase', supabaseDir, { recursive: true })
    const bundle = { projectDir, supabaseDir, migrationsDir: path.join(supabaseDir, 'migrations'),
      functionsMountPath: path.join(supabaseDir, 'functions'), configPath: null,
      seedPath: path.join(supabaseDir, 'seed.sql'), extracted: [] }
    const defaults: Record<string, string> = {}
    for (const line of (await fs.readFile(path.join(core, '.env.example'), 'utf8')).split('\n')) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (match) defaults[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
    const env = await preparePreviewImport({ bundle, dockerDir, host: 't14.example.invalid',
      redirectPattern: 'https://*.example.invalid/**', runtimeMainPath: path.join(core, 'volumes/functions/main'),
      runtimeMainDigest: PINNED_RUNTIME_MAIN_DIGEST, environment: {
        ...defaults, POSTGRES_PORT: '5432', API_GW_HTTP_PORT: '0', FUNCTIONS_VERIFY_JWT: 'true',
      } })
    const services = await listServices(dockerDir)
    await fs.writeFile(path.join(dockerDir, 'supaconsole.override.yml'), renderOverride({ profile: 'preview', services }))
    const lines = ['services:', '  db:', '    networks: !override [import-fence]',
      '    command: [postgres, -c, config_file=/etc/postgresql/postgresql.conf, -c, cron.launch_active_jobs=off]']
    for (const service of services.filter(service => !['db', 'studio', 'meta', 'supavisor'].includes(service))) {
      lines.push(`  ${service}:`, '    networks:', '      default: {}', '      import-fence: {}')
    }
    lines.push('networks:', '  import-fence:', '    internal: true')
    await fs.writeFile(path.join(dockerDir, 'import-fence.yml'), lines.join('\n') + '\n')
    await up(target)
    const compose = ['compose', '-p', name, ...target.files.flatMap(file => ['-f', file])]
    const { stdout: gateway } = await docker([...compose, 'port', 'api-gw', '8000'], { cwd: dockerDir })
    const url = `http://${gateway.trim()}`
    const execute = async (sql: string) => docker([...compose, 'exec', '-T', 'db', 'psql',
      '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: dockerDir })
    const result = await importBundle({ bundle, databaseUrl: 'postgresql://postgres@db:5432/postgres?sslmode=disable', baselineVersion: '20261008000400', execute,
      fence: async () => {
        expect((await docker(['network', 'inspect', `${name}_import-fence`, '--format', '{{.Internal}}'])).stdout.trim()).toBe('true')
      }, auth: { url, serviceRoleKey: env.SERVICE_ROLE_KEY },
      seedUsers: [{ email: 't14@example.invalid', password: 't14-synthetic-password' }] })
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'ready', usersCreated: 1 })
    const { stdout: authEnv } = await docker([...compose, 'exec', '-T', 'auth', 'printenv', 'API_EXTERNAL_URL', 'GOTRUE_SITE_URL', 'GOTRUE_MAILER_AUTOCONFIRM'], { cwd: dockerDir })
    expect(authEnv.trim()).toBe('https://t14.example.invalid\nhttps://t14.example.invalid\ntrue')
    let response: Response | undefined
    const deadline = Date.now() + 45000
    do {
      response = await fetch(`${url}/functions/v1/echo`, { headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${env.ANON_KEY}` }, signal: AbortSignal.timeout(5000) })
      if (response.ok) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    } while (Date.now() < deadline)
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ row: { id: 1, title: 'Synthetic title 1' } })
  } finally {
    await down(target)
    await removeProjectDir(projectDir, os.tmpdir())
  }
}, 180000)
