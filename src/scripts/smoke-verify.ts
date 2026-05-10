import { count, desc, eq } from 'drizzle-orm'

import { env } from '#/config/env'
import type { Db } from '#/db/client'
import { createDbClient } from '#/db/client'
import { auditLog, giveaways, users, wins } from '#/db/schema'
import type { WinStatus } from '#/db/schema'
import type { Group } from '#/repos/groups'
import { listGroups } from '#/repos/groups'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEADLINE_TOLERANCE_MS = 60_000

type StatusCounts = Record<WinStatus, number>
const emptyStatusCounts = (): StatusCounts => ({
  pending: 0,
  played: 0,
  kicked: 0,
  not_in_group: 0,
  exempt: 0,
})

type GroupReport = {
  readonly group: Group
  readonly giveawayCount: number
  readonly mostRecentGiveaway: { readonly endedAt: Date; readonly code: string | null } | null
  readonly winsTotal: number
  readonly byStatus: StatusCounts
  readonly pendingWithBaseline: number
  readonly pendingMissingBaseline: number
  readonly deadlineMismatchCount: number
}

const verifyGroup = async (db: Db, group: Group): Promise<GroupReport> => {
  const [gc] = await db
    .select({ n: count() })
    .from(giveaways)
    .where(eq(giveaways.groupId, group.id))

  const recent = await db
    .select({ endedAt: giveaways.endedAt, code: giveaways.steamgiftsCode })
    .from(giveaways)
    .where(eq(giveaways.groupId, group.id))
    .orderBy(desc(giveaways.endedAt))
    .limit(1)

  const groupWins = await db
    .select({
      status: wins.status,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .where(eq(giveaways.groupId, group.id))

  const byStatus = emptyStatusCounts()
  let pendingWithBaseline = 0
  let pendingMissingBaseline = 0
  let deadlineMismatchCount = 0
  const expectedDeltaMs = group.playWindowDays * MS_PER_DAY

  for (const w of groupWins) {
    byStatus[w.status] += 1
    if (w.status === 'pending') {
      if (w.playtimeAtWinMinutes === null) pendingMissingBaseline += 1
      else pendingWithBaseline += 1
    }
    const actualDeltaMs = w.playDeadline.getTime() - w.wonAt.getTime()
    if (Math.abs(actualDeltaMs - expectedDeltaMs) > DEADLINE_TOLERANCE_MS) {
      deadlineMismatchCount += 1
    }
  }

  return {
    group,
    giveawayCount: gc?.n ?? 0,
    mostRecentGiveaway: recent[0] ?? null,
    winsTotal: groupWins.length,
    byStatus,
    pendingWithBaseline,
    pendingMissingBaseline,
    deadlineMismatchCount,
  }
}

const printGroupReport = (r: GroupReport): void => {
  console.log(`\n--- group: ${r.group.slug} (${r.group.name}) ---`)
  console.log(
    `  config: playWindowDays=${String(r.group.playWindowDays)} sgCode=${r.group.steamgiftsGroupCode} steamGroupId=${r.group.steamGroupId}`,
  )
  console.log(`  giveaways: ${String(r.giveawayCount)}`)
  if (r.mostRecentGiveaway) {
    console.log(
      `  most-recent giveaway: ${r.mostRecentGiveaway.endedAt.toISOString()} (${r.mostRecentGiveaway.code})`,
    )
  }
  console.log(
    `  wins: total=${String(r.winsTotal)} pending=${String(r.byStatus.pending)} played=${String(r.byStatus.played)} kicked=${String(r.byStatus.kicked)} not_in_group=${String(r.byStatus.not_in_group)} exempt=${String(r.byStatus.exempt)}`,
  )
  console.log(
    `  pending baseline: captured=${String(r.pendingWithBaseline)} missing=${String(r.pendingMissingBaseline)}`,
  )
  if (r.deadlineMismatchCount > 0) {
    console.log(
      `  WARN: ${String(r.deadlineMismatchCount)} win(s) have play_deadline that does not match won_at + ${String(r.group.playWindowDays)}d`,
    )
  } else {
    console.log(`  OK: all play_deadlines = won_at + ${String(r.group.playWindowDays)}d`)
  }
}

const printRecentWins = async (db: Db): Promise<void> => {
  const rows = await db
    .select({
      id: wins.id,
      status: wins.status,
      wonAt: wins.wonAt,
      playDeadline: wins.playDeadline,
      playtimeAtWinMinutes: wins.playtimeAtWinMinutes,
      currentPlaytimeMinutes: wins.currentPlaytimeMinutes,
      steamId: users.steamId,
      sgCode: giveaways.steamgiftsCode,
    })
    .from(wins)
    .innerJoin(giveaways, eq(wins.giveawayId, giveaways.id))
    .innerJoin(users, eq(wins.userId, users.id))
    .orderBy(desc(wins.wonAt))
    .limit(5)

  console.log(`\n--- recent wins (${String(rows.length)}) ---`)
  for (const r of rows) {
    const baseline = r.playtimeAtWinMinutes === null ? '—' : String(r.playtimeAtWinMinutes)
    const current = r.currentPlaytimeMinutes === null ? '—' : String(r.currentPlaytimeMinutes)
    console.log(
      `  win=${String(r.id)} status=${r.status} won=${r.wonAt.toISOString()} deadline=${r.playDeadline.toISOString()} steam=${r.steamId} sg=${r.sgCode} playtime=${baseline}→${current}`,
    )
  }
}

const printRecentAudit = async (db: Db): Promise<void> => {
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(10)

  console.log(`\n--- recent audit entries (${String(rows.length)}) ---`)
  for (const r of rows) {
    const payload = typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)
    console.log(
      `  audit=${String(r.id)} ${r.createdAt.toISOString()} actor=${String(r.actorUserId ?? 'system')} ${r.action} target=${r.targetType}:${String(r.targetId)} payload=${payload}`,
    )
  }
}

const main = async (): Promise<void> => {
  const db = createDbClient()
  console.log(`[smoke-verify] target: ${env.db.mode} (${env.db.url})`)

  if (env.db.mode === 'replica') {
    await db.$client.sync()
    console.log('[smoke-verify] synced replica from remote')
  }

  const groups = await listGroups(db)
  if (groups.length === 0) {
    console.log('\nWARN: no groups in DB — did you run db:seed?')
  }

  const reports: GroupReport[] = []
  for (const g of groups) {
    reports.push(await verifyGroup(db, g))
  }
  for (const r of reports) printGroupReport(r)

  await printRecentWins(db)
  await printRecentAudit(db)

  console.log('\n[smoke-verify] done')
  db.$client.close()
}

main().catch((e: unknown) => {
  console.error('[smoke-verify] failed:', e)
  process.exit(1)
})
