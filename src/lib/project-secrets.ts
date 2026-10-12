import { createHmac, randomBytes } from 'crypto'

export function generateRandomString(length: number): string {
  return randomBytes(Math.ceil(length * 3 / 4)).toString('base64url').slice(0, length)
}

export function generateJWT(role: 'anon' | 'service_role', secret: string, timestamp: number): string {
  const issuedAt = Math.floor(timestamp / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase', iat: issuedAt,
    exp: issuedAt + 365 * 24 * 60 * 60 })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}
