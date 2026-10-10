import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// SQLite has one writer. A single connection avoids competing interactive
// transactions inside this process; the port unique key protects other processes.
const databaseUrl = process.env.DATABASE_URL
const datasourceUrl = databaseUrl?.startsWith('file:') && !databaseUrl.includes('connection_limit=')
  ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=1`
  : databaseUrl
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma