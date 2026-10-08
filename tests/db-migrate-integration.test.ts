import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return { command: 'npx', prefix: ['prisma'] }
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

function runMigrate(url: string) {
  return spawnSync(process.execPath, ['scripts/db-migrate.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
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
})
