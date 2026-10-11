import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const dir = mkdtempSync(path.join(os.tmpdir(), 't12-migrate-'))
const upgradedUrl = `file:${dir}/upgraded.db`
const referenceUrl = `file:${dir}/reference.db`
const client = new PrismaClient({ datasourceUrl: `${upgradedUrl}?connection_limit=1` })
const migrationDir = path.join(root, 'prisma', 'migrations', '20261011190000_preview_state_machine')

function prismaCli(args: string[]): string {
  const local = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
  return execFileSync(process.execPath, [local, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  })
}

function applySql(url: string, file: string): void {
  prismaCli(['db', 'execute', '--file', file, '--url', url])
}

const LEGACY_ROWS_SQL = `
INSERT INTO "users" ("id", "email", "password", "updatedAt")
  VALUES ('u1', 'a@example.test', 'pw', CURRENT_TIMESTAMP);
INSERT INTO "projects" ("id", "name", "slug", "updatedAt", "ownerId", "environmentType", "repository", "branch", "pullRequestNumber", "headSha")
  VALUES ('p1', 'Preview', 'prev-1', CURRENT_TIMESTAMP, 'u1', 'preview', 'GitHub.com/Acme/App', ' Feature/One ', 42, 'abc123');
INSERT INTO "projects" ("id", "name", "slug", "updatedAt", "ownerId")
  VALUES ('p2', 'Persistent', 'pers-1', CURRENT_TIMESTAMP, 'u1');
INSERT INTO "operations" ("id", "projectId", "kind", "state", "updatedAt")
  VALUES ('op-pending', 'p1', 'provision', 'pending', CURRENT_TIMESTAMP);
INSERT INTO "operations" ("id", "projectId", "kind", "state", "updatedAt")
  VALUES ('op-running', 'p1', 'provision', 'provisioning', CURRENT_TIMESTAMP);
INSERT INTO "operations" ("id", "projectId", "kind", "state", "updatedAt", "startedAt")
  VALUES ('op-done', 'p1', 'provision', 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
`

async function tableColumns(url: string, table: string): Promise<string[]> {
  const prisma = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` })
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`)
    return rows.map(row => row.name)
  } finally {
    await prisma.$disconnect()
  }
}

async function indexExists(url: string, index: string): Promise<boolean> {
  const prisma = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` })
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${index}'`
    )
    return rows.length > 0
  } finally {
    await prisma.$disconnect()
  }
}

function schemaDiff(fromUrl: string, toArgs: string[]): string {
  return prismaCli(['migrate', 'diff', '--from-url', fromUrl, ...toArgs, '--script'])
    .replace(/^--.*$/gm, '')
    .trim()
}

beforeAll(() => {
  applySql(upgradedUrl, path.join(root, 'prisma', 'migrations', '0_init', 'migration.sql'))
  applySql(upgradedUrl, path.join(root, 'prisma', 'migrations', '20261010070000_ports_environment', 'migration.sql'))
  applySql(referenceUrl, path.join(root, 'prisma', 'migrations', '0_init', 'migration.sql'))
  applySql(referenceUrl, path.join(root, 'prisma', 'migrations', '20261010070000_ports_environment', 'migration.sql'))
})

afterAll(async () => {
  await client.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('preview state-machine migration', () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'execute', '--stdin', '--url', upgradedUrl],
      { cwd: root, input: LEGACY_ROWS_SQL, encoding: 'utf8', timeout: 60000 }
    )
    applySql(upgradedUrl, path.join(migrationDir, 'migration.sql'))
  })

  it('drops the superseded pull-request identity rule and keeps project rows', async () => {
    const columns = await tableColumns(upgradedUrl, 'projects')
    expect(columns).toContain('prTitle')
    expect(columns).toContain('prAuthor')
    expect(await indexExists(upgradedUrl, 'projects_repository_branch_key')).toBe(true)
    expect(await indexExists(upgradedUrl, 'projects_repository_pullRequestNumber_key')).toBe(false)

    const preview = await client.project.findUniqueOrThrow({ where: { id: 'p1' } })
    expect(preview).toMatchObject({
      repository: 'GitHub.com/Acme/App',
      branch: ' Feature/One ',
      pullRequestNumber: 42,
      headSha: 'abc123',
    })
    expect(await client.project.count()).toBe(2)
  })

  it('backfills legacy pending operations to queued and keeps every row', async () => {
    const operations = await client.operation.findMany({ orderBy: { id: 'asc' } })
    expect(operations.map(op => [op.id, op.state])).toEqual([
      ['op-done', 'ready'],
      ['op-pending', 'queued'],
      ['op-running', 'provisioning'],
    ])
    expect(operations.find(op => op.id === 'op-done')?.startedAt).not.toBeNull()
  })

  it('defaults new operations to queued after the upgrade', async () => {
    const created = await client.operation.create({ data: { projectId: 'p1', kind: 'post-upgrade' } })
    expect(created.state).toBe('queued')
  })

  it('rejects raw writes to a state outside the machine', async () => {
    await expect(client.$executeRawUnsafe(
      `INSERT INTO "operations" ("id", "projectId", "kind", "state", "updatedAt") VALUES ('op-bogus', 'p1', 'bogus', 'bogus', CURRENT_TIMESTAMP)`
    )).rejects.toThrow()
  })

  it('converges: the full migration chain matches schema.prisma exactly', () => {
    // Replay the whole migrations folder (not a hardcoded prefix) so the check
    // stays correct as later tickets add migrations after this one.
    expect(
      prismaCli([
        'migrate', 'diff',
        '--from-migrations', path.join(root, 'prisma', 'migrations'),
        '--to-schema-datamodel', path.join(root, 'prisma', 'schema.prisma'),
        '--script',
      ]).replace(/^--.*$/gm, '').trim(),
    ).toBe('')
  })
})

describe('down path', () => {
  beforeAll(() => {
    applySql(upgradedUrl, path.join(migrationDir, 'down.sql'))
  })

  it('restores the pre-T12 shape', async () => {
    const columns = await tableColumns(upgradedUrl, 'projects')
    expect(columns).not.toContain('prTitle')
    expect(columns).not.toContain('prAuthor')
    expect(await indexExists(upgradedUrl, 'projects_repository_branch_key')).toBe(false)
    expect(await indexExists(upgradedUrl, 'projects_repository_pullRequestNumber_key')).toBe(true)

    // The generated client assumes the post-T12 shape; assert the restored DB
    // default through raw SQL, the way a pre-T12 install would insert.
    await client.$executeRawUnsafe(
      `INSERT INTO "operations" ("id", "projectId", "kind", "updatedAt") VALUES ('op-raw', 'p1', 'post-down', CURRENT_TIMESTAMP)`
    )
    const rows = await client.$queryRawUnsafe<{ state: string }[]>(
      `SELECT "state" FROM "operations" WHERE "id" = 'op-raw'`
    )
    expect(rows[0].state).toBe('pending')
  })

  it('keeps project and operation rows through the downgrade', async () => {
    const projects = await client.$queryRawUnsafe<{ id: string; repository: string; pullRequestNumber: number }[]>(
      `SELECT "id", "repository", "pullRequestNumber" FROM "projects" WHERE "id" = 'p1'`
    )
    expect(projects[0]).toMatchObject({ repository: 'GitHub.com/Acme/App', pullRequestNumber: 42 })
    const operations = await client.$queryRawUnsafe<{ id: string; state: string }[]>(
      `SELECT "id", "state" FROM "operations" WHERE "projectId" = 'p1'`
    )
    expect(operations.map(row => row.id)).toEqual(
      expect.arrayContaining(['op-pending', 'op-running', 'op-done'])
    )
    // The up-migration queued 'op-pending'; downgrade maps it back so pre-T12
    // code never meets a state it does not know.
    expect(operations.find(row => row.id === 'op-pending')?.state).toBe('pending')
    expect(operations.find(row => row.id === 'op-running')?.state).toBe('provisioning')
    expect(operations.find(row => row.id === 'op-done')?.state).toBe('ready')
  })

  it('converges: the downgraded database matches the pre-T12 migration chain exactly', () => {
    expect(schemaDiff(upgradedUrl, ['--to-url', referenceUrl])).toBe('')
  })
})
