import { promises as fs } from 'node:fs'
import { prisma } from '../../src/lib/db'
import { createPreviewRuntime } from '../../src/lib/preview-runtime'
import { createPreviewService } from '../../src/lib/previews'
import { normalizePreviewIdentity } from '../../src/lib/preview-identity'
import { fakeTunnel } from './fake-tunnel'

async function main() {
  const service = createPreviewService(prisma, createPreviewRuntime({
    domain: 't15.example.invalid', baselineVersion: '20261008000400',
    coreDockerDir: process.env.SUPACONSOLE_PREVIEW_CORE_DOCKER_DIR!, projectsRoot: process.env.SUPACONSOLE_PREVIEW_PROJECTS_ROOT!,
  }), { tunnel: fakeTunnel('t15.example.invalid') })
  const operation = await service.ensure(normalizePreviewIdentity({ repository: 't15/app', branch: 'crash' }),
    await fs.readFile(process.env.T15_CRASH_TARBALL!))
  await fs.writeFile(process.env.T15_CRASH_OPERATION!, JSON.stringify(operation))
  await service.idle()
  await prisma.$disconnect()
}
void main().catch(() => { process.exitCode = 1 })
