import { createPreviewRoutes } from '@/lib/preview-routes'
import { getPreviewService } from '@/lib/preview-worker'

export const runtime = 'nodejs'
export const POST = createPreviewRoutes(getPreviewService).destroy
