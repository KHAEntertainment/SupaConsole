import { promises as fs } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { prisma } from './db'

const execAsync = promisify(exec)
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
function parseEnvExample(content: string): Map<string, string> {
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

// Extracts every container_name declared in the compose file so the
// per-project renaming stays correct as services are added or removed
// upstream (e.g. supabase-kong -> supabase-envoy).
function extractContainerNames(composeContent: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of composeContent.matchAll(/^\s*container_name:\s*(\S+)\s*$/gm)) {
    const name = match[1].replace(/^["']|["']$/g, '')
    if (name && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

// Pre-flight checks for Docker deployment
async function checkDockerPrerequisites() {
  const checks = {
    docker: false,
    dockerCompose: false,
    internetConnection: false,
  }
  
  try {
    await execAsync('docker --version')
    checks.docker = true
  } catch {
    // Docker not available
  }
  
  try {
    await execAsync('docker compose version')
    checks.dockerCompose = true
  } catch {
    // Docker Compose not available
  }
  
  // Multi-layered internet connectivity check
  checks.internetConnection = await checkInternetConnectivity()
  
  return checks
}

// Improved internet connectivity check using multiple methods
async function checkInternetConnectivity(): Promise<boolean> {
  // Method 1: HTTP connectivity test to multiple reliable endpoints
  const httpEndpoints = [
    'https://www.google.com',
    'https://1.1.1.1', // Cloudflare DNS
    'https://8.8.8.8', // Google DNS
  ]
  
  for (const endpoint of httpEndpoints) {
    try {
      // Use curl for HTTP connectivity test with short timeout
      await execAsync(`curl -s --max-time 10 --head ${endpoint}`, { timeout: 15000 })
      return true // If any endpoint succeeds, we have internet
    } catch {
      // Try next endpoint
      continue
    }
  }
  
  // Method 2: DNS resolution test
  try {
    await execAsync('nslookup google.com', { timeout: 10000 })
    return true
  } catch {
    // DNS resolution failed
  }
  
  // Method 3: Ping test (as fallback)
  try {
    const pingCommand = process.platform === 'win32' 
      ? 'ping -n 1 8.8.8.8' 
      : 'ping -c 1 8.8.8.8'
    await execAsync(pingCommand, { timeout: 10000 })
    return true
  } catch {
    // Ping failed
  }
  
  // Method 4: Docker registry connectivity (original method as last resort)
  try {
    await execAsync('docker pull alpine:latest', { 
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for Docker pull
    })
    return true
  } catch {
    // All methods failed
  }
  
  return false
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
  try {
    // Generate unique slug
    const timestamp = Date.now()
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${timestamp}`

    // Record which Supabase release this project's docker files come from. The
    // ref is recorded only when the checkout verifies against it (meta at its
    // own commit, or an unambiguous git ref); a legacy or detached checkout
    // records the commit alone and shows as "unknown". The commit is always
    // the live checkout the files were copied from. Rows from before this was
    // tracked simply stay null.
    const coreInfo = await readSupabaseCoreInfo(path.join(process.cwd(), 'supabase-core'))

    // Create project in database
    const project = await prisma.project.create({
      data: {
        name,
        slug,
        description,
        ownerId: userId,
        supabaseRef: coreInfo.ref,
        supabaseCommit: coreInfo.commit,
      },
    })
    
    // Create project directory
    const projectDir = path.join(process.cwd(), 'supabase-projects', slug)
    const coreDockerDir = path.join(process.cwd(), 'supabase-core', 'docker')
    
    // Copy docker folder from supabase-core
    await fs.mkdir(projectDir, { recursive: true })
    
    // Use cross-platform copy command
    const isWindows = process.platform === 'win32'
    const copyCommand = isWindows 
      ? `xcopy "${coreDockerDir}" "${path.join(projectDir, 'docker')}" /E /I /H /K`
      : `cp -r "${coreDockerDir}" "${projectDir}/"`
      
    await execAsync(copyCommand)
    
    // Customize docker-compose.yml with unique container names
    const dockerComposeFile = path.join(projectDir, 'docker', 'docker-compose.yml')
    let dockerComposeContent = await fs.readFile(dockerComposeFile, 'utf8')
    
    // Replace container names with project-specific names. Names are read from
    // the compose file itself so new/renamed upstream services (for example
    // supabase-kong becoming supabase-envoy) are handled without code changes.
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    for (const containerName of extractContainerNames(dockerComposeContent)) {
      const suffix = containerName
        .replace(/^supabase-/, '')
        .replace(/^realtime-dev\./, '')
      const replacement = containerName.startsWith('realtime-dev.')
        ? `realtime-dev.${slug}-${suffix}`
        : `${slug}-${suffix}`

      dockerComposeContent = dockerComposeContent.replace(
        new RegExp(`(container_name:\\s*)${escapeRegExp(containerName)}\\b`, 'g'),
        `$1${replacement}`
      )
    }

    // Update the compose project name to be unique
    dockerComposeContent = dockerComposeContent.replace(
      /^name:\s*\S+\s*$/m,
      `name: ${slug}`
    )
    
    
    // Write the modified docker-compose.yml back
    await fs.writeFile(dockerComposeFile, dockerComposeContent)
    
    // Generate unique default port values to prevent conflicts between projects.
    // Each key is offset from a per-project base so concurrent projects never collide.
    const basePort = 8000 + (timestamp % 10000)
    const portOffsets: Record<string, number> = {
      API_GW_HTTP_PORT: 0,
      KONG_HTTP_PORT: 0,
      KONG_HTTPS_PORT: 443,
      STUDIO_PORT: 100,
      ANALYTICS_PORT: 1000,
      POSTGRES_PORT: 2000,
      POOLER_PROXY_PORT_TRANSACTION: 3000,
    }

    // Build the environment from the .env.example that ships with the cloned
    // Supabase release, so every variable the current compose file expects is
    // present with a sane value, then override the ones SupaConsole owns.
    const envExampleFile = path.join(coreDockerDir, '.env.example')
    const upstreamEnv = parseEnvExample(await fs.readFile(envExampleFile, 'utf8'))

    const jwtSecret = generateRandomString(64)
    const publicUrl = `http://localhost:${basePort}`
    const tenantId = `project-${timestamp}`

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
      if (key in portOffsets) {
        defaultEnvVars[key] = (basePort + portOffsets[key]).toString()
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
    const envFilePath = path.join(projectDir, 'docker', '.env')
    const envContent = Object.entries(defaultEnvVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)
    
    // Save environment variables to database
    for (const [key, value] of Object.entries(defaultEnvVars)) {
      await prisma.projectEnvVar.create({
        data: {
          projectId: project.id,
          key,
          value,
        },
      })
    }
    
    return { success: true, project }
  } catch (error) {
    console.error('Failed to create project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function updateProjectEnvVars(projectId: string, envVars: Record<string, string>) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
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
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)
    
    return { success: true }
  } catch (error) {
    console.error('Failed to update project env vars:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deployProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    
    // Run pre-flight checks
    console.log('Running pre-flight checks...')
    const checks = await checkDockerPrerequisites()
    
    if (!checks.docker) {
      throw new Error('Docker is not installed or not running. Please install Docker Desktop and ensure it is started before deploying.')
    }
    
    if (!checks.dockerCompose) {
      throw new Error('Docker Compose is not available. Please ensure Docker Desktop includes Docker Compose or install it separately.')
    }
    
    // Try to run Docker commands with better error handling
    try {
      // Only pull images if we have internet connectivity
      if (checks.internetConnection) {
        console.log('Attempting to pull latest Docker images...')
        try {
          await execAsync('docker compose pull', { 
            cwd: projectDir, 
            timeout: 300000, // 5 minute timeout
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
          })
        } catch (pullError) {
          console.warn('Failed to pull some images, will try to use existing/cached images:', pullError)
          // Continue with deployment even if pull fails
        }
      } else {
        console.warn('No internet connectivity detected, using cached Docker images')
      }
      
      // Start the services
      console.log('Starting Supabase services...')
      await execAsync('docker compose up -d --remove-orphans', { 
        cwd: projectDir, 
        timeout: 300000, // 5 minute timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      })
      
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
    
    // Verify that containers are running
    try {
      const { stdout } = await execAsync('docker compose ps --format json', { 
        cwd: projectDir,
        maxBuffer: 1024 * 1024 * 2 // 2MB buffer for container status
      })
      const containers = JSON.parse(`[${stdout.trim().split('\n').join(',')}]`)
      const runningContainers = containers.filter((c: { State: string }) => c.State === 'running')
      console.log(`Deployment successful: ${runningContainers.length} containers running`)
    } catch {
      console.warn('Could not verify container status, but deployment may have succeeded')
    }
    
    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'active' },
    })
    
    return { success: true }
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
    
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    
    // Stop Docker containers
    await execAsync('docker compose stop', { cwd: projectDir })
    
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

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug)
    const dockerDir = path.join(projectDir, 'docker')

    // Step 1: Stop and remove Docker containers
    try {
      console.log(`Stopping Docker containers for project ${project.slug}...`)
      await execAsync('docker compose down --volumes --remove-orphans', {
        cwd: dockerDir,
        timeout: 120000, // 2 minutes timeout
        maxBuffer: 1024 * 1024 * 5 // 5MB buffer
      })
    } catch (dockerError) {
      console.warn('Failed to stop Docker containers (they may not be running):', dockerError)
      // Continue with deletion even if Docker cleanup fails
    }

    // Step 2: Remove project directory. The plain rm path still works on hosts
    // where the service runs as root, and is the simplest cleanup on macOS or
    // on hosts without bind-mounts. On Linux hosts running this app as a
    // non-root service user, the docker bind-mount target dirs (e.g.
    // supabase-projects/<slug>/docker/volumes/db/data) end up owned by the
    // container's internal UID (often a system account like dhcpcd), so the
    // service user can't remove them directly. In that case we fall back to a
    // throwaway container running as root, which has the access to the bind-
    // mount source dirs that the service user lacks.
    try {
      console.log(`Removing project directory: ${projectDir}`)
      const isWindows = process.platform === 'win32'
      if (isWindows) {
        await execAsync(`rmdir /s /q "${projectDir}"`, { timeout: 60000 })
      } else {
        await execFileAsync('rm', ['-rf', '--', projectDir], { timeout: 60000 })
      }
    } catch (fsError) {
      if (process.platform !== 'win32') {
        const stillExists = await fs.access(projectDir).then(() => true).catch(() => false)
        if (stillExists) {
          console.warn(`Plain rm failed for ${projectDir}; falling back to docker helper for bind-mount cleanup`)
          await removeProjectDirViaDocker(projectDir)
        }
      } else {
        console.warn('Failed to remove project directory:', fsError)
      }
    }

    // Step 3: Clean up database records
    try {
      // Delete project environment variables
      await prisma.projectEnvVar.deleteMany({
        where: { projectId },
      })

      // Delete the project itself
      await prisma.project.delete({
        where: { id: projectId },
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

// Remove a project directory using a one-shot root-in-a-container helper.
// Used when the service user can't delete docker bind-mount source dirs
// directly (see the comment in deleteProject). Mounts the projects root
// (resolved relative to cwd), not the entire SupaConsole tree, so a stray
// path can't reach prisma/supaconsole.db or supabase-core. The slug is
// validated against a strict regex and a containment check against the
// resolved projects root before the helper is invoked.
const PROJECTS_ROOT_NAME = 'supabase-projects'
const CLEANUP_IMAGE = 'alpine:3.20'
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

async function removeProjectDirViaDocker(projectDir: string): Promise<void> {
  const cwd = process.cwd()
  const projectsRoot = path.resolve(cwd, PROJECTS_ROOT_NAME)
  const resolved = path.resolve(projectDir)
  const slug = path.basename(resolved)

  if (!SLUG_RE.test(slug)) {
    throw new Error(`Refusing to clean up project directory: slug "${slug}" does not match ${SLUG_RE}`)
  }
  if (path.dirname(resolved) !== projectsRoot) {
    throw new Error(
      `Refusing to clean up project directory: ${resolved} is not a direct child of ${projectsRoot}`
    )
  }

  // Best-effort pull of a pinned image; ignore failure so the helper can
  // still run if the registry is unreachable and the image is already local.
  try {
    await execFileAsync('docker', ['pull', '--quiet', CLEANUP_IMAGE], { timeout: 120000 })
  } catch (pullError) {
    console.warn(`docker pull ${CLEANUP_IMAGE} failed (continuing if image is local):`, pullError)
  }

  // Mount only the projects root, not cwd, and use execFile (not a shell
  // string) so the slug cannot break out of the mount.
  await execFileAsync(
    'docker',
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