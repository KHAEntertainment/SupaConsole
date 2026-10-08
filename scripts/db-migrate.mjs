#!/usr/bin/env node
// Applies the tracked Prisma migrations to the database in DATABASE_URL.
//
// Three cases:
//   - legacy DB created by `prisma db push` (no _prisma_migrations table, app
//     tables present): first converge the schema to 0_init additively (ADD
//     COLUMN / CREATE TABLE / CREATE INDEX only; anything else is refused with
//     no changes), then mark 0_init applied and deploy. Every existing row is
//     kept. The converge target is prisma/migrations/0_init, NOT schema.prisma,
//     so this keeps working once later migrations exist.
//   - fresh DB (no _prisma_migrations, no app tables): just deploy.
//   - DB with migration history: just deploy (a no-op when up to date).
//
// Used by the Dockerfile CMD, ops/vps-setup.sh and `npm run db:migrate`.
import { execSync } from 'node:child_process'
import {
  readFileSync,
  existsSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_TABLES = [
  'users',
  'sessions',
  'projects',
  'project_env_vars',
  'team_members',
  'password_reset_tokens',
]

const BASELINE_MIGRATION = '0_init'

export function decideAction({ hasMigrationsTable, hasAppTables }) {
  if (!hasMigrationsTable && hasAppTables) return 'baseline'
  return 'deploy'
}

// Splits a Prisma `migrate diff --script` body into statements. Comments are
// dropped; anything left over that is not a complete statement fails the
// additive whitelist later, which is the safe direction.
export function splitSqlStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

// Additive-only whitelist: the change may not lose or rewrite anything that
// already exists. `CREATE TABLE "new_...` is the RedefineTables artifact of a
// table rebuild and is refused even though it starts with CREATE TABLE.
export function isAdditiveStatement(statement) {
  const sql = statement.trim()
  if (/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?new_/i.test(sql)) return false
  if (/^CREATE\s+TABLE\s/i.test(sql)) return true
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(sql)) return true
  if (/^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s/i.test(sql)) return true
  return false
}

// Classifies a schema-diff script as 'empty' (schemas match), 'additive'
// (safe to apply: ADD COLUMN / CREATE TABLE / CREATE INDEX only) or 'unsafe'
// (DROP, RedefineTables, rewrites, unknown statements).
export function classifyDiffScript(sql) {
  const statements = splitSqlStatements(sql)
  if (statements.length === 0) return { kind: 'empty', statements }
  for (const statement of statements) {
    if (!isAdditiveStatement(statement)) {
      return { kind: 'unsafe', statements, rejected: statement }
    }
  }
  return { kind: 'additive', statements }
}

function loadEnvFiles(dir) {
  for (const name of ['.env', '.env.local']) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1)
      }
      if (key && !(key in process.env)) process.env[key] = value
    }
  }
}

async function inspectTables() {
  // Imported lazily so the decideAction export can be unit-tested without a
  // generated Prisma client.
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    return new Set(rows.map((row) => row.name))
  } finally {
    await prisma.$disconnect()
  }
}

function q(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

// Runs the local Prisma CLI directly (node node_modules/prisma/...) when it is
// installed — `npx prisma` pays npm resolution overhead on every call. Falls
// back to npx if node_modules is not laid out as expected.
function prismaBin(cwd) {
  const local = path.join(cwd, 'node_modules', 'prisma', 'build', 'index.js')
  return existsSync(local)
    ? `${q(process.execPath)} ${q(local)}`
    : 'npx prisma'
}

function prismaCli(args, cwd) {
  execSync(`${prismaBin(cwd)} ${args}`, { stdio: 'inherit', env: process.env, cwd })
}

function prismaCliOutput(args, cwd) {
  return execSync(`${prismaBin(cwd)} ${args}`, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

// Brings a legacy db-push database up to the 0_init schema before it is
// baselined, using only additive statements. The difference is computed
// against a scratch DB that holds exactly 0_init (NOT schema.prisma, which
// will be ahead of 0_init once later migrations exist). Anything non-additive
// aborts before a single statement is applied to the legacy DB.
function convergeLegacyToBaseline(url, repoRoot) {
  const migrationSql = path.join(
    repoRoot,
    'prisma',
    'migrations',
    BASELINE_MIGRATION,
    'migration.sql'
  )
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'supaconsole-db-migrate-'))
  try {
    const targetUrl = `file:${path.join(tmpDir, 'target.db')}`
    prismaCli(
      `db execute --file ${q(migrationSql)} --url ${q(targetUrl)}`,
      repoRoot
    )
    const diff = prismaCliOutput(
      `migrate diff --from-url ${q(url)} --to-url ${q(targetUrl)} --script`,
      repoRoot
    )
    const verdict = classifyDiffScript(diff)
    if (verdict.kind === 'empty') {
      console.log(
        `[db-migrate] legacy schema already matches ${BASELINE_MIGRATION} (empty diff)`
      )
      return
    }
    if (verdict.kind === 'unsafe') {
      console.error(
        `[db-migrate] refusing to alter the database: the difference from ${BASELINE_MIGRATION} is not purely additive.`
      )
      console.error('[db-migrate] first unsafe statement:')
      console.error(verdict.rejected)
      console.error(
        '[db-migrate] No changes were applied. Reconcile the database manually, then re-run.'
      )
      process.exit(1)
    }
    console.log(
      `[db-migrate] legacy schema differs from ${BASELINE_MIGRATION}; ` +
        `applying ${verdict.statements.length} additive statement(s):`
    )
    console.log(diff.trim())
    const convergeSql = path.join(tmpDir, 'converge.sql')
    writeFileSync(convergeSql, diff)
    prismaCli(`db execute --file ${q(convergeSql)} --url ${q(url)}`, repoRoot)
    console.log('[db-migrate] additive schema updates applied')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  loadEnvFiles(repoRoot)
  if (!process.env.DATABASE_URL) {
    console.error(
      'db-migrate: DATABASE_URL is not set (export it or put it in .env)'
    )
    process.exit(1)
  }

  const url = process.env.DATABASE_URL
  console.log(`[db-migrate] database: ${url}`)

  const tables = await inspectTables()
  const action = decideAction({
    hasMigrationsTable: tables.has('_prisma_migrations'),
    hasAppTables: APP_TABLES.some((table) => tables.has(table)),
  })

  if (action === 'baseline') {
    console.log(
      '[db-migrate] legacy database created by `prisma db push` detected ' +
        '(no _prisma_migrations table, app tables present)'
    )
    convergeLegacyToBaseline(url, repoRoot)
    console.log(`[db-migrate] marking ${BASELINE_MIGRATION} as applied`)
    prismaCli(`migrate resolve --applied ${BASELINE_MIGRATION}`, repoRoot)
  }

  console.log('[db-migrate] prisma migrate deploy')
  prismaCli('migrate deploy', repoRoot)
  console.log('[db-migrate] done')
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error('[db-migrate] failed:', error)
    process.exit(1)
  })
}
