import { randomInt } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, expect, it, vi } from 'vitest'

const root = process.cwd()
const dir = mkdtempSync(path.join(os.tmpdir(), 't9-ports-multiclient-'))
const databaseUrl = `file:${dir}/test.db`
const first = new PrismaClient({ datasourceUrl: `${databaseUrl}?connection_limit=1` })
const second = new PrismaClient({ datasourceUrl: `${databaseUrl}?connection_limit=1` })

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomInt: vi.fn(actual.randomInt) }
})

afterAll(async () => {
  vi.restoreAllMocks()
  await Promise.all([first.$disconnect(), second.$disconnect()])
  rmSync(dir, { recursive: true, force: true })
})

it('retries port collisions from two independent Prisma clients on the same SQLite database', async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/db-migrate.mjs')], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  })

  const user = await first.user.create({
    data: { email: 'multiclient-ports@example.test', password: 'unused' },
  })
  const reservedPort = 32123
  const existing = await first.project.create({
    data: { name: 'existing', slug: 'existing', ownerId: user.id },
  })
  await first.allocatedPort.create({
    data: { port: reservedPort, projectId: existing.id },
  })

  // Both client operations first receive the same already-reserved candidate.
  // Each must roll back its project and retry with a fresh candidate. This
  // exercises the database uniqueness constraint without relying on a local
  // queue shared by the two PrismaClient instances.
  let candidateDraws = 0
  vi.mocked(randomInt as (min: number, max: number) => number).mockImplementation((min, max) => {
    if (min === 20000 && max === 32768) {
      candidateDraws += 1
      if (candidateDraws <= 2) return reservedPort
      return reservedPort + candidateDraws
    }
    // The allocator uses randomInt(10, 60) only for retry backoff.
    return 10
  })

  const { createProjectWithPorts } = await import('../src/lib/ports')
  const [left, right] = await Promise.all([
    createProjectWithPorts(first, {
      name: 'left', slug: 'left', ownerId: user.id,
    }, ['API_GW_HTTP_PORT']),
    createProjectWithPorts(second, {
      name: 'right', slug: 'right', ownerId: user.id,
    }, ['API_GW_HTTP_PORT']),
  ])

  expect(candidateDraws).toBeGreaterThanOrEqual(4)
  expect(left.ports.API_GW_HTTP_PORT).not.toBe(String(reservedPort))
  expect(right.ports.API_GW_HTTP_PORT).not.toBe(String(reservedPort))
  expect(left.ports.API_GW_HTTP_PORT).not.toBe(right.ports.API_GW_HTTP_PORT)

  const projects = await first.project.findMany({
    where: { slug: { in: ['left', 'right'] } },
    include: { allocatedPorts: true, envVars: true },
    orderBy: { slug: 'asc' },
  })
  expect(projects).toHaveLength(2)
  expect(projects.map(project => project.allocatedPorts.map(row => row.port)))
    .toEqual([[Number(left.ports.API_GW_HTTP_PORT)], [Number(right.ports.API_GW_HTTP_PORT)]])
  expect(projects.map(project => project.envVars[0]?.value))
    .toEqual([left.ports.API_GW_HTTP_PORT, right.ports.API_GW_HTTP_PORT])
  expect(await first.allocatedPort.count()).toBe(3)

  const transaction = vi.spyOn(first, '$transaction')
    .mockRejectedValueOnce(new Error('database is locked'))
  const afterLock = await createProjectWithPorts(first, {
    name: 'locked-retry', slug: 'locked-retry', ownerId: user.id,
  }, ['API_GW_HTTP_PORT'])
  expect(transaction).toHaveBeenCalledTimes(2)
  expect(afterLock.ports.API_GW_HTTP_PORT).not.toBe(String(reservedPort))
  expect(await first.allocatedPort.count()).toBe(4)
}, 120000)
