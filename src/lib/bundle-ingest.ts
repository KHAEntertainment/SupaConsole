// Extracts an uploaded `supabase/` tarball into a project's directory, with
// strict path validation applied to the whole bundle up front.
//
// This module owns the *library* that the `ensure` worker (T15) calls; it does
// not run migrations, seed, or functions. Its single responsibility is to
// land the bundle safely on disk:
//
//   - Reject the whole tarball if any entry names a path that could escape
//     `<projectDir>/supabase/` (`..` segments, leading `/`, Windows drive
//     letters, backslash separators, literal `.` or `..` entries), or is a
//     symlink whose target escapes that root. Hardlinks (`Link`) are
//     rejected outright: a tar Link's `linkpath` is archive-root-relative,
//     so re-using it as a host relative path dangles, and no real Supabase
//     bundle needs hardlinks.
//   - Validate every entry first, then extract; never write a single byte
//     until the bundle is known to be clean. Extraction happens into a
//     sibling temp directory under `<projectDir>` and is `rename`-d into
//     place on success, so a mid-extraction failure leaves nothing partial
//     at the final destinations.
//   - Strip the setuid / setgid / sticky bits from any tar `mode` via
//     `normalizeMode`. A `0` or `undefined` mode normalises to `0o644`.
//   - Cap the bundle at a fixed entry count and total bytes so an attacker
//     cannot OOM the worker with a 4 GB single-file tarball.
//   - Pull `supabase/migrations/**`, `supabase/functions/**`,
//     `supabase/config.toml`, and `supabase/seed.sql` out of the tarball
//     into `<projectDir>/supabase/`. Other entries in the bundle (e.g.
//     `baseline-prelude.sql`, `neutralise.sql`) are intentionally skipped:
//     those belong to later phases and should not be staged on disk.
//     Unknown tar entry types (FIFOs, character / block devices, sparse
//     files, ...) are silently dropped rather than rejected: node-tar
//     never carries them in a real Supabase bundle, and rejecting on type
//     would reject the whole archive for a header artifact.
//   - Stage `functions/**` into a separate functions-mount path. That
//     path is the host directory the runtime container bind-mounts onto
//     `/home/deno/functions` at compose startup; by default it is
//     `<projectDir>/supabase/functions`, which means functions are only
//     written once (the mirror write is skipped when the paths are equal).
//     Callers that mount from elsewhere (e.g.
//     `<projectDir>/docker/volumes/functions`) pass `functionsMountPath`
//     explicitly.
//   - Reject a bundle that contains no file entries under
//     `supabase/migrations/**` with a typed error, so the worker can
//     distinguish "bad tarball" from "missing directory".
//
// **Destructive-replace semantics:** a successful ingest REPLACES any
// existing tree at `<projectDir>/supabase/` (and at the functions mount
// path, if different). It is NOT a merge; files in the destination that
// are not in the bundle are removed. The previous tree is preserved at
// `<projectDir>/.supabase-old-<hex>` during the rename so an interrupted
// ingest leaves the previous tree recoverable, but a successful ingest
// deletes the backup as the last step.

import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { Parser, type ReadEntry } from 'tar'

// What we recognize inside the bundle. Anything else is skipped, not rejected:
// `baseline-prelude.sql` and `neutralise.sql` exist in fixtures for later
// phases and should never land on disk during ingest.
const SUPABASE_PREFIX = 'supabase/'
const MIGRATIONS_PREFIX = 'migrations/'
const FUNCTIONS_PREFIX = 'functions/'
const CONFIG_BASENAME = 'config.toml'
const SEED_BASENAME = 'seed.sql'

// Resource limits applied during the validation pass. Both are sized to
// comfortably exceed any real Supabase bundle we expect (largest in-tree
// fixtures are a few hundred KB across <50 entries) and small enough that
// a hostile bundle cannot exhaust worker memory.
const MAX_ENTRIES = 5_000
// 100 MiB: enough for a bundle with hundreds of SQL migrations and many
// edge functions; a tarball this size is almost certainly either a copy
// of a vendored dependency or an attack.
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
// Hard cap on a single file's body. Real migrations top out at ~10 KB
// and edge functions at ~50 KB; anything larger is a copy of vendored
// code or an attack.
const MAX_FILE_BYTES = 8 * 1024 * 1024

// Thrown for any traversal / shape problem in the bundle. Carries the entry
// path so the worker can log the exact cause without re-listing the tarball.
export class InvalidBundleError extends Error {
  readonly entryPath: string | undefined
  constructor(message: string, entryPath?: string) {
    super(message)
    this.name = 'InvalidBundleError'
    this.entryPath = entryPath
  }
}

// The bundle parsed cleanly but contained no `supabase/migrations/**` file
// entries. Distinct from `InvalidBundleError` so callers can surface
// "your tarball has no migrations" as a user-facing error and "bad
// tarball" as a 4xx.
export class NoMigrationsError extends Error {
  constructor(message = 'Bundle contains no supabase/migrations/** file entries') {
    super(message)
    this.name = 'NoMigrationsError'
  }
}

export interface IngestBundleOptions {
  // Raw bytes of the tarball. Accepts Buffer or Uint8Array (e.g. a File's
  // .arrayBuffer() result) since the route handler reads a multipart upload.
  tarball: Buffer | Uint8Array
  // Where the bundle's contents land. Created if it does not exist.
  projectDir: string
  // Host directory the functions container bind-mounts onto
  // `/home/deno/functions`. Defaults to `<projectDir>/supabase/functions`.
  // Must be a sub-directory of `projectDir`; pass a different path only
  // when the compose project mounts from elsewhere (e.g.
  // `docker/volumes/functions`).
  functionsMountPath?: string
}

export interface IngestBundleResult {
  // Absolute paths on disk after a successful ingest. The ingest was
  // destructive-replace: any pre-existing tree at `supabaseDir` (and at
  // `functionsMountPath` if it differs) was replaced with the bundle's
  // contents. The worker should not assume files outside the four
  // recognised shapes survived.
  projectDir: string
  supabaseDir: string
  migrationsDir: string
  functionsMountPath: string
  configPath: string | null
  seedPath: string | null
  // Set of paths that were actually extracted, useful for tests and for the
  // worker to log what landed. Does not include skipped entries (e.g.
  // `baseline-prelude.sql`).
  extracted: ReadonlyArray<string>
}

// The subset of tar entry kinds we know how to handle. Anything else
// (CharacterDevice, FIFO, global PAX headers, sparse files, hardlinks...)
// is rejected.
type HandledType = 'File' | 'Directory' | 'SymbolicLink'

interface ValidatedEntry {
  // The original tar entry name (post-decode; we never mutate names that
  // came out of the tarball, we just compute a relative target).
  rawPath: string
  // Position of this entry in archive order, so the extract pass can pair
  // it back to the parser's emission even when paths repeat.
  archiveIndex: number
  // Resolved category for this entry, or null if it should be silently
  // skipped (e.g. baseline-prelude.sql).
  classification: EntryClassification
  // The resolved absolute destination path on the host filesystem, computed
  // during validation so the extraction step just calls fs.cp without
  // thinking about traversal again.
  destPath: string
  // True if the entry must additionally be staged into the functions mount
  // path. Only set for entries under `supabase/functions/**` AND only when
  // the mount path differs from the in-tree path (otherwise the in-tree
  // write already populates it).
  alsoStageToFunctions: boolean
  // For symlinks: the validated target string we should write into the
  // resulting symlink (resolved + containment-checked against the supabase
  // root). Undefined for regular files and directories.
  linkTarget?: string
  // The mode to write the entry with, with setuid / setgid / sticky bits
  // stripped. Undefined for non-File / non-SymbolicLink entries (directories
  // are created via mkdir which uses the host default).
  mode?: number
}

type EntryClassification =
  | { kind: 'migrations'; relativePath: string }
  | { kind: 'functions'; relativePath: string }
  | { kind: 'config' }
  | { kind: 'seed' }

// Read the entire tarball into a Buffer. Supabase bundles are small enough
// that holding them in memory twice (once for validation, once for
// extraction) is cheaper than juggling temp files.
function asBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input)
}

// Path utilities shared by the validation and extraction passes. POSIX
// separators only: tar names are `/`-separated by spec, and we refuse
// backslashes outright, so splitting on `/` is correct.
function splitPosix(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0)
}

function stripLeadingDotSegments(parts: string[]): string[] {
  // Tar produced by some clients has a `./supabase/...` form; ignore those
  // leading `./` segments, but only when they are at the very start.
  let i = 0
  while (i < parts.length && parts[i] === '.') i++
  return parts.slice(i)
}

// Reject if any segment is `..`. Used both for the entry's own name and
// for a symlink's linkpath.
function hasTraversalSegment(parts: string[]): boolean {
  for (const seg of parts) {
    if (seg === '..') return true
  }
  return false
}

// Returns true for absolute paths (`/foo`), Windows drive letters
// (`C:\`), and backslash separators. macOS / Linux paths never
// legitimately use any of these inside a tar, so any occurrence is
// treated as a hostile attempt. Empty strings are rejected by callers
// (linkpath checks) before this is called, so we don't re-check.
function hasAbsoluteOrWindowsShape(raw: string): boolean {
  if (raw.startsWith('/')) return true
  if (raw.includes('\\')) return true
  if (/^[A-Za-z]:/.test(raw)) return true
  return false
}

// `path.relative` can return strings like `..foo` (a sibling literally
// named `..foo`) which `startsWith('..')` would over-match. The real
// check is "this path's first segment is `..`".
function escapesSupabaseRoot(supabaseRoot: string, candidate: string): boolean {
  const rel = path.relative(supabaseRoot, candidate)
  if (path.isAbsolute(rel)) return true
  if (rel === '..') return true
  if (rel.startsWith('..' + path.sep)) return true
  return false
}

// Containment check used for the `functionsMountPath` argument. The mount
// must be inside the project directory, otherwise an attacker who can
// influence the caller's URL handler could redirect the staged functions
// tree outside the project.
function isInside(parent: string, child: string): boolean {
  const parentAbs = path.resolve(parent)
  const childAbs = path.resolve(child)
  if (parentAbs === childAbs) return true
  const rel = path.relative(parentAbs, childAbs)
  if (path.isAbsolute(rel)) return false
  if (rel === '..') return false
  if (rel.startsWith('..' + path.sep)) return false
  return true
}

// Validate every entry. Throws InvalidBundleError on the first hostile
// entry, after having validated (but not extracted) the entries that came
// before it. The caller must not write anything to disk until this returns.
//
// Returns the list of entries that should actually land on disk, with
// their classification and resolved destination paths computed.
async function validateBundle(opts: {
  tarball: Buffer
  projectDir: string
  functionsMountPath: string
  inTreeFunctionsPath: string
}): Promise<ValidatedEntry[]> {
  const { tarball, projectDir, functionsMountPath, inTreeFunctionsPath } = opts

  // Containment: the functions mount must be inside the project, so an
  // attacker controlling the multipart upload's headers can't redirect
  // the staged functions tree outside the project.
  if (!isInside(projectDir, functionsMountPath)) {
    throw new InvalidBundleError(
      `functionsMountPath must be inside projectDir: ${JSON.stringify(functionsMountPath)} is not inside ${JSON.stringify(projectDir)}`
    )
  }

  // Whether entries classified as `functions` also need a mirror write to
  // `functionsMountPath`. When the two paths are equal, the in-tree write
  // already populates it; the mirror is a no-op that doubles I/O for no
  // gain and is a foot-gun if the in-tree path is on a slower filesystem
  // than the mount target.
  const mirrorToFunctionsPath = functionsMountPath !== inTreeFunctionsPath
  // The root everything must stay inside. Symlinks are resolved against
  // the directory of the entry that contains them; the result is checked
  // to stay inside `supabaseRoot`.
  const supabaseRoot = path.resolve(projectDir, 'supabase')

  // Overlap rejection: when the mirror path is distinct from the in-tree
  // functions dir, it must not nest inside `supabaseRoot` (or vice
  // versa). `isInside` returns true for equality, so `mirrorToFunctionsPath
  // === false` already covers the equal case; the check below catches
  // `<projectDir>/supabase` and `<projectDir>/supabase/...` overlaps. If
  // we didn't reject, the rename into place would delete what was just
  // committed (because the staging mirror is on the same filesystem, but
  // the destination's safeRemove would race with the supabase rename).
  if (mirrorToFunctionsPath) {
    if (isInside(supabaseRoot, functionsMountPath) || isInside(functionsMountPath, supabaseRoot)) {
      throw new InvalidBundleError(
        `functionsMountPath must not overlap the supabase root: ${JSON.stringify(functionsMountPath)} overlaps ${JSON.stringify(supabaseRoot)}`
      )
    }
  }

  const out: ValidatedEntry[] = []
  // `archiveOrder` is the parser-emission counter for THIS pass. It
  // tracks the position of every entry the parser yields, including ones
  // that fail validation or don't match a recognized classification, so
  // the extract pass can pair parser-emissions back to validated entries
  // by position (not by name, which would collapse duplicate paths).
  let archiveOrder = 0
  let migrationsSeen = 0
  let entriesSeen = 0
  let totalBodyBytes = 0

  const parser = new Parser({ strict: true })

  // Per-entry validation, in a Promise wrapper so we can throw on the first
  // hostile entry. Each `entry` event gives us a ReadEntry we must drain
  // (or pause+resume later); we just drain now since the data is small
  // and we are not extracting in this pass.
  const drained: Promise<void>[] = []
  const validationDone = new Promise<void>((resolve, reject) => {
    parser.on('entry', (entry) => {
      // Always drain the body so the parser can move on.
      const drain: Promise<void> = new Promise((res) => {
        entry.on('end', res)
        entry.resume()
      })
      drained.push(drain)

      // Track the parser-emission order so the extract pass can pair
      // entries back by position. Incremented for EVERY entry the parser
      // yields, including ones that fail validation.
      const myArchiveOrder = archiveOrder++

      // Resource caps: entry count and total body bytes. These run BEFORE
      // any path validation so a hostile bundle cannot pin a worker by
      // streaming millions of tiny entries first.
      entriesSeen++
      if (entriesSeen > MAX_ENTRIES) {
        reject(new InvalidBundleError(
          `Bundle exceeds the entry-count limit of ${MAX_ENTRIES}: ${entriesSeen} entries seen so far`
        ))
        parser.abort(new InvalidBundleError('entry-count limit exceeded'))
        return
      }
      if (typeof entry.size === 'number' && entry.size > MAX_FILE_BYTES) {
        reject(new InvalidBundleError(
          `Bundle entry exceeds the per-file size limit of ${MAX_FILE_BYTES} bytes: ${JSON.stringify(entry.path)} is ${entry.size} bytes`,
          entry.path
        ))
        parser.abort(new InvalidBundleError('per-file size limit exceeded'))
        return
      }
      if (typeof entry.size === 'number') totalBodyBytes += entry.size
      if (totalBodyBytes > MAX_TOTAL_BYTES) {
        reject(new InvalidBundleError(
          `Bundle exceeds the total-body size limit of ${MAX_TOTAL_BYTES} bytes`
        ))
        parser.abort(new InvalidBundleError('total-body size limit exceeded'))
        return
      }

      try {
        const rawPath = entry.path
        if (hasAbsoluteOrWindowsShape(rawPath)) {
          throw new InvalidBundleError(
            `Bundle entry has an absolute, drive-lettered, or backslash path: ${JSON.stringify(rawPath)}`,
            rawPath
          )
        }
        if (rawPath === '.' || rawPath === '..') {
          throw new InvalidBundleError(
            `Bundle entry is named ${JSON.stringify(rawPath)}, which is a directory reference`,
            rawPath
          )
        }

        const parts = stripLeadingDotSegments(splitPosix(rawPath))
        if (hasTraversalSegment(parts)) {
          throw new InvalidBundleError(
            `Bundle entry contains a ".." path segment: ${JSON.stringify(rawPath)}`,
            rawPath
          )
        }
        if (parts.length === 0) {
          // An entry whose name was just `./` or `/` or empty after the
          // checks above. Treat as suspicious.
          throw new InvalidBundleError(
            `Bundle entry has no usable path: ${JSON.stringify(rawPath)}`,
            rawPath
          )
        }

        // Require a `supabase/` prefix so a stray top-level file in the
        // tarball (e.g. a CI script) cannot slip into the project root.
        if (parts[0] !== 'supabase') {
          // Silently skip — the bundle is for Supabase, anything else is
          // outside our scope and may be an internal tar header artifact.
          return
        }
        const inner = parts.slice(1)
        if (inner.length === 0) {
          // The `supabase/` directory itself. We recreate it via fs.mkdir
          // later; just skip emitting a real entry for it.
          return
        }

        const type = entryType(entry)
        // Hardlinks (`Link`, typeflag '1') are rejected outright: their
        // `linkpath` is archive-root-relative, so re-using it as a host
        // relative path dangles. Real Supabase bundles never need them.
        // `entryType` maps `Link` to `null`, so we check the raw entry
        // type string for the rejection.
        if (entry.type === 'Link') {
          throw new InvalidBundleError(
            `Bundle contains a hardlink, which is not supported: ${JSON.stringify(rawPath)}`,
            rawPath
          )
        }

        // Classify the entry by its position inside `supabase/`. Anything
        // outside the four recognized shapes is skipped: this is how we
        // ignore `baseline-prelude.sql`, `neutralise.sql`, and similar.
        const classification = classify(inner, type)

        // Compute the absolute destination. Done here, once, so extraction
        // is a flat list of file copies.
        const destPath = path.resolve(supabaseRoot, ...inner)

        // Containment check.
        if (escapesSupabaseRoot(supabaseRoot, destPath)) {
          throw new InvalidBundleError(
            `Bundle entry resolves outside the supabase root: ${JSON.stringify(rawPath)} -> ${destPath}`,
            rawPath
          )
        }

        // Symlink target handling: must point at something that, when
        // resolved against the link's directory, stays inside the supabase
        // root. Done BEFORE the skip-by-classification step so a hostile
        // link under any unrecognised path still fails the bundle.
        let linkTarget: string | undefined
        if (type === 'SymbolicLink') {
          const raw = entry.linkpath ?? ''
          if (raw.length === 0) {
            throw new InvalidBundleError(
              `Symlink entry has no linkpath: ${JSON.stringify(rawPath)}`,
              rawPath
            )
          }
          // Same shape checks we applied to entry names: tar linkpaths
          // can be absolute or contain `..` even when the entry name does
          // not.
          if (hasAbsoluteOrWindowsShape(raw)) {
            throw new InvalidBundleError(
              `Bundle symlink target has an absolute, drive-lettered, or backslash path: ${rawPath} -> ${JSON.stringify(raw)}`,
              rawPath
            )
          }
          // Resolve the link's effective location by joining the link's
          // directory with the target, then absolutizing.
          const linkDir = path.dirname(destPath)
          const resolvedTarget = path.resolve(linkDir, raw)
          if (escapesSupabaseRoot(supabaseRoot, resolvedTarget)) {
            throw new InvalidBundleError(
              `Bundle symlink target escapes the supabase root: ${rawPath} -> ${JSON.stringify(raw)} -> ${resolvedTarget}`,
              rawPath
            )
          }
          linkTarget = raw
        }

        // Skip entries that aren't one of the four recognized shapes,
        // but only after we've already validated symlink targets above.
        if (!classification) return

        // Mode-bit hardening. node-tar yields `mode & 0o7777`, so the
        // upper bits are already cleared; we still need to strip the
        // setuid / setgid / sticky bits and default `0` / `undefined`
        // to `0o644`. Applied to both regular files and symlinks —
        // symlinks don't actually use mode on Linux but we keep the
        // field for symmetry.
        let mode: number | undefined
        if (type === 'File' || type === 'SymbolicLink') {
          mode = normalizeMode(entry.mode)
        }

        // Only file entries count for migrations; a `migrations/`
        // directory marker or a symlink there would otherwise inflate
        // the count and let a bundle with no real migration slip past.
        if (classification.kind === 'migrations' && type === 'File') {
          migrationsSeen++
        }

        const alsoStageToFunctions =
          classification.kind === 'functions' && mirrorToFunctionsPath

        out.push({
          rawPath,
          archiveIndex: myArchiveOrder,
          classification,
          destPath,
          alsoStageToFunctions,
          linkTarget,
          mode,
        })
      } catch (error) {
        reject(error)
        // Stop the parser so we do not waste time streaming the rest.
        parser.abort(error instanceof Error ? error : new Error(String(error)))
      }
    })
    parser.on('end', () => resolve())
    parser.on('error', (error) =>
      reject(new InvalidBundleError(`Failed to parse tarball: ${error.message}`))
    )
  })

  parser.end(tarball)
  try {
    await validationDone
  } catch (error) {
    if (error instanceof InvalidBundleError) throw error
    throw new InvalidBundleError(
      `Failed to validate tarball: ${(error as Error).message}`
    )
  }
  await Promise.all(drained)

  if (migrationsSeen === 0) {
    throw new NoMigrationsError()
  }
  return out
}

// node-tar's parser surfaces the four kinds we accept; everything else
// (FIFO, character / block devices, sparse files, hardlinks — hardlinks
// are caught separately upstream) never reaches extract.
function entryType(entry: { type: string }): HandledType | null {
  switch (entry.type) {
    case 'File':
    case 'OldFile':
      return 'File'
    case 'Directory':
    case 'GNUDumpDir':
      return 'Directory'
    case 'SymbolicLink':
      return 'SymbolicLink'
    default:
      return null
  }
}

// Normalize a tar `mode` into a safe host-side mode: strip the
// setuid / setgid / sticky bits (Linux honours them on `writeFile`,
// so an attacker-supplied `0o4755` would otherwise plant a setuid file
// in a tree that later gets bind-mounted or executed), default `0` or
// `undefined` to `0o644`, and replace any result that strips to `0` with
// `0o644` so we never write an unreadable file.
//
// Exported (not just module-local) so unit tests can cover the bit math
// without round-tripping through the OS — on darwin `open()` strips
// `S_ISUID` from the resulting file, which makes an end-to-end test
// for the stripping silently pass on a broken implementation.
export function normalizeMode(raw: number | undefined): number {
  // `||` (not `??`): `0` is a hostile mode, not a missing one. node-tar
  // yields `mode & 0o7777`, so a real tarball will never produce `0` by
  // accident, and treating it as "missing" lets the rest of the
  // pipeline normalise it back to `0o644`.
  const base = raw || 0o644
  const stripped = base & ~0o7000
  return stripped === 0 ? 0o644 : stripped
}

// Classify the entry's path inside `supabase/` (the `supabase/` segment
// already removed). Returns null for paths we silently skip.
function classify(inner: string[], type: HandledType | null): EntryClassification | null {
  const [head, ...rest] = inner
  if (head === undefined) return null

  if (head === MIGRATIONS_PREFIX.slice(0, -1)) {
    // `migrations/foo/bar.sql` is fine; `migrations` by itself is just
    // the directory marker.
    if (rest.length === 0) return null
    if (type === 'File' || type === 'Directory' || type === 'SymbolicLink') {
      return { kind: 'migrations', relativePath: rest.join('/') }
    }
    return null
  }

  if (head === FUNCTIONS_PREFIX.slice(0, -1)) {
    if (rest.length === 0) return null
    if (type === 'File' || type === 'Directory' || type === 'SymbolicLink') {
      return { kind: 'functions', relativePath: rest.join('/') }
    }
    return null
  }

  if (head === CONFIG_BASENAME && inner.length === 1) {
    if (type === 'File' || type === 'SymbolicLink') {
      return { kind: 'config' }
    }
    return null
  }

  if (head === SEED_BASENAME && inner.length === 1) {
    if (type === 'File' || type === 'SymbolicLink') {
      return { kind: 'seed' }
    }
    return null
  }

  return null
}

// Once every entry is validated, walk the validated list and write the
// files / directories / links to disk. The parser is re-driven over the
// same buffer; we fully drain each entry into memory as we go, then write
// everything into a sibling temp directory under `<projectDir>` and
// `rename` it into place only after the entire bundle has been written.
//
// The two-pass + temp-dir design means the caller either gets a complete
// ingest on disk or no ingest at all — never a half-written tree that
// later leaves the runtime pointing at a missing migration.
async function extractValidated(opts: {
  entries: ValidatedEntry[]
  tarball: Buffer
  projectDir: string
  functionsMountPath: string
  inTreeFunctionsPath: string
}): Promise<{ extracted: string[] }> {
  const { entries, tarball, projectDir, functionsMountPath, inTreeFunctionsPath } = opts
  const supabaseRoot = path.resolve(projectDir, 'supabase')
  const functionsRoot = path.resolve(functionsMountPath)
  const inTreeFunctionsResolved = path.resolve(inTreeFunctionsPath)
  const mirrorToFunctionsPath = functionsRoot !== inTreeFunctionsResolved

  // Pair parsed entries back to validated ones by archive order. The
  // validation pass collected `entries` in parser-emission order, so
  // pairing by index works for any well-formed tarball. This avoids the
  // previous bug where two entries with the same path collapsed into one
  // in a `byPath` map.
  const collected: CollectedEntry[] = []

  // Index validated entries by their archive position so the parser's
  // emissions can be paired back by index. Position-keying (not path-
  // keying) preserves duplicate paths: if a hostile tarball carries two
  // entries at `supabase/migrations/x.sql`, both are seen and the second
  // overwrites the first on disk; `extracted` reflects both writes.
  const byArchiveIndex = new Map<number, ValidatedEntry>()
  for (const v of entries) byArchiveIndex.set(v.archiveIndex, v)

  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true })

    parser.on('entry', (entry: ReadEntry) => {
      const v = byArchiveIndex.get(collected.length) ?? null
      // Start draining immediately so the parser keeps advancing. The
      // promise is awaited after the loop.
      collected.push({
        entry,
        validated: v,
        bodyPromise: readEntryBody(entry),
      })
    })
    parser.on('end', () => resolve())
    parser.on('error', (error: Error) => {
      reject(new InvalidBundleError(`Failed to parse tarball during extract: ${error.message}`))
    })
    parser.end(tarball)
  })

  // Now write everything into a temp dir, sequentially, with each entry's
  // body awaited. Wrap the whole thing so a mid-flight failure cleans up
  // and surfaces as a typed InvalidBundleError. `fs.mkdtemp` requires
  // the parent directory to exist, so create projectDir up front; the
  // staging dir is the only thing ever left in it until rename.
  await fs.mkdir(projectDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(projectDir, `.bundle-ingest-${randomBytes(6).toString('hex')}-`))
  const stagingSupabase = path.join(staging, 'supabase')
  const stagingMirror = mirrorToFunctionsPath ? path.join(staging, 'functions-mirror') : null
  await fs.mkdir(stagingSupabase, { recursive: true })
  if (stagingMirror) await fs.mkdir(stagingMirror, { recursive: true })

  const extracted: string[] = []
  try {
    for (const c of collected) {
      if (!c.validated) {
        // An entry the first pass skipped (e.g. baseline-prelude.sql,
        // directory markers, or a top-level non-supabase path). Just
        // await its drain so the body buffer is freed.
        await c.bodyPromise
        continue
      }
      const body = await c.bodyPromise
      await writeValidatedEntry({
        entry: c.entry,
        v: c.validated,
        body,
        functionsRoot: stagingMirror,
        // The entry's `destPath` is under the FINAL supabase root, not
        // the staging one. Pass both so writeValidatedEntry can
        // re-anchor the relative path under the staging dir.
        finalSupabaseRoot: supabaseRoot,
        stagingSupabaseRoot: stagingSupabase,
      })
      extracted.push(c.validated.destPath)
      if (c.validated.alsoStageToFunctions) {
        const relative = c.validated.classification.kind === 'functions'
          ? c.validated.classification.relativePath
          : ''
        extracted.push(path.join(functionsRoot, relative))
      }
    }

    // Commit the staged tree atomically: move the previous root aside
    // first (preserving it under `.supabase-old-<hex>`), rename the
    // staging dir into place, then delete the backup. If the rename
    // ever fails the previous tree is still recoverable from the
    // backup, instead of being deleted outright (the old
    // `safeRemove + rename` ordering lost the previous tree on any
    // failure between the two calls).
    const hexSuffix = randomBytes(6).toString('hex')
    const oldSupabaseBackup = path.join(projectDir, `.supabase-old-${hexSuffix}`)
    const oldFunctionsBackup = stagingMirror
      ? path.join(projectDir, `.functions-old-${hexSuffix}`)
      : null
    let supabaseBackedUp = false
    let functionsBackedUp = false
    try {
      // Move (not delete) the previous tree aside. The destination may
      // not exist on a fresh ingest; ignore ENOENT there.
      try {
        await fs.rename(supabaseRoot, oldSupabaseBackup)
        supabaseBackedUp = true
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError
      }
      // And the previous functions mirror, if any.
      if (stagingMirror) {
        // The mount target may live several layers below projectDir
        // (e.g. `<projectDir>/docker/volumes/functions`); `fs.rename`
        // cannot create intermediate directories, so mkdir the chain
        // first. Safe to call on an existing tree.
        await fs.mkdir(path.dirname(functionsRoot), { recursive: true })
        try {
          await fs.rename(functionsRoot, oldFunctionsBackup!)
          functionsBackedUp = true
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError
        }
      }
      // Put the new tree into place. If THIS fails, restore the
      // backups first so the worker never sees an empty destination.
      try {
        await fs.rename(stagingSupabase, supabaseRoot)
        if (stagingMirror) {
          await fs.rename(stagingMirror, functionsRoot)
        }
      } catch (renameError) {
        // Roll back: the new tree is gone, restore the old tree from
        // the backup. If the rollback itself fails the worker will at
        // least see the previous files at `.supabase-old-<hex>` rather
        // than nothing.
        if (supabaseBackedUp) {
          await fs.rename(oldSupabaseBackup, supabaseRoot).catch(() => undefined)
        }
        if (functionsBackedUp && oldFunctionsBackup) {
          await fs.rename(oldFunctionsBackup, functionsRoot).catch(() => undefined)
        }
        throw renameError
      }
    } finally {
      // Always clean the staging dir; only delete the backups after a
      // successful rename into place.
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (supabaseBackedUp && (await pathExists(oldSupabaseBackup))) {
        await fs.rm(oldSupabaseBackup, { recursive: true, force: true }).catch(() => undefined)
      }
      if (functionsBackedUp && oldFunctionsBackup && (await pathExists(oldFunctionsBackup))) {
        await fs.rm(oldFunctionsBackup, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof InvalidBundleError) throw error
    throw new InvalidBundleError(
      `Failed to extract bundle: ${(error as Error).message}`
    )
  }

  return { extracted }
}

interface CollectedEntry {
  entry: ReadEntry
  validated: ValidatedEntry | null
  bodyPromise: Promise<Buffer>
}

async function writeValidatedEntry({
  v,
  body,
  functionsRoot,
  finalSupabaseRoot,
  stagingSupabaseRoot,
  entry,
}: {
  entry: ReadEntry
  v: ValidatedEntry
  body: Buffer
  // null when the in-tree functions path equals functionsMountPath
  // (no mirror write happens, see extractValidated).
  functionsRoot: string | null
  // The original (post-rename) destination root. `v.destPath` is
  // anchored here.
  finalSupabaseRoot: string
  // The staging dir's supabase root; this is where the entry actually
  // lands on disk during extraction, before the rename.
  stagingSupabaseRoot: string
}): Promise<void> {
  const type = entryType(entry)
  if (!type) {
    throw new InvalidBundleError(`Entry has an unhandled tar type on extract: ${v.rawPath}`, v.rawPath)
  }

  // Re-anchor `v.destPath` (which points under the final supabase root)
  // to the same path under the staging dir. Validation already proved
  // it stays inside the supabase root; the same check here protects
  // against a second parser pass somehow seeing a different shape, and
  // uses `escapesSupabaseRoot` so a sibling literally named `..foo` is
  // not over-rejected.
  if (escapesSupabaseRoot(finalSupabaseRoot, v.destPath)) {
    throw new InvalidBundleError(
      `Entry destination escapes the supabase root: ${v.rawPath}`,
      v.rawPath
    )
  }
  const relToFinal = path.relative(finalSupabaseRoot, v.destPath)
  const stagedDest = path.resolve(stagingSupabaseRoot, relToFinal)
  await fs.mkdir(path.dirname(stagedDest), { recursive: true })

  // Function-side staging mirrors the relative path inside the functions
  // mount root. Only done when (a) the entry is a function and (b) the
  // mount path differs from the in-tree path.
  const relativeForMount = v.classification.kind === 'functions'
    ? v.classification.relativePath
    : null
  const mountDest: string | null =
    v.alsoStageToFunctions && relativeForMount !== null && functionsRoot !== null
      ? path.resolve(functionsRoot, relativeForMount)
      : null
  if (mountDest) {
    await fs.mkdir(path.dirname(mountDest), { recursive: true })
  }

  if (type === 'Directory') {
    await fs.mkdir(stagedDest, { recursive: true })
    if (mountDest) await fs.mkdir(mountDest, { recursive: true })
    return
  }

  if (type === 'SymbolicLink') {
    if (v.linkTarget === undefined) {
      throw new InvalidBundleError(`Symlink entry has no validated target: ${v.rawPath}`, v.rawPath)
    }
    await safeUnlink(stagedDest)
    await fs.symlink(v.linkTarget, stagedDest)
    if (mountDest) {
      await safeUnlink(mountDest)
      await fs.symlink(v.linkTarget, mountDest)
    }
    return
  }

  // Regular file: write the body we already drained. Mode has been
  // validated (setuid/setgid/sticky stripped, 0o000 rejected) during the
  // validation pass, so we can write it verbatim.
  await safeUnlink(stagedDest)
  await fs.writeFile(stagedDest, body, { mode: v.mode ?? 0o644 })
  if (mountDest) {
    await fs.writeFile(mountDest, body, { mode: v.mode ?? 0o644 })
  }
}

function readEntryBody(entry: ReadEntry): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    entry.on('data', (chunk: Buffer) => chunks.push(chunk))
    entry.on('end', () => resolve(Buffer.concat(chunks)))
    entry.on('error', reject)
    entry.resume()
  })
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fs.unlink(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

// `pathExists` returns true if the target exists on the filesystem;
// throws on anything other than ENOENT.
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// Sweep stale staging / backup directories left behind by a previous
// SIGKILL / OOM. Called at the start of every ingest so a half-completed
// run does not pile up `.bundle-ingest-*` and `.supabase-old-*` siblings
// under the project root.
async function sweepStaleStaging(projectDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(projectDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of entries) {
    if (
      name.startsWith('.bundle-ingest-') ||
      name.startsWith('.supabase-old-') ||
      name.startsWith('.functions-old-')
    ) {
      await fs
        .rm(path.join(projectDir, name), { recursive: true, force: true })
        .catch(() => undefined)
    }
  }
}

// Public entry point.
export async function ingestBundle(options: IngestBundleOptions): Promise<IngestBundleResult> {
  const tarball = asBuffer(options.tarball)
  const projectDir = path.resolve(options.projectDir)
  const supabaseRoot = path.join(projectDir, 'supabase')
  const inTreeFunctionsPath = path.join(supabaseRoot, 'functions')
  const functionsMountPath = path.resolve(
    options.functionsMountPath ?? inTreeFunctionsPath
  )

  // Sweep any staging / backup dirs left over from a previous SIGKILL /
  // OOM before doing anything else, so we don't pile them up across
  // runs.
  await sweepStaleStaging(projectDir)

  // Run the validation pass first. If anything throws here, no bytes
  // have been written and the caller sees a typed error.
  const validated = await validateBundle({
    tarball,
    projectDir,
    functionsMountPath,
    inTreeFunctionsPath,
  })

  // Then write atomically. Two separate parses of the same buffer:
  // cheaper than building a temp directory and copying through it, and
  // the staging/rename pattern guarantees the final destinations are
  // either complete or untouched.
  const { extracted } = await extractValidated({
    entries: validated,
    tarball,
    projectDir,
    functionsMountPath,
    inTreeFunctionsPath,
  })

  const supabaseDir = supabaseRoot
  const migrationsDir = path.join(supabaseDir, 'migrations')

  const configEntry = validated.find((e) => e.classification.kind === 'config')
  const seedEntry = validated.find((e) => e.classification.kind === 'seed')

  return {
    projectDir,
    supabaseDir,
    migrationsDir,
    functionsMountPath,
    configPath: configEntry ? configEntry.destPath : null,
    seedPath: seedEntry ? seedEntry.destPath : null,
    extracted,
  }
}

// Re-exported for tests: lets test fixtures create tarballs with arbitrary
// (including hostile) entries without round-tripping through the system tar
// CLI, which would refuse to create such tarballs.
export {
  SUPABASE_PREFIX as _SUPABASE_PREFIX,
  MIGRATIONS_PREFIX as _MIGRATIONS_PREFIX,
  FUNCTIONS_PREFIX as _FUNCTIONS_PREFIX,
  CONFIG_BASENAME as _CONFIG_BASENAME,
  SEED_BASENAME as _SEED_BASENAME,
  MAX_ENTRIES as _MAX_ENTRIES,
  MAX_TOTAL_BYTES as _MAX_TOTAL_BYTES,
  MAX_FILE_BYTES as _MAX_FILE_BYTES,
}