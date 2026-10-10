import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposeTarget } from '@/lib/engine/layout'

// compose.ts checks its files with fs.promises.access; make that slow.
const accessDelay = { ms: 0 }
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, accessDelay.ms))
      }),
    },
  }
})

// Keep the real deadline logic; only the docker invocation is observed.
const dockerCalls: Array<{ args: string[]; startedAt: number }> = []
vi.mock('@/lib/engine/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/run')>()
  return {
    ...actual,
    docker: vi.fn(async (args: string[], options: import('@/lib/engine/run').RunOptions) => {
      // What run() does first, before any process exists.
      actual.checkLimits(options)
      dockerCalls.push({ args, startedAt: Date.now() })
      return { stdout: '', stderr: '' }
    }),
  }
})

const { ps } = await import('@/lib/engine/compose')
const { run, checkLimits, DeadlineExceededError } = await import('@/lib/engine/run')
const { runHealth } = await import('@/lib/engine/health')

const target: ComposeTarget = {
  layout: 'override',
  dockerDir: '/nonexistent/docker',
  projectName: 'p',
  profile: 'persistent',
  files: ['docker-compose.yml', 'supaconsole.override.yml'],
}

afterEach(() => {
  dockerCalls.length = 0
  accessDelay.ms = 0
})

describe('compose under a deadline', () => {
  it('never invokes docker once a slow file check has crossed the deadline', async () => {
    accessDelay.ms = 40
    const deadline = Date.now() + 20
    await expect(ps(target, { timeout: 60000, deadline })).rejects.toBeInstanceOf(DeadlineExceededError)
    // Wait past where a late spawn would have happened.
    await new Promise((r) => setTimeout(r, 120))
    expect(dockerCalls).toEqual([])
  })

  it('never invokes docker once the signal is aborted during the file checks', async () => {
    accessDelay.ms = 40
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    await expect(ps(target, { signal: controller.signal })).rejects.toBeInstanceOf(DeadlineExceededError)
    await new Promise((r) => setTimeout(r, 120))
    expect(dockerCalls).toEqual([])
  })

  it('runs docker when the file checks finish in time', async () => {
    await ps(target, { timeout: 60000, deadline: Date.now() + 5000 })
    expect(dockerCalls).toHaveLength(1)
    expect(dockerCalls[0].args.slice(0, 3)).toEqual(['compose', '-p', 'p'])
  })
})

describe('run under a deadline', () => {
  it('does not start a process at or after the deadline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'run-deadline-'))
    const marker = path.join(dir, 'started')
    try {
      await expect(
        run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { deadline: Date.now() - 1 })
      ).rejects.toBeInstanceOf(DeadlineExceededError)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills a running process when its signal is aborted', async () => {
    const controller = new AbortController()
    const t0 = Date.now()
    setTimeout(() => controller.abort(), 100)
    await expect(run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { signal: controller.signal })).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('cuts the timeout to what is left before the deadline', async () => {
    const t0 = Date.now()
    await expect(
      run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 60000, deadline: Date.now() + 200 })
    ).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('checkLimits reports the remaining time', () => {
    expect(checkLimits({})).toBeUndefined()
    expect(checkLimits({ deadline: Date.now() + 1000 })).toBeGreaterThan(900)
  })
})

describe('health attempts are cancelled at the deadline', () => {
  it('aborts the outstanding attempt and starts nothing afterwards', async () => {
    let seen: AbortSignal | undefined
    const psql = vi.fn(async () => '')
    const fetch = vi.fn(async () => ({ status: 200 }))
    const realtime = vi.fn(async () => ({ ok: true, detail: '' }))
    const result = await runHealth(
      { API_GW_HTTP_PORT: '8000', ANON_KEY: 'a' },
      {
        services: ({ signal }) => {
          seen = signal
          return new Promise(() => {}) // hangs
        },
        psql,
        fetch,
        realtime,
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { timeoutMs: 100, intervalMs: 20 }
    )
    expect(seen?.aborted).toBe(true)
    expect(result.checks[0].detail).toMatch(/health deadline reached/)
    expect(result.checks.slice(1).every((c) => c.attempts === 0)).toBe(true)
    expect(psql).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(realtime).not.toHaveBeenCalled()
  })
})

describe('health cancels everything an attempt started when it settles', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('kills an insert child that is still running when the realtime event arrives', async () => {
    const { realtimeProbe, PROBE_TABLE } = await import('@/lib/engine/realtime')
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-insert-'))
    const pidFile = path.join(dir, 'pid')
    let emitInsert: (value: string) => void = () => {}

    // A minimal realtime server: confirms the subscription, and emits an
    // INSERT event whenever the test asks.
    class FakeSocket {
      onopen: ((ev: unknown) => void) | null = null
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onerror: ((ev: unknown) => void) | null = null
      onclose: ((ev: { code?: number }) => void) | null = null
      constructor() {
        setTimeout(() => this.onopen?.({}), 0)
      }
      send(data: string) {
        const msg = JSON.parse(data)
        if (msg.event !== 'phx_join') return
        const push = (event: string, payload: unknown) =>
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ topic: msg.topic, event, payload, ref: null }) }), 0)
        push('phx_reply', { status: 'ok', response: {} })
        push('system', { status: 'ok', extension: 'postgres_changes' })
        emitInsert = (value) => push('postgres_changes', { data: { type: 'INSERT', table: PROBE_TABLE, record: { probe: value } } })
      }
      close() {}
    }

    let insertChild: Promise<unknown> | undefined
    let insertPid = 0
    const psql = vi.fn(async (_db: string, sql: string, opts: { signal: AbortSignal }) => {
      if (!sql.startsWith('insert')) return ''
      const value = /values \('([^']+)'\)/.exec(sql)![1]
      // The insert's process: records its pid, then stays alive.
      insertChild = run(
        process.execPath,
        ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`],
        { signal: opts.signal }
      )
      insertChild.catch(() => {})
      while (!existsSync(pidFile) || !require('fs').readFileSync(pidFile, 'utf8')) await new Promise((r) => setTimeout(r, 10))
      insertPid = Number(require('fs').readFileSync(pidFile, 'utf8'))
      // The row is "visible" to realtime while the insert process is still running.
      emitInsert(value)
      await insertChild
      return ''
    })

    try {
      const result = await runHealth(
        { API_GW_HTTP_PORT: '8000', ANON_KEY: 'a', POOLER_TENANT_ID: 't', POSTGRES_PASSWORD: 'p' },
        {
          services: async () => ['db', 'api-gw', 'supavisor'].map((s) => ({ Name: `p-${s}-1`, Service: s, State: 'running', Health: 'healthy' })),
          psql,
          fetch: async () => ({ status: 200 }),
          realtime: (input) => realtimeProbe({ ...input, socket: FakeSocket as never }),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        { timeoutMs: 20000 }
      )
      expect(result.checks.find((c) => c.name === 'realtime')).toMatchObject({ ok: true, detail: 'INSERT event received after 1 insert(s)' })
      expect(insertPid).toBeGreaterThan(0)
      // By the time health returns, the insert child has been cancelled and reaped.
      await expect(insertChild).rejects.toThrow()
      expect(alive(insertPid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts the signal of every attempt once it settles, not only on expiry', async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    await runHealth(
      { API_GW_HTTP_PORT: '8000', ANON_KEY: 'a' },
      {
        services: async ({ signal }) => {
          signals.push(signal)
          return [{ Name: 'p-db-1', Service: 'db', State: 'running', Health: 'healthy' }]
        },
        psql: async (_db, _sql, { signal }) => {
          signals.push(signal)
          return ''
        },
        // Fails quickly twice, then passes.
        fetch: async (_url, { signal }) => {
          signals.push(signal)
          return { status: ++calls <= 2 ? 503 : 200 }
        },
        realtime: async ({ signal }) => {
          signals.push(signal)
          return { ok: true, detail: '' }
        },
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { timeoutMs: 20000, intervalMs: 10 }
    )
    expect(signals.length).toBeGreaterThan(5)
    expect(signals.every((s) => s.aborted)).toBe(true)
  })
})
