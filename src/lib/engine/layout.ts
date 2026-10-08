import { promises as fs } from 'fs'
import * as path from 'path'
import { docker } from './run'
import { OVERRIDE_FILE, type OverrideProfile } from './override'

// How a project's docker/ directory is laid out, which decides how compose is
// invoked for it:
//   override - created by this engine: unmodified upstream docker-compose.yml
//              plus a generated override, compose project = slug.
//   legacy   - created before the engine: docker-compose.yml was rewritten
//              with per-project container_names and a `name:`. Deployed with
//              its own file plus a minimal override; the compose project name
//              is whatever its containers were created under.
export type ProjectLayout = 'override' | 'legacy'

// Written into docker/ by createProject. Its presence is what marks a project
// as override-layout; every project without it is legacy.
export const PROJECT_META_FILE = '.supaconsole-project.json'
export const COMPOSE_FILE = 'docker-compose.yml'

export interface ProjectMeta {
  layout: 'override'
  composeProject: string
  profile: OverrideProfile
  createdAt: string
}

export interface ComposeTarget {
  layout: ProjectLayout
  dockerDir: string
  projectName: string
  // Override profile for override-layout projects (from the marker file).
  profile: OverrideProfile
  // Compose files in order, relative to dockerDir.
  files: string[]
}

// Compose project names: lowercase alphanumerics, '-' and '_', starting with
// a letter or digit (`docker compose -p` rejects anything else).
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name)
}

export async function writeProjectMeta(dockerDir: string, meta: ProjectMeta): Promise<void> {
  await fs.writeFile(path.join(dockerDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

export async function readProjectMeta(dockerDir: string): Promise<ProjectMeta | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dockerDir, PROJECT_META_FILE), 'utf8')
  } catch {
    return null
  }
  const meta = JSON.parse(raw) as Partial<ProjectMeta>
  if (meta.layout !== 'override' || typeof meta.composeProject !== 'string' || !isValidProjectName(meta.composeProject)) {
    throw new Error(`${PROJECT_META_FILE} in ${dockerDir} is malformed`)
  }
  return {
    layout: 'override',
    composeProject: meta.composeProject,
    profile: meta.profile === 'preview' ? 'preview' : 'persistent',
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
  }
}

// Read-only scans of a compose file, used only for legacy projects to find
// what the old regex rewrite produced. Nothing is ever written back.
export function declaredProjectName(composeContent: string): string | null {
  const match = composeContent.match(/^name:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m)
  return match ? match[1] : null
}

export function declaredContainerNames(composeContent: string): string[] {
  const names = new Set<string>()
  for (const match of composeContent.matchAll(/^\s*container_name:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)) {
    names.add(match[1])
  }
  return [...names]
}

export interface ContainerLabels {
  name: string
  project: string
  workingDir: string
}

export interface LegacyNameInput {
  slug: string
  dockerDir: string
  declaredName: string | null
  declaredContainerNames: string[]
  containers: ContainerLabels[]
}

export interface LegacyNameResult {
  projectName: string
  source: 'containers' | 'compose-name' | 'slug'
}

// The compose project a legacy project must be driven as. It has to equal the
// project its containers already carry, or compose won't adopt them and `up`
// fails on container_name conflicts. In order:
//   1. the com.docker.compose.project label on its existing containers (found
//      by compose's working_dir label, else by the declared container names);
//   2. the compose file's top-level `name:`;
//   3. the slug.
export function resolveLegacyProjectName(input: LegacyNameInput): LegacyNameResult {
  const dockerDir = path.resolve(input.dockerDir)
  const byDir = input.containers.filter((c) => c.workingDir && path.resolve(c.workingDir) === dockerDir)
  const declared = new Set(input.declaredContainerNames)
  const byName = input.containers.filter((c) => declared.has(c.name))

  for (const group of [byDir, byName]) {
    const projects = [...new Set(group.map((c) => c.project).filter(Boolean))]
    if (projects.length > 1) {
      throw new Error(
        `Containers for ${dockerDir} belong to more than one compose project (${projects.join(', ')}); refusing to guess`
      )
    }
    if (projects.length === 1) {
      if (!isValidProjectName(projects[0])) {
        throw new Error(`Existing containers carry an unusable compose project name: ${projects[0]}`)
      }
      return { projectName: projects[0], source: 'containers' }
    }
  }
  if (input.declaredName && isValidProjectName(input.declaredName)) {
    return { projectName: input.declaredName, source: 'compose-name' }
  }
  return { projectName: input.slug, source: 'slug' }
}

// Every container on the host with its compose labels (one docker call;
// containers outside compose come back with empty labels).
export async function listContainerLabels(): Promise<ContainerLabels[]> {
  const { stdout } = await docker(
    [
      'ps', '-a', '--no-trunc',
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    { timeout: 60000 }
  )
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name = '', project = '', workingDir = ''] = line.split('\t')
      return { name, project, workingDir }
    })
}

export async function resolveTarget(dockerDir: string, slug: string): Promise<ComposeTarget> {
  const meta = await readProjectMeta(dockerDir)
  if (meta) {
    return {
      layout: 'override',
      dockerDir,
      projectName: meta.composeProject,
      profile: meta.profile,
      files: [COMPOSE_FILE, OVERRIDE_FILE],
    }
  }

  const compose = await fs.readFile(path.join(dockerDir, COMPOSE_FILE), 'utf8')
  const { projectName, source } = resolveLegacyProjectName({
    slug,
    dockerDir,
    declaredName: declaredProjectName(compose),
    declaredContainerNames: declaredContainerNames(compose),
    containers: await listContainerLabels(),
  })
  console.log(`Legacy project ${slug}: compose project "${projectName}" (from ${source})`)
  return { layout: 'legacy', dockerDir, projectName, profile: 'persistent', files: [COMPOSE_FILE, OVERRIDE_FILE] }
}
