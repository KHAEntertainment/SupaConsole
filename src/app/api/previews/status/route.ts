import { createPreviewRoutes } from '@/lib/preview-routes'
import { getPreviewService } from '@/lib/preview-worker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = createPreviewRoutes(getPreviewService).status
