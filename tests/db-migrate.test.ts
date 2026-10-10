import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeDatabaseUrl,
  classifyDiffScript,
  decideAction,
  isAdditiveStatement,
  splitSqlStatements,
  verifyConvergedAfterApply,
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
      '    "token" TEXT NOT NULL,',
      '    "userId" TEXT NOT NULL,',
      '    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE',
      ');',
      '',
      '-- CreateIndex',
      'CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token" ASC);',
    ].join('\n')
    const verdict = classifyDiffScript(sql)
    expect(verdict.kind).toBe('additive')
    expect(verdict.statements).toHaveLength(4)
  })

  it('accepts ALTER ADD COLUMN with canonical constraints', () => {
    expect(
      isAdditiveStatement(`ALTER TABLE "projects" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active'`)
    ).toBe(true)
    expect(
      isAdditiveStatement(
        'ALTER TABLE "projects" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'
      )
    ).toBe(true)
  })

  it('rejects literals containing ";" (blind split, then odd-quote rejection)', () => {
    // Deliberate contract change from the tokenizer era: Prisma diffs never
    // put `;` inside literals, and such input must be refused, not parsed.
    const verdict = classifyDiffScript(`ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT 'a;b';`)
    expect(verdict.kind).toBe('unsafe')
  })

  it('refuses the crafted comment-marker-in-literal statement pair', () => {
    // Stripping "--" line comments mangles the literal into an unterminated
    // quote; the odd-quote check refuses it. Reconstruction would never let
    // the DROP reach SQLite either way.
    const sql = `CREATE TABLE x(v TEXT DEFAULT '--'); DROP TABLE users;`
    const verdict = classifyDiffScript(sql)
    expect(verdict.kind).toBe('unsafe')
    expect(verdict.statements).toHaveLength(1)
  })

  it('refuses backtick identifiers (Codex payload)', () => {
    const verdict = classifyDiffScript('CREATE TABLE `x--` (v TEXT); DROP TABLE users;')
    expect(verdict.kind).toBe('unsafe')
  })

  it('refuses bracket identifiers (Codex payload)', () => {
    const verdict = classifyDiffScript('CREATE TABLE [x--] (v TEXT); DROP TABLE users;')
    expect(verdict.kind).toBe('unsafe')
  })

  it('refuses DROP COLUMN and RENAME disguised with an "ADD COLUMN" identifier', () => {
    expect(
      classifyDiffScript('ALTER TABLE projects DROP COLUMN "ADD COLUMN";').kind
    ).toBe('unsafe')
    expect(
      classifyDiffScript('ALTER TABLE projects RENAME TO "ADD COLUMN";').kind
    ).toBe('unsafe')
    expect(
      classifyDiffScript('ALTER TABLE "projects" DROP COLUMN "ADD COLUMN";').kind
    ).toBe('unsafe')
    expect(
      classifyDiffScript('ALTER TABLE "projects" RENAME TO "ADD COLUMN";').kind
    ).toBe('unsafe')
  })

  it('refuses EOF inside a quote', () => {
    expect(
      classifyDiffScript(`ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT 'unfinished`).kind
    ).toBe('unsafe')
    expect(
      classifyDiffScript(`ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT "unfinished`).kind
    ).toBe('unsafe')
  })

  it('refuses an unclosed block comment', () => {
    expect(
      classifyDiffScript('ALTER TABLE "t" ADD COLUMN "c" TEXT; /*\nDROP TABLE users;').kind
    ).toBe('unsafe')
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
    expect(
      isAdditiveStatement('CREATE UNIQUE INDEX "t_a_b" ON "t"("a" ASC, "b" DESC)')
    ).toBe(true)
  })

  it('refuses non-canonical statements keyword-denied after masking literals', () => {
    // "DROP" inside a literal is data and must not trip the denylist…
    expect(
      isAdditiveStatement(`ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT 'DROP TABLE x'`)
    ).toBe(true)
    // …but real keyword statements are denied even if shaped oddly.
    expect(isAdditiveStatement('ALTER TABLE "t" ADD COLUMN "c" TEXT TRIGGER')).toBe(false)
    expect(isAdditiveStatement('CREATE TABLE "x" ("v" TEXT ATTACH)')).toBe(false)
  })
})

describe('splitSqlStatements', () => {
  it('splits on every semicolon after stripping line comments', () => {
    const statements = splitSqlStatements(
      '-- AlterTable\nALTER TABLE "a" ADD COLUMN "b" TEXT;\n\n-- CreateTable\nCREATE TABLE "c" ("id" TEXT);\n'
    )
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^ALTER TABLE/)
    expect(statements[1]).toMatch(/^CREATE TABLE/)
  })

  it('does not treat quotes as semicolon context (such diffs are refused later)', () => {
    const statements = splitSqlStatements(
      `ALTER TABLE "t" ADD COLUMN "c" TEXT DEFAULT 'a;b';`
    )
    expect(statements).toHaveLength(2)
  })
})

describe('verifyConvergedAfterApply', () => {
  it('accepts an empty post-apply diff', () => {
    expect(() => verifyConvergedAfterApply('-- This is an empty migration\n')).not.toThrow()
    expect(() => verifyConvergedAfterApply('')).not.toThrow()
  })

  it('rejects a post-apply diff that is not empty', () => {
    expect(() =>
      verifyConvergedAfterApply('ALTER TABLE "x" ADD COLUMN "y" TEXT;')
    ).toThrow(/did not stick/)
    expect(() => verifyConvergedAfterApply('DROP TABLE "x";')).toThrow(/did not stick/)
  })
})
