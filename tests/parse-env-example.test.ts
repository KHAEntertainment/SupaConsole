import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/db', () => ({ prisma: {} }))

const { parseEnvExample } = await import('../src/lib/project')

describe('parseEnvExample', () => {
  it('parses KEY=value pairs', () => {
    const vars = parseEnvExample('POSTGRES_PORT=5432\nJWT_SECRET=abc123\n')
    expect(vars.get('POSTGRES_PORT')).toBe('5432')
    expect(vars.get('JWT_SECRET')).toBe('abc123')
    expect(vars.size).toBe(2)
  })

  it('strips a single leading comment marker, matching upstream .env.example defaults', () => {
    const vars = parseEnvExample('# ANON_KEY=public-anon\n## still a comment\n')
    expect(vars.get('ANON_KEY')).toBe('public-anon')
    expect(vars.size).toBe(1)
  })

  it('skips blank lines and comment text without an assignment', () => {
    const vars = parseEnvExample('\n   \n# Supabase keys\nKEEP=1\nnot an assignment\n')
    expect(vars.get('KEEP')).toBe('1')
    expect(vars.size).toBe(1)
  })

  it('unwraps matching single or double quotes around values', () => {
    const vars = parseEnvExample('A="quoted value"\nB=\'single\'\nC="unterminated\nD=""\n')
    expect(vars.get('A')).toBe('quoted value')
    expect(vars.get('B')).toBe('single')
    expect(vars.get('C')).toBe('"unterminated')
    expect(vars.get('D')).toBe('')
  })

  it('keeps equals signs inside values and trims padding', () => {
    const vars = parseEnvExample('URL=postgres://user:pass@host/db?x=1\n  SPACED  =  hello  \n')
    expect(vars.get('URL')).toBe('postgres://user:pass@host/db?x=1')
    expect(vars.get('SPACED')).toBe('hello')
  })

  it('ignores keys that are not SCREAMING_SNAKE_CASE', () => {
    const vars = parseEnvExample('lower=1\nMiXeD=2\n1NUM=3\nWITH-DASH=4\nWITH SPACE=5\nGOOD_KEY=ok\n')
    expect(vars.get('GOOD_KEY')).toBe('ok')
    expect(vars.size).toBe(1)
  })

  it('lets later duplicate keys win', () => {
    const vars = parseEnvExample('DUP=first\nDUP=second\n')
    expect(vars.get('DUP')).toBe('second')
    expect(vars.size).toBe(1)
  })
})
