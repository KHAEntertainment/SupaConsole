// Preview identity is normalized once, at the API edge: repositories are
// lowercased and branches trimmed, so writes that differ only in casing or
// whitespace collapse onto the same canonical row.

export class IncompletePreviewIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncompletePreviewIdentityError'
  }
}

export function normalizeRepository(input: string | null | undefined): string | null {
  if (input == null) return null
  const normalized = input.trim().toLowerCase()
  return normalized === '' ? null : normalized
}

// Branch names are case-sensitive on the host; only padding is removed.
export function normalizeBranch(input: string | null | undefined): string | null {
  if (input == null) return null
  const normalized = input.trim()
  return normalized === '' ? null : normalized
}

export interface PreviewIdentityInput {
  repository: string | null | undefined
  branch: string | null | undefined
  pullRequestNumber?: number | null
  prTitle?: string | null
  prAuthor?: string | null
}

export interface PreviewIdentity {
  repository: string
  branch: string
  pullRequestNumber: number | null
  prTitle: string | null
  prAuthor: string | null
}

export function normalizePreviewIdentity(input: PreviewIdentityInput): PreviewIdentity {
  const repository = normalizeRepository(input.repository)
  const branch = normalizeBranch(input.branch)
  if (!repository) throw new IncompletePreviewIdentityError('repository is required')
  if (!branch) throw new IncompletePreviewIdentityError('branch is required')
  return {
    repository,
    branch,
    pullRequestNumber: input.pullRequestNumber ?? null,
    prTitle: input.prTitle ?? null,
    prAuthor: input.prAuthor ?? null,
  }
}
