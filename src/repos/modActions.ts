import type { Db } from '#/db/client'
import { withTransaction } from '#/db/client'
import type { WinStatus } from '#/db/schema'
import { writeAuditEvent } from '#/repos/auditLog'
import { findWinById, updateWinNotes, updateWinStatus } from '#/repos/wins'
import { err, ok } from '#/lib/result'
import type { Result } from '#/lib/result'

export type ModWinError =
  | { readonly kind: 'win_not_found'; readonly winId: number }
  | { readonly kind: 'no_op' }

export type StatusChangeOutcome = {
  readonly winId: number
  readonly from: WinStatus
  readonly to: WinStatus
}

export const applyWinStatusChange = async (
  db: Db,
  winId: number,
  to: WinStatus,
  now: Date,
  actorUserId: number,
): Promise<Result<StatusChangeOutcome, ModWinError>> =>
  withTransaction(db, async (tx) => {
    const win = await findWinById(tx, winId)
    if (!win) return err({ kind: 'win_not_found', winId })
    if (win.status === to) return err({ kind: 'no_op' })

    const resolvedAt = to === 'pending' ? null : now
    await updateWinStatus(tx, winId, to, resolvedAt)
    await writeAuditEvent(tx, {
      event: { kind: 'win_status_changed', from: win.status, to },
      targetType: 'win',
      targetId: winId,
      actorUserId,
    })
    return ok({ winId, from: win.status, to })
  })

const normalizeNotes = (notes: string | null): string | null => {
  if (notes === null) return null
  const trimmed = notes.trim()
  return trimmed.length === 0 ? null : trimmed
}

export type NotesUpdateOutcome = {
  readonly winId: number
  readonly before: string | null
  readonly after: string | null
}

export const applyWinNotesUpdate = async (
  db: Db,
  winId: number,
  notes: string | null,
  actorUserId: number,
): Promise<Result<NotesUpdateOutcome, ModWinError>> =>
  withTransaction(db, async (tx) => {
    const win = await findWinById(tx, winId)
    if (!win) return err({ kind: 'win_not_found', winId })

    const before = win.modNotes
    const after = normalizeNotes(notes)
    if (before === after) return err({ kind: 'no_op' })

    await updateWinNotes(tx, winId, after)
    await writeAuditEvent(tx, {
      event: { kind: 'win_notes_updated', before, after },
      targetType: 'win',
      targetId: winId,
      actorUserId,
    })
    return ok({ winId, before, after })
  })
