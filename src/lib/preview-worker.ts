import path from 'node:path'
import { prisma } from './db'
import { createPreviewRuntime } from './preview-runtime'
import { createPreviewService, type PreviewService } from './previews'

const workerGlobal = globalThis as typeof globalThis & { previewService?: PreviewService }

export function getPreviewService(): PreviewService {
  if (!workerGlobal.previewService) {
    const domain = process.env.PREVIEW_DOMAIN ?? ''
    const baselineVersion = process.env.SUPACONSOLE_PREVIEW_BASELINE_VERSION ?? ''
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.includes('..')) throw new Error('PREVIEW_DOMAIN is required')
    if (!/^\d{14}$/.test(baselineVersion)) throw new Error('SUPACONSOLE_PREVIEW_BASELINE_VERSION is required')
    workerGlobal.previewService = createPreviewService(prisma, createPreviewRuntime({ domain, baselineVersion,
      coreDockerDir: path.resolve(process.env.SUPACONSOLE_PREVIEW_CORE_DOCKER_DIR ?? 'supabase-core/docker'),
      projectsRoot: path.resolve(process.env.SUPACONSOLE_PREVIEW_PROJECTS_ROOT ?? 'supabase-projects'),
    }))
  }
  return workerGlobal.previewService
}
