import { randomInt } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

// Gateway names are aliases across Supabase releases and share one reservation.
export const PORT_KEYS = [
  'API_GW_HTTP_PORT', 'KONG_HTTP_PORT', 'KONG_HTTPS_PORT', 'STUDIO_PORT',
  'ANALYTICS_PORT', 'POSTGRES_PORT', 'POOLER_PROXY_PORT_TRANSACTION',
] as const

async function allocate(
  db: PrismaClient,
  data: Prisma.ProjectUncheckedCreateInput,
  keys: string[],
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const project = await tx.project.create({ data })
        const ports: Record<string, string> = {}
        const assigned = new Map<string, number>()
        for (const key of keys) {
          const group = key === 'KONG_HTTP_PORT' ? 'API_GW_HTTP_PORT' : key
          let port = assigned.get(group)
          if (port === undefined) {
            port = randomInt(20000, 32768)
            await tx.allocatedPort.create({ data: { port, projectId: project.id } })
            assigned.set(group, port)
          }
          ports[key] = String(port)
          await tx.projectEnvVar.create({ data: { projectId: project.id, key, value: String(port) } })
        }
        return { project, ports }
      }, { maxWait: 30000, timeout: 30000 })
    } catch (error) {
      const retry = (error instanceof Error && /database is locked/i.test(error.message)) ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          (['P1008', 'P2034', 'P2028'].includes(error.code) ||
            (error.code === 'P2002' && String(error.meta?.target).includes('port'))))
      if (!retry || attempt === 39) throw error
      await new Promise(resolve => setTimeout(resolve, randomInt(10, 60)))
    }
  }
  throw new Error('Unable to allocate project ports')
}

// Prisma's SQLite interactive transactions cannot share a connection at once.
// Queue local writers while keeping the database constraint as the authority
// across independent clients and application processes.
const pending = new WeakMap<PrismaClient, Promise<unknown>>()
export async function createProjectWithPorts(
  db: PrismaClient, data: Prisma.ProjectUncheckedCreateInput, keys: string[],
) {
  const previous = pending.get(db) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => allocate(db, data, keys))
  pending.set(db, current)
  try { return await current } finally {
    if (pending.get(db) === current) pending.delete(db)
  }
}
