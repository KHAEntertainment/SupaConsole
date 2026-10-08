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
// DATABASE_URL is canonicalized once to an absolute file: URL (relative paths
// resolve against prisma/ , as Prisma Client and schema-based CLI commands do)
// and that absolute URL is used for every diff/execute/resolve/deploy.
//
// Used by the Dockerfile CMD, ops/vps-setup.sh and `npm run db:migrate`.
import { execSync } from 'node:child_process'
import {
  existsSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nextEnv from '@next/env'

const { loadEnvConfig } = nextEnv

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

// Prisma resolves relative file: URLs against the schema directory (prisma/),
// while `--url`/`--from-url`/`--to-url` resolve them against the process cwd.
// Canonicalize once so every consumer sees the same absolute database.
export function canonicalizeDatabaseUrl(rawUrl, schemaDir) {
  if (!rawUrl.startsWith('file:')) return rawUrl
  const rest = rawUrl.slice('file:'.length)
  const suffixIndex = rest.search(/[?#]/)
  const filePath = suffixIndex === -1 ? rest : rest.slice(0, suffixIndex)
  const suffix = suffixIndex === -1 ? '' : rest.slice(suffixIndex)
  return `file:${path.resolve(schemaDir, filePath)}${suffix}`
}

// Blanks the contents of single-quoted SQL string literals (keeping the
// quotes and the exact length) so classification regexes cannot be fooled by
// `;`, `--` or keywords inside literals. Double-quoted identifiers pass
// through, because checks like the `new_` table artifact need them.
function maskStringLiterals(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'") {
      out += "'"
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += '  '
            i += 2
            continue
          }
          out += "'"
          i++
          break
        }
        out += ' '
        i++
      }
      continue
    }
    if (c === '"') {
      out += c
      i++
      while (i < sql.length) {
        out += sql[i]
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += '"'
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// Splits a Prisma `migrate diff --script` body into statements. Tokenizing is
// quote- and comment-aware: `;` inside '…' / "…" literals does not split, and
// `--` / `*//*` comments are dropped (but comment markers inside literals are
// literal text). Splits only on top-level `;`.
export function splitSqlStatements(sql) {
  const statements = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      current += c
      i++
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += quote + quote
            i += 2
            continue
          }
          current += quote
          i++
          break
        }
        current += sql[i]
        i++
      }
      continue
    }
    if (c === ';') {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)
  return statements
}

// Additive-only whitelist: the change may not lose or rewrite anything that
// already exists. `CREATE TABLE "new_...` is the RedefineTables artifact of a
// table rebuild and `CREATE TABLE ... AS SELECT` copies data; both are refused
// even though they start with CREATE TABLE.
export function isAdditiveStatement(statement) {
  const sql = statement.trim()
  const masked = maskStringLiterals(sql)
  if (/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?new_/i.test(sql)) return false
  if (/^CREATE\s+TABLE\b/i.test(masked)) {
    return !/\bAS\s+SELECT\b/i.test(masked)
  }
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(masked)) return true
  if (/^ALTER\s+TABLE\b/i.test(masked) && /\bADD\s+COLUMN\b/i.test(masked)) {
    return true
  }
  return false
}

// Classifies a schema-diff script as 'empty' (schemas match), 'additive'
// (safe to apply: ADD COLUMN / CREATE TABLE / CREATE INDEX only) or 'unsafe'
// (DROP, RedefineTables, CTAS, rewrites, unknown statements).
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

// Runs the installed Prisma CLI directly (node node_modules/prisma/...).
// There is no npx fallback: a missing local CLI is a broken install and must
// fail loudly instead of resolving some other version.
function prismaBin(cwd) {
  const local = path.join(cwd, 'node_modules', 'prisma', 'build', 'index.js')
  if (!existsSync(local)) {
    throw new Error(
      `local Prisma CLI not found at ${local} (run npm ci in ${cwd})`
    )
  }
  return `${q(process.execPath)} ${q(local)}`
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
// aborts before a single statement is applied to the legacy DB, and the
// additive batch runs inside one SQLite transaction so a late failure (e.g. a
// unique index rejected by duplicate rows) rolls everything back.
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
    writeFileSync(convergeSql, `BEGIN;\n${diff}\nCOMMIT;\n`)
    prismaCli(`db execute --file ${q(convergeSql)} --url ${q(url)}`, repoRoot)
    console.log('[db-migrate] additive schema updates applied')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const schemaDir = path.join(repoRoot, 'prisma')

  // Same file set and precedence as the Next.js app; exported process vars
  // stay authoritative.
  loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production')

  if (!process.env.DATABASE_URL) {
    console.error(
      'db-migrate: DATABASE_URL is not set (export it or put it in .env)'
    )
    process.exit(1)
  }

  const url = canonicalizeDatabaseUrl(process.env.DATABASE_URL, schemaDir)
  process.env.DATABASE_URL = url
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
