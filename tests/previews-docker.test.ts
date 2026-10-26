import { execFileSync, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { c } from 'tar'
import { NextRequest } from 'next/server'
import { expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { docker } from '@/lib/engine'
import { createPreviewRuntime } from '@/lib/preview-runtime'
import { createPreviewService } from '@/lib/previews'
import { createPreviewRoutes } from '@/lib/preview-routes'
import { issuePreviewToken } from '@/lib/preview-tokens'
import { fakeTunnel } from './helpers/fake-tunnel'

async function tarball(cwd: string) {
  const archive = c({ cwd, gzip: true }, ['supabase'])
  const chunks: Buffer[] = []
  for await (const chunk of archive) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

it.skipIf(process.env.T15_DOCKER_TEST !== '1')('authenticated real-stack ensure/status/destroy, uniqueness, broken SQL, 20 clean cycles and killed-worker recovery', async () => {
  if (!process.env.DATABASE_URL?.includes('t15-acceptance')) throw new Error('Use an isolated t15-acceptance database')
  execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { env: process.env, stdio: 'pipe' })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't15-projects-'))
  const coreDockerDir = process.env.SUPACONSOLE_PREVIEW_CORE_DOCKER_DIR!
  const stack = createPreviewRuntime({ coreDockerDir, projectsRoot: root, domain: 't15.example.invalid', baselineVersion: '20261008000400' })
  let arrivals = 0
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  const tunnel = fakeTunnel('t15.example.invalid')
  const service = createPreviewService(prisma, stack, { tunnel, beforeInsert: async () => {
    if (arrivals >= 2) return
    if (++arrivals === 2) release()
    await latch
  } })
  const routes = createPreviewRoutes(() => service)
  const token = await issuePreviewToken({ name: 't15 acceptance', repository: 't15/app' })
  const headers = { authorization: `Bearer ${token.token}` }
  const bundle = await tarball('fixtures/preview-sample')
  const projects: string[] = []
  async function ensure(branch: string, data = bundle) {
    const form = new FormData()
    form.set('tarball', new Blob([new Uint8Array(data)]), 'supabase.tar.gz')
    const query = new URLSearchParams({ repository: ' T15/App ', branch, pullRequestNumber: '42' })
    const response = await routes.ensure(new NextRequest(`http://localhost/api/previews/ensure?${query}`, { method: 'POST', headers, body: form }))
    expect(response.status).toBe(202)
    return (await response.json()).operationId as string
  }
  async function status(operationId: string) {
    const response = await routes.status(new NextRequest(`http://localhost/api/previews/status?repository=t15/app&operationId=${operationId}`, { headers }))
    expect(response.status).toBe(200)
    return response.json()
  }
  async function destroy(operationId: string) {
    const operation = await prisma.operation.findUniqueOrThrow({ where: { id: operationId }, include: { project: true } })
    const slug = operation.project.slug
    const response = await routes.destroy(new NextRequest('http://localhost/api/previews/destroy?repository=t15%2Fapp', { method: 'POST', headers,
      body: JSON.stringify({ operationId }) }))
    expect(response.status).toBe(200)
    await assertClean(slug)
  }
  async function assertClean(slug: string) {
    for (const resource of ['container', 'volume', 'network']) {
      const args = resource === 'container' ? ['ps', '-aq'] : [resource, 'ls', '-q']
      expect((await docker([...args, '--filter', `label=com.docker.compose.project=${slug}`])).stdout.trim()).toBe('')
    }
    expect(await fs.access(path.join(root, slug)).then(() => true).catch(() => false)).toBe(false)
  }
  let child: ReturnType<typeof spawn> | undefined
  try {
    const cycles = Number(process.env.T15_CYCLES ?? '20')
    for (let index = 0; index < cycles; index++) {
      const branch = `cycle-${index}`
      const ids = index === 0 ? await Promise.all([ensure(branch), ensure(branch)]) : [await ensure(branch)]
      expect(new Set(ids).size).toBe(1)
      const operationId = ids[0]
      const operation = await prisma.operation.findUniqueOrThrow({ where: { id: operationId }, include: { project: true } })
      projects.push(operation.project.slug)
      await service.idle()
      const result = await status(operationId)
      expect(result.state).toBe('ready')
      expect(result.url).toBe(`https://${operation.project.slug}.t15.example.invalid`)
      expect(typeof result.anonKey).toBe('string')
      expect(result.anonKey.split('.')).toHaveLength(3)
      expect(await ensure(branch)).toBe(operationId)
      expect(await prisma.project.count({ where: { repository: 't15/app', branch } })).toBe(1)
      expect((await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${operation.project.slug}`, '--filter', 'label=com.docker.compose.service=db'])).stdout.trim().split('\n')).toHaveLength(1)
      await destroy(operationId)
      console.info(`T15 cycle ${index + 1}/${cycles}: ready, idempotent, clean`)
    }
    const largeRoot = path.join(root, 'large-migration-fixture')
    const largeSupabaseDir = path.join(largeRoot, 'supabase')
    await fs.cp('fixtures/preview-sample/supabase', largeSupabaseDir, { recursive: true })
    const payload = 'x'.repeat(129 * 1024)
    await fs.writeFile(path.join(largeSupabaseDir, 'migrations/20261008000600_large_delta.sql'),
      `create table public.stdin_probe (payload text not null);\ninsert into public.stdin_probe(payload) values ('${payload}');\ncreate index concurrently stdin_probe_payload_idx on public.stdin_probe(payload);\n`)
    const largeOperationId = await ensure('large-migration', await tarball(largeRoot))
    await service.idle()
    expect(await status(largeOperationId)).toMatchObject({ state: 'ready' })
    const largeOperation = await prisma.operation.findUniqueOrThrow({ where: { id: largeOperationId }, include: { project: true } })
    const dbContainer = (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${largeOperation.project.slug}`,
      '--filter', 'label=com.docker.compose.service=db'])).stdout.trim()
    expect(dbContainer).not.toBe('')
    const largeResult = await docker(['exec', dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t',
      '-c', 'select length(payload) from public.stdin_probe;'])
    expect(largeResult.stdout.trim()).toBe(String(payload.length))
    const indexResult = await docker(['exec', dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t',
      '-c', "select count(*) from pg_indexes where schemaname='public' and indexname='stdin_probe_payload_idx';"])
    expect(indexResult.stdout.trim()).toBe('1')
    await destroy(largeOperationId)
    await fs.rm(largeRoot, { recursive: true, force: true })
    console.info('T15 large migration: executed SQL over 128 KiB through psql stdin')

    const brokenRoot = path.join(root, 'broken-fixture')
    await fs.cp('fixtures/preview-sample/supabase', path.join(brokenRoot, 'supabase'), { recursive: true })
    await fs.writeFile(path.join(brokenRoot, 'supabase/migrations/20261008000600_broken.sql'), 'deliberately invalid SQL;')
    const broken = await ensure('broken', await tarball(brokenRoot))
    await service.idle()
    expect(await status(broken)).toMatchObject({ state: 'failed' })
    expect(await status(broken)).not.toHaveProperty('anonKey')
    await destroy(broken)
    await fs.rm(brokenRoot, { recursive: true, force: true })
    console.info('T15 broken migration: failed, retained, destroyed')
    const workerRoot = path.join(root, 'worker')
    const workerPath = path.join(workerRoot, 'tests/helpers/preview-crash-worker.js')
    const tarballPath = path.join(root, 'bundle.tar.gz')
    const operationPath = path.join(root, 'crash-operation.json')
    await fs.writeFile(tarballPath, bundle)
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'tests/helpers/preview-crash-worker.ts',
      '--outDir', workerRoot, '--module', 'commonjs', '--target', 'es2022', '--lib', 'esnext,dom', '--esModuleInterop', '--skipLibCheck'], { stdio: 'pipe' })
    child = spawn(process.execPath, [workerPath], { detached: true, stdio: 'ignore', env: { ...process.env,
      NODE_PATH: path.join(process.cwd(), 'node_modules'), SUPACONSOLE_PREVIEW_PROJECTS_ROOT: root,
      T15_CRASH_TARBALL: tarballPath, T15_CRASH_OPERATION: operationPath } })
    const deadline = Date.now() + 90000
    let operationId: string | undefined
    let slug: string | undefined
    while (Date.now() < deadline) {
      if (!operationId) {
        const raw = await fs.readFile(operationPath, 'utf8').catch(() => null)
        if (raw) operationId = JSON.parse(raw).id
      }
      if (operationId) {
        const operation = await prisma.operation.findUniqueOrThrow({ where: { id: operationId }, include: { project: true } })
        slug = operation.project.slug
        const containers = await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${slug}`])
        if (containers.stdout.trim()) break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!operationId || !slug) throw new Error('Crash worker did not provision')
    expect((await prisma.operation.findUniqueOrThrow({ where: { id: operationId } })).state).toBe('provisioning')
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
    process.kill(-child.pid!, 'SIGKILL')
    await exited
    child = undefined
    const restarted = createPreviewService(prisma, stack, { tunnel })
    expect(await restarted.start()).toBe(1)
    expect(await restarted.status('t15/app', operationId)).toMatchObject({ state: 'failed', error: 'interrupted by restart' })
    await restarted.destroy('t15/app', operationId)
    await assertClean(slug)
    console.info('T15 SIGKILL: recovered failed and cleaned partial stack')
    for (const slug of projects) await assertClean(slug)
    expect(await prisma.project.count({ where: { environmentType: 'preview' } })).toBe(0)
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    for (const project of await prisma.project.findMany({ where: { environmentType: 'preview' } })) {
      await stack.destroy(project)
      await prisma.project.delete({ where: { id: project.id } })
    }
    await prisma.$disconnect()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 3600000)
