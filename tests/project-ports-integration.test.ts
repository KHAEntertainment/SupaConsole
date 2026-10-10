import { randomInt } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, expect, it, vi } from 'vitest'

const root = process.cwd()
const dir = mkdtempSync(path.join(os.tmpdir(), 't9-ports-'))
const client = new PrismaClient({ datasourceUrl: `file:${dir}/test.db?connection_limit=1` })
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomInt: vi.fn(actual.randomInt) }
})
vi.mock('../src/lib/db', () => ({ prisma: client }))
vi.mock('../src/lib/engine', () => ({
  copyDockerTemplate: vi.fn(async (_source: string, projectDir: string) => {
    const dockerDir = path.join(projectDir, 'docker')
    mkdirSync(dockerDir, { recursive: true })
    writeFileSync(path.join(dockerDir, 'docker-compose.yml'), 'services: {}\n')
    return dockerDir
  }),
  COMPOSE_FILE: 'docker-compose.yml',
  readProjectMeta: vi.fn(async () => null),
  writeProjectMeta: vi.fn(), resolveTarget: vi.fn(), writeOverride: vi.fn(),
  docker: vi.fn(async () => ({ stdout: '', stderr: '' })),
  down: vi.fn(),
  removeProjectDir: vi.fn(async (projectDir: string) => rmSync(projectDir, { recursive: true, force: true })),
}))
afterAll(async () => {
  vi.restoreAllMocks()
  process.chdir(root)
  await client.$disconnect()
  rmSync(dir, { recursive: true, force: true })
})
it('twenty concurrent creates reserve distinct ports, avoid existing projects and release on delete', async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/db-migrate.mjs')], {
    cwd: root, env: { ...process.env, DATABASE_URL: `file:${dir}/test.db` }, stdio: 'pipe',
  })
  mkdirSync(path.join(dir, 'supabase-core/docker'), { recursive: true })
  writeFileSync(path.join(dir, 'supabase-core/docker/.env.example'),
    'API_GW_HTTP_PORT=8000\nKONG_HTTP_PORT=8000\nPOSTGRES_PORT=5432\nPOOLER_PROXY_PORT_TRANSACTION=6543\n')
  process.chdir(dir)
  const { createProject, deleteProject, updateProjectEnvVars } = await import('../src/lib/project')
  const engine = await import('../src/lib/engine')
  const user = await client.user.create({ data: { email: 'ports@example.test', password: 'unused' } })
  const existing = await createProject('existing', user.id)
  expect(existing.success).toBe(true)
  const oldGateway = await client.projectEnvVar.findFirstOrThrow({
    where: { key: 'API_GW_HTTP_PORT' },
  })
  // Force a conflict with an existing project. The whole allocation transaction
  // must roll back and retry without leaving an extra project or partial ports.
  vi.mocked(randomInt as (min: number, max: number) => number).mockReturnValueOnce(Number(oldGateway.value))
  // Freeze only the synchronous timestamp capture, then restore before Prisma
  // starts work so its transaction timers keep using the real clock.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
  const creates = Array.from({ length: 20 }, (_, i) => createProject(`concurrent-${i}`, user.id))
  clock.mockRestore()
  const results = await Promise.all(creates)
  expect(results.every(result => result.success)).toBe(true)
  const projects = await client.project.findMany({ include: { envVars: true } })
  const ports = projects.flatMap(project => [...new Set(project.envVars.filter(row =>
    ['API_GW_HTTP_PORT', 'KONG_HTTP_PORT', 'POSTGRES_PORT', 'POOLER_PROXY_PORT_TRANSACTION'].includes(row.key)
  ).map(row => Number(row.value)))])
  expect(new Set(ports).size).toBe(21 * 3)
  expect(ports.every(port => port >= 20000 && port < 32768)).toBe(true)
  expect(projects).toHaveLength(21)
  expect(await client.allocatedPort.count()).toBe(21 * 3)

  const existingProject = await client.project.findFirstOrThrow({
    where: { name: 'existing' }, include: { envVars: true },
  })
  const envFile = path.join(dir, 'supabase-projects', existingProject.slug, 'docker', '.env')
  const configurePayload = Object.fromEntries(
    existingProject.envVars.map(({ key, value }) => [key, value])
  )
  expect(configurePayload).not.toHaveProperty('STUDIO_PORT')
  expect(configurePayload).not.toHaveProperty('ANALYTICS_PORT')
  configurePayload.STUDIO_PORT = '3000'
  configurePayload.ANALYTICS_PORT = '4000'
  expect(await updateProjectEnvVars(existingProject.id, configurePayload))
    .toMatchObject({ success: true })

  // STUDIO_PORT is a configure-page default, not an allocated reservation.
  // Re-saving the full form with a changed value must remain allowed.
  configurePayload.STUDIO_PORT = '3001'
  expect(await updateProjectEnvVars(existingProject.id, configurePayload))
    .toMatchObject({ success: true })
  expect(await client.allocatedPort.count()).toBe(21 * 3)

  configurePayload.REVIEW_NOTE = '"ok'
  expect(await updateProjectEnvVars(existingProject.id, configurePayload))
    .toMatchObject({ success: true })
  const serializedLines = readFileSync(envFile, 'utf8').split(/\r?\n/)
  expect(serializedLines).toContain(`REVIEW_NOTE=${JSON.stringify('"ok')}`)
  expect(serializedLines).toContain(
    `API_GW_HTTP_PORT=${JSON.stringify(configurePayload.API_GW_HTTP_PORT)}`
  )

  const otherReservation = await client.allocatedPort.findFirstOrThrow({
    where: { projectId: { not: existingProject.id } },
  })
  configurePayload.STUDIO_PORT = String(otherReservation.port)
  expect(await updateProjectEnvVars(existingProject.id, configurePayload))
    .toMatchObject({ success: false })
  configurePayload.STUDIO_PORT = '3001'

  const envFileBeforeInjection = readFileSync(envFile, 'utf8')
  const smtpHostBeforeInjection = await client.projectEnvVar.findUniqueOrThrow({
    where: { projectId_key: { projectId: existingProject.id, key: 'SMTP_HOST' } },
  })
  expect(await updateProjectEnvVars(existingProject.id, {
    SMTP_HOST: 'mail.example.test\r\nINJECTED=value',
  })).toMatchObject({ success: false })
  expect(readFileSync(envFile, 'utf8')).toBe(envFileBeforeInjection)
  expect(await client.projectEnvVar.findUniqueOrThrow({
    where: { projectId_key: { projectId: existingProject.id, key: 'SMTP_HOST' } },
  })).toMatchObject({ value: smtpHostBeforeInjection.value })
  expect(await client.projectEnvVar.findFirst({
    where: { projectId: existingProject.id, key: 'INJECTED' },
  })).toBeNull()

  const coreEnvFile = path.join(dir, 'supabase-core', 'docker', '.env.example')
  const coreEnvBefore = readFileSync(coreEnvFile, 'utf8')
  writeFileSync(coreEnvFile, 'POSTGRES_PORT=5432\n')
  expect(await createProject('missing-gateway', user.id)).toMatchObject({ success: false })
  expect(await client.project.count()).toBe(21)
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  writeFileSync(coreEnvFile, coreEnvBefore)

  const stableProjectCount = await client.project.count()
  const stableReservationCount = await client.allocatedPort.count()
  let failedCopyPath = ''
  vi.mocked(engine.copyDockerTemplate).mockImplementationOnce(async (_source, projectDir) => {
    failedCopyPath = projectDir
    mkdirSync(path.join(projectDir, 'docker'), { recursive: true })
    throw new Error('copy failed after creating the project directory')
  })
  expect(await createProject('failed-copy', user.id)).toMatchObject({ success: false })
  expect(failedCopyPath).not.toBe('')
  expect(existsSync(failedCopyPath)).toBe(false)
  expect(await client.project.count()).toBe(stableProjectCount)
  expect(await client.allocatedPort.count()).toBe(stableReservationCount)

  const createInDirectory = async (_source: string, projectDir: string) => {
    const dockerDir = path.join(projectDir, 'docker')
    mkdirSync(dockerDir, { recursive: true })
    writeFileSync(path.join(dockerDir, 'docker-compose.yml'), 'services: {}\n')
    return dockerDir
  }
  let failedMetaPath = ''
  vi.mocked(engine.copyDockerTemplate).mockImplementationOnce(async (source, projectDir) => {
    failedMetaPath = projectDir
    return createInDirectory(source, projectDir)
  })
  vi.mocked(engine.writeProjectMeta).mockRejectedValueOnce(new Error('metadata write failed'))
  expect(await createProject('failed-metadata', user.id)).toMatchObject({ success: false })
  expect(existsSync(failedMetaPath)).toBe(false)
  expect(await client.project.count()).toBe(stableProjectCount)
  expect(await client.allocatedPort.count()).toBe(stableReservationCount)

  let failedEnvPath = ''
  vi.mocked(engine.copyDockerTemplate).mockImplementationOnce(async (source, projectDir) => {
    failedEnvPath = projectDir
    return createInDirectory(source, projectDir)
  })
  const envUpsert = vi.spyOn(client.projectEnvVar, 'upsert')
    .mockRejectedValueOnce(new Error('environment upsert failed'))
  expect(await createProject('failed-environment', user.id)).toMatchObject({ success: false })
  envUpsert.mockRestore()
  expect(existsSync(failedEnvPath)).toBe(false)
  expect(await client.project.count()).toBe(stableProjectCount)
  expect(await client.allocatedPort.count()).toBe(stableReservationCount)

  configurePayload.API_GW_HTTP_PORT = '1'
  expect(await updateProjectEnvVars(existingProject.id, configurePayload))
    .toMatchObject({ success: false })
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  vi.mocked(engine.down).mockRejectedValueOnce(new Error('container shutdown failed'))
  expect(await deleteProject(existingProject.id)).toMatchObject({ success: false })
  expect(await client.project.findUnique({ where: { id: existingProject.id } })).not.toBeNull()
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  expect(await deleteProject(existingProject.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.count()).toBe(20 * 3)

  const missingComposeEmpty = await createProject('missing-compose-empty', user.id)
  expect(missingComposeEmpty.success).toBe(true)
  const emptyProject = await client.project.findFirstOrThrow({ where: { name: 'missing-compose-empty' } })
  const emptyComposePath = path.join(dir, 'supabase-projects', emptyProject.slug, 'docker', 'docker-compose.yml')
  rmSync(emptyComposePath)
  vi.mocked(engine.docker).mockClear()
  vi.mocked(engine.docker)
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(emptyProject.id)).toMatchObject({ success: true })
  expect(engine.docker).toHaveBeenNthCalledWith(1, [
    'ps', '-a', '--filter', `label=com.docker.compose.project=${emptyProject.slug}`, '--format', '{{.ID}}',
  ])
  expect(engine.docker).toHaveBeenNthCalledWith(2, [
    'ps', '-a', '--filter', `label=com.docker.compose.project.working_dir=${path.dirname(emptyComposePath)}`, '--format', '{{.ID}}',
  ])
  expect(await client.project.findUnique({ where: { id: emptyProject.id } })).toBeNull()
  expect(await client.allocatedPort.count()).toBe(20 * 3)

  const missingComposeHasContainers = await createProject('missing-compose-live', user.id)
  expect(missingComposeHasContainers.success).toBe(true)
  const liveProject = await client.project.findFirstOrThrow({ where: { name: 'missing-compose-live' } })
  const liveComposePath = path.join(dir, 'supabase-projects', liveProject.slug, 'docker', 'docker-compose.yml')
  rmSync(liveComposePath)
  vi.mocked(engine.docker).mockClear()
  vi.mocked(engine.docker).mockResolvedValueOnce({ stdout: 'container-id\n', stderr: '' })
  expect(await deleteProject(liveProject.id)).toMatchObject({ success: false })
  expect(await client.project.findUnique({ where: { id: liveProject.id } })).not.toBeNull()
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  vi.mocked(engine.docker).mockClear()
  vi.mocked(engine.docker).mockRejectedValueOnce(new Error('docker unavailable'))
  expect(await deleteProject(liveProject.id)).toMatchObject({ success: false })
  expect(await client.project.findUnique({ where: { id: liveProject.id } })).not.toBeNull()
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  vi.mocked(engine.docker).mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(liveProject.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.count()).toBe(20 * 3)

  const workingDirLabelProject = await createProject('missing-compose-working-dir-label', user.id)
  expect(workingDirLabelProject.success).toBe(true)
  const workingDirProject = await client.project.findFirstOrThrow({
    where: { name: 'missing-compose-working-dir-label' },
  })
  const workingDirCompose = path.join(dir, 'supabase-projects', workingDirProject.slug, 'docker', 'docker-compose.yml')
  rmSync(workingDirCompose)
  vi.mocked(engine.docker).mockClear()
  vi.mocked(engine.docker)
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'legacy-container-id\n', stderr: '' })
  expect(await deleteProject(workingDirProject.id)).toMatchObject({ success: false })
  expect(engine.docker).toHaveBeenNthCalledWith(2, [
    'ps', '-a', '--filter', `label=com.docker.compose.project.working_dir=${path.dirname(workingDirCompose)}`, '--format', '{{.ID}}',
  ])
  expect(await client.project.findUnique({ where: { id: workingDirProject.id } })).not.toBeNull()
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  vi.mocked(engine.docker).mockClear()
  vi.mocked(engine.docker)
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(workingDirProject.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.count()).toBe(20 * 3)

  const unreadableMetaResult = await createProject('unreadable-metadata', user.id)
  expect(unreadableMetaResult.success).toBe(true)
  const unreadableProject = await client.project.findFirstOrThrow({
    where: { name: 'unreadable-metadata' },
  })
  const unreadableCompose = path.join(dir, 'supabase-projects', unreadableProject.slug, 'docker', 'docker-compose.yml')
  rmSync(unreadableCompose)
  vi.mocked(engine.readProjectMeta).mockRejectedValueOnce(
    Object.assign(new Error('permission denied reading project metadata'), { code: 'EACCES' })
  )
  vi.mocked(engine.docker).mockClear()
  expect(await deleteProject(unreadableProject.id)).toMatchObject({ success: false })
  expect(engine.docker).not.toHaveBeenCalled()
  expect(await client.project.findUnique({ where: { id: unreadableProject.id } })).not.toBeNull()
  expect(await client.allocatedPort.count()).toBe(21 * 3)
  vi.mocked(engine.docker)
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(unreadableProject.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.count()).toBe(20 * 3)

  const invalidLegacyClaimant = await client.project.create({
    data: {
      name: 'legacy-invalid-claimant', slug: 'legacy-invalid-claimant', ownerId: user.id,
      createdAt: new Date('2019-01-01T00:00:00.000Z'),
    },
  })
  const legacyOwner = await client.project.create({
    data: {
      name: 'legacy-owner', slug: 'legacy-owner', ownerId: user.id,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    },
  })
  const legacySurvivor = await client.project.create({
    data: {
      name: 'legacy-survivor', slug: 'legacy-survivor', ownerId: user.id,
      createdAt: new Date('2021-01-01T00:00:00.000Z'),
    },
  })
  const contestedPort = 22345
  await client.projectEnvVar.create({
    data: {
      projectId: invalidLegacyClaimant.id, key: 'KONG_HTTP_PORT',
      value: `${contestedPort}junk`,
    },
  })
  await client.projectEnvVar.create({
    data: { projectId: legacyOwner.id, key: 'API_GW_HTTP_PORT', value: String(contestedPort) },
  })
  await client.projectEnvVar.create({
    data: {
      projectId: legacySurvivor.id, key: 'API_GW_HTTP_PORT',
      value: `\t"${contestedPort}" # legacy compatibility`,
    },
  })
  await client.allocatedPort.create({ data: { port: contestedPort, projectId: legacyOwner.id } })
  vi.mocked(engine.docker).mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(legacyOwner.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.findUnique({ where: { port: contestedPort } }))
    .toMatchObject({ projectId: legacySurvivor.id })
  vi.mocked(engine.docker).mockResolvedValueOnce({ stdout: '', stderr: '' })
  expect(await deleteProject(legacySurvivor.id)).toMatchObject({ success: true })
  expect(await client.allocatedPort.findUnique({ where: { port: contestedPort } })).toBeNull()
}, 120000)
