import { and, desc, eq, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamAppId, SteamGiftsGiveawayCode, SteamSubId } from '#/db/schema'
import { giveaways, groups } from '#/db/schema'

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

export const findGiveawayByGroupAndCode = async (
  db: DbOrTx,
  groupId: number,
  code: SteamGiftsGiveawayCode,
): Promise<Giveaway | null> => {
  const [row] = await db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.groupId, groupId), eq(giveaways.steamgiftsCode, code)))
    .limit(1)
  return row ?? null
}

export const findGiveawayById = async (db: DbOrTx, id: number): Promise<Giveaway | null> => {
  const [row] = await db.select().from(giveaways).where(eq(giveaways.id, id)).limit(1)
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
  const [row] = await db
    .insert(giveaways)
    .values(values)
    .onConflictDoUpdate({
      target: [giveaways.groupId, giveaways.steamgiftsCode],
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
    .where(eq(giveaways.groupId, groupId))
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
