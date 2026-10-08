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
// The convergence SQL is never executed raw: only statements matching the
// exact shapes Prisma's SQLite renderer emits are accepted, and the batch is
// rebuilt from those statements (comments can never reach SQLite), wrapped in
// one transaction, and verified against a fresh diff afterwards.
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

// ---------------------------------------------------------------------------
// Convergence SQL validation.
//
// Deliberately NOT a general SQL tokenizer: the only diffs that may be applied
// are the ones Prisma's SQLite renderer produces, so validation is "match the
// canonical shapes exactly, refuse everything else".
// ---------------------------------------------------------------------------

const ID = '"[A-Za-z0-9_]+"'
const TYPE =
  '(?:TEXT|DATETIME|INTEGER|REAL|BOOLEAN|BLOB|DECIMAL(?:\\([0-9]+(?:,\\s*[0-9]+)?\\))?)'
const LITERAL =
  "(?:'(?:[^']|'')*'|NULL|CURRENT_TIMESTAMP|true|false|-?[0-9]+(?:\\.[0-9]+)?)"
const ALTER_ADD_COLUMN_RE = new RegExp(
  `^ALTER TABLE ${ID} ADD COLUMN ${ID} ${TYPE}(?: NOT NULL)?(?: DEFAULT ${LITERAL})?$`
)
const CREATE_TABLE_RE = new RegExp(`^CREATE TABLE ${ID} \\([\\s\\S]+\\)$`)
const CREATE_INDEX_RE = new RegExp(
  `^CREATE (?:UNIQUE )?INDEX ${ID} ON ${ID}\\(${ID}(?: (?:ASC|DESC))?(?:, ${ID}(?: (?:ASC|DESC))?)*\\)$`
)
const DENIED_KEYWORD_RE =
  /\b(?:DROP|RENAME|DELETE|UPDATE|INSERT|PRAGMA|ATTACH|TRIGGER|VIEW)\b/i

function hasBalancedQuotes(text) {
  const singles = (text.match(/'/g) ?? []).length
  const doubles = (text.match(/"/g) ?? []).length
  return singles % 2 === 0 && doubles % 2 === 0
}

// Whole-diff character scan: no backticks, no bracket identifiers, no block
// comments, nothing outside printable ASCII (plus tab/newline/CR).
function scanDiffInput(sql) {
  if (sql.includes('`')) return { ok: false, reason: 'diff contains a backtick' }
  if (sql.includes('[')) return { ok: false, reason: 'diff contains "["' }
  if (sql.includes('/*')) return { ok: false, reason: 'diff contains "/*"' }
  if (/[^\t\n\r\x20-\x7E]/.test(sql)) {
    return { ok: false, reason: 'diff contains control or non-ASCII characters' }
  }
  return { ok: true }
}

function stripLineComments(sql) {
  return sql.replace(/--[^\n]*/g, '')
}

// Strips `--` line comments, then splits on every `;`. Quotes are not
// semicolon context: a literal containing `;` splits the statement, the halves
// then fail the balanced-quote check and the whole diff is refused (Prisma
// diffs never put `;` inside literals).
export function splitSqlStatements(sql) {
  return stripLineComments(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

// Blanks the contents of '…' / "…" literals (quotes and length kept) so
// keyword scans cannot be fooled by literal text. Handles '' and "" escapes.
function maskSqlTokens(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      out += c
      i++
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            out += '  '
            i += 2
            continue
          }
          out += c
          i++
          break
        }
        out += ' '
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// Second validation layer, applied after masking literals. `ON DELETE` /
// `ON UPDATE` referential actions are masked too: they are canonical Prisma
// foreign-key syntax ("ON DELETE CASCADE ON UPDATE CASCADE"), not statements.
function hasDeniedKeyword(statement) {
  const masked = maskSqlTokens(statement).replace(
    /\bON\s+(?:DELETE|UPDATE)\b/gi,
    '   '
  )
  return DENIED_KEYWORD_RE.test(masked)
}

// True only for statements exactly shaped like Prisma's canonical SQLite
// output: ALTER TABLE … ADD COLUMN …, CREATE TABLE … ( … ), and
// CREATE [UNIQUE] INDEX … ON …("col"[ ASC|DESC], …).
export function isAdditiveStatement(statement) {
  const sql = statement.trim()
  if (!hasBalancedQuotes(sql)) return false
  if (hasDeniedKeyword(sql)) return false
  if (ALTER_ADD_COLUMN_RE.test(sql)) return true
  const tableMatch = /^CREATE TABLE "([A-Za-z0-9_]+)" \([\s\S]+\)$/.exec(sql)
  if (tableMatch) {
    if (/^new_/i.test(tableMatch[1])) return false
    if (/\bAS\s+SELECT\b/i.test(maskSqlTokens(sql))) return false
    return CREATE_TABLE_RE.test(sql)
  }
  return CREATE_INDEX_RE.test(sql)
}

// Classifies a schema-diff script as 'empty' (schemas match), 'additive'
// (safe to apply) or 'unsafe'.
export function classifyDiffScript(sql) {
  const scan = scanDiffInput(sql)
  if (!scan.ok) return { kind: 'unsafe', statements: [], rejected: scan.reason }
  if (!hasBalancedQuotes(sql)) {
    return { kind: 'unsafe', statements: [], rejected: 'unbalanced quote' }
  }
  const statements = splitSqlStatements(sql)
  if (statements.length === 0) return { kind: 'empty', statements }
  for (const statement of statements) {
    if (!isAdditiveStatement(statement)) {
      return { kind: 'unsafe', statements, rejected: statement }
    }
  }
  return { kind: 'additive', statements }
}

// Post-apply gate: the convergence batch must have brought the database all
// the way to 0_init. A non-empty diff here means the executed batch did not
// stick (e.g. silently rolled back) and baselining must not proceed.
export function verifyConvergedAfterApply(afterDiffSql) {
  const verdict = classifyDiffScript(afterDiffSql)
  if (verdict.kind !== 'empty') {
    throw new Error(
      'convergence did not stick: schema still differs from 0_init after applying the batch'
    )
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
// baselined. The difference is computed against a scratch DB that holds
// exactly 0_init (NOT schema.prisma, which will be ahead of 0_init once later
// migrations exist). Only canonical additive statements are accepted, and the
// batch is rebuilt from those statements and executed inside one SQLite
// transaction so a late failure rolls everything back. Afterwards the diff is
// re-run and must be empty before 0_init is marked applied.
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
    console.log(
      verdict.statements.map((statement) => `${statement};`).join('\n')
    )
    // Execute the RECONSTRUCTED batch, never the raw diff: comments and any
    // smuggled text can never reach SQLite.
    const batch = `BEGIN;\n${verdict.statements
      .map((statement) => `${statement};`)
      .join('\n')}\nCOMMIT;\n`
    const convergeSql = path.join(tmpDir, 'converge.sql')
    writeFileSync(convergeSql, batch)
    prismaCli(`db execute --file ${q(convergeSql)} --url ${q(url)}`, repoRoot)
    console.log('[db-migrate] additive schema updates applied')

    const after = prismaCliOutput(
      `migrate diff --from-url ${q(url)} --to-url ${q(targetUrl)} --script`,
      repoRoot
    )
    try {
      verifyConvergedAfterApply(after)
    } catch (error) {
      console.error(`[db-migrate] ${error.message}`)
      console.error(
        `[db-migrate] not marking ${BASELINE_MIGRATION} as applied. ` +
          'Reconcile the database manually, then re-run.'
      )
      process.exit(1)
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const schemaDir = path.join(repoRoot, 'prisma')

  // Same file precedence as the app: production semantics unless NODE_ENV is
  // explicitly development (matching `next start`, which forces production).
  // Exported process vars stay authoritative.
  loadEnvConfig(repoRoot, process.env.NODE_ENV === 'development')

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
