import { eq, isNull, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamSubId } from '#/db/schema'
import { steamSubs } from '#/db/schema'

export type SteamSub = typeof steamSubs.$inferSelect

export type UpsertSteamSubInput = {
  readonly subId: SteamSubId
  readonly name: string
  readonly lastSyncedAt?: Date | null
}

export const findSteamSubById = async (db: DbOrTx, subId: SteamSubId): Promise<SteamSub | null> => {
  const [row] = await db.select().from(steamSubs).where(eq(steamSubs.subId, subId)).limit(1)
  return row ?? null
}

export const upsertSteamSub = async (db: DbOrTx, input: UpsertSteamSubInput): Promise<SteamSub> => {
  const [row] = await db
    .insert(steamSubs)
    .values({
      subId: input.subId,
      name: input.name,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: steamSubs.subId,
      set: {
        name: sql`excluded.name`,
        lastSyncedAt: sql`coalesce(excluded.last_synced_at, ${steamSubs.lastSyncedAt})`,
      },
    })
    .returning()
  if (!row) throw new Error(`upsertSteamSub returned no row for sub ${String(input.subId)}`)
  return row
}

// Mirrors SteamAppDetailsInput on the sub side. No library_*/community_icon
// since subs don't have those; one extra (assetPackageHeader) which is sub-only.
export type SteamSubDetailsInput = {
  readonly subId: SteamSubId
  readonly name: string
  readonly assetSmallCapsule: string | null
  readonly assetMainCapsule: string | null
  readonly assetHeader: string | null
  readonly assetHeroCapsule: string | null
  readonly assetPackageHeader: string | null
  readonly assetPageBackground: string | null
  readonly assetUrlFormat: string | null
  readonly releaseDate: Date | null
  readonly shortDescription: string | null
  readonly reviewScore: number | null
  readonly reviewScoreLabel: string | null
  readonly reviewPercentPositive: number | null
  readonly reviewCount: number | null
  readonly detailsSyncedAt: Date
}

export const upsertSteamSubDetails = async (
  db: DbOrTx,
  input: SteamSubDetailsInput,
): Promise<void> => {
  await db
    .insert(steamSubs)
    .values({
      subId: input.subId,
      name: input.name,
      assetSmallCapsule: input.assetSmallCapsule,
      assetMainCapsule: input.assetMainCapsule,
      assetHeader: input.assetHeader,
      assetHeroCapsule: input.assetHeroCapsule,
      assetPackageHeader: input.assetPackageHeader,
      assetPageBackground: input.assetPageBackground,
      assetUrlFormat: input.assetUrlFormat,
      releaseDate: input.releaseDate,
      shortDescription: input.shortDescription,
      reviewScore: input.reviewScore,
      reviewScoreLabel: input.reviewScoreLabel,
      reviewPercentPositive: input.reviewPercentPositive,
      reviewCount: input.reviewCount,
      detailsSyncedAt: input.detailsSyncedAt,
    })
    .onConflictDoUpdate({
      target: steamSubs.subId,
      set: {
        name: sql`excluded.name`,
        assetSmallCapsule: sql`excluded.asset_small_capsule`,
        assetMainCapsule: sql`excluded.asset_main_capsule`,
        assetHeader: sql`excluded.asset_header`,
        assetHeroCapsule: sql`excluded.asset_hero_capsule`,
        assetPackageHeader: sql`excluded.asset_package_header`,
        assetPageBackground: sql`excluded.asset_page_background`,
        assetUrlFormat: sql`excluded.asset_url_format`,
        releaseDate: sql`excluded.release_date`,
        shortDescription: sql`excluded.short_description`,
        reviewScore: sql`excluded.review_score`,
        reviewScoreLabel: sql`excluded.review_score_label`,
        reviewPercentPositive: sql`excluded.review_percent_positive`,
        reviewCount: sql`excluded.review_count`,
        detailsSyncedAt: sql`excluded.details_synced_at`,
      },
    })
}

export const markSubDetailsAttempted = async (
  db: DbOrTx,
  subId: SteamSubId,
  attemptedAt: Date,
): Promise<void> => {
  await db.update(steamSubs).set({ detailsSyncedAt: attemptedAt }).where(eq(steamSubs.subId, subId))
}

export const findSubIdsNeedingDetails = async (
  db: DbOrTx,
  limit: number,
): Promise<ReadonlyArray<SteamSubId>> => {
  const rows = await db
    .select({ subId: steamSubs.subId })
    .from(steamSubs)
    .where(isNull(steamSubs.detailsSyncedAt))
    .limit(limit)
  return rows.map((r) => r.subId)
}
