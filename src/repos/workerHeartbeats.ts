import { eq } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import { workerHeartbeats } from '#/db/schema'

const HEARTBEAT_ID = 1

export type WorkerHeartbeatRow = {
  readonly startedAt: Date
  readonly lastSeenAt: Date
  readonly pid: number
}

// Upsert the singleton heartbeat row. Caller supplies startedAt (held in
// worker memory across the process lifetime) so it doesn't drift to "now"
// on every tick — only lastSeenAt and pid are observed live.
export const recordHeartbeat = async (db: DbOrTx, args: WorkerHeartbeatRow): Promise<void> => {
  await db
    .insert(workerHeartbeats)
    .values({
      id: HEARTBEAT_ID,
      startedAt: args.startedAt,
      lastSeenAt: args.lastSeenAt,
      pid: args.pid,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.id,
      set: {
        startedAt: args.startedAt,
        lastSeenAt: args.lastSeenAt,
        pid: args.pid,
      },
    })
}

export const getLatestHeartbeat = async (db: DbOrTx): Promise<WorkerHeartbeatRow | null> => {
  const [row] = await db
    .select()
    .from(workerHeartbeats)
    .where(eq(workerHeartbeats.id, HEARTBEAT_ID))
    .limit(1)
  if (!row) return null
  return {
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    pid: row.pid,
  }
}
