import { execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Bounds on when a command may run. `deadline` is absolute (ms since the
// epoch): a command is never started at or after it, and its timeout is cut to
// what is left. Aborting `signal` refuses to start the command, or kills it if
// it is running.
export interface RunLimits {
  deadline?: number
  signal?: AbortSignal
}

export class DeadlineExceededError extends Error {}

// Throws if the limits no longer allow starting work; otherwise returns the
// milliseconds left before the deadline (undefined when there is none). Call
// it after every awaited step and immediately before starting a process.
export function checkLimits(limits: RunLimits = {}): number | undefined {
  if (limits.signal?.aborted) throw new DeadlineExceededError('aborted before starting: health deadline reached')
  if (limits.deadline === undefined) return undefined
  const remaining = limits.deadline - Date.now()
  if (remaining <= 0) throw new DeadlineExceededError('deadline passed before starting')
  return remaining
}

export interface RunOptions extends RunLimits {
  cwd?: string
  timeout?: number
  maxBuffer?: number
  // Extra environment for the child, layered over this process's. Lets
  // secrets reach a child (e.g. `docker exec -e PGPASSWORD`) without
  // appearing in its argument list.
  env?: Record<string, string>
  input?: string | Buffer
}

export interface RunResult {
  stdout: string
  stderr: string
}

// The only way the engine starts a process: a program plus an argument array,
// never a shell string, so slugs, paths and refs can't be interpreted by a
// shell. Rejects with the child_process error (stdout/stderr attached) on a
// non-zero exit or timeout.
export async function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const remaining = checkLimits(options)
  const timeout = remaining === undefined ? options.timeout : Math.min(options.timeout ?? remaining, remaining)
  let child: ChildProcess | undefined
  try {
    const pending = execFileAsync(file, args, {
      cwd: options.cwd,
      timeout,
      signal: options.signal,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    })
    child = pending.child
    const inputWritten = new Promise<void>((resolve, reject) => {
      if (!child?.stdin) { resolve(); return }
      child.stdin.once('error', reject)
      child.stdin.end(options.input, (error?: Error | null) => error ? reject(error) : resolve())
    })
    const [{ stdout, stderr }] = await Promise.all([pending, inputWritten])
    return { stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    // Input and abort errors can reject before the process exits.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await reap(child)
    }
    throw error
  }
}

const REAP_KILL_AFTER_MS = 2000
const REAP_GIVE_UP_MS = 5000

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), REAP_KILL_AFTER_MS)
    const giveUp = setTimeout(done, REAP_GIVE_UP_MS)
    function done() {
      clearTimeout(kill)
      clearTimeout(giveUp)
      resolve()
    }
    child.once('exit', done)
  })
}

export function docker(args: string[], options?: RunOptions): Promise<RunResult> {
  return run('docker', args, options)
}
