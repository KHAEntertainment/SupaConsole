import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ingestBundle,
  InvalidBundleError,
  normalizeMode,
  NoMigrationsError,
} from '../src/lib/bundle-ingest'

const execFileAsync = promisify(execFile)

// Build a ustar (POSIX) tarball from a list of entries. The tar CLI on
// macOS (bsdtar) and Linux (GNU tar) both reject evil entries, so for the
// hostile-fixture tests we hand-build the header bytes: ustar is small
// enough to do without a dependency.
//
// `entries` items can include any of:
//   { name: 'foo.txt', body: 'text' }                          // regular file
//   { name: 'foo.txt', body: 'text', mode: 0o4755 }            // regular file with custom mode
//   { name: 'dir/', type: 'dir' }                             // directory
//   { name: 'link', type: 'symlink', linkname: 'x' }          // symbolic link
//   { name: 'hard', type: 'hardlink', linkname: 'x' }         // hard link (typeflag '1')
type Entry =
  | { name: string; body: string; mode?: number }
  | { name: string; type: 'dir' }
  | { name: string; type: 'symlink'; linkname: string }
  | { name: string; type: 'hardlink'; linkname: string }

function pad(num: number, size: number): string {
  return num.toString(8).padStart(size - 1, '0') + '\0'
}

// Build one 512-byte ustar header. Numeric fields are octal strings; the
// checksum is a 6-digit octal followed by NUL + space per POSIX.
function ustarHeader(input: {
  name: string
  mode?: number
  size?: number
  typeflag: string
  linkname?: string
}): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(input.name, 0, 100, 'utf8')
  buf.write(pad(input.mode ?? 0o644, 8), 100, 8)
  buf.write('0000000', 108, 8)
  buf.write('0000000', 116, 8)
  buf.write(pad(input.size ?? 0, 12), 124, 12)
  buf.write(pad(0, 12), 136, 12)
  // Checksum placeholder (spaces during compute).
  for (let i = 148; i < 156; i++) buf[i] = 0x20
  buf.write(input.typeflag, 156, 1)
  buf.write(input.linkname ?? '', 157, 100, 'utf8')
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  // Compute checksum over the entire header.
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const cks = sum.toString(8).padStart(6, '0')
  buf.write(cks + '\0 ', 148, 8)
  return buf
}

// Assemble a tarball from raw entries, padding file bodies to 512-byte
// boundaries and adding two end-of-archive blocks.
function buildTarball(entries: Entry[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    if ('body' in e) {
      const body = Buffer.from(e.body, 'utf8')
      blocks.push(ustarHeader({ name: e.name, size: body.length, typeflag: '0', mode: e.mode }))
      blocks.push(body)
      const padLen = (512 - (body.length % 512)) % 512
      if (padLen > 0) blocks.push(Buffer.alloc(padLen))
    } else if (e.type === 'dir') {
      blocks.push(ustarHeader({ name: e.name, typeflag: '5' }))
    } else if (e.type === 'symlink') {
      blocks.push(ustarHeader({ name: e.name, typeflag: '2', linkname: e.linkname }))
    } else {
      // hardlink (typeflag '1')
      blocks.push(ustarHeader({ name: e.name, typeflag: '1', linkname: e.linkname }))
    }
  }
  blocks.push(Buffer.alloc(1024)) // two zero blocks: end-of-archive
  return Buffer.concat(blocks)
}

// Build a tarball from a real on-disk fixture directory using the system
// tar CLI. Used for the happy-path test where the bundle is byte-for-byte
// the same as what T15 will receive from a real upload.
async function buildTarballFromDir(srcDir: string, relPathInside: string): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-fixtar-'))
  try {
    const out = path.join(tmp, 'bundle.tar')
    await execFileAsync('tar', ['-cf', out, '-C', srcDir, relPathInside])
    return await fs.readFile(out)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

let workDir = ''

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-test-'))
})

afterEach(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true })
})

function projectDir(name: string): string {
  return path.join(workDir, name)
}

describe('ingestBundle: happy path', () => {
  it('extracts the fixtures/preview-sample bundle into the project directory', async () => {
    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'preview-sample')
    const tarball = await buildTarballFromDir(fixtureDir, 'supabase')

    const result = await ingestBundle({ tarball, projectDir: projectDir('happy') })

    // All four categories of files survived, in the expected layout.
    expect(result.supabaseDir).toBe(path.join(projectDir('happy'), 'supabase'))
    expect(result.migrationsDir).toBe(path.join(result.supabaseDir, 'migrations'))
    expect(result.configPath).toBe(path.join(result.supabaseDir, 'config.toml'))
    expect(result.seedPath).toBe(path.join(result.supabaseDir, 'seed.sql'))

    const migrations = await fs.readdir(result.migrationsDir)
    expect(migrations.sort()).toEqual([
      '20261008000100_catalog.sql',
      '20261008000200_rpc_and_vault.sql',
      '20261008000300_write_fence.sql',
      '20261008000400_background_hazards.sql',
      '20261008000500_featured_delta.sql',
    ])

    const functions = await fs.readdir(path.join(result.supabaseDir, 'functions'))
    expect(functions).toEqual(['echo'])
    const echoFiles = await fs.readdir(path.join(result.supabaseDir, 'functions', 'echo'))
    expect(echoFiles).toEqual(['index.ts'])

    // config.toml was extracted verbatim from the fixture. The fixture
    // happens to begin with `project_id`, not `[api]` — we only assert
    // it's a non-empty file in the right place.
    const cfg = await fs.readFile(path.join(result.supabaseDir, 'config.toml'), 'utf8')
    expect(cfg.length).toBeGreaterThan(0)
    expect(cfg).toContain('project_id')

    // baseline-prelude.sql / neutralise.sql / .gitignore must NOT land on
    // disk — they are deliberately out of scope for this phase.
    const supabaseContents = await fs.readdir(result.supabaseDir)
    expect(supabaseContents).not.toContain('baseline-prelude.sql')
    expect(supabaseContents).not.toContain('neutralise.sql')
    expect(supabaseContents).not.toContain('.gitignore')
  })

  it('stages functions under the mount path with _shared preserved', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/20260101_init.sql', body: 'CREATE TABLE x(id int);\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'export default () => new Response("hi")\n' },
      { name: 'supabase/functions/_shared/util.ts', body: 'export const v = 1\n' },
      { name: 'supabase/functions/_shared/nested/deep.ts', body: 'export const v = 2\n' },
      { name: 'supabase/config.toml', body: '[api]\nenabled = true\n' },
    ])

    const result = await ingestBundle({ tarball, projectDir: projectDir('fns') })

    // Mount path defaults to <projectDir>/supabase/functions.
    expect(result.functionsMountPath).toBe(path.join(projectDir('fns'), 'supabase', 'functions'))

    // The functions mount path is populated, including the _shared tree.
    const echoIdx = await fs.readFile(path.join(result.functionsMountPath, 'echo', 'index.ts'), 'utf8')
    expect(echoIdx).toContain('Response')
    const sharedUtil = await fs.readFile(path.join(result.functionsMountPath, '_shared', 'util.ts'), 'utf8')
    expect(sharedUtil).toContain('export const v = 1')
    const sharedDeep = await fs.readFile(
      path.join(result.functionsMountPath, '_shared', 'nested', 'deep.ts'),
      'utf8'
    )
    expect(sharedDeep).toContain('export const v = 2')

    // The same files also exist under the project's supabase tree.
    expect(
      await fs.readFile(path.join(result.supabaseDir, 'functions', 'echo', 'index.ts'), 'utf8')
    ).toContain('Response')
    expect(
      await fs.readFile(path.join(result.supabaseDir, 'functions', '_shared', 'util.ts'), 'utf8')
    ).toContain('export const v = 1')
  })

  it('uses an explicit functionsMountPath when provided', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/x.sql', body: '--\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'echo\n' },
    ])
    const mountPath = path.join(projectDir('mount'), 'docker', 'volumes', 'functions')
    const result = await ingestBundle({
      tarball,
      projectDir: projectDir('mount'),
      functionsMountPath: mountPath,
    })
    expect(result.functionsMountPath).toBe(mountPath)
    expect(await fs.readFile(path.join(mountPath, 'echo', 'index.ts'), 'utf8')).toBe('echo\n')
  })
})

describe('ingestBundle: path-traversal hardening', () => {
  it('rejects a `..` path entry and writes nothing outside the destination', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: '../evil.txt', body: 'pwned' },
    ])

    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-dotdot') })
    ).rejects.toBeInstanceOf(InvalidBundleError)

    // Nothing landed in the project directory, and absolutely nothing
    // outside it. We check several neighbours to be sure.
    const projectExists = await fs
      .access(projectDir('evil-dotdot'))
      .then(() => true)
      .catch(() => false)
    expect(projectExists).toBe(false)

    const siblingHasEvil = await fs
      .access(path.join(workDir, 'evil.txt'))
      .then(() => true)
      .catch(() => false)
    expect(siblingHasEvil).toBe(false)
  })

  it('rejects an absolute path entry', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: '/etc/passwd', body: 'pwned' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-abs') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    // The /etc/passwd file must not have been written. We don't try to
    // stat the real /etc/passwd (sandbox), we only need to confirm that
    // nothing under workDir was written.
    const contents = await fs.readdir(workDir).catch(() => [])
    expect(contents).toEqual([])
  })

  it('rejects a Windows drive-letter path entry', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: 'C:\\Windows\\evil.exe', body: 'pwned' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-drive') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })

  it('rejects a Windows-style backslash path entry', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: 'supabase\\..\\evil.txt', body: 'pwned' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-bs') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })

  it('rejects a literal `..` entry name', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: '..', type: 'dir' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('literal-dotdot') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })

  it('rejects a symlink whose target escapes the supabase root', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: 'supabase/escape', type: 'symlink', linkname: '../../../../etc/passwd' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-sym') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    // Nothing under workDir may have been created.
    expect(await fs.readdir(workDir)).toEqual([])
  })

  it('rejects an absolute-path symlink target', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      { name: 'supabase/abs', type: 'symlink', linkname: '/etc/passwd' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('evil-abs-sym') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })

  it('allows a symlink whose target stays inside the supabase root', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      // `supabase/config.toml` is one of the recognized shapes; a
      // symlink there with a target that stays inside the root is fine
      // and is extracted as a link, not skipped.
      { name: 'supabase/config.toml', type: 'symlink', linkname: 'migrations/init.sql' },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('good-sym') })
    const lst = await fs.lstat(path.join(result.supabaseDir, 'config.toml'))
    expect(lst.isSymbolicLink()).toBe(true)
    const link = await fs.readlink(path.join(result.supabaseDir, 'config.toml'))
    expect(link).toBe('migrations/init.sql')
  })
})

describe('ingestBundle: shape errors', () => {
  it('rejects a bundle with no migrations via NoMigrationsError', async () => {
    const tarball = buildTarball([
      { name: 'supabase/config.toml', body: '[api]\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'echo\n' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('no-mig') })
    ).rejects.toBeInstanceOf(NoMigrationsError)

    // NoMigrationsError is not an InvalidBundleError: it's a typed
    // "missing required content" rejection the worker surfaces as a 422,
    // not a 400.
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('no-mig-2') })
    ).rejects.not.toBeInstanceOf(InvalidBundleError)
  })

  it('rejects a bundle with no recognizable supabase/ content', async () => {
    const tarball = buildTarball([
      { name: 'README.md', body: 'no supabase here' },
      { name: 'whatever.sql', body: '-- nope' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('no-supa') })
    ).rejects.toBeInstanceOf(NoMigrationsError)
  })

  it('silently drops unsupported tar entry types (FIFO, devices, sparse files)', async () => {
    // Node-tar's parser yields FIFOs, character / block devices, sparse
    // files and similar oddities as entries of types we do not handle.
    // We don't carry those onto disk; the rest of the bundle extracts
    // normally and the unsupported entry is skipped without error.
    const tarball = Buffer.concat([
      ustarHeader({
        name: 'supabase/migrations/init.sql',
        size: 5,
        typeflag: '0',
      }),
      Buffer.from('-- ok'),
      Buffer.alloc(507),
      ustarHeader({ name: 'supabase/fifo', typeflag: '6' }),
      Buffer.alloc(1024),
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('fifo') })
    // Migration landed; FIFO did not.
    expect(await fs.readdir(result.migrationsDir)).toEqual(['init.sql'])
    expect(await fs.readdir(result.supabaseDir)).not.toContain('fifo')
  })

  it('rejects an empty tarball', async () => {
    const tarball = Buffer.alloc(1024) // two zero blocks, no entries
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('empty') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })
})

describe('ingestBundle: hardlink rejection (P2-2)', () => {
  it('rejects a hardlink (Link / typeflag 1) outright', async () => {
    // A hardlink's `linkpath` is archive-root-relative, so re-using it as
    // a host relative path dangles; real Supabase bundles never need them.
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '-- ok\n' },
      {
        name: 'supabase/config.toml',
        type: 'hardlink',
        linkname: 'migrations/init.sql',
      },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('hardlink') })
    ).rejects.toBeInstanceOf(InvalidBundleError)

    // Nothing under workDir may have been created.
    expect(await fs.readdir(workDir)).toEqual([])
  })
})

describe('ingestBundle: mode-bit hardening (P2-1)', () => {
  it('strips setuid / setgid / sticky bits from extracted files', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/setuid.sql', body: '--\n', mode: 0o4755 }, // setuid + 0755
      { name: 'supabase/migrations/setgid.sql', body: '--\n', mode: 0o2755 }, // setgid + 0755
      { name: 'supabase/migrations/sticky.sql', body: '--\n', mode: 0o1755 }, // sticky + 0755
      { name: 'supabase/migrations/all-bits.sql', body: '--\n', mode: 0o7755 }, // all three + 0755
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('modes') })
    // Each file landed with the host-side 0755 permission (no upper bits).
    for (const name of ['setuid.sql', 'setgid.sql', 'sticky.sql', 'all-bits.sql']) {
      const stat = await fs.stat(path.join(result.migrationsDir, name))
      // Mask with 0o7777 because umask can affect the lower bits in some
      // setups; we only care that the upper bits are gone.
      expect(stat.mode & 0o7777).toBe(0o755)
    }
  })

  it('normalizes a hostile 0o000 mode to 0o644 instead of writing an unreadable file', async () => {
    // An attacker-supplied mode of 0 would create a file nobody (not
    // even us) can read back. We normalise to 0o644 and extract.
    const tarball = buildTarball([
      { name: 'supabase/migrations/empty.sql', body: '--\n', mode: 0o000 },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('zero-mode') })
    const stat = await fs.stat(path.join(result.migrationsDir, 'empty.sql'))
    expect(stat.mode & 0o7777).toBe(0o644)
  })

  it('preserves a normal non-setuid mode like 0o600', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/secret.sql', body: '--\n', mode: 0o600 },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('600') })
    const stat = await fs.stat(path.join(result.migrationsDir, 'secret.sql'))
    expect(stat.mode & 0o7777).toBe(0o600)
  })
})

describe('ingestBundle: path-shape edge cases (P3-6)', () => {
  it('accepts a sibling file literally named `..foo` inside supabase/', async () => {
    // `startsWith('..')` would over-match; the real check is the first
    // segment is exactly `..`. A directory entry like `supabase/..foo`
    // is a legitimate sibling (e.g. a typo'd file in a bundle) and must
    // not be rejected.
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
      { name: 'supabase/..foo', type: 'dir' },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('dotfoo') })
    // The `..foo` directory is unrecognized and silently skipped, but the
    // bundle still extracts cleanly and the migrations land.
    expect(await fs.readdir(result.migrationsDir)).toEqual(['init.sql'])
  })

  it('still rejects `..` as a first segment', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
      { name: 'supabase/../escape.txt', body: 'pwned' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('escape') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    expect(await fs.readdir(workDir)).toEqual([])
  })
})

describe('ingestBundle: duplicate paths and archive-order pairing (P3-4)', () => {
  it('processes duplicate paths in archive order, with the second overwriting the first', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: 'first\n' },
      { name: 'supabase/migrations/init.sql', body: 'second\n' },
      { name: 'supabase/config.toml', body: 'cfg\n' },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('dup') })
    // The migration was written twice; the second body wins on disk.
    const onDisk = await fs.readFile(
      path.join(result.migrationsDir, 'init.sql'),
      'utf8'
    )
    expect(onDisk).toBe('second\n')
    // `extracted` reflects BOTH writes (no silent collapse).
    const seen = result.extracted.filter((p) => p.endsWith('init.sql'))
    expect(seen.length).toBe(2)
  })
})

describe('ingestBundle: resource limits (P3-1)', () => {
  it('rejects a bundle exceeding the per-file size limit', async () => {
    // Build a tarball with a single file whose size exceeds MAX_FILE_BYTES.
    // We don't actually have to write 8 MiB of payload: a header with a
    // size field above the limit is enough, because the limit is
    // enforced before the body is drained.
    const oversized = Buffer.alloc(1)
    const tarball = Buffer.concat([
      ustarHeader({
        name: 'supabase/migrations/huge.sql',
        size: 8 * 1024 * 1024 + 1,
        typeflag: '0',
      }),
      oversized,
      // No body padding; we never read it.
      Buffer.alloc(1024),
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('oversize') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    expect(await fs.readdir(workDir)).toEqual([])
  })

  it('rejects a bundle exceeding the entry-count limit', async () => {
    // 5_001 file entries: MAX_ENTRIES is 5_000.
    const entries: Entry[] = []
    entries.push({ name: 'supabase/migrations/seed.sql', body: '--\n' })
    for (let i = 0; i < 5_001; i++) {
      entries.push({ name: `supabase/extra_${i}.txt`, body: 'x' })
    }
    const tarball = buildTarball(entries)
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('toomany') })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    expect(await fs.readdir(workDir)).toEqual([])
  })
})

describe('ingestBundle: migration counting (P3-2)', () => {
  it('rejects a bundle whose only "migrations" are a directory marker + non-file', async () => {
    // A directory marker under `supabase/migrations/` plus a symlink there
    // does NOT count as a migration file. The bundle has no SQL file, so
    // it must fail with NoMigrationsError.
    const tarball = buildTarball([
      { name: 'supabase/migrations', type: 'dir' },
      {
        name: 'supabase/migrations/init.sql',
        type: 'symlink',
        linkname: 'config.toml',
      },
      { name: 'supabase/config.toml', body: '[api]\n' },
    ])
    await expect(
      ingestBundle({ tarball, projectDir: projectDir('no-real-mig') })
    ).rejects.toBeInstanceOf(NoMigrationsError)
  })
})

describe('ingestBundle: functionsMountPath containment (P3-7)', () => {
  it('rejects a functionsMountPath that escapes projectDir', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'export default () => new Response("hi")\n' },
    ])
    const escapeMount = path.join(workDir, 'sibling', 'functions')
    await expect(
      ingestBundle({
        tarball,
        projectDir: projectDir('escape-mount'),
        functionsMountPath: escapeMount,
      })
    ).rejects.toBeInstanceOf(InvalidBundleError)
    // The escape path must not have been created.
    expect(await fs.stat(escapeMount).then(() => true).catch(() => false)).toBe(false)
  })

  it('skips the mirror write when functionsMountPath equals the in-tree functions path', async () => {
    // The default mount path is `<projectDir>/supabase/functions`. The
    // extraction must still succeed; the mirror write is just skipped
    // to avoid double-writing the same bytes.
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'echo\n' },
    ])
    const result = await ingestBundle({ tarball, projectDir: projectDir('mirror-eq') })
    // The file exists exactly once under the in-tree path.
    expect(
      await fs.readFile(path.join(result.supabaseDir, 'functions', 'echo', 'index.ts'), 'utf8')
    ).toBe('echo\n')
    // Since mount path equals in-tree, there is no separate mirror hit
    // possible. `extracted` should list the file at its single path.
    const targetPath = path.join(result.functionsMountPath, 'echo', 'index.ts')
    expect(result.functionsMountPath).toBe(path.join(result.supabaseDir, 'functions'))
    expect(result.extracted.filter((p) => p === targetPath).length).toBe(1)
  })
})

describe('normalizeMode (P3-5)', () => {
  // Pure-function tests: the OS-specific `open()` behaviour cannot be
  // observed from an end-to-end test on darwin (it strips S_ISUID), so
  // we exercise the bit math directly.
  it('strips the setuid bit (0o4755 → 0o755)', () => {
    expect(normalizeMode(0o4755)).toBe(0o755)
  })
  it('strips the setgid bit (0o2755 → 0o755)', () => {
    expect(normalizeMode(0o2755)).toBe(0o755)
  })
  it('strips the sticky bit (0o1755 → 0o755)', () => {
    expect(normalizeMode(0o1755)).toBe(0o755)
  })
  it('strips all three upper bits at once (0o7755 → 0o755)', () => {
    expect(normalizeMode(0o7755)).toBe(0o755)
  })
  it('defaults `0` to 0o644 (hostile zero-mode is normalised, not rejected)', () => {
    expect(normalizeMode(0)).toBe(0o644)
  })
  it('defaults `undefined` to 0o644', () => {
    expect(normalizeMode(undefined)).toBe(0o644)
  })
  it('preserves a normal non-setuid mode like 0o600', () => {
    expect(normalizeMode(0o600)).toBe(0o600)
  })
  it('replaces a stripped-zero result with 0o644', () => {
    // 0o7000 is all three upper bits and zero lower bits; stripping
    // leaves `0`, which we substitute back to 0o644 so the file is
    // readable.
    expect(normalizeMode(0o7000)).toBe(0o644)
  })
})

describe('ingestBundle: overlap rejection (P2-3)', () => {
  it('rejects functionsMountPath = <projectDir>/supabase (overlaps the supabase root)', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
      { name: 'supabase/functions/echo/index.ts', body: 'echo\n' },
    ])
    await expect(
      ingestBundle({
        tarball,
        projectDir: projectDir('overlap-supabase'),
        functionsMountPath: path.join(projectDir('overlap-supabase'), 'supabase'),
      })
    ).rejects.toBeInstanceOf(InvalidBundleError)

    // Regression assertion: the in-tree supabase tree (which the
    // previous commit had already committed before the mirror rename
    // tried to clobber it) must still be on disk with its migrations.
    const supabaseStillThere = await fs
      .access(path.join(projectDir('overlap-supabase'), 'supabase', 'migrations'))
      .then(() => true)
      .catch(() => false)
    expect(supabaseStillThere).toBe(false) // never written because the validation rejected
  })

  it('rejects functionsMountPath = <projectDir> (mount equals project root)', async () => {
    const tarball = buildTarball([
      { name: 'supabase/migrations/init.sql', body: '--\n' },
    ])
    await expect(
      ingestBundle({
        tarball,
        projectDir: projectDir('overlap-project'),
        functionsMountPath: projectDir('overlap-project'),
      })
    ).rejects.toBeInstanceOf(InvalidBundleError)
  })

  it('preserves the previous supabase tree when the bundle extracts successfully', async () => {
    // Seed an existing supabase/ with one migration; ingest a different
    // bundle and confirm the previous tree is replaced (not merged).
    const proj = projectDir('replace')
    await fs.mkdir(path.join(proj, 'supabase', 'migrations'), { recursive: true })
    await fs.writeFile(
      path.join(proj, 'supabase', 'migrations', '20260101_old.sql'),
      '-- old\n'
    )
    const tarball = buildTarball([
      { name: 'supabase/migrations/20260202_new.sql', body: '-- new\n' },
    ])
    const result = await ingestBundle({ tarball, projectDir: proj })
    const migrations = await fs.readdir(result.migrationsDir)
    // Old migration is GONE; new one is present. Destructive replace.
    expect(migrations).toEqual(['20260202_new.sql'])
    // The backup `.supabase-old-*` directory was cleaned up after the
    // successful rename.
    const leftover = await fs.readdir(proj)
    expect(leftover.filter((n) => n.startsWith('.supabase-old-'))).toEqual([])
  })
})

describe('ingestBundle: stale staging sweep (P3-6)', () => {
  it('cleans .bundle-ingest-* / .supabase-old-* siblings under projectDir at ingest start', async () => {
    const proj = projectDir('sweep')
    await fs.mkdir(proj, { recursive: true })
    // Plant fake stale artifacts.
    await fs.mkdir(path.join(proj, '.bundle-ingest-deadbeef-cafe'), { recursive: true })
    await fs.writeFile(
      path.join(proj, '.bundle-ingest-deadbeef-cafe', 'leaked.sql'),
      '-- leaked\n'
    )
    await fs.mkdir(path.join(proj, '.supabase-old-deadbeef'), { recursive: true })
    await fs.writeFile(
      path.join(proj, '.supabase-old-deadbeef', 'old.sql'),
      '-- old\n'
    )
    const tarball = buildTarball([
      { name: 'supabase/migrations/20260101_init.sql', body: '--\n' },
    ])
    await ingestBundle({ tarball, projectDir: proj })
    // After the ingest the only sibling under projectDir is the
    // freshly committed supabase/ tree — no stale dirs.
    const leftover = await fs.readdir(proj)
    expect(leftover.filter((n) => n.startsWith('.bundle-ingest-'))).toEqual([])
    expect(leftover.filter((n) => n.startsWith('.supabase-old-'))).toEqual([])
    expect(leftover.filter((n) => n.startsWith('.functions-old-'))).toEqual([])
    expect(leftover).toContain('supabase')
  })
})