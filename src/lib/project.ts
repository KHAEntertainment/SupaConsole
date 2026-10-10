import { promises as fs } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { prisma } from './db'
import * as engine from './engine'
import { createProjectWithPorts, PORT_KEYS } from './ports'

const execFileAsync = promisify(execFile)

// The Supabase release projects are created from. Overridable with
// SUPABASE_CORE_REF (a tag, branch or commit SHA); this default is upstream's
// newest self-hosted tag as of 2026-10-05, the release the compatibility fix
// was tested against (Postgres 17.6.1.136, Envoy v1.39.1, GoTrue v2.196.0,
// PostgREST v14.17).
const DEFAULT_CORE_REF = 'self-hosted/v0.8.2'

// Written inside supabase-core/ at clone time so later Initialize calls can
// tell which ref the checkout is at without guessing from branch names.
const CORE_META_FILE = '.supaconsole-core.json'

// Helper functions for generating secure defaults
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Signs a real HS256 JWT with the project's JWT_SECRET.
// Supabase validates the anon/service_role keys as HS256 JWTs against
// JWT_SECRET (PostgREST, GoTrue and Realtime all reject a bad signature),
// so these MUST be genuinely signed rather than carrying a placeholder.
function generateJWT(role: 'anon' | 'service_role', secret: string, timestamp: number): string {
  const issuedAt = Math.floor(timestamp / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    role,
    iss: 'supabase',
    iat: issuedAt,
    exp: issuedAt + (365 * 24 * 60 * 60),
  }))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

// Reads KEY=value pairs out of the upstream .env.example that ships inside
// supabase-core/docker. Using this as the source of truth means new Supabase
// releases are picked up automatically instead of requiring code changes.
export function parseEnvExample(content: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim().replace(/^#\s?/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    vars.set(key, value)
  }
  return vars
}

// Accepts either a plain repository URL or a full `git clone ...` command as
// documented in the README, and returns just the repository URL.
function normalizeRepoUrl(raw: string): string {
  const value = raw.trim().replace(/^["']|["']$/g, '')
  const cloneMatch = value.match(/^git\s+clone\b.*?(\S+)$/i)
  const url = (cloneMatch ? cloneMatch[1] : value).trim()
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    throw new Error(`SUPABASE_CORE_REPO_URL must be an http(s) or ssh repository URL, received: ${url}`)
  }
  return url
}

// A clone is only usable if the docker directory we actually copy projects from
// is present, so an interrupted clone is detected and retried rather than being
// mistaken for a finished workspace.
async function isUsableSupabaseCore(coreDir: string): Promise<boolean> {
  const dockerCompose = path.join(coreDir, 'docker', 'docker-compose.yml')
  return fs.access(dockerCompose).then(() => true).catch(() => false)
}

// The configured release ref (tag, branch or commit SHA). Validated here
// because it is passed to git as an argument.
async function normalizeCoreRef(raw: string, coreDir: string, repoUrl: string): Promise<string> {
  const value = raw.trim().replace(/^["']|["']$/g, '')
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.length > 255
  ) {
    throw new Error(`SUPABASE_CORE_REF must be a tag, branch or commit SHA, received: ${value}`)
  }
  // A 7-39 character hex string is a short SHA only when it is not also a real
  // ref name (a tag called `deadbeef` clones fine), so look for an exact
  // refs/heads/<ref> or refs/tags/<ref> in the existing checkout and on the
  // remote before refusing. Commit refs are accepted only in full:
  // `git fetch origin <sha>` only takes full SHAs, and a short SHA of a
  // historical commit cannot be expanded from advertised refs at all.
  if (/^[0-9a-fA-F]{7,39}$/.test(value) && !(await isRefName(value, coreDir, repoUrl))) {
    throw new Error(
      `SUPABASE_CORE_REF commit SHAs must be the full 40 characters (short SHAs are not supported), received: ${value}`
    )
  }
  return value
}

async function configuredCoreRef(coreDir: string, repoUrl: string): Promise<string> {
  return normalizeCoreRef(process.env.SUPABASE_CORE_REF || DEFAULT_CORE_REF, coreDir, repoUrl)
}

function isCommitSha(ref: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(ref)
}

// Is this exact name a branch or a tag? Checked in the existing checkout and
// against the remote's advertised refs (exact ref names, no DWIM). Distinguishes
// a hex-named ref from an abbreviated SHA.
async function isRefName(ref: string, coreDir: string, repoUrl: string): Promise<boolean> {
  if (await git(['rev-parse', '--verify', `refs/heads/${ref}`], coreDir)) return true
  if (await git(['rev-parse', '--verify', `refs/tags/${ref}`], coreDir)) return true
  const listed = await git(
    ['ls-remote', repoUrl, `refs/heads/${ref}`, `refs/tags/${ref}`],
    process.cwd()
  )
  if (!listed) return false
  for (const line of listed.split('\n')) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/)
    if (match && (match[2] === `refs/heads/${ref}` || match[2] === `refs/tags/${ref}`)) return true
  }
  return false
}

// Runs git in the given directory, returning trimmed stdout, or null when the
// command fails (missing directory, not a git checkout, ref not present...).
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

// Which ref and commit is the local supabase-core checkout at? The meta file
// written at clone time is authoritative, but only while the checkout is still
// at the commit it was cloned at: a later checkout, reset or pull to another
// commit leaves the meta behind, so its ref name no longer describes the files.
// Without a trustworthy meta (checkouts made by older versions, or by hand)
// fall back to asking git.
export interface SupabaseCoreInfo {
  ref: string | null
  commit: string | null
  source: 'meta' | 'git' | 'stale-meta' | 'none'
}

export async function readSupabaseCoreInfo(coreDir: string): Promise<SupabaseCoreInfo> {
  const commit = await git(['rev-parse', 'HEAD'], coreDir)
  try {
    const raw = await fs.readFile(path.join(coreDir, CORE_META_FILE), 'utf8')
    const meta = JSON.parse(raw) as { ref?: unknown; commit?: unknown }
    if (typeof meta.ref === 'string' && meta.ref) {
      const metaCommit = typeof meta.commit === 'string' ? meta.commit.toLowerCase() : null
      // Trust the recorded ref only when HEAD is still exactly where the clone
      // left it; otherwise the meta is stale and the ref is unverifiable.
      if (metaCommit && commit && metaCommit === commit.toLowerCase()) {
        return { ref: meta.ref, commit, source: 'meta' }
      }
      return { ref: null, commit, source: 'stale-meta' }
    }
  } catch {
    // No meta file: derive the ref from the checkout itself.
  }
  // Derive a candidate name (a local branch, else an exact tag) and verify it
  // resolves back to HEAD under the clone's own precedence; a name that points
  // elsewhere is ambiguous (a branch and a tag may share it) and is not
  // recorded.
  let candidate: string | null = null
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], coreDir)
  if (branch && branch !== 'HEAD') candidate = branch
  if (!candidate) candidate = await git(['describe', '--tags', '--exact-match', 'HEAD'], coreDir)
  if (candidate && commit) {
    const resolved = await resolveLocalRefCommit(coreDir, candidate)
    if (resolved && resolved !== 'ambiguous' && resolved.toLowerCase() === commit.toLowerCase()) {
      return { ref: candidate, commit, source: 'git' }
    }
  }
  return { ref: null, commit, source: 'none' }
}

// Local half of ref resolution, in the same precedence `git clone --branch`
// uses: refs/heads/<ref> first, then refs/tags/<ref> peeled to its commit.
// When there is no local head and a remote-tracking branch and a same-name tag
// point at different commits, the name is ambiguous: the remote-tracking ref
// may be stale (upstream may have deleted the branch since), so neither side
// can be picked safely. Report 'ambiguous' and let callers treat the checkout
// as unverifiable rather than silently preferring one.
type LocalRefResolution = string | 'ambiguous' | null

async function resolveLocalRefCommit(coreDir: string, ref: string): Promise<LocalRefResolution> {
  const head = await git(['rev-parse', '--verify', `refs/heads/${ref}^{commit}`], coreDir)
  if (head) return head
  const tracking = await git(['rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`], coreDir)
  const tag = await git(['rev-parse', '--verify', `refs/tags/${ref}^{commit}`], coreDir)
  if (tracking && tag && tracking.toLowerCase() !== tag.toLowerCase()) return 'ambiguous'
  return tracking ?? tag
}

// Resolves a ref name to a commit SHA without cloning: locally first (works
// offline for refs already fetched), then against the remote with exact ref
// names. Precedence is explicit and matches `git clone --branch`: heads first,
// then peeled tags. An ambiguous local name is not resolved from the remote
// either: the checkout is unverifiable, not wrong-but-guessable.
async function resolveRefCommit(
  coreDir: string,
  repoUrl: string,
  ref: string
): Promise<LocalRefResolution> {
  const local = await resolveLocalRefCommit(coreDir, ref)
  if (local) return local

  // ls-remote prints the tag object for an annotated tag and its peeled commit
  // on a separate `^{}` line; match exact ref names rather than taking the
  // first peeled row seen.
  const listed = await git(
    ['ls-remote', repoUrl, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    process.cwd()
  )
  if (!listed) return null
  const lines = new Map<string, string>()
  for (const line of listed.split('\n')) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/)
    if (match) lines.set(match[2], match[1])
  }
  return (
    lines.get(`refs/heads/${ref}`) ??
    lines.get(`refs/tags/${ref}^{}`) ??
    lines.get(`refs/tags/${ref}`) ??
    null
  )
}

// How does the existing checkout relate to the configured ref?
//   match     - same ref (or the configured commit SHA); Initialize is a no-op
//   mismatch  - provably a different ref; report it, never re-clone
//   unknown   - the checkout's ref cannot be verified against the configured one
type CoreRefCheck = 'match' | 'mismatch' | 'unknown'

async function checkCoreRef(
  coreDir: string,
  info: SupabaseCoreInfo,
  configuredRef: string,
  repoUrl: string
): Promise<CoreRefCheck> {
  // A stale meta proves nothing about the current checkout: the files on disk
  // may be anything checked out since the clone. Report unverifiable.
  if (info.source === 'stale-meta') return 'unknown'
  // Name equality is only sound for a meta-recorded ref (the clone was made
  // from exactly this name at exactly this commit); an ambiguous name must go
  // through resolution below.
  if (info.source === 'meta' && info.ref === configuredRef) return 'match'
  if (info.commit && isCommitSha(configuredRef)) {
    return info.commit.toLowerCase() === configuredRef.toLowerCase() ? 'match' : 'mismatch'
  }
  // The configured ref may point at the checkout's commit under another name
  // (same tag fetched twice, or a commit checked out by another ref).
  const resolved = await resolveRefCommit(coreDir, repoUrl, configuredRef)
  if (resolved === 'ambiguous') return 'unknown'
  if (resolved && info.commit) {
    return resolved.toLowerCase() === info.commit.toLowerCase() ? 'match' : 'mismatch'
  }
  return info.ref !== null ? 'mismatch' : 'unknown'
}

export async function initializeSupabaseCore(): Promise<
  | { success: true; ref: string; commit: string | null }
  | { success: false; error: string; code?: 'REF_MISMATCH' }
> {
  const coreDir = path.join(process.cwd(), 'supabase-core')
  const projectsDir = path.join(process.cwd(), 'supabase-projects')
  const stagingDir = path.join(process.cwd(), '.supabase-core-incoming')

  try {
    const projectsExists = await fs.access(projectsDir).then(() => true).catch(() => false)

    if (!projectsExists) {
      await fs.mkdir(projectsDir, { recursive: true })
    }

    const repoUrl = normalizeRepoUrl(
      process.env.SUPABASE_CORE_REPO_URL || 'https://github.com/supabase/supabase'
    )
    const configuredRef = await configuredCoreRef(coreDir, repoUrl)

    if (await isUsableSupabaseCore(coreDir)) {
      const info = await readSupabaseCoreInfo(coreDir)
      const check = await checkCoreRef(coreDir, info, configuredRef, repoUrl)
      if (check === 'match') {
        return { success: true, ref: configuredRef, commit: info.commit }
      }
      const at = info.ref
        ? `ref "${info.ref}"`
        : info.commit
          ? `commit ${info.commit.slice(0, 12)}`
          : 'an unverifiable checkout'
      const detail =
        check === 'mismatch'
          ? `supabase-core already exists at ${at} but SUPABASE_CORE_REF is "${configuredRef}"`
          : `supabase-core already exists (${at}) and could not be verified against SUPABASE_CORE_REF "${configuredRef}"`
      return {
        success: false,
        code: 'REF_MISMATCH',
        error: `${detail}. Refusing to re-clone over an existing checkout: existing projects keep the files they were created from. To re-initialize at the configured ref, remove or rename the supabase-core directory and initialize again.`,
      }
    }

    // An earlier attempt may have been interrupted part-way through, leaving a
    // directory that exists but has no usable checkout.
    if (await fs.access(coreDir).then(() => true).catch(() => false)) {
      console.warn('Existing supabase-core directory is incomplete, re-cloning')
      await fs.rm(coreDir, { recursive: true, force: true })
    }

    // Clone to a staging directory and move it into place only once complete, so
    // an interrupted clone can never leave a half-populated supabase-core.
    await fs.rm(stagingDir, { recursive: true, force: true })
    console.log(`Cloning Supabase core at ${configuredRef} from ${repoUrl}...`)
    if (isCommitSha(configuredRef)) {
      // A commit SHA is not a ref `git clone --branch` can take, so fetch just
      // that commit into a fresh repository instead. Commit refs are accepted
      // only as full 40-character SHAs (normalizeCoreRef rejects abbreviated
      // SHAs), which `git fetch` can resolve directly.
      await fs.mkdir(stagingDir, { recursive: true })
      await execFileAsync('git', ['init'], { cwd: stagingDir, timeout: 60000 })
      await execFileAsync('git', ['remote', 'add', 'origin', repoUrl], { cwd: stagingDir, timeout: 60000 })
      await execFileAsync('git', ['fetch', '--depth', '1', 'origin', configuredRef], {
        cwd: stagingDir,
        timeout: 1800000,
        maxBuffer: 10 * 1024 * 1024,
      })
      await execFileAsync('git', ['checkout', '--detach', 'FETCH_HEAD'], {
        cwd: stagingDir,
        timeout: 60000,
      })
    } else {
      // Shallow clone of the tag or branch; a shallow clone of a tag is enough
      // because projects only copy the docker/ directory out of it.
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--branch', configuredRef, repoUrl, stagingDir],
        { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 }
      )
    }

    if (!(await isUsableSupabaseCore(stagingDir))) {
      throw new Error('Clone finished but docker/docker-compose.yml is missing from the Supabase repository')
    }

    // Validate the clone: it must resolve to a commit, and a SHA-configured ref
    // must be the commit that was fetched. FETCH_HEAD is also accepted because
    // an annotated tag's object SHA fetches fine and peels to its commit.
    const commit = await git(['rev-parse', 'HEAD'], stagingDir)
    const fetchedRev = await git(['rev-parse', 'FETCH_HEAD'], stagingDir)
    if (!commit) {
      throw new Error('Clone finished but the checked-out commit could not be resolved')
    }
    if (
      isCommitSha(configuredRef) &&
      commit.toLowerCase() !== configuredRef.toLowerCase() &&
      (fetchedRev ?? '').toLowerCase() !== configuredRef.toLowerCase()
    ) {
      throw new Error(
        `Clone of ${configuredRef} resolved to commit ${commit}, which does not match the requested ref`
      )
    }

    // Record the resolved ref and commit so later Initialize calls can detect a
    // changed SUPABASE_CORE_REF without re-cloning.
    await fs.writeFile(
      path.join(stagingDir, CORE_META_FILE),
      JSON.stringify({ ref: configuredRef, commit, repoUrl, clonedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    )

    await fs.rename(stagingDir, coreDir)

    return { success: true, ref: configuredRef, commit }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    console.error('Failed to initialize Supabase core:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function createProject(name: string, userId: string, description?: string) {
  let allocatedProjectId: string | undefined
  let allocatedProjectDir: string | undefined
  try {
    // Keep names safe for Compose and use a UUID so same-name concurrent
    // requests cannot share a directory or collide on the unique slug.
    const timestamp = Date.now()
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const slug = `${baseSlug || 'project'}-${crypto.randomUUID()}`

    // Record which Supabase release this project's docker files come from. The
    // ref is recorded only when the checkout verifies against it (meta at its
    // own commit, or an unambiguous git ref); a legacy or detached checkout
    // records the commit alone and shows as "unknown". The commit is always
    // the live checkout the files were copied from. Rows from before this was
    // tracked simply stay null.
    const coreInfo = await readSupabaseCoreInfo(path.join(process.cwd(), 'supabase-core'))

    const coreDockerDir = path.join(process.cwd(), 'supabase-core', 'docker')
    const upstreamEnv = parseEnvExample(await fs.readFile(path.join(coreDockerDir, '.env.example'), 'utf8'))
    if (!upstreamEnv.has('API_GW_HTTP_PORT') && !upstreamEnv.has('KONG_HTTP_PORT')) {
      throw new Error('Supabase template has no gateway port key')
    }
    const { project, ports } = await createProjectWithPorts(prisma, {
      name, slug, description, ownerId: userId,
      supabaseRef: coreInfo.ref, supabaseCommit: coreInfo.commit,
    }, PORT_KEYS.filter(key => upstreamEnv.has(key)))
    const projectDir = path.join(process.cwd(), 'supabase-projects', slug)
    allocatedProjectId = project.id
    allocatedProjectDir = projectDir
    const dockerDir = await engine.copyDockerTemplate(coreDockerDir, projectDir)

    const jwtSecret = generateRandomString(64)
    const publicUrl = `http://localhost:${ports.API_GW_HTTP_PORT || ports.KONG_HTTP_PORT}`
    const tenantId = `project-${project.id}`

    // Values SupaConsole must own: credentials, signing material, and identity.
    const overrides: Record<string, string> = {
      POSTGRES_PASSWORD: generateRandomString(32),
      JWT_SECRET: jwtSecret,
      ANON_KEY: generateJWT('anon', jwtSecret, timestamp),
      SERVICE_ROLE_KEY: generateJWT('service_role', jwtSecret, timestamp),
      SECRET_KEY_BASE: generateRandomString(64),
      VAULT_ENC_KEY: generateRandomString(32),
      // Realtime encrypts with AES-128, so this must be exactly 16 characters.
      REALTIME_DB_ENC_KEY: generateRandomString(16),
      // pgcrypto requires this to be at least 32 characters.
      PG_META_CRYPTO_KEY: generateRandomString(32),
      DASHBOARD_USERNAME: 'supabase',
      DASHBOARD_PASSWORD: generateRandomString(16),
      MINIO_ROOT_USER: 'supabase',
      MINIO_ROOT_PASSWORD: generateRandomString(32),
      S3_PROTOCOL_ACCESS_KEY_ID: generateRandomString(24),
      S3_PROTOCOL_ACCESS_KEY_SECRET: generateRandomString(64),
      LOGFLARE_PUBLIC_ACCESS_TOKEN: generateRandomString(64),
      LOGFLARE_PRIVATE_ACCESS_TOKEN: generateRandomString(64),

      // Identity / tenancy
      POSTGRES_HOST: 'db',
      POSTGRES_DB: 'postgres',
      POOLER_TENANT_ID: tenantId,
      STORAGE_TENANT_ID: tenantId,
      REGION: 'local',
      GLOBAL_S3_BUCKET: 'stub',

      // Public URLs must follow this project's allocated gateway port.
      SUPABASE_PUBLIC_URL: publicUrl,
      API_EXTERNAL_URL: publicUrl,
      SITE_URL: publicUrl,
      PROXY_DOMAIN: publicUrl,
      SAML_EXTERNAL_URL: `${publicUrl}/auth/v1`,

      // Upstream ships SAML_ENABLED=true alongside a placeholder private key.
      // Enabling it with a non-key makes GoTrue fail to parse it, so keep SAML
      // off until a real key is supplied.
      SAML_ENABLED: 'false',
      SAML_PRIVATE_KEY: '',
      SAML_ALLOW_ENCRYPTED_ASSERTIONS: 'false',

      // Keep phone sign-up usable with the local mail catcher.
      SMTP_ADMIN_EMAIL: 'admin@example.com',
      SMTP_HOST: 'supabase-mail',
      SMTP_PORT: '2500',
      SMTP_USER: 'fake_mail_user',
      SMTP_PASS: 'fake_mail_password',
      SMTP_SENDER_NAME: 'fake_sender',
      SMS_PROVIDER: 'twilio',
      SMS_TEST_OTP: '123456',

      OPENAI_API_KEY: '',
      ADDITIONAL_REDIRECT_URLS: '',
    }

    // Upstream defaults, with SupaConsole's overrides applied on top. Port keys
    // are only written when the current release actually defines them, which
    // avoids resurrecting variables upstream has retired.
    const defaultEnvVars: Record<string, string> = {}
    for (const [key, upstreamValue] of upstreamEnv) {
      if (key in ports) {
        defaultEnvVars[key] = ports[key]
      } else if (key in overrides) {
        defaultEnvVars[key] = overrides[key]
      } else {
        defaultEnvVars[key] = upstreamValue
      }
    }
    // Overrides for keys this Supabase release does not define are still written
    // so older or newer compose files keep working.
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in defaultEnvVars)) defaultEnvVars[key] = value
    }
    
    // Write initial .env file with unique defaults
    const envFilePath = path.join(dockerDir, '.env')
    const envContent = Object.entries(defaultEnvVars)
      .map(([key, value]) => `${key}=${dotenvValue(value)}`)
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)

    // Mark the project as override-layout (compose project = slug) and render
    // its override now, so the directory is complete before the first deploy.
    // Deploy re-renders it from the compose file on disk, so a failure here
    // (rendering asks the docker CLI for the service list) doesn't fail the
    // create, which never needed Docker before.
    await engine.writeProjectMeta(dockerDir, {
      layout: 'override',
      composeProject: slug,
      profile: 'persistent',
      createdAt: new Date(timestamp).toISOString(),
    })
    try {
      await engine.writeOverride(await engine.resolveTarget(dockerDir, slug))
    } catch (renderError) {
      console.warn('Could not render the compose override yet; deploy will render it:', renderError)
    }
    
    // Save environment variables to database
    for (const [key, value] of Object.entries(defaultEnvVars)) {
      await prisma.projectEnvVar.upsert({
        where: { projectId_key: { projectId: project.id, key } },
        create: { projectId: project.id, key, value },
        update: { value },
      })
    }
    
    return { success: true, project }
  } catch (error) {
    if (allocatedProjectId) {
      const cleanup = await Promise.allSettled([
        prisma.project.delete({ where: { id: allocatedProjectId } }),
        fs.rm(allocatedProjectDir!, { recursive: true, force: true }),
      ])
      for (const result of cleanup) {
        if (result.status === 'rejected') console.error('Failed to clean up incomplete project:', result.reason)
      }
    }
    console.error('Failed to create project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

function dotenvValue(value: string): string {
  return JSON.stringify(value.replace(/\$/g, '$$$$'))
}

function numericEnvPort(value: string): number {
  return Number(value.split('#', 1)[0].trim().replace(/^['"]|['"]$/g, '').trim())
}

export async function updateProjectEnvVars(projectId: string, envVars: Record<string, string>) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    // A dotenv value must occupy one line: otherwise another variable could
    // be injected into the generated file without updating its DB reservation.
    for (const [key, value] of Object.entries(envVars)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new Error('Environment variables require valid keys and single-line string values')
      }
    }

    // Published ports stay reserved for the lifetime of the project.
    const storedPorts = await prisma.projectEnvVar.findMany({
      where: { projectId, key: { in: [...PORT_KEYS] } },
    })
    const reservations = await prisma.allocatedPort.findMany({ where: { projectId } })
    const reservedPorts = new Set(reservations.map(row => row.port))
    // The configure UI also submits compatibility defaults absent from the
    // template. Only values backed by this project's reservations are fixed.
    for (const row of storedPorts) {
      const storedPort = numericEnvPort(row.value)
      if (reservedPorts.has(storedPort) && row.key in envVars && envVars[row.key] !== row.value) {
        throw new Error('Published ports cannot be changed; create a new project to allocate new ports')
      }
    }

    for (const [key, value] of Object.entries(envVars)) {
      if (!PORT_KEYS.some(portKey => portKey === key)) continue
      const reservation = await prisma.allocatedPort.findUnique({ where: { port: numericEnvPort(value) } })
      if (reservation && reservation.projectId !== projectId) {
        throw new Error('Port is reserved by another project')
      }
    }

    // Update environment variables in database
    for (const [key, value] of Object.entries(envVars)) {
      await prisma.projectEnvVar.upsert({
        where: {
          projectId_key: {
            projectId,
            key,
          },
        },
        update: { value },
        create: {
          projectId,
          key,
          value,
        },
      })
    }
    
    // Update .env file in project directory. Compose needs every variable the
    // release defines, so merge over what is already stored instead of writing
    // only the submitted subset.
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    const envFilePath = path.join(projectDir, '.env')

    const stored = await prisma.projectEnvVar.findMany({ where: { projectId } })
    const merged: Record<string, string> = {}
    for (const row of stored) {
      merged[row.key] = row.value
    }
    for (const [key, value] of Object.entries(envVars)) {
      merged[key] = value
    }

    const envContent = Object.entries(merged)
      .map(([key, value]) => {
        const port = numericEnvPort(value)
        const fileValue = PORT_KEYS.some(portKey => portKey === key) && reservedPorts.has(port)
          ? String(port) : value
        // Quote values so quotes, comments and backslashes cannot change the
        // meaning of later dotenv assignments. Legacy quoted ports emit digits.
        return `${key}=${dotenvValue(fileValue)}`
      })
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)
    
    return { success: true }
  } catch (error) {
    console.error('Failed to update project env vars:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// How long deploy waits for the project to become healthy. A cold first boot
// (fresh database init, realtime creating its slot) takes a few minutes.
function healthTimeoutMs(): number {
  const raw = Number(process.env.SUPACONSOLE_HEALTH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : engine.DEFAULT_HEALTH_TIMEOUT_MS
}

export async function deployProject(projectId: string): Promise<{
  success: boolean
  error?: string
  health?: engine.HealthResult
}> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const dockerDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    
    // Run pre-flight checks
    console.log('Running pre-flight checks...')
    const checks = await engine.checkDockerPrerequisites()
    
    if (!checks.docker) {
      throw new Error('Docker is not installed or not running. Please install Docker Desktop and ensure it is started before deploying.')
    }
    
    if (!checks.dockerCompose) {
      throw new Error('Docker Compose is not available. Please ensure Docker Desktop includes Docker Compose or install it separately.')
    }

    // New projects get their override re-rendered from the compose file on
    // disk; legacy projects (rewritten compose file) get the realtime-alias
    // override and keep their compose project and container names.
    const target = await engine.resolveTarget(dockerDir, project.slug)
    await engine.writeOverride(target)
    
    // Try to run Docker commands with better error handling
    try {
      // Only pull images if we have internet connectivity
      if (checks.internetConnection) {
        console.log('Attempting to pull latest Docker images...')
        try {
          await engine.pull(target)
        } catch (pullError) {
          console.warn('Failed to pull some images, will try to use existing/cached images:', pullError)
          // Continue with deployment even if pull fails
        }
      } else {
        console.warn('No internet connectivity detected, using cached Docker images')
      }
      
      // Start the services
      console.log('Starting Supabase services...')
      await engine.up(target)
      
    } catch (composeError) {
      // If the main docker compose command fails, provide better error message
      const errorMessage = composeError instanceof Error ? composeError.message : 'Unknown Docker error'
      
      if (errorMessage.includes('maxBuffer length exceeded')) {
        throw new Error('Docker deployment generated too much output. This usually means the deployment is working but Docker is downloading many large images. Please wait a few more minutes and check Docker Desktop to see if containers are starting. You can also try running "docker compose up -d" manually in the project directory.')
      } else if (errorMessage.includes('no such host') || errorMessage.includes('dial tcp')) {
        throw new Error('Network connectivity issue: Unable to reach Docker registry. This might be due to:\n\n1. Internet connection issues\n2. Corporate firewall blocking Docker registry\n3. DNS resolution problems\n\nSolution: Try running "docker pull supabase/postgres" manually to test connectivity, or work with your IT team to allow access to Docker Hub.')
      } else if (errorMessage.includes('permission denied')) {
        throw new Error('Docker permission denied. Please ensure:\n\n1. Docker Desktop is running\n2. Your user is in the "docker" group (Linux/Mac)\n3. You have administrator privileges (Windows)')
      } else if (errorMessage.includes('not found')) {
        throw new Error('Docker or Docker Compose not found. Please install Docker Desktop from https://docker.com/products/docker-desktop')
      } else if (errorMessage.includes('image') && errorMessage.includes('not found')) {
        throw new Error('Required Docker images not found. Please ensure you have internet connectivity and try again, or manually pull images with "docker compose pull"')
      } else {
        throw new Error(`Docker deployment failed: ${errorMessage}`)
      }
    }
    
    // `up` returning only means compose created the containers. Wait (bounded)
    // until the project actually serves clients: containers healthy, DB
    // reachable through the pooler, gateway, auth, REST and a realtime
    // round-trip, which also warms realtime for the first real subscriber.
    const stored = await prisma.projectEnvVar.findMany({ where: { projectId } })
    const env: Record<string, string> = {}
    for (const row of stored) env[row.key] = row.value
    console.log('Waiting for the project to become healthy...')
    const health = await engine.health(target, env, {
      timeoutMs: healthTimeoutMs(),
      probeHost: process.env.SUPACONSOLE_PROBE_HOST,
    })
    try {
      await engine.writeHealth(dockerDir, health)
    } catch (writeError) {
      console.warn('Could not record the health result:', writeError)
    }
    for (const check of health.checks) {
      console.log(`  health ${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.ms}ms, ${check.attempts} attempt(s)): ${check.detail}`)
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { status: health.healthy ? 'active' : 'unhealthy' },
    })

    if (!health.healthy) {
      return {
        success: false,
        error: `Deployment unhealthy after ${Math.round(health.ms / 1000)}s: ${engine.describeFailure(health)}`,
        health,
      }
    }
    return { success: true, health }
  } catch (error) {
    console.error('Failed to deploy project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function pauseProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const dockerDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    
    // Stop Docker containers
    await engine.stop(await engine.resolveTarget(dockerDir, project.slug))
    
    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'paused' },
    })
    
    return { success: true }
  } catch (error) {
    console.error('Failed to pause project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deleteProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectsRoot = path.join(process.cwd(), 'supabase-projects')
    const projectDir = path.join(projectsRoot, project.slug)
    const dockerDir = path.join(projectDir, 'docker')

    // Step 1: Stop and remove Docker containers, volumes and networks, under
    // the same compose project and files the project was deployed with.
    try {
      console.log(`Stopping Docker containers for project ${project.slug}...`)
      const composeExists = await fs.access(path.join(dockerDir, engine.COMPOSE_FILE)).then(() => true).catch(error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (composeExists) {
        await engine.down(await engine.resolveTarget(dockerDir, project.slug))
      } else {
        const meta = await engine.readProjectMeta(dockerDir)
        const labels = new Set([
          `com.docker.compose.project=${project.slug}`,
          `com.docker.compose.project.working_dir=${dockerDir}`,
        ])
        if (meta) labels.add(`com.docker.compose.project=${meta.composeProject}`)
        for (const label of labels) {
          const containers = await engine.docker([
            'ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}',
          ])
          if (containers.stdout.trim()) throw new Error('Project containers remain but compose file is missing')
        }
      }
    } catch (dockerError) {
      console.error('Failed to stop Docker containers; retaining project and port reservations:', dockerError)
      throw new Error('Failed to stop project containers; project and ports retained')
    }

    // Step 2: Remove project directory (with a root-in-a-container fallback
    // for bind-mount dirs the service user can't delete; see engine/files.ts).
    console.log(`Removing project directory: ${projectDir}`)
    await engine.removeProjectDir(projectDir, projectsRoot)

    // Step 3: Clean up database records
    try {
      // Preserve contested legacy reservations before the owner's cascading
      // delete. The transfer and delete commit together.
      await prisma.$transaction(async tx => {
        const ownedPorts = await tx.allocatedPort.findMany({ where: { projectId } })
        for (const { port } of ownedPorts) {
          const claimant = await tx.$queryRaw<{ projectId: string }[]>`
            WITH published_env AS (
              SELECT env.projectId, projects.createdAt, trim(trim(trim(
                CASE WHEN instr(env.value, '#') > 0 THEN substr(env.value, 1, instr(env.value, '#') - 1) ELSE env.value END,
                ' ' || char(9) || char(10) || char(13)), '"' || char(39)),
                ' ' || char(9) || char(10) || char(13)) AS numericPort
              FROM project_env_vars AS env JOIN projects ON projects.id = env.projectId
              WHERE env.projectId <> ${projectId}
                AND (env.key IN ('API_GW_HTTP_PORT', 'KONG_HTTP_PORT', 'POSTGRES_PORT', 'POOLER_PROXY_PORT_TRANSACTION')
                  OR (env.key = 'KONG_HTTPS_PORT' AND NOT EXISTS (
                    SELECT 1 FROM project_env_vars AS gateway
                    WHERE gateway.projectId = env.projectId AND gateway.key = 'API_GW_HTTP_PORT'
                  )))
            )
            SELECT DISTINCT projectId FROM published_env
            WHERE numericPort <> '' AND numericPort NOT GLOB '*[^0-9]*'
              AND CAST(numericPort AS INTEGER) BETWEEN 1 AND 65535
              AND CAST(numericPort AS INTEGER) = ${port}
            ORDER BY createdAt, projectId LIMIT 1
          `
          if (claimant[0]) {
            await tx.allocatedPort.update({ where: { port }, data: { projectId: claimant[0].projectId } })
          }
        }
        await tx.project.delete({ where: { id: projectId } })
      })
    } catch (dbError) {
      console.error('Failed to clean up database records:', dbError)
      throw new Error('Failed to remove project from database')
    }

    console.log(`Project ${project.slug} deleted successfully`)
    return { success: true }
  } catch (error) {
    console.error('Failed to delete project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
