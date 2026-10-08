import { execSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const initSql = readFileSync(
  path.join(repoRoot, 'prisma', 'migrations', '0_init', 'migration.sql'),
  'utf8'
)
const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 't7-migrate-test-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function dbUrl(file: string): string {
  return `file:${file}`
}

function prismaCliCmd(): { command: string; prefix: string[] } {
  const local = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js')
  if (existsSync(local)) return { command: process.execPath, prefix: [local] }
  throw new Error(`local Prisma CLI not found at ${local}`)
}

function execSql(url: string, sql: string): void {
  const dir = makeTmpDir()
  const sqlFile = path.join(dir, 'fixture.sql')
  writeFileSync(sqlFile, sql)
  const { command, prefix } = prismaCliCmd()
  execSync(
    [command, ...prefix, 'db', 'execute', '--file', sqlFile, '--url', url]
      .map((part) => `"${part}"`)
      .join(' '),
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] }
  )
}

interface RunOpts {
  cwd?: string
  script?: string
  /** Remove these env vars from the child before running (e.g. ['DATABASE_URL']). */
  unsetEnv?: string[]
}

function runMigrate(url: string | null, opts: RunOpts = {}) {
  // NODE_ENV=development so @next/env loads .env.local (it skips it under
  // NODE_ENV=test) and uses dev precedence, like `next dev`.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' }
  for (const key of opts.unsetEnv ?? []) delete env[key]
  if (url === null) delete env.DATABASE_URL
  else env.DATABASE_URL = url
  const script = opts.script ?? path.join(repoRoot, 'scripts', 'db-migrate.mjs')
  return spawnSync(process.execPath, [script], {
    cwd: opts.cwd ?? repoRoot,
    env,
    encoding: 'utf8',
    timeout: 120000,
  })
}

function migrateStatus(url: string) {
  const { command, prefix } = prismaCliCmd()
  return spawnSync(command, [...prefix, 'migrate', 'status'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 60000,
  })
}

async function withClient<T>(
  url: string,
  fn: (prisma: PrismaClient) => Promise<T>
): Promise<T> {
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    return await fn(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

async function tableExists(url: string, table: string): Promise<boolean> {
  return withClient(url, async (prisma) => {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`
    )
    return rows.length > 0
  })
}

async function indexExists(url: string, index: string): Promise<boolean> {
  return withClient(url, async (prisma) => {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${index}'`
    )
    return rows.length > 0
  })
}

// A repo-layout sandbox: scripts/db-migrate.mjs resolves its repo root from
// its own location, so relative-URL tests need a real scripts/ + prisma/ tree
// (with node_modules symlinked for the Prisma CLI and generated client).
function makeSandbox(): string {
  const dir = makeTmpDir()
  mkdirSync(path.join(dir, 'scripts'))
  mkdirSync(path.join(dir, 'prisma'))
  copyFileSync(
    path.join(repoRoot, 'scripts', 'db-migrate.mjs'),
    path.join(dir, 'scripts', 'db-migrate.mjs')
  )
  copyFileSync(
    path.join(repoRoot, 'prisma', 'schema.prisma'),
    path.join(dir, 'prisma', 'schema.prisma')
  )
  cpSync(path.join(repoRoot, 'prisma', 'migrations'), path.join(dir, 'prisma', 'migrations'), {
    recursive: true,
  })
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}

// Pre-T3 legacy shape: projects without supabaseRef/supabaseCommit.
const PRE_T3_SQL = `
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ownerId" TEXT NOT NULL,
    CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");
INSERT INTO "users" ("id", "email", "password", "updatedAt")
  VALUES ('u1', 'a@example.com', 'pw', CURRENT_TIMESTAMP);
INSERT INTO "projects" ("id", "name", "slug", "description", "updatedAt", "ownerId")
  VALUES ('p1', 'Demo', 'demo', 'kept', CURRENT_TIMESTAMP, 'u1');
`

// Pre-T3 shape WITHOUT projects_slug_key, plus duplicate slugs: converging
// must fail on CREATE UNIQUE INDEX and roll back the ADD COLUMNs.
const PRE_T3_DUP_SLUG_SQL = `
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ownerId" TEXT NOT NULL,
    CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
INSERT INTO "users" ("id", "email", "password", "updatedAt")
  VALUES ('u1', 'dup@example.com', 'pw', CURRENT_TIMESTAMP);
INSERT INTO "projects" ("id", "name", "slug", "updatedAt", "ownerId")
  VALUES ('p1', 'One', 'dup', CURRENT_TIMESTAMP, 'u1');
INSERT INTO "projects" ("id", "name", "slug", "updatedAt", "ownerId")
  VALUES ('p2', 'Two', 'dup', CURRENT_TIMESTAMP, 'u1');
`

describe('db-migrate integration', () => {
  it('adds missing columns to a pre-T3 legacy DB and keeps its rows', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'legacy.db')
    const url = dbUrl(file)
    execSql(url, PRE_T3_SQL)

    const first = runMigrate(url)
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stdout).toMatch(/applying \d+ additive statement/)
    expect(first.stdout).toContain('0_init marked as applied')

    await withClient(url, async (prisma) => {
      const projects = await prisma.$queryRawUnsafe<
        { id: string; name: string; slug: string; description: string; supabaseRef: string | null; supabaseCommit: string | null }[]
      >('SELECT id, name, slug, description, supabaseRef, supabaseCommit FROM projects')
      expect(projects).toHaveLength(1)
      expect(projects[0]).toMatchObject({
        id: 'p1',
        name: 'Demo',
        slug: 'demo',
        description: 'kept',
        supabaseRef: null,
        supabaseCommit: null,
      })
      const users = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT COUNT(*) AS n FROM users'
      )
      expect(Number(users[0].n)).toBe(1)
    })

    const status = migrateStatus(url)
    expect(status.status, status.stdout + status.stderr).toBe(0)
    expect(status.stdout).toContain('Database schema is up to date!')

    const second = runMigrate(url)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('No pending migrations to apply.')
    expect(second.stdout).not.toContain('legacy database created by')
  }, 120000)

  it('baselines a legacy DB already at 0_init shape with an empty diff and keeps rows', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'legacy-current.db')
    const url = dbUrl(file)
    execSql(
      url,
      initSql +
        `
INSERT INTO "users" ("id", "email", "password", "updatedAt")
  VALUES ('u1', 'b@example.com', 'pw', CURRENT_TIMESTAMP);
INSERT INTO "projects" ("id", "name", "slug", "supabaseRef", "updatedAt", "ownerId")
  VALUES ('p1', 'Kept', 'kept', 'self-hosted/v0.8.2', CURRENT_TIMESTAMP, 'u1');
`
    )

    const result = runMigrate(url)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('already matches 0_init (empty diff)')
    expect(result.stdout).not.toMatch(/applying \d+ additive statement/)
    expect(result.stdout).toContain('0_init marked as applied')

    await withClient(url, async (prisma) => {
      const projects = await prisma.$queryRawUnsafe<
        { name: string; supabaseRef: string | null }[]
      >('SELECT name, supabaseRef FROM projects')
      expect(projects).toHaveLength(1)
      expect(projects[0]).toMatchObject({ name: 'Kept', supabaseRef: 'self-hosted/v0.8.2' })
    })

    const status = migrateStatus(url)
    expect(status.status, status.stdout + status.stderr).toBe(0)
    expect(status.stdout).toContain('Database schema is up to date!')
  }, 120000)

  it('refuses a destructive diff without changing the database', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'legacy-destructive.db')
    const url = dbUrl(file)
    execSql(
      url,
      initSql +
        `
CREATE TABLE "legacy_notes" ("id" TEXT NOT NULL PRIMARY KEY, "note" TEXT NOT NULL);
INSERT INTO "legacy_notes" ("id", "note") VALUES ('n1', 'keep me');
INSERT INTO "users" ("id", "email", "password", "updatedAt")
  VALUES ('u1', 'c@example.com', 'pw', CURRENT_TIMESTAMP);
`
    )

    const result = runMigrate(url)
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/refusing to alter the database/)
    expect(result.stdout + result.stderr).toContain('No changes were applied')

    await withClient(url, async (prisma) => {
      const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      const names = tables.map((row) => row.name)
      expect(names).toContain('legacy_notes')
      expect(names).not.toContain('_prisma_migrations')
      const notes = await prisma.$queryRawUnsafe<{ note: string }[]>(
        'SELECT note FROM legacy_notes'
      )
      expect(notes).toEqual([{ note: 'keep me' }])
    })
  }, 120000)

  it('resolves file:./dev.db against prisma/ and ignores a decoy in the repo root', async () => {
    const sandbox = makeSandbox()
    const realDb = path.join(sandbox, 'prisma', 'dev.db')
    const decoyDb = path.join(sandbox, 'dev.db')
    execSql(dbUrl(realDb), PRE_T3_SQL)
    execSql(dbUrl(decoyDb), 'CREATE TABLE "decoy" ("x" TEXT);')

    const result = runMigrate('file:./dev.db', {
      cwd: sandbox,
      script: path.join(sandbox, 'scripts', 'db-migrate.mjs'),
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)

    expect(await tableExists(dbUrl(realDb), '_prisma_migrations')).toBe(true)
    await withClient(dbUrl(realDb), async (prisma) => {
      const rows = await prisma.$queryRawUnsafe<{ supabaseRef: string | null }[]>(
        'SELECT supabaseRef FROM projects'
      )
      expect(rows).toHaveLength(1)
    })

    expect(await tableExists(dbUrl(decoyDb), '_prisma_migrations')).toBe(false)
    expect(await tableExists(dbUrl(decoyDb), 'users')).toBe(false)
    expect(await tableExists(dbUrl(decoyDb), 'decoy')).toBe(true)
  }, 120000)

  it('resolves file:dev.db against prisma/ even when cwd is elsewhere', async () => {
    const sandbox = makeSandbox()
    const otherCwd = makeTmpDir()
    const realDb = path.join(sandbox, 'prisma', 'dev.db')
    const decoyDb = path.join(otherCwd, 'dev.db')
    execSql(dbUrl(realDb), PRE_T3_SQL)
    execSql(dbUrl(decoyDb), 'CREATE TABLE "decoy" ("x" TEXT);')

    const result = runMigrate('file:dev.db', {
      cwd: otherCwd,
      script: path.join(sandbox, 'scripts', 'db-migrate.mjs'),
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)

    expect(await tableExists(dbUrl(realDb), '_prisma_migrations')).toBe(true)
    expect(await tableExists(dbUrl(decoyDb), '_prisma_migrations')).toBe(false)
    expect(await tableExists(dbUrl(decoyDb), 'decoy')).toBe(true)
  }, 120000)

  it('lets .env.local win over .env for DATABASE_URL (Next precedence)', async () => {
    const sandbox = makeSandbox()
    const envDb = path.join(sandbox, 'prisma', 'from-env.db')
    const envLocalDb = path.join(sandbox, 'prisma', 'from-env-local.db')
    writeFileSync(
      path.join(sandbox, '.env'),
      'DATABASE_URL=file:./from-env.db\n'
    )
    writeFileSync(
      path.join(sandbox, '.env.local'),
      'DATABASE_URL=file:./from-env-local.db\n'
    )
    execSql(dbUrl(envDb), PRE_T3_SQL)
    execSql(dbUrl(envLocalDb), PRE_T3_SQL)

    const result = runMigrate(null, {
      cwd: sandbox,
      script: path.join(sandbox, 'scripts', 'db-migrate.mjs'),
      unsetEnv: ['DATABASE_URL'],
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)

    expect(await tableExists(dbUrl(envLocalDb), '_prisma_migrations')).toBe(true)
    expect(await tableExists(dbUrl(envDb), '_prisma_migrations')).toBe(false)
  }, 120000)

  it('keeps an exported DATABASE_URL authoritative over .env files', async () => {
    const sandbox = makeSandbox()
    const exportedDb = path.join(sandbox, 'prisma', 'from-export.db')
    writeFileSync(
      path.join(sandbox, '.env'),
      'DATABASE_URL=file:./from-env.db\n'
    )
    writeFileSync(
      path.join(sandbox, '.env.local'),
      'DATABASE_URL=file:./from-env-local.db\n'
    )
    execSql(dbUrl(exportedDb), PRE_T3_SQL)

    const result = runMigrate('file:./from-export.db', {
      cwd: sandbox,
      script: path.join(sandbox, 'scripts', 'db-migrate.mjs'),
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)

    expect(await tableExists(dbUrl(exportedDb), '_prisma_migrations')).toBe(true)
  }, 120000)

  it('rolls back a failed convergence batch (duplicate slugs vs unique index)', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'legacy-dup-slug.db')
    const url = dbUrl(file)
    execSql(url, PRE_T3_DUP_SLUG_SQL)

    const result = runMigrate(url)
    expect(result.status).toBe(1)

    // Schema unchanged: no ADD COLUMN stuck, no slug index created.
    const tableSql = await withClient(url, async (prisma) => {
      const rows = await prisma.$queryRawUnsafe<{ sql: string }[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'"
      )
      return rows[0].sql
    })
    expect(tableSql).not.toContain('supabaseRef')
    expect(tableSql).not.toContain('supabaseCommit')
    expect(await indexExists(url, 'projects_slug_key')).toBe(false)

    // Rows unchanged.
    await withClient(url, async (prisma) => {
      const projects = await prisma.$queryRawUnsafe<{ id: string; slug: string }[]>(
        'SELECT id, slug FROM projects ORDER BY id'
      )
      expect(projects).toEqual([
        { id: 'p1', slug: 'dup' },
        { id: 'p2', slug: 'dup' },
      ])
    })
  }, 120000)
})
