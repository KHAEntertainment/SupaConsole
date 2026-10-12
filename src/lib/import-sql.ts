export class UnsafeImportSqlError extends Error {
  readonly code = 'PSQL_METACOMMAND'
}

export function assertSqlOnly(sql: string): void {
  let i = 0
  while (i < sql.length) {
    const char = sql[i]
    if (char === '\\') throw new UnsafeImportSqlError('psql commands are not allowed in imported SQL')
    if (sql.startsWith('--', i)) {
      const end = sql.slice(i + 2).search(/[\r\n]/)
      i = end === -1 ? sql.length : i + 3 + end
      continue
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) throw new UnsafeImportSqlError('Unterminated SQL comment')
      continue
    }
    if (char === '$' && (i === 0 || !/[a-zA-Z0-9_$\u0080-\uFFFF]/.test(sql[i - 1]))) {
      const delimiter = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0]
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length)
        if (end === -1) throw new UnsafeImportSqlError('Unterminated dollar quoted SQL')
        i = end + delimiter.length
        continue
      }
    }
    if (char === "'" || char === '"') {
      const escape = char === "'" && i > 0 && /[eE]/.test(sql[i - 1]) &&
        (i === 1 || !/[a-zA-Z0-9_$\u0080-\uFFFF]/.test(sql[i - 2]))
      const quote = char
      let closed = false
      i++
      while (i < sql.length) {
        if (escape && sql[i] === '\\') { i += 2; continue }
        if (!escape && quote === "'" && sql[i] === '\\') {
          const start = i
          while (sql[i] === '\\') i++
          if ((i - start) % 2 === 1 && sql[i] === quote) {
            throw new UnsafeImportSqlError('Ambiguous backslash quote requires an explicit E string')
          }
          continue
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue }
          i++; closed = true; break
        }
        i++
      }
      if (!closed) throw new UnsafeImportSqlError('Unterminated SQL quote')
      continue
    }
    i++
  }
}
