import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamAppId, SteamGiftsGiveawayCode, SteamSubId } from '#/db/schema'
import { giveaways, groups, wins } from '#/db/schema'

export type Giveaway = typeof giveaways.$inferSelect

export type GiveawayTarget =
  | { readonly kind: 'app'; readonly appId: SteamAppId }
  | { readonly kind: 'sub'; readonly subId: SteamSubId }

export type UpsertGiveawayInput = {
  readonly groupId: number
  readonly steamgiftsCode: SteamGiftsGiveawayCode
  readonly target: GiveawayTarget
  readonly creatorUserId: number
  readonly quantity: number
  readonly startedAt: Date
  readonly endedAt: Date
  readonly scrapedAt: Date
  readonly slug?: string | null
  readonly winnersScrapedAt?: Date | null
}

// Read paths skip soft-deleted giveaways (deletedAt IS NOT NULL). Manual
// giveaways are the only ones that can be soft-deleted today; SG-scraped
// rows always have deletedAt = null.
export const findGiveawayByGroupAndCode = async (
  db: DbOrTx,
  groupId: number,
  code: SteamGiftsGiveawayCode,
): Promise<Giveaway | null> => {
  const [row] = await db
    .select()
    .from(giveaways)
    .where(
      and(
        eq(giveaways.groupId, groupId),
        eq(giveaways.steamgiftsCode, code),
        isNull(giveaways.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export const findGiveawayById = async (db: DbOrTx, id: number): Promise<Giveaway | null> => {
  const [row] = await db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.id, id), isNull(giveaways.deletedAt)))
    .limit(1)
  return row ?? null
}

export const upsertGiveaway = async (db: DbOrTx, input: UpsertGiveawayInput): Promise<Giveaway> => {
  const values = {
    groupId: input.groupId,
    steamgiftsCode: input.steamgiftsCode,
    steamAppId: input.target.kind === 'app' ? input.target.appId : null,
    steamSubId: input.target.kind === 'sub' ? input.target.subId : null,
    creatorUserId: input.creatorUserId,
    quantity: input.quantity,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    scrapedAt: input.scrapedAt,
    slug: input.slug ?? null,
    winnersScrapedAt: input.winnersScrapedAt ?? null,
  }
  // The unique index on (group_id, steamgifts_code) is partial — it filters
  // out rows where steamgifts_code IS NULL, so SQLite's ON CONFLICT needs the
  // same WHERE clause to match the partial index.
  const [row] = await db
    .insert(giveaways)
    .values(values)
    .onConflictDoUpdate({
      target: [giveaways.groupId, giveaways.steamgiftsCode],
      targetWhere: sql`steamgifts_code IS NOT NULL`,
      set: {
        steamAppId: sql`excluded.steam_app_id`,
        steamSubId: sql`excluded.steam_sub_id`,
        creatorUserId: sql`excluded.creator_user_id`,
        quantity: sql`excluded.quantity`,
        startedAt: sql`excluded.started_at`,
        endedAt: sql`excluded.ended_at`,
        scrapedAt: sql`excluded.scraped_at`,
        slug: sql`coalesce(giveaways.slug, excluded.slug)`,
        winnersScrapedAt: sql`coalesce(giveaways.winners_scraped_at, excluded.winners_scraped_at)`,
      },
    })
    .returning()
  if (!row) {
    throw new Error(
      `upsertGiveaway returned no row for ${String(input.groupId)}/${input.steamgiftsCode}`,
    )
  }
  return row
}

export const listRecentGiveawaysByGroup = async (
  db: DbOrTx,
  groupId: number,
  limit: number,
): Promise<ReadonlyArray<Giveaway>> =>
  db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.groupId, groupId), isNull(giveaways.deletedAt)))
    .orderBy(desc(giveaways.endedAt))
    .limit(limit)

export const listGiveawaysNeedingWinnersBackfill = async (
  db: DbOrTx,
  options?: { readonly limit?: number },
): Promise<ReadonlyArray<Giveaway>> => {
  const now = new Date()
  const query = db
    .select({ giveaway: giveaways })
    .from(giveaways)
    .innerJoin(groups, eq(giveaways.groupId, groups.id))
    .where(
      and(
        sql`${giveaways.endedAt} < ${now}`,
        sql`${giveaways.winnersScrapedAt} IS NULL`,
        sql`${groups.lastScrapedAt} IS NOT NULL`,
        sql`${giveaways.scrapedAt} < ${groups.lastScrapedAt}`,
        isNull(giveaways.deletedAt),
      ),
    )
    .orderBy(desc(giveaways.endedAt))
    .$dynamic()
  const rows = options?.limit ? await query.limit(options.limit) : await query
  return rows.map((r) => r.giveaway)
}

export const setWinnersScrapedAt = async (
  db: DbOrTx,
  giveawayId: number,
  at: Date,
): Promise<void> => {
  await db.update(giveaways).set({ winnersScrapedAt: at }).where(eq(giveaways.id, giveawayId))
}

export type CreateManualGiveawayInput = {
  readonly groupId: number
  readonly target: GiveawayTarget
  readonly creatorUserId: number
  readonly quantity: number
  readonly addedAt: Date
  // Optional override for the giveaway's actual lifecycle dates. When the
  // mod backdates a manual giveaway, these come in distinct from `addedAt`
  // (which is still used as scrapedAt — the moment we recorded it).
  readonly startedAt?: Date
  readonly endedAt?: Date
}

export type UpdateManualGiveawayDatesError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_manual' }
  | { readonly kind: 'already_deleted' }
  | { readonly kind: 'invalid_range' }

export type UpdateManualGiveawayDatesResult = {
  readonly giveaway: Giveaway
  readonly before: { readonly startedAt: Date; readonly endedAt: Date }
}

// Updates startedAt/endedAt on a manual giveaway. SG-scraped rows are refused
// because the next scrape would clobber the override. Returns the prior
// values so the caller can record a before/after audit entry. The repo
// validates the range so the rule lives next to the column definition.
export const updateManualGiveawayDatesTx = async (
  tx: DbOrTx,
  giveawayId: number,
  startedAt: Date,
  endedAt: Date,
): Promise<
  | { readonly ok: true; readonly value: UpdateManualGiveawayDatesResult }
  | { readonly ok: false; readonly error: UpdateManualGiveawayDatesError }
> => {
  if (startedAt.getTime() > endedAt.getTime()) {
    return { ok: false, error: { kind: 'invalid_range' } }
  }
  const [existing] = await tx
    .select()
    .from(giveaways)
    .where(eq(giveaways.id, giveawayId))
    .limit(1)
  if (!existing) return { ok: false, error: { kind: 'not_found' } }
  if (existing.steamgiftsCode !== null) return { ok: false, error: { kind: 'not_manual' } }
  if (existing.deletedAt !== null) return { ok: false, error: { kind: 'already_deleted' } }

  const [row] = await tx
    .update(giveaways)
    .set({ startedAt, endedAt })
    .where(eq(giveaways.id, giveawayId))
    .returning()
  if (!row) return { ok: false, error: { kind: 'not_found' } }
  return {
    ok: true,
    value: {
      giveaway: row,
      before: { startedAt: existing.startedAt, endedAt: existing.endedAt },
    },
  }
}

export type SoftDeleteManualGiveawayResult = {
  readonly giveaway: Giveaway
  readonly winCount: number
}

export type SoftDeleteManualGiveawayError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_manual' }
  | { readonly kind: 'already_deleted' }

// Atomically marks a manual giveaway deleted and adjusts the parent group's
// denormalized win counters. Wins themselves stay intact (filtered out of
// reads via the giveaway's deleted_at), so playtime history is preserved on
// the rows even though the giveaway is gone from the UI.
//
// Refuses to delete SG-scraped giveaways — they'd just come back on the
// next scrape, and silently re-suppressing them would be confusing.
export const softDeleteManualGiveawayTx = async (
  tx: DbOrTx,
  giveawayId: number,
  deletedAt: Date,
): Promise<
  { readonly ok: true; readonly value: SoftDeleteManualGiveawayResult }
  | { readonly ok: false; readonly error: SoftDeleteManualGiveawayError }
> => {
  const [existing] = await tx
    .select()
    .from(giveaways)
    .where(eq(giveaways.id, giveawayId))
    .limit(1)
  if (!existing) return { ok: false, error: { kind: 'not_found' } }
  if (existing.steamgiftsCode !== null) return { ok: false, error: { kind: 'not_manual' } }
  if (existing.deletedAt !== null) return { ok: false, error: { kind: 'already_deleted' } }

  // Counter math: totalWins is "all wins", pendingWins is "status = pending".
  // Both need to drop by the matching slice for the giveaway being removed.
  const [counts] = await tx
    .select({
      total: sql<number>`count(*)`,
      pending: sql<number>`sum(case when ${wins.status} = 'pending' then 1 else 0 end)`,
    })
    .from(wins)
    .where(eq(wins.giveawayId, giveawayId))
  const totalDelta = Number(counts?.total ?? 0)
  const pendingDelta = Number(counts?.pending ?? 0)

  const [row] = await tx
    .update(giveaways)
    .set({ deletedAt })
    .where(eq(giveaways.id, giveawayId))
    .returning()
  if (!row) return { ok: false, error: { kind: 'not_found' } }

  if (totalDelta > 0 || pendingDelta > 0) {
    await tx
      .update(groups)
      .set({
        totalWins: sql`${groups.totalWins} - ${totalDelta}`,
        pendingWins: sql`${groups.pendingWins} - ${pendingDelta}`,
      })
      .where(eq(groups.id, existing.groupId))
  }

  return { ok: true, value: { giveaway: row, winCount: totalDelta } }
}

// Manual giveaway = a row added by a mod against a manual-source group.
// No SG code, scrapedAt is the insertion moment; startedAt/endedAt default
// to the same but can be overridden when a mod is recording a giveaway that
// already happened (or is scheduled). winnersScrapedAt stays null (never
// enters the SG winners-backfill path because that path filters on
// lastScrapedAt, which manual groups never set).
export const createManualGiveaway = async (
  db: DbOrTx,
  input: CreateManualGiveawayInput,
): Promise<Giveaway> => {
  const [row] = await db
    .insert(giveaways)
    .values({
      groupId: input.groupId,
      steamgiftsCode: null,
      steamAppId: input.target.kind === 'app' ? input.target.appId : null,
      steamSubId: input.target.kind === 'sub' ? input.target.subId : null,
      creatorUserId: input.creatorUserId,
      quantity: input.quantity,
      startedAt: input.startedAt ?? input.addedAt,
      endedAt: input.endedAt ?? input.addedAt,
      scrapedAt: input.addedAt,
      slug: null,
      winnersScrapedAt: null,
    })
    .returning()
  if (!row) {
    throw new Error(
      `createManualGiveaway returned no row for group=${String(input.groupId)}`,
    )
  }
  return row
}
