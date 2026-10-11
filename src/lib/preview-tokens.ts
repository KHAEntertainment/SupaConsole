import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from './db'

export const PREVIEW_TOKEN_PREFIX = 'spc_'
const TOKEN_BYTES = 24 // 32 url-safe characters
const BCRYPT_ROUNDS = 12

export type PreviewTokenRecord = {
  id: string
  name: string
  repository: string
  createdAt: Date
  revokedAt: Date | null
  expiresAt: Date | null
}

export type IssuedPreviewToken = PreviewTokenRecord & {
  token: string
}

function generateCleartextToken(): string {
  const bytes = randomBytes(TOKEN_BYTES)
  return PREVIEW_TOKEN_PREFIX + bytes.toString('base64url')
}

// sha256(cleartext) used as the lookup key. A 192-bit random token's sha256 is
// not password-equivalent, so it is safe to index and store.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// Module-scope dummy hash so verification always runs exactly one bcrypt.compare
// regardless of whether a row matches — keeps timing independent of N tokens and
// independent of input validity. Generated once at module load.
const DUMMY_HASH = bcrypt.hashSync('__preview_token_lookup_dummy__', BCRYPT_ROUNDS)

// Minimal repository normalization (trim + lowercase). T12 owns the canonical
// full normalizer under src/lib/preview-identity.ts; this stays inline and
// minimal until merge-time reconciliation.
export function normalizeRepository(input: string): string {
  return input.trim().toLowerCase()
}

export async function issuePreviewToken(input: {
  name: string
  repository: string
  expiresAt?: Date | null
}): Promise<IssuedPreviewToken> {
  const cleartext = generateCleartextToken()
  const tokenHash = await bcrypt.hash(cleartext, BCRYPT_ROUNDS)
  const tokenLookup = sha256Hex(cleartext)

  const row = await prisma.previewToken.create({
    data: {
      name: input.name,
      repository: input.repository,
      tokenHash,
      tokenLookup,
      expiresAt: input.expiresAt ?? null,
    },
    select: {
      id: true,
      name: true,
      repository: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })

  return { ...row, token: cleartext }
}

export async function listPreviewTokens(repository?: string): Promise<PreviewTokenRecord[]> {
  const rows = await prisma.previewToken.findMany({
    where: repository ? { repository } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      repository: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })
  return rows
}

export async function revokePreviewToken(id: string): Promise<PreviewTokenRecord | null> {
  const existing = await prisma.previewToken.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      repository: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })
  if (!existing) return null

  return prisma.previewToken.update({
    where: { id },
    data: { revokedAt: new Date() },
    select: {
      id: true,
      name: true,
      repository: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })
}

// O(1) verification: one indexed findFirst + one bcrypt.compare, regardless of
// how many tokens exist or whether the input matches. The cleartext lookup is
// sha256, the security boundary is bcrypt, and the compare always runs (against
// a module-scope dummy if no row matches) so timing/branching does not leak
// token count or validity. revokedAt and expiresAt are checked at the query
// layer so a revoke wins immediately on the very next request.
export async function verifyPreviewToken(
  cleartext: string,
  repository: string,
): Promise<PreviewTokenRecord | null> {
  if (!cleartext || !repository) return null

  const tokenLookup = sha256Hex(cleartext)
  const now = new Date()
  const candidate = await prisma.previewToken.findFirst({
    where: {
      tokenLookup,
      repository,
      revokedAt: null,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    select: {
      id: true,
      name: true,
      repository: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
      tokenHash: true,
    },
  })

  const hashToCompare = candidate?.tokenHash ?? DUMMY_HASH
  const matches = await bcrypt.compare(cleartext, hashToCompare)
  if (!candidate || !matches) return null

  return {
    id: candidate.id,
    name: candidate.name,
    repository: candidate.repository,
    createdAt: candidate.createdAt,
    revokedAt: candidate.revokedAt,
    expiresAt: candidate.expiresAt,
  }
}

export function extractBearerToken(header: string | null): string | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null
  const token = trimmed.slice(7).trim()
  return token || null
}
