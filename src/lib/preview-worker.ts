import path from 'node:path'
import { prisma } from './db'
import { createPreviewRuntime } from './preview-runtime'
import { createPreviewService, type PreviewService } from './previews'
import { CloudflareTunnel } from './tunnel'

const workerGlobal = globalThis as typeof globalThis & { previewService?: PreviewService }

export function getPreviewService(): PreviewService {
  if (!workerGlobal.previewService) {
    const domain = process.env.PREVIEW_DOMAIN ?? ''
    const baselineVersion = process.env.SUPACONSOLE_PREVIEW_BASELINE_VERSION ?? ''
    const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
    const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID ?? ''
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.includes('..')) throw new Error('PREVIEW_DOMAIN is required')
    if (!/^\d{14}$/.test(baselineVersion)) throw new Error('SUPACONSOLE_PREVIEW_BASELINE_VERSION is required')
    if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is required')
    if (!tunnelId) throw new Error('CLOUDFLARE_TUNNEL_ID is required')
    // The API token is read from CLOUDFLARE_PREVIEW_API_TOKEN inside the adapter.
    const tunnel = new CloudflareTunnel({ account, tunnel: tunnelId, domain })
    workerGlobal.previewService = createPreviewService(prisma, createPreviewRuntime({ domain: tunnel.domain, baselineVersion,
      coreDockerDir: path.resolve(process.env.SUPACONSOLE_PREVIEW_CORE_DOCKER_DIR ?? 'supabase-core/docker'),
      projectsRoot: path.resolve(process.env.SUPACONSOLE_PREVIEW_PROJECTS_ROOT ?? 'supabase-projects'),
    }), { tunnel })
  }
  return workerGlobal.previewService
}
