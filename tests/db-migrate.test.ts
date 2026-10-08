import { describe, expect, it } from 'vitest'
import { decideAction } from '../scripts/db-migrate.mjs'

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
