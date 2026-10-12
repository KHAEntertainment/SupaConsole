import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  IncompletePreviewIdentityError,
  normalizeBranch,
  normalizePreviewIdentity,
  normalizeRepository,
} from '../src/lib/preview-identity'
import {
  IllegalOperationTransitionError,
  assertTransition,
  canTransition,
  isTerminalState,
  recoverInterruptedOperations,
  transitionOperation,
} from '../src/lib/operations'

const root = process.cwd()
const dir = mkdtempSync(path.join(os.tmpdir(), 't12-ops-'))
const client = new PrismaClient({ datasourceUrl: `file:${dir}/test.db?connection_limit=1` })

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'db-migrate.mjs')], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${dir}/test.db` },
    stdio: 'pipe',
  })
})

afterAll(async () => {
  await client.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})

describe('canonical preview identity', () => {
  it('lowercases and trims the repository, trims the branch, and preserves branch case', () => {
    expect(normalizeRepository('  GitHub.com/Acme/App  ')).toBe('github.com/acme/app')
    expect(normalizeBranch('  Feature/One  ')).toBe('Feature/One')
  })

  it('maps null, empty and whitespace-only input to null explicitly', () => {
    for (const input of [null, undefined, '', '   \t ']) {
      expect(normalizeRepository(input)).toBeNull()
      expect(normalizeBranch(input)).toBeNull()
    }
  })

  it('refuses an incomplete preview identity', () => {
    expect(() => normalizePreviewIdentity({ repository: '  ', branch: 'Feature/One' }))
      .toThrow(IncompletePreviewIdentityError)
    expect(() => normalizePreviewIdentity({ repository: 'github.com/acme/app', branch: null }))
      .toThrow(IncompletePreviewIdentityError)
  })

  it('collapses two writes that differ only in casing and whitespace to one canonical row', async () => {
    const owner = await client.user.create({
      data: { email: `t12-${randomBytes(4).toString('hex')}@example.test`, password: 'unused' },
    })
    const write = async (repository: string, branch: string, suffix: string) => {
      const identity = normalizePreviewIdentity({ repository, branch, pullRequestNumber: 42 })
      return client.project.upsert({
        where: { repository_branch: { repository: identity.repository, branch: identity.branch } },
        create: {
          name: `t12-${suffix}`,
          slug: `t12-${suffix}-${randomBytes(4).toString('hex')}`,
          ownerId: owner.id,
          environmentType: 'preview',
          ...identity,
        },
        update: {},
      })
    }

    const first = await write('GitHub.com/Acme/App', '  Feature/One ', 'a')
    const second = await write('  GITHUB.COM/ACME/APP', 'Feature/One  ', 'b')
    expect(second.id).toBe(first.id)
    const rows = await client.project.findMany({
      where: { repository: 'github.com/acme/app', branch: 'Feature/One' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      repository: 'github.com/acme/app',
      branch: 'Feature/One',
      pullRequestNumber: 42,
      environmentType: 'preview',
    })
  })

  it('keeps persistent projects NULL-or-canonical through the project write path', async () => {
    const owner = await client.user.create({
      data: { email: `t12-${randomBytes(4).toString('hex')}@example.test`, password: 'unused' },
    })
    const { createProjectWithPorts } = await import('../src/lib/ports')
    const write = (name: string, repository: string, branch: string) =>
      createProjectWithPorts(client, {
        name,
        slug: `${name}-${randomBytes(4).toString('hex')}`,
        ownerId: owner.id,
        repository,
        branch,
      }, ['API_GW_HTTP_PORT'])
    // Empty and whitespace-only identity stores NULL, never '', so the unique
    // index (NULLs distinct) cannot collide across persistent projects.
    const first = await write('t12-null-1', '', '')
    const second = await write('t12-null-2', '   \t ', '  ')
    expect(first.project.repository).toBeNull()
    expect(first.project.branch).toBeNull()
    expect(second.project.repository).toBeNull()
    expect(second.project.branch).toBeNull()
    const rows = await client.project.findMany({
      where: { name: { startsWith: 't12-null-' } },
    })
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.repository === null && row.branch === null)).toBe(true)
  })

  it('keeps the database unique key as the backstop against unsanitized duplicates', async () => {
    const owner = await client.user.create({
      data: { email: `t12-${randomBytes(4).toString('hex')}@example.test`, password: 'unused' },
    })
    const identity = normalizePreviewIdentity({
      repository: 'github.com/acme/dup',
      branch: 'Feature/Dup',
    })
    const data = {
      name: 't12-dup',
      slug: `t12-dup-${randomBytes(4).toString('hex')}`,
      ownerId: owner.id,
      environmentType: 'preview',
      ...identity,
    }
    await client.project.create({ data })
    await expect(
      client.project.create({
        data: { ...data, slug: `${data.slug}-2`, name: 't12-dup-2' },
      })
    ).rejects.toMatchObject({ code: 'P2002' })
  })
})

describe('operation state machine', () => {
  it('defines exactly queued -> provisioning -> ready | failed with two terminal states', () => {
    expect(canTransition('queued', 'provisioning')).toBe(true)
    expect(canTransition('provisioning', 'ready')).toBe(true)
    expect(canTransition('provisioning', 'failed')).toBe(true)
    for (const [from, to] of [
      ['queued', 'ready'], ['queued', 'failed'], ['ready', 'provisioning'],
      ['ready', 'failed'], ['failed', 'queued'], ['failed', 'provisioning'],
      ['pending', 'queued'], ['pending', 'provisioning'],
    ] as const) {
      expect(canTransition(from, to)).toBe(false)
      expect(() => assertTransition(from, to)).toThrow(IllegalOperationTransitionError)
    }
    expect(isTerminalState('ready')).toBe(true)
    expect(isTerminalState('failed')).toBe(true)
    expect(isTerminalState('queued')).toBe(false)
    expect(isTerminalState('provisioning')).toBe(false)
    expect(isTerminalState('pending')).toBe(false)
  })

  async function makeOperation(kind: string, environmentType = 'persistent') {
    const owner = await client.user.create({
      data: { email: `t12-${randomBytes(4).toString('hex')}@example.test`, password: 'unused' },
    })
    const project = await client.project.create({
      data: {
        name: `t12-op-${kind}`,
        slug: `t12-op-${kind}-${randomBytes(4).toString('hex')}`,
        ownerId: owner.id,
        environmentType,
        status: 'provisioning',
      },
    })
    return client.operation.create({ data: { projectId: project.id, kind } })
  }

  it('creates operations as queued and drives one to ready and one to failed', async () => {
    const toReady = await makeOperation('ready-path')
    expect(toReady.state).toBe('queued')
    expect(toReady.startedAt).toBeNull()
    expect(toReady.finishedAt).toBeNull()

    const provisioning = await transitionOperation(client, toReady.id, 'provisioning')
    expect(provisioning.state).toBe('provisioning')
    expect(provisioning.startedAt).not.toBeNull()
    expect(provisioning.finishedAt).toBeNull()

    const ready = await transitionOperation(client, toReady.id, 'ready')
    expect(ready.state).toBe('ready')
    expect(ready.finishedAt).not.toBeNull()

    const toFailed = await makeOperation('failed-path')
    await transitionOperation(client, toFailed.id, 'provisioning')
    const failed = await transitionOperation(client, toFailed.id, 'failed', {
      error: 'migration failed',
    })
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('migration failed')
    expect(failed.finishedAt).not.toBeNull()
    expect(failed.state).not.toBe(ready.state)
  })

  it('rejects an illegal transition and leaves the row untouched', async () => {
    const operation = await makeOperation('illegal')
    await transitionOperation(client, operation.id, 'provisioning')
    await transitionOperation(client, operation.id, 'ready')

    await expect(transitionOperation(client, operation.id, 'provisioning'))
      .rejects.toBeInstanceOf(IllegalOperationTransitionError)
    await expect(transitionOperation(client, operation.id, 'failed'))
      .rejects.toBeInstanceOf(IllegalOperationTransitionError)

    const skipped = await makeOperation('skip')
    await expect(transitionOperation(client, skipped.id, 'ready'))
      .rejects.toBeInstanceOf(IllegalOperationTransitionError)

    const rows = await client.operation.findMany({
      where: { id: { in: [operation.id, skipped.id] } },
      orderBy: { id: 'asc' },
    })
    expect(rows.find(row => row.id === operation.id)?.state).toBe('ready')
    expect(rows.find(row => row.id === skipped.id)?.state).toBe('queued')
  })

  it('clears a stale error when an operation reaches ready', async () => {
    const operation = await makeOperation('error-clear')
    await transitionOperation(client, operation.id, 'provisioning', { error: 'retryable warning' })
    const ready = await transitionOperation(client, operation.id, 'ready')
    expect(ready.state).toBe('ready')
    expect(ready.error).toBeNull()
  })

  it('composes create and transition inside a caller transaction', async () => {
    const owner = await client.user.create({
      data: { email: `t12-${randomBytes(4).toString('hex')}@example.test`, password: 'unused' },
    })
    const project = await client.project.create({
      data: {
        name: 't12-composed',
        slug: `t12-composed-${randomBytes(4).toString('hex')}`,
        ownerId: owner.id,
      },
    })
    const created = await client.$transaction(async tx => {
      const operation = await tx.operation.create({ data: { projectId: project.id, kind: 'composed' } })
      const provisioning = await transitionOperation(tx, operation.id, 'provisioning')
      expect(provisioning.state).toBe('provisioning')
      return operation
    })
    const row = await client.operation.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.state).toBe('provisioning')
  })

  it('recovers non-terminal operations as failed after a restart, leaving terminal ones alone', async () => {
    const queued = await makeOperation('recover-preview')
    const running = await makeOperation('recover-preview')
    await transitionOperation(client, running.id, 'provisioning')
    const done = await makeOperation('recover-preview')
    await transitionOperation(client, done.id, 'provisioning')
    await transitionOperation(client, done.id, 'ready')
    const previewQueued = await makeOperation('recover-preview', 'preview')
    const otherKindPreview = await makeOperation('recover-other-kind', 'preview')

    const recovered = await recoverInterruptedOperations(client, { kind: 'recover-preview' })
    expect(recovered).toBe(3)

    const rows = await client.operation.findMany({
      where: { id: { in: [queued.id, running.id, done.id, previewQueued.id, otherKindPreview.id] } },
    })
    const queuedRow = rows.find(row => row.id === queued.id)
    const runningRow = rows.find(row => row.id === running.id)
    const doneRow = rows.find(row => row.id === done.id)
    const previewQueuedRow = rows.find(row => row.id === previewQueued.id)
    const otherKindRow = rows.find(row => row.id === otherKindPreview.id)
    expect(queuedRow).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
    expect(runningRow).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
    expect(queuedRow?.finishedAt).not.toBeNull()
    expect(runningRow?.finishedAt).not.toBeNull()
    expect(doneRow?.state).toBe('ready')
    expect(previewQueuedRow).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
    expect(otherKindRow?.state).toBe('queued')

    const projects = await client.project.findMany({
      where: { id: { in: [queued.projectId, running.projectId, done.projectId, previewQueued.projectId, otherKindPreview.projectId] } },
    })
    expect(projects.find(project => project.id === previewQueued.projectId)?.status).toBe('failed')
    expect(projects.find(project => project.id === otherKindPreview.projectId)?.status).toBe('provisioning')
    expect(projects.find(project => project.id === queued.projectId)?.status).toBe('provisioning')

    await expect(transitionOperation(client, queued.id, 'provisioning'))
      .rejects.toBeInstanceOf(IllegalOperationTransitionError)
  })
})
