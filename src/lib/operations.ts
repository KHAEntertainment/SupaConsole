import type { Prisma, PrismaClient } from '@prisma/client'

export const OPERATION_STATES = ['queued', 'provisioning', 'ready', 'failed'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

const ALLOWED_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  queued: ['provisioning'],
  provisioning: ['ready', 'failed'],
  ready: [],
  failed: [],
}

const TERMINAL_STATES: readonly OperationState[] = ['ready', 'failed']

export function isOperationState(value: string): value is OperationState {
  return (OPERATION_STATES as readonly string[]).includes(value)
}

export function isTerminalState(value: string): boolean {
  return isOperationState(value) && TERMINAL_STATES.includes(value)
}

export class IllegalOperationTransitionError extends Error {
  readonly from: string
  readonly to: OperationState

  constructor(from: string, to: OperationState) {
    super(`Illegal operation transition ${from} -> ${to}`)
    this.name = 'IllegalOperationTransitionError'
    this.from = from
    this.to = to
  }
}

export function canTransition(from: string, to: OperationState): boolean {
  return isOperationState(from) && ALLOWED_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: string, to: OperationState): void {
  if (!canTransition(from, to)) throw new IllegalOperationTransitionError(from, to)
}

export async function transitionOperation(
  db: PrismaClient | Prisma.TransactionClient,
  id: string,
  to: OperationState,
  options: { error?: string } = {},
) {
  const run = async (tx: Prisma.TransactionClient) => {
    const operation = await tx.operation.findUniqueOrThrow({ where: { id } })
    assertTransition(operation.state, to)
    const now = new Date()
    const result = await tx.operation.updateMany({
      where: { id, state: operation.state },
      data: {
        state: to,
        ...(to === 'provisioning' && operation.startedAt == null ? { startedAt: now } : {}),
        ...(TERMINAL_STATES.includes(to) ? { finishedAt: now } : {}),
        // Reaching ready supersedes any earlier recoverable error.
        error: options.error ?? (to === 'ready' ? null : operation.error),
      },
    })
    if (result.count === 0) throw new IllegalOperationTransitionError(operation.state, to)
    return tx.operation.findUniqueOrThrow({ where: { id } })
  }
  // Composing inside a caller's transaction: a TransactionClient is already in one.
  if ('$transaction' in db) return db.$transaction(run)
  return run(db)
}

// The one sanctioned bypass of the transition table: an in-process queue does
// not survive a restart, so anything not terminal was interrupted and is
// recoverable as failed rather than driven to completion.
export async function recoverInterruptedOperations(
  db: PrismaClient,
  options: { kind?: string; ids?: string[] } = {},
): Promise<number> {
  // `ids` narrows recovery to operations whose external cleanup (e.g. tunnel
  // route removal) already succeeded; the rest stay recoverable on a retry.
  return db.$transaction(async tx => {
    const interrupted = await tx.operation.findMany({
      where: {
        state: { in: ['queued', 'provisioning'] },
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.ids !== undefined ? { id: { in: options.ids } } : {}),
      },
      select: { id: true },
    })
    const ids = interrupted.map(row => row.id)
    const result = await tx.operation.updateMany({
      where: { id: { in: ids } },
      data: {
        state: 'failed',
        finishedAt: new Date(),
        error: 'interrupted by restart',
      },
    })
    // Project status follows only a recovered attempt that owned the project
    // (T20): a project whose current operation moved on must not be marked
    // failed by an older attempt's recovery. Rows without a recorded owner
    // keep the legacy rule.
    await tx.project.updateMany({ where: { environmentType: 'preview', OR: [
      { currentOperationId: { in: ids } },
      { currentOperationId: null, operations: { some: {
        state: 'failed', id: { in: ids }, ...(options.kind !== undefined ? { kind: options.kind } : {}),
      } } },
    ] }, data: { status: 'failed' } })
    return result.count
  })
}
