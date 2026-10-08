#!/usr/bin/env node
// Applies the tracked Prisma migrations to the database in DATABASE_URL.
//
// Three cases:
//   - legacy DB created by `prisma db push` (no _prisma_migrations table, app
//     tables present): baseline 0_init as applied, then deploy. Nothing is
//     rewritten; every existing row is kept.
//   - fresh DB (no _prisma_migrations, no app tables): just deploy.
//   - DB with migration history: just deploy (a no-op when up to date).
//
// Used by the Dockerfile CMD, ops/vps-setup.sh and `npm run db:migrate`.
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
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

function prismaCli(args, cwd) {
  execSync(`npx prisma ${args}`, { stdio: 'inherit', env: process.env, cwd })
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
        '(no _prisma_migrations table, app tables present); ' +
        `marking ${BASELINE_MIGRATION} as applied`
    )
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
