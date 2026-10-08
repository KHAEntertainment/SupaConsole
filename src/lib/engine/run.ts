import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface RunOptions {
  cwd?: string
  timeout?: number
  maxBuffer?: number
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
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}

export function docker(args: string[], options?: RunOptions): Promise<RunResult> {
  return run('docker', args, options)
}
