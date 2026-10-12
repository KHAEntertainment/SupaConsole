import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '@prisma/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const engineMock = vi.hoisted(() => ({
  down: vi.fn(),
  docker: vi.fn(),
  removeProjectDir: vi.fn(),
}))

vi.mock('@/lib/engine', () => ({
  COMPOSE_FILE: 'docker-compose.yml',
  OVERRIDE_FILE: 'supaconsole.override.yml',
  down: engineMock.down,
  docker: engineMock.docker,
  removeProjectDir: engineMock.removeProjectDir,
}))

const { createPreviewRuntime } = await import('@/lib/preview-runtime')

let projectsRoot: string
let projectDir: string
let runtime: ReturnType<typeof createPreviewRuntime>
const projectSlug = 'cleanup-test'
const project = { slug: projectSlug } as Project

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 't15-preview-runtime-cleanup-'))
  projectDir = path.join(projectsRoot, projectSlug)
  const dockerDir = path.join(projectDir, 'docker')
  await fs.mkdir(dockerDir, { recursive: true })
  await fs.writeFile(path.join(dockerDir, 'docker-compose.yml'), 'services:\n  db:\n    image:\n')

  engineMock.down.mockReset().mockRejectedValue(new Error('compose config is malformed'))
  engineMock.docker.mockReset()
  engineMock.removeProjectDir.mockReset().mockImplementation(async (dir: string) => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  runtime = createPreviewRuntime({
    coreDockerDir: path.join(projectsRoot, 'unused-core'),
    projectsRoot,
    domain: 'preview.test',
    baselineVersion: '20261008000400',
  })
})

afterEach(async () => {
  await fs.rm(projectsRoot, { recursive: true, force: true })
})

it('falls back to removing labeled containers, volumes, networks, and the project directory after compose down fails', async () => {
  engineMock.docker
    .mockResolvedValueOnce({ stdout: 'container-id\n', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'volume-id\n', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'network-id\n', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })

  await expect(runtime.destroy(project)).resolves.toBeUndefined()

  expect(engineMock.down).toHaveBeenCalledTimes(1)
  expect(engineMock.docker.mock.calls.map(([args]) => args)).toEqual([
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectSlug}`],
    ['container', 'rm', '-f', '-v', 'container-id'],
    ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectSlug}`],
    ['volume', 'rm', 'volume-id'],
    ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectSlug}`],
    ['network', 'rm', 'network-id'],
  ])
  expect(engineMock.removeProjectDir).toHaveBeenCalledWith(projectDir, projectsRoot)
  await expect(fs.access(projectDir)).rejects.toThrow()
})

it('propagates labeled-resource cleanup failures and retains the project directory', async () => {
  engineMock.docker
    .mockResolvedValueOnce({ stdout: 'container-id\n', stderr: '' })
    .mockRejectedValueOnce(new Error('container label cleanup failed'))

  await expect(runtime.destroy(project)).rejects.toThrow('container label cleanup failed')

  expect(engineMock.down).toHaveBeenCalledTimes(1)
  expect(engineMock.docker).toHaveBeenCalledTimes(2)
  expect(engineMock.removeProjectDir).not.toHaveBeenCalled()
  await expect(fs.access(projectDir)).resolves.toBeUndefined()
})
