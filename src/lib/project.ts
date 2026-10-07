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
function normalizeCoreRef(raw: string): string {
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
  return value
}

function configuredCoreRef(): string {
  return normalizeCoreRef(process.env.SUPABASE_CORE_REF || DEFAULT_CORE_REF)
}

function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref)
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
// written at clone time is authoritative; without it (checkouts made by older
// versions, or by hand) fall back to asking git.
export interface SupabaseCoreInfo {
  ref: string | null
  commit: string | null
  source: 'meta' | 'git' | 'none'
}

export async function readSupabaseCoreInfo(coreDir: string): Promise<SupabaseCoreInfo> {
  const commit = await git(['rev-parse', 'HEAD'], coreDir)
  try {
    const raw = await fs.readFile(path.join(coreDir, CORE_META_FILE), 'utf8')
    const meta = JSON.parse(raw) as { ref?: unknown; commit?: unknown }
    if (typeof meta.ref === 'string' && meta.ref) {
      return {
        ref: meta.ref,
        commit: commit ?? (typeof meta.commit === 'string' ? meta.commit : null),
        source: 'meta',
      }
    }
  } catch {
    // No meta file: derive the ref from the checkout itself.
  }
  const exactTag = await git(['describe', '--tags', '--exact-match', 'HEAD'], coreDir)
  if (exactTag) return { ref: exactTag, commit, source: 'git' }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], coreDir)
  if (branch && branch !== 'HEAD') return { ref: branch, commit, source: 'git' }
  return { ref: null, commit, source: 'none' }
}

// Resolves a ref name to a commit SHA without cloning: locally first (works
// offline for refs already fetched), then against the remote. Returns the
// peeled commit SHA (annotated tags resolve to what they point at).
async function resolveRefCommit(coreDir: string, repoUrl: string, ref: string): Promise<string | null> {
  const local =
    (await git(['rev-parse', '--verify', `${ref}^{commit}`], coreDir)) ??
    (await git(['rev-parse', '--verify', `refs/tags/${ref}^{commit}`], coreDir)) ??
    (await git(['rev-parse', '--verify', `refs/remotes/origin/${ref}`], coreDir))
  if (local) return local

  // ls-remote needs the explicit `^{}` pattern to print the peeled commit of an
  // annotated tag; a bare ref name only matches the tag object itself.
  const listed = await git(
    ['ls-remote', repoUrl, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref],
    process.cwd()
  )
  if (!listed) return null
  let candidate: string | null = null
  for (const line of listed.split('\n')) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/)
    if (!match) continue
    if (match[2].endsWith('^{}')) return match[1]
    candidate = candidate ?? match[1]
  }
  return candidate
}

// `git fetch origin <sha>` only accepts full SHAs, so a short SHA has to be
// expanded against the remote's advertised refs first. Returns null when the
// prefix is unknown or ambiguous.
async function expandShortSha(repoUrl: string, prefix: string): Promise<string | null> {
  const listed = await git(['ls-remote', repoUrl], process.cwd())
  if (!listed) return null
  const found = new Set<string>()
  for (const line of listed.split('\n')) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/)
    if (!match) continue
    const sha = match[1]
    // Prefer peeled commits (tag objects also advertise their own SHA).
    const key = match[2].endsWith('^{}') ? `peeled:${sha}` : sha
    if (sha.toLowerCase().startsWith(prefix.toLowerCase())) found.add(key)
  }
  const shas = [...found].map((k) => k.replace(/^peeled:/, ''))
  const unique = [...new Set(shas)]
  return unique.length === 1 ? unique[0] : null
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
  if (info.ref === configuredRef) return 'match'
  if (info.commit && isCommitSha(configuredRef)) {
    return info.commit.toLowerCase().startsWith(configuredRef.toLowerCase()) ? 'match' : 'mismatch'
  }
  // The configured ref may point at the checkout's commit under another name
  // (same tag fetched twice, or a commit checked out by another ref).
  const resolved = await resolveRefCommit(coreDir, repoUrl, configuredRef)
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

    const configuredRef = configuredCoreRef()
    const repoUrl = normalizeRepoUrl(
      process.env.SUPABASE_CORE_REPO_URL || 'https://github.com/supabase/supabase'
    )

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
      // that commit into a fresh repository instead. `git fetch` wants a full
      // SHA, so expand a short one against the remote's advertised refs.
      const fetchTarget =
        configuredRef.length === 40 ? configuredRef : (await expandShortSha(repoUrl, configuredRef)) ?? configuredRef
      await fs.mkdir(stagingDir, { recursive: true })
      await execFileAsync('git', ['init'], { cwd: stagingDir, timeout: 60000 })
      await execFileAsync('git', ['remote', 'add', 'origin', repoUrl], { cwd: stagingDir, timeout: 60000 })
      await execFileAsync('git', ['fetch', '--depth', '1', 'origin', fetchTarget], {
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
      !commit.toLowerCase().startsWith(configuredRef.toLowerCase()) &&
      !(fetchedRev ?? '').toLowerCase().startsWith(configuredRef.toLowerCase())
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
    // checkout's own ref is preferred (it describes the files actually copied);
    // rows from before this was tracked simply stay null and show as "unknown".
    const coreInfo = await readSupabaseCoreInfo(path.join(process.cwd(), 'supabase-core'))

    // Create project in database
    const project = await prisma.project.create({
      data: {
        name,
        slug,
        description,
        ownerId: userId,
        supabaseRef: coreInfo.ref ?? configuredCoreRef(),
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
    
    // Step 2: Remove project directory
    try {
      console.log(`Removing project directory: ${projectDir}`)
      const isWindows = process.platform === 'win32'
      const removeCommand = isWindows 
        ? `rmdir /s /q "${projectDir}"` 
        : `rm -rf "${projectDir}"`
      
      await execAsync(removeCommand, { timeout: 60000 })
    } catch (fsError) {
      console.warn('Failed to remove project directory:', fsError)
      // Continue with database cleanup even if filesystem cleanup fails
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