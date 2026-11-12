import { Buffer } from 'node:buffer'

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
export type Entry =
  | { name: string; body: string; mode?: number }
  | { name: string; type: 'dir' }
  | { name: string; type: 'symlink'; linkname: string }
  | { name: string; type: 'hardlink'; linkname: string }

function pad(num: number, size: number): string {
  return num.toString(8).padStart(size - 1, '0') + '\0'
}

// Build one 512-byte ustar header. Numeric fields are octal strings; the
// checksum is a 6-digit octal followed by NUL + space per POSIX.
export function ustarHeader(input: {
  name: string
  mode?: number
  size?: number
  typeflag: string
  linkname?: string
}): Buffer {
  const buf = Buffer.alloc(512)
  // USTAR encodes a long path across the 100-byte `name` and 155-byte
  // `prefix` fields at a '/' boundary (full path == prefix + '/' + name).
  // Never truncate: a path with no valid split throws instead of silently
  // dropping bytes (T20 review R2-5).
  let name = input.name
  let prefix = ''
  if (Buffer.byteLength(name, 'utf8') > 100) {
    let cut = -1
    for (let i = name.length - 1; i >= 0; i--) {
      if (name[i] !== '/') continue
      const tail = name.slice(i + 1)
      const head = name.slice(0, i)
      if (Buffer.byteLength(tail, 'utf8') <= 100 && Buffer.byteLength(head, 'utf8') <= 155) { cut = i; break }
    }
    if (cut < 0) throw new Error(`path cannot be encoded as USTAR name+prefix: ${JSON.stringify(name)}`)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
  }
  buf.write(name, 0, 100, 'utf8')
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
  buf.write(prefix, 345, 155, 'utf8')
  // Compute checksum over the entire header.
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const cks = sum.toString(8).padStart(6, '0')
  buf.write(cks + '\0 ', 148, 8)
  return buf
}

// Assemble a tarball from raw entries, padding file bodies to 512-byte
// boundaries and adding two end-of-archive blocks.
export function buildTarball(entries: Entry[]): Buffer {
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
