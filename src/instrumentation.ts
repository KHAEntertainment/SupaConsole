export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getPreviewService } = await import('./lib/preview-worker')
    if (process.env.PREVIEW_DOMAIN && process.env.SUPACONSOLE_PREVIEW_BASELINE_VERSION) {
      await getPreviewService().start()
    } else {
      const { prisma } = await import('./lib/db')
      const { recoverInterruptedOperations } = await import('./lib/operations')
      await recoverInterruptedOperations(prisma, { kind: 'preview-ensure' })
    }
  }
}
