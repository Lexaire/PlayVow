import type { Db, DbOrTx } from '#/db/client'
import { withTransaction } from '#/db/client'
import type {
  ProfileVisibility,
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsUsername,
  SteamId,
  SteamSubId,
} from '#/db/schema'
import type { Giveaway, GiveawayTarget } from '#/repos/giveaways'
import { upsertGiveaway } from '#/repos/giveaways'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertSteamSub } from '#/repos/steamSubs'
import type { User } from '#/repos/users'
import { upsertUserBySgUsername } from '#/repos/users'
import type { Win } from '#/repos/wins'
import { findWinByGiveawayAndUser, insertWinIfAbsent } from '#/repos/wins'
import { computePlayDeadline } from '#/domain/wins'

export type ScrapedSgUser = {
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly steamId: SteamId | null
  readonly personaName?: string | null
  readonly avatarUrl?: string | null
  readonly profileVisibility?: ProfileVisibility | null
}

export type ScrapedSteamTarget =
  | {
      readonly kind: 'app'
      readonly appId: SteamAppId
      readonly name: string
    }
  | { readonly kind: 'sub'; readonly subId: SteamSubId; readonly name: string }

export type ScrapedGiveawayMeta = {
  readonly steamgiftsCode: SteamGiftsGiveawayCode
  readonly slug: string
  readonly quantity: number
  readonly startedAt: Date
  readonly endedAt: Date
  readonly winnersScrapedAt: Date | null
}

export type ScrapedGiveawayInput = {
  readonly groupId: number
  readonly target: ScrapedSteamTarget
  readonly giveaway: ScrapedGiveawayMeta
  readonly creator: ScrapedSgUser
  readonly scrapedAt: Date
}

export type ScrapedGiveawayResult = {
  readonly giveaway: Giveaway
  readonly creator: User
}

export type ScrapedWinInput = ScrapedGiveawayInput & {
  readonly playWindowDays: number
  readonly winner: ScrapedSgUser
  readonly wonAt: Date
}

export type ScrapedWinResult = ScrapedGiveawayResult & {
  readonly winner: User
  readonly win: Win
  readonly created: boolean
}

const upsertScrapedUser = async (tx: DbOrTx, u: ScrapedSgUser, syncedAt: Date): Promise<User> =>
  upsertUserBySgUsername(tx, {
    steamgiftsUsername: u.steamgiftsUsername,
    steamId: u.steamId,
    personaName: u.personaName ?? null,
    avatarUrl: u.avatarUrl ?? null,
    profileVisibility: u.profileVisibility ?? null,
    lastSyncedAt: syncedAt,
  })

const upsertScrapedTarget = async (
  tx: DbOrTx,
  t: ScrapedSteamTarget,
  syncedAt: Date,
): Promise<GiveawayTarget> => {
  if (t.kind === 'app') {
    const row = await upsertSteamApp(tx, {
      appId: t.appId,
      name: t.name,
      lastSyncedAt: syncedAt,
    })
    return { kind: 'app', appId: row.appId }
  }
  const row = await upsertSteamSub(tx, { subId: t.subId, name: t.name, lastSyncedAt: syncedAt })
  return { kind: 'sub', subId: row.subId }
}

const writeScrapedGiveaway = async (
  tx: DbOrTx,
  input: ScrapedGiveawayInput,
): Promise<ScrapedGiveawayResult> => {
  const target = await upsertScrapedTarget(tx, input.target, input.scrapedAt)
  const creator = await upsertScrapedUser(tx, input.creator, input.scrapedAt)
  const giveaway = await upsertGiveaway(tx, {
    groupId: input.groupId,
    steamgiftsCode: input.giveaway.steamgiftsCode,
    target,
    creatorUserId: creator.id,
    quantity: input.giveaway.quantity,
    startedAt: input.giveaway.startedAt,
    endedAt: input.giveaway.endedAt,
    scrapedAt: input.scrapedAt,
    slug: input.giveaway.slug,
    winnersScrapedAt: input.giveaway.winnersScrapedAt,
  })
  return { giveaway, creator }
}

export const recordScrapedGiveaway = async (
  db: Db,
  input: ScrapedGiveawayInput,
): Promise<ScrapedGiveawayResult> =>
  withTransaction(db, async (tx) => writeScrapedGiveaway(tx, input))

export const recordScrapedWin = async (db: Db, input: ScrapedWinInput): Promise<ScrapedWinResult> =>
  withTransaction(db, async (tx) => {
    const base = await writeScrapedGiveaway(tx, input)
    const winner = await upsertScrapedUser(tx, input.winner, input.scrapedAt)
    const playDeadline = computePlayDeadline(input.wonAt, input.playWindowDays)

    const inserted = await insertWinIfAbsent(tx, {
      giveawayId: base.giveaway.id,
      userId: winner.id,
      wonAt: input.wonAt,
      playDeadline,
    })

    if (inserted) {
      return { ...base, winner, win: inserted, created: true }
    }

    const existing = await findWinByGiveawayAndUser(tx, base.giveaway.id, winner.id)
    if (!existing) {
      throw new Error(
        `recordScrapedWin: win for giveaway=${String(base.giveaway.id)} user=${String(winner.id)} vanished after upsert`,
      )
    }
    return { ...base, winner, win: existing, created: false }
  })
