import { promises as fs } from 'fs'
import * as path from 'path'
import { docker, run } from './run'

// Copies supabase-core/docker into <projectDir>/docker. Replaces the old
// `cp -r` / `xcopy` shell strings: symlinks are copied as links (like cp -r)
// and file modes are kept, so the release's entrypoint scripts stay
// executable.
export async function copyDockerTemplate(coreDockerDir: string, projectDir: string): Promise<string> {
  const dest = path.join(projectDir, 'docker')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.cp(coreDockerDir, dest, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  })
  return dest
}

// Remove a project directory. On Linux hosts running this app as a non-root
// service user, the docker bind-mount target dirs (e.g.
// supabase-projects/<slug>/docker/volumes/db/data) end up owned by the
// container's internal UID (often a system account like dhcpcd), so the
// service user can't remove them directly. In that case we fall back to a
// throwaway container running as root, which has the access to the bind-
// mount source dirs that the service user lacks.
export async function removeProjectDir(projectDir: string, projectsRoot: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await fs.rm(projectDir, { recursive: true, force: true })
    } else {
      await run('rm', ['-rf', '--', projectDir], { timeout: 60000 })
    }
  } catch (fsError) {
    if (process.platform !== 'win32') {
      const stillExists = await fs.access(projectDir).then(() => true).catch(() => false)
      if (stillExists) {
        console.warn(`Plain rm failed for ${projectDir}; falling back to docker helper for bind-mount cleanup`)
        await removeProjectDirViaDocker(projectDir, projectsRoot)
      }
    } else {
      console.warn('Failed to remove project directory:', fsError)
    }
  }
}

// Remove a project directory using a one-shot root-in-a-container helper.
// Mounts the projects root, not the entire SupaConsole tree, so a stray path
// can't reach prisma/supaconsole.db or supabase-core. The slug is validated
// against a strict regex and a containment check against the resolved
// projects root before the helper is invoked.
const CLEANUP_IMAGE = 'alpine:3.20'
// Slugs come from `createProject`, which lower-cases the name, replaces runs
// of non-[a-z0-9] with '-', and strips leading and trailing dashes. Legacy
// slugs in the database may still start with '-' (predating that change);
// the regex keeps accepting them so cleanup stays correct for old data.
// Empty, '.', and '..' are rejected explicitly.
const SLUG_RE = /^[a-z0-9-]+$/

async function removeProjectDirViaDocker(projectDir: string, projectsRootDir: string): Promise<void> {
  const projectsRoot = path.resolve(projectsRootDir)
  const resolved = path.resolve(projectDir)
  const slug = path.basename(resolved)

  if (slug === '' || slug === '.' || slug === '..' || !SLUG_RE.test(slug)) {
    throw new Error(`Refusing to clean up project directory: slug "${slug}" is not a valid slug`)
  }
  if (path.dirname(resolved) !== projectsRoot) {
    throw new Error(
      `Refusing to clean up project directory: ${resolved} is not a direct child of ${projectsRoot}`
    )
  }

  // Best-effort pull of a pinned image; ignore failure so the helper can
  // still run if the registry is unreachable and the image is already local.
  try {
    await docker(['pull', '--quiet', CLEANUP_IMAGE], { timeout: 120000 })
  } catch (pullError) {
    console.warn(`docker pull ${CLEANUP_IMAGE} failed (continuing if image is local):`, pullError)
  }

  // The `--` ends rm's option parsing so a slug that happens to look like a
  // flag (e.g. `-r`) is treated as a path.
  await docker(
    [
      'run', '--rm',
      '-v', `${projectsRoot}:/projects`,
      CLEANUP_IMAGE,
      'rm', '-rf', '--', `/projects/${slug}`,
    ],
    { timeout: 120000 }
  )

  const stillExists = await fs.access(resolved).then(() => true).catch(() => false)
  if (stillExists) {
    throw new Error(`Docker helper ran but ${resolved} still exists`)
  }
}
