import { eq, isNull, sql } from 'drizzle-orm'

import type { DbOrTx } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import { steamApps } from '#/db/schema'

export type SteamApp = typeof steamApps.$inferSelect

export type UpsertSteamAppInput = {
  readonly appId: SteamAppId
  readonly name: string
  readonly lastSyncedAt?: Date | null
}

export const findSteamAppById = async (db: DbOrTx, appId: SteamAppId): Promise<SteamApp | null> => {
  const [row] = await db.select().from(steamApps).where(eq(steamApps.appId, appId)).limit(1)
  return row ?? null
}

export const upsertSteamApp = async (db: DbOrTx, input: UpsertSteamAppInput): Promise<SteamApp> => {
  const [row] = await db
    .insert(steamApps)
    .values({
      appId: input.appId,
      name: input.name,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: steamApps.appId,
      set: {
        name: sql`excluded.name`,
        lastSyncedAt: sql`coalesce(excluded.last_synced_at, ${steamApps.lastSyncedAt})`,
      },
    })
    .returning()
  if (!row) throw new Error(`upsertSteamApp returned no row for app ${String(input.appId)}`)
  return row
}

// Rich metadata fetched once per app from IStoreBrowseService/GetItems.
// All fields nullable because Steam returns empty/missing for delisted or
// region-locked apps. detailsSyncedAt is set unconditionally on every call so
// that "WHERE details_synced_at IS NULL" reliably picks up only un-synced rows.
export type SteamAppDetailsInput = {
  readonly appId: SteamAppId
  readonly name: string
  readonly assetSmallCapsule: string | null
  readonly assetMainCapsule: string | null
  readonly assetHeader: string | null
  readonly assetHeroCapsule: string | null
  readonly assetLibraryCapsule: string | null
  readonly assetLibraryHero: string | null
  readonly assetCommunityIcon: string | null
  readonly assetPageBackground: string | null
  readonly assetUrlFormat: string | null
  readonly releaseDate: Date | null
  readonly shortDescription: string | null
  readonly appType: number | null
  readonly reviewScore: number | null
  readonly reviewScoreLabel: string | null
  readonly reviewPercentPositive: number | null
  readonly reviewCount: number | null
  readonly detailsSyncedAt: Date
}

export const upsertSteamAppDetails = async (
  db: DbOrTx,
  input: SteamAppDetailsInput,
): Promise<void> => {
  await db
    .insert(steamApps)
    .values({
      appId: input.appId,
      name: input.name,
      assetSmallCapsule: input.assetSmallCapsule,
      assetMainCapsule: input.assetMainCapsule,
      assetHeader: input.assetHeader,
      assetHeroCapsule: input.assetHeroCapsule,
      assetLibraryCapsule: input.assetLibraryCapsule,
      assetLibraryHero: input.assetLibraryHero,
      assetCommunityIcon: input.assetCommunityIcon,
      assetPageBackground: input.assetPageBackground,
      assetUrlFormat: input.assetUrlFormat,
      releaseDate: input.releaseDate,
      shortDescription: input.shortDescription,
      appType: input.appType,
      reviewScore: input.reviewScore,
      reviewScoreLabel: input.reviewScoreLabel,
      reviewPercentPositive: input.reviewPercentPositive,
      reviewCount: input.reviewCount,
      detailsSyncedAt: input.detailsSyncedAt,
    })
    .onConflictDoUpdate({
      target: steamApps.appId,
      set: {
        name: sql`excluded.name`,
        assetSmallCapsule: sql`excluded.asset_small_capsule`,
        assetMainCapsule: sql`excluded.asset_main_capsule`,
        assetHeader: sql`excluded.asset_header`,
        assetHeroCapsule: sql`excluded.asset_hero_capsule`,
        assetLibraryCapsule: sql`excluded.asset_library_capsule`,
        assetLibraryHero: sql`excluded.asset_library_hero`,
        assetCommunityIcon: sql`excluded.asset_community_icon`,
        assetPageBackground: sql`excluded.asset_page_background`,
        assetUrlFormat: sql`excluded.asset_url_format`,
        releaseDate: sql`excluded.release_date`,
        shortDescription: sql`excluded.short_description`,
        appType: sql`excluded.app_type`,
        reviewScore: sql`excluded.review_score`,
        reviewScoreLabel: sql`excluded.review_score_label`,
        reviewPercentPositive: sql`excluded.review_percent_positive`,
        reviewCount: sql`excluded.review_count`,
        detailsSyncedAt: sql`excluded.details_synced_at`,
      },
    })
}

// Set details_synced_at without touching anything else. Used when Steam
// reports success != 1 for an appId (delisted, region-locked) so that we
// stop trying to sync it but preserve the row's other columns (name from
// the SG scrape, lastSyncedAt, etc.).
export const markAppDetailsAttempted = async (
  db: DbOrTx,
  appId: SteamAppId,
  attemptedAt: Date,
): Promise<void> => {
  await db.update(steamApps).set({ detailsSyncedAt: attemptedAt }).where(eq(steamApps.appId, appId))
}

export const findAppIdsNeedingDetails = async (
  db: DbOrTx,
  limit: number,
): Promise<ReadonlyArray<SteamAppId>> => {
  const rows = await db
    .select({ appId: steamApps.appId })
    .from(steamApps)
    .where(isNull(steamApps.detailsSyncedAt))
    .limit(limit)
  return rows.map((r) => r.appId)
}
