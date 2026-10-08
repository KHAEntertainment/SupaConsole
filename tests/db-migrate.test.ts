import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeDatabaseUrl,
  classifyDiffScript,
  decideAction,
  isAdditiveStatement,
  splitSqlStatements,
} from '../scripts/db-migrate.mjs'

describe('decideAction', () => {
  it('baselines a legacy db-push database (app tables, no _prisma_migrations)', () => {
    expect(decideAction({ hasMigrationsTable: false, hasAppTables: true })).toBe('baseline')
  })

  it('deploys into a fresh database (no tables at all)', () => {
    expect(decideAction({ hasMigrationsTable: false, hasAppTables: false })).toBe('deploy')
  })

  it('deploys when migration history already exists', () => {
    expect(decideAction({ hasMigrationsTable: true, hasAppTables: true })).toBe('deploy')
    expect(decideAction({ hasMigrationsTable: true, hasAppTables: false })).toBe('deploy')
  })
})

describe('canonicalizeDatabaseUrl', () => {
  const schemaDir = path.resolve('/repo/prisma')

  it('resolves ./relative file: URLs against the schema directory', () => {
    expect(canonicalizeDatabaseUrl('file:./dev.db', schemaDir)).toBe(
      `file:${path.resolve(schemaDir, 'dev.db')}`
    )
  })

  it('resolves bare relative file: URLs against the schema directory', () => {
    expect(canonicalizeDatabaseUrl('file:dev.db', schemaDir)).toBe(
      `file:${path.resolve(schemaDir, 'dev.db')}`
    )
  })

  it('keeps absolute file: URLs as-is (normalizing file:/// forms)', () => {
    expect(canonicalizeDatabaseUrl('file:/abs/x.db', schemaDir)).toBe('file:/abs/x.db')
    expect(canonicalizeDatabaseUrl('file:///abs/x.db', schemaDir)).toBe('file:/abs/x.db')
  })

  it('resolves ../ relative to the schema directory and keeps URL suffixes', () => {
    expect(canonicalizeDatabaseUrl('file:../data/x.db', schemaDir)).toBe(
      `file:${path.resolve(schemaDir, '..', 'data', 'x.db')}`
    )
    expect(canonicalizeDatabaseUrl('file:./x.db?bind=1', schemaDir)).toBe(
      `file:${path.resolve(schemaDir, 'x.db')}?bind=1`
    )
  })

  it('leaves non-file URLs untouched', () => {
    expect(canonicalizeDatabaseUrl('postgresql://localhost/db', schemaDir)).toBe(
      'postgresql://localhost/db'
    )
  })
})

describe('classifyDiffScript', () => {
  it('treats a comments-only diff as empty', () => {
    expect(classifyDiffScript('-- This is an empty migration\n').kind).toBe('empty')
    expect(classifyDiffScript('').kind).toBe('empty')
    expect(classifyDiffScript('-- AlterTable\n').kind).toBe('empty')
  })

  it('accepts a purely additive diff (ADD COLUMN, CREATE TABLE, CREATE INDEX)', () => {
    const sql = [
      '-- AlterTable',
      'ALTER TABLE "projects" ADD COLUMN "supabaseCommit" TEXT;',
      'ALTER TABLE "projects" ADD COLUMN "supabaseRef" TEXT;',
      '',
      '-- CreateTable',
      'CREATE TABLE "sessions" (',
      '    "id" TEXT NOT NULL PRIMARY KEY,',
      '    "token" TEXT NOT NULL',
      ');',
      '',
      '-- CreateIndex',
      'CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token" ASC);',
    ].join('\n')
    const verdict = classifyDiffScript(sql)
    expect(verdict.kind).toBe('additive')
    expect(verdict.statements).toHaveLength(4)
  })

  it('accepts an additive statement whose DEFAULT literal contains a semicolon', () => {
    const sql = `ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT 'a;b';`
    const verdict = classifyDiffScript(sql)
    expect(verdict.kind).toBe('additive')
    expect(verdict.statements).toHaveLength(1)
  })

  it('accepts additive statements with comments around the keywords', () => {
    const verdict = classifyDiffScript(
      `/* c1 */ CREATE /* c2 */ TABLE "x" ("v" TEXT DEFAULT 'x;y'); -- done\n`
    )
    expect(verdict.kind).toBe('additive')
  })

  it('refuses the crafted comment-marker-in-literal statement pair', () => {
    // Naive comment stripping turns "DEFAULT '--'" into an open string and
    // hides the DROP; the tokenizer must see both statements and refuse.
    const sql = `CREATE TABLE x(v TEXT DEFAULT '--'); DROP TABLE users;`
    const verdict = classifyDiffScript(sql)
    expect(verdict.kind).toBe('unsafe')
    expect(verdict.statements).toHaveLength(2)
  })

  it('refuses CREATE TABLE ... AS SELECT', () => {
    expect(
      classifyDiffScript('CREATE TABLE "x" AS SELECT * FROM "users";').kind
    ).toBe('unsafe')
    expect(
      classifyDiffScript('CREATE TABLE "x" AS\n  SELECT "id" FROM "users";').kind
    ).toBe('unsafe')
  })

  it('refuses DROP statements', () => {
    const verdict = classifyDiffScript('DROP TABLE "legacy_notes";')
    expect(verdict.kind).toBe('unsafe')
    expect(verdict.rejected).toContain('DROP TABLE')
  })

  it('rejects column drops and unknown statements', () => {
    expect(
      classifyDiffScript('ALTER TABLE "projects" DROP COLUMN "name";').kind
    ).toBe('unsafe')
    expect(classifyDiffScript('PRAGMA foreign_keys=OFF;').kind).toBe('unsafe')
    expect(classifyDiffScript('INSERT INTO "x" VALUES (1);').kind).toBe('unsafe')
  })

  it('rejects RedefineTables scripts (table rebuild)', () => {
    const redefine = [
      '-- RedefineTables',
      'PRAGMA defer_foreign_keys=ON;',
      'PRAGMA foreign_keys=OFF;',
      'CREATE TABLE "new_projects" (',
      '    "id" TEXT NOT NULL PRIMARY KEY',
      ');',
      'INSERT INTO "new_projects" ("id") SELECT "id" FROM "projects";',
      'DROP TABLE "projects";',
      'ALTER TABLE "new_projects" RENAME TO "projects";',
      'PRAGMA foreign_keys=ON;',
    ].join('\n')
    const verdict = classifyDiffScript(redefine)
    expect(verdict.kind).toBe('unsafe')
  })

  it('rejects CREATE TABLE "new_..." even standalone', () => {
    expect(isAdditiveStatement('CREATE TABLE "new_projects" ("id" TEXT NOT NULL)')).toBe(false)
    expect(isAdditiveStatement('CREATE TABLE new_projects ("id" TEXT NOT NULL)')).toBe(false)
    expect(isAdditiveStatement('CREATE TABLE "projects" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isAdditiveStatement('ALTER TABLE "projects" ADD COLUMN "supabaseRef" TEXT')).toBe(true)
    expect(
      isAdditiveStatement('CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug")')
    ).toBe(true)
  })

  it('splits only on top-level semicolons, respecting quotes', () => {
    const statements = splitSqlStatements(
      `ALTER TABLE "a" ADD COLUMN "b" TEXT DEFAULT 'x;y';\n` +
        `CREATE TABLE "c;odd" ("d" TEXT DEFAULT '--');\n`
    )
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^ALTER TABLE/)
    expect(statements[1]).toContain(`DEFAULT '--'`)
  })

  it('splits statements and drops comments', () => {
    const statements = splitSqlStatements(
      '-- AlterTable\nALTER TABLE "a" ADD COLUMN "b" TEXT;\n\n-- CreateTable\nCREATE TABLE "c" ("id" TEXT);\n'
    )
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^ALTER TABLE/)
    expect(statements[1]).toMatch(/^CREATE TABLE/)
  })
})
