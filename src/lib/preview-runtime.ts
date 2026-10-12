import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as engine from './engine'
import { ingestBundle } from './bundle-ingest'
import { importBundle, preparePreviewImport, PINNED_RUNTIME_MAIN_DIGEST } from './import-pipeline'
import { parseEnvExample } from './project'
import type { Project } from '@prisma/client'

export const PREVIEW_CORE_REF = 'self-hosted/v0.8.2'

export interface PreviewRuntime {
  provision(project: Project, tarball: Buffer, ports: Record<string, string>, persist: (env: Record<string, string>) => Promise<void>): Promise<void>
  destroy(project: Project): Promise<void>
}

export interface PreviewRuntimeOptions {
  coreDockerDir: string
  projectsRoot: string
  domain: string
  baselineVersion: string
}

export function createPreviewRuntime(options: PreviewRuntimeOptions): PreviewRuntime {
  function target(project: Project): engine.ComposeTarget {
    return { layout: 'override', profile: 'preview', projectName: project.slug,
      dockerDir: path.join(options.projectsRoot, project.slug, 'docker'),
      files: [engine.COMPOSE_FILE, engine.OVERRIDE_FILE, 'import-fence.yml'] }
  }
  return {
    async provision(project, tarball, ports, persist) {
      if (!/^\d{14}$/.test(options.baselineVersion)) throw new Error('Invalid pinned baseline version')
      const host = `${project.slug}.${options.domain}`
      const projectDir = path.join(options.projectsRoot, project.slug)
      const bundle = await ingestBundle({ tarball, projectDir })
      const dockerDir = await engine.copyDockerTemplate(options.coreDockerDir, projectDir)
      const env = await preparePreviewImport({ bundle, dockerDir, host, redirectPattern: `https://${host}/**`,
        runtimeMainPath: path.join(options.coreDockerDir, 'volumes/functions/main'),
        runtimeMainDigest: PINNED_RUNTIME_MAIN_DIGEST,
        environment: { ...Object.fromEntries(parseEnvExample(await fs.readFile(path.join(options.coreDockerDir, '.env.example'), 'utf8'))),
          ...ports, POSTGRES_PORT: '5432' } })
      await persist(env)
      const stack = target(project)
      await engine.writeProjectMeta(dockerDir, { layout: 'override', composeProject: project.slug, profile: 'preview', createdAt: new Date().toISOString() })
      await engine.writeOverride(stack)
      const services = await engine.listServices(dockerDir)
      const lines = ['services:', '  db:', '    networks: !override [import-fence]',
        '    ports: !reset []',
        '    command: [postgres, -c, config_file=/etc/postgresql/postgresql.conf, -c, cron.launch_active_jobs=off]']
      for (const service of services.filter(service => !['db', 'studio', 'meta', 'supavisor'].includes(service))) {
        lines.push(`  ${service}:`, '    networks:', '      default: {}', '      import-fence: {}')
      }
      lines.push('networks:', '  import-fence:', '    internal: true')
      await fs.writeFile(path.join(dockerDir, 'import-fence.yml'), lines.join('\n') + '\n')
      await engine.up(stack)
      const compose = ['compose', '-p', project.slug, ...stack.files.flatMap(file => ['-f', file])]
      const databaseUrl = `postgresql://postgres:${encodeURIComponent(env.POSTGRES_PASSWORD)}@db:5432/${env.POSTGRES_DB}?sslmode=disable`
      const result = await importBundle({ bundle, databaseUrl, baselineVersion: options.baselineVersion, seedUsers: [],
        fence: async () => {
          const network = await engine.docker(['network', 'inspect', `${project.slug}_import-fence`, '--format', '{{.Internal}}'])
          if (network.stdout.trim() !== 'true') throw new Error('Import network must be internal')
          const container = await engine.docker([...compose, 'ps', '-q', 'db'], { cwd: dockerDir })
          const attached = await engine.docker(['inspect', container.stdout.trim(), '--format', '{{json .NetworkSettings.Networks}}'])
          const networks = Object.keys(JSON.parse(attached.stdout))
          if (networks.length !== 1 || networks[0] !== `${project.slug}_import-fence`) throw new Error('Database escaped import fence')
        },
        execute: sql => engine.docker([...compose, 'exec', '-T', 'db', 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', env.POSTGRES_DB,
          '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { cwd: dockerDir, timeout: 60000, input: sql }),
      })
      if (result.status !== 'ready') throw result.failure
      const health = await engine.health(stack, env, { probeHost: '127.0.0.1' })
      if (!health.healthy) throw new Error('Preview health gate failed')
    },
    async destroy(project) {
      const stack = target(project)
      const exists = await fs.access(path.join(stack.dockerDir, engine.COMPOSE_FILE)).then(() => true).catch(() => false)
      if (exists) await engine.down(stack).catch(() => undefined)
      for (const resource of ['container', 'volume', 'network'] as const) {
        const list = await engine.docker(resource === 'container'
          ? ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project.slug}`]
          : [resource, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project.slug}`])
        const ids = list.stdout.split(/\s+/).filter(Boolean)
        if (ids.length) await engine.docker([resource, 'rm', ...(resource === 'container' ? ['-f', '-v'] : []), ...ids])
      }
      const projectDir = path.join(options.projectsRoot, project.slug)
      await engine.removeProjectDir(projectDir, options.projectsRoot)
      if (await fs.access(projectDir).then(() => true).catch(() => false)) throw new Error('Preview directory cleanup failed')
    },
  }
}
