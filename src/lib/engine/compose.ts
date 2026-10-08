import { promises as fs } from 'fs'
import * as path from 'path'
import { docker } from './run'
import { COMPOSE_FILE, type ComposeTarget } from './layout'
import { OVERRIDE_FILE, renderLegacyOverride, renderOverride } from './override'

const BUFFER = 1024 * 1024 * 10

// `docker compose -p <project> -f <file>... <subcommand...>`. Files that are
// missing on disk are skipped, so `down` still works for a half-created
// project directory.
async function composeArgs(target: ComposeTarget, sub: string[]): Promise<string[]> {
  const args = ['compose', '-p', target.projectName]
  for (const file of target.files) {
    const exists = await fs.access(path.join(target.dockerDir, file)).then(() => true).catch(() => false)
    if (exists) args.push('-f', file)
  }
  return [...args, ...sub]
}

async function compose(target: ComposeTarget, sub: string[], timeout: number) {
  return docker(await composeArgs(target, sub), { cwd: target.dockerDir, timeout, maxBuffer: BUFFER })
}

// The services compose itself sees in the upstream file (no override), so the
// generated override always matches the release the project was copied from.
export async function listServices(dockerDir: string): Promise<string[]> {
  const { stdout } = await docker(['compose', '-f', COMPOSE_FILE, 'config', '--services'], {
    cwd: dockerDir,
    timeout: 60000,
    maxBuffer: BUFFER,
  })
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

// (Re)writes the override for this target from the compose file on disk.
export async function writeOverride(target: ComposeTarget): Promise<void> {
  const services = await listServices(target.dockerDir)
  const content =
    target.layout === 'legacy'
      ? renderLegacyOverride(services)
      : renderOverride({ profile: target.profile, services })
  await fs.writeFile(path.join(target.dockerDir, OVERRIDE_FILE), content, 'utf8')
}

export async function pull(target: ComposeTarget): Promise<void> {
  await compose(target, ['pull'], 300000)
}

export async function up(target: ComposeTarget): Promise<void> {
  await compose(target, ['up', '-d', '--remove-orphans'], 300000)
}

export async function stop(target: ComposeTarget): Promise<void> {
  await compose(target, ['stop'], 120000)
}

export async function down(target: ComposeTarget): Promise<void> {
  await compose(target, ['down', '--volumes', '--remove-orphans'], 120000)
}

export interface ServiceState {
  Name: string
  Service: string
  State: string
  Health?: string
}

// Compose prints one JSON object per line (older releases print an array).
export async function ps(target: ComposeTarget): Promise<ServiceState[]> {
  const { stdout } = await compose(target, ['ps', '-a', '--format', 'json'], 60000)
  const text = stdout.trim()
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text) as ServiceState[]
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ServiceState)
}
