import { eq } from 'drizzle-orm'

import { createDbClient } from '#/db/client'
import { groups, users } from '#/db/schema'
import type {
  SteamAppId,
  SteamGiftsGiveawayCode,
  SteamGiftsUsername,
  SteamId,
  WinStatus,
} from '#/db/schema'
import { recordAchievementStateIfChanged, upsertSteamAchievement } from '#/repos/achievements'
import { upsertGiveaway } from '#/repos/giveaways'
import { applyMembershipDiff } from '#/repos/groupMemberships'
import { upsertSteamApp } from '#/repos/steamApps'
import { upsertUserBySgUsername } from '#/repos/users'
import {
  insertWinIfAbsent,
  findWinByGiveawayAndUser,
  recordWinPlaytimeBaseline,
  recordWinPlaytimeProgress,
  updateWinNotes,
  updateWinStatus,
} from '#/repos/wins'

const GROUP_SLUG = 'taleplay'

type AppSeed = { readonly appId: SteamAppId; readonly name: string }
type UserSeed = {
  readonly steamId: SteamId
  readonly steamgiftsUsername: SteamGiftsUsername
  readonly avatarUrl: string
}
type GiveawaySeed = {
  readonly code: SteamGiftsGiveawayCode
  readonly app: AppSeed
  readonly quantity: number
  readonly endedDaysAgo: number
  readonly creatorSgUsername: SteamGiftsUsername
}
type WinSeed = {
  readonly giveawayCode: SteamGiftsGiveawayCode
  readonly steamId: SteamId
  readonly status: WinStatus
  readonly wonDaysAgo: number
  readonly baselineMinutes?: number
  readonly currentMinutes?: number
  readonly hasReview?: boolean
  readonly screenshotCount?: number
  readonly achievementsUnlocked?: number
  readonly achievementsTotal?: number
  readonly notes?: string
}
type AchievementSeed = {
  readonly giveawayCode: SteamGiftsGiveawayCode
  readonly steamId: SteamId
  readonly app: AppSeed
  readonly apiname: string
  readonly displayName: string
  readonly description: string
  readonly unlockedDaysAgo: number
}

const APPS: ReadonlyArray<AppSeed> = [
  { appId: 220 as SteamAppId, name: 'Half-Life 2' },
  { appId: 400 as SteamAppId, name: 'Portal' },
  { appId: 620 as SteamAppId, name: 'Portal 2' },
  { appId: 105600 as SteamAppId, name: 'Terraria' },
  { appId: 322330 as SteamAppId, name: "Don't Starve Together" },
  { appId: 379720 as SteamAppId, name: 'DOOM (2016)' },
]

const USERS: ReadonlyArray<UserSeed> = [
  {
    steamId: '76561198000000001' as SteamId,
    steamgiftsUsername: 'cilantro' as SteamGiftsUsername,
    avatarUrl: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
  },
  {
    steamId: '76561198000000002' as SteamId,
    steamgiftsUsername: 'mossfox' as SteamGiftsUsername,
    avatarUrl: 'https://avatars.steamstatic.com/b5bd56c1aa4644a474a2e4972be27ef9e82e517e_full.jpg',
  },
  {
    steamId: '76561198000000003' as SteamId,
    steamgiftsUsername: 'pixelpilgrim' as SteamGiftsUsername,
    avatarUrl: 'https://avatars.steamstatic.com/0ed4d4b9b9e6e76b7c6f9f5b16f36e2e84a6e9c9_full.jpg',
  },
  {
    steamId: '76561198000000004' as SteamId,
    steamgiftsUsername: 'tinker_t' as SteamGiftsUsername,
    avatarUrl: 'https://avatars.steamstatic.com/cb0d5fd61e3d7b7ee5e5f8a4bb7d5c5c5f5c5c5c_full.jpg',
  },
  {
    steamId: '76561198000000099' as SteamId,
    steamgiftsUsername: 'mod_admin' as SteamGiftsUsername,
    avatarUrl: 'https://avatars.steamstatic.com/aaaa1111aaaa2222bbbb3333cccc4444dddd5555_full.jpg',
  },
]

const GIVEAWAYS: ReadonlyArray<GiveawaySeed> = [
  {
    code: 'tp001' as SteamGiftsGiveawayCode,
    app: APPS[0]!,
    quantity: 1,
    endedDaysAgo: 100,
    creatorSgUsername: 'mod_admin' as SteamGiftsUsername,
  },
  {
    code: 'tp002' as SteamGiftsGiveawayCode,
    app: APPS[1]!,
    quantity: 1,
    endedDaysAgo: 80,
    creatorSgUsername: 'mod_admin' as SteamGiftsUsername,
  },
  {
    code: 'tp003' as SteamGiftsGiveawayCode,
    app: APPS[2]!,
    quantity: 2,
    endedDaysAgo: 60,
    creatorSgUsername: 'mod_admin' as SteamGiftsUsername,
  },
  {
    code: 'tp004' as SteamGiftsGiveawayCode,
    app: APPS[3]!,
    quantity: 1,
    endedDaysAgo: 30,
    creatorSgUsername: 'cilantro' as SteamGiftsUsername,
  },
  {
    code: 'tp005' as SteamGiftsGiveawayCode,
    app: APPS[4]!,
    quantity: 1,
    endedDaysAgo: 12,
    creatorSgUsername: 'mod_admin' as SteamGiftsUsername,
  },
  {
    code: 'tp006' as SteamGiftsGiveawayCode,
    app: APPS[5]!,
    quantity: 1,
    endedDaysAgo: 3,
    creatorSgUsername: 'pixelpilgrim' as SteamGiftsUsername,
  },
  {
    code: 'tp007' as SteamGiftsGiveawayCode,
    app: APPS[3]!,
    quantity: 1,
    endedDaysAgo: 18,
    creatorSgUsername: 'mod_admin' as SteamGiftsUsername,
  },
]

const WINS: ReadonlyArray<WinSeed> = [
  {
    giveawayCode: 'tp001' as SteamGiftsGiveawayCode,
    steamId: '76561198000000001' as SteamId,
    status: 'played',
    wonDaysAgo: 100,
    baselineMinutes: 30,
    currentMinutes: 540,
    hasReview: true,
    screenshotCount: 4,
    achievementsUnlocked: 12,
    achievementsTotal: 33,
  },
  {
    giveawayCode: 'tp002' as SteamGiftsGiveawayCode,
    steamId: '76561198000000002' as SteamId,
    status: 'kicked',
    wonDaysAgo: 80,
    baselineMinutes: 0,
    currentMinutes: 0,
    hasReview: false,
    screenshotCount: 0,
    notes: 'never launched the game',
  },
  {
    giveawayCode: 'tp003' as SteamGiftsGiveawayCode,
    steamId: '76561198000000003' as SteamId,
    status: 'played',
    wonDaysAgo: 60,
    baselineMinutes: 120,
    currentMinutes: 360,
    hasReview: false,
    screenshotCount: 2,
    achievementsUnlocked: 8,
    achievementsTotal: 51,
  },
  {
    giveawayCode: 'tp003' as SteamGiftsGiveawayCode,
    steamId: '76561198000000004' as SteamId,
    status: 'exempt',
    wonDaysAgo: 60,
    baselineMinutes: 1450,
    currentMinutes: 1450,
    hasReview: true,
    screenshotCount: 0,
    notes: 'already had >24h playtime at win',
  },
  {
    giveawayCode: 'tp004' as SteamGiftsGiveawayCode,
    steamId: '76561198000000001' as SteamId,
    status: 'pending',
    wonDaysAgo: 30,
    baselineMinutes: 0,
    currentMinutes: 75,
    hasReview: false,
    screenshotCount: 1,
    achievementsUnlocked: 3,
    achievementsTotal: 115,
  },
  {
    giveawayCode: 'tp005' as SteamGiftsGiveawayCode,
    steamId: '76561198000000002' as SteamId,
    status: 'pending',
    wonDaysAgo: 12,
    baselineMinutes: 200,
    currentMinutes: 200,
    hasReview: false,
    screenshotCount: 0,
  },
  {
    giveawayCode: 'tp006' as SteamGiftsGiveawayCode,
    steamId: '76561198000000003' as SteamId,
    status: 'pending',
    wonDaysAgo: 3,
  },
  {
    giveawayCode: 'tp007' as SteamGiftsGiveawayCode,
    steamId: '76561198000000004' as SteamId,
    status: 'not_in_group',
    wonDaysAgo: 18,
    baselineMinutes: 0,
    currentMinutes: 0,
    hasReview: false,
    screenshotCount: 0,
    achievementsUnlocked: 0,
    achievementsTotal: 115,
    notes: 'left the Steam group before the play window ended',
  },
]

const ACHIEVEMENTS: ReadonlyArray<AchievementSeed> = [
  {
    giveawayCode: 'tp001' as SteamGiftsGiveawayCode,
    steamId: '76561198000000001' as SteamId,
    app: APPS[0]!,
    apiname: 'HL2_BEAT_COP',
    displayName: 'Defiant',
    description: 'Hit the trashcan cop with the can.',
    unlockedDaysAgo: 96,
  },
  {
    giveawayCode: 'tp003' as SteamGiftsGiveawayCode,
    steamId: '76561198000000003' as SteamId,
    app: APPS[2]!,
    apiname: 'PORTAL2_WAKE_UP',
    displayName: 'Wake Up Call',
    description: 'Survive the manual override.',
    unlockedDaysAgo: 55,
  },
  {
    giveawayCode: 'tp004' as SteamGiftsGiveawayCode,
    steamId: '76561198000000001' as SteamId,
    app: APPS[3]!,
    apiname: 'TERRARIA_TIMBER',
    displayName: 'Timber!!',
    description: 'Chop down your first tree.',
    unlockedDaysAgo: 27,
  },
]

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

const main = async (): Promise<void> => {
  const db = createDbClient()

  const [groupRow] = await db.select().from(groups).where(eq(groups.slug, GROUP_SLUG)).limit(1)
  if (!groupRow) {
    throw new Error(`group "${GROUP_SLUG}" not found — run \`bun run db:seed\` first`)
  }

  for (const a of APPS) {
    await upsertSteamApp(db, a)
  }
  console.log(`[fake] upserted ${String(APPS.length)} steam apps`)

  for (const u of USERS) {
    await upsertUserBySgUsername(db, {
      steamgiftsUsername: u.steamgiftsUsername,
      steamId: u.steamId,
      avatarUrl: u.avatarUrl,
      profileVisibility: 3,
      lastSyncedAt: new Date(),
    })
  }
  console.log(`[fake] upserted ${String(USERS.length)} users`)

  await applyMembershipDiff(db, {
    groupId: groupRow.id,
    currentRoster: new Set(USERS.map((u) => u.steamId)),
    ranAt: daysAgo(120),
  })
  await applyMembershipDiff(db, {
    groupId: groupRow.id,
    currentRoster: new Set(
      USERS.filter((u) => u.steamgiftsUsername !== 'tinker_t').map((u) => u.steamId),
    ),
    ranAt: new Date(),
  })
  console.log('[fake] seeded Steam group memberships')

  const userIdBySgUsername = new Map<SteamGiftsUsername, number>()
  const userIdBySteamId = new Map<SteamId, number>()
  for (const u of USERS) {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.steamgiftsUsername, u.steamgiftsUsername))
      .limit(1)
    if (row) {
      userIdBySgUsername.set(u.steamgiftsUsername, row.id)
      userIdBySteamId.set(u.steamId, row.id)
    }
  }

  const giveawayIdByCode = new Map<SteamGiftsGiveawayCode, number>()
  for (const g of GIVEAWAYS) {
    const ended = daysAgo(g.endedDaysAgo)
    const started = new Date(ended.getTime() - 7 * 24 * 60 * 60 * 1000)
    const creatorId = userIdBySgUsername.get(g.creatorSgUsername)
    if (creatorId === undefined) {
      throw new Error(`fixture mismatch: creator ${g.creatorSgUsername} not seeded`)
    }
    const row = await upsertGiveaway(db, {
      groupId: groupRow.id,
      steamgiftsCode: g.code,
      target: { kind: 'app', appId: g.app.appId },
      creatorUserId: creatorId,
      quantity: g.quantity,
      startedAt: started,
      endedAt: ended,
      scrapedAt: new Date(),
    })
    giveawayIdByCode.set(g.code, row.id)
  }
  console.log(`[fake] upserted ${String(GIVEAWAYS.length)} giveaways`)

  let winsInserted = 0
  for (const w of WINS) {
    const giveawayId = giveawayIdByCode.get(w.giveawayCode)
    const userId = userIdBySteamId.get(w.steamId)
    if (giveawayId === undefined || userId === undefined) {
      throw new Error(`fixture mismatch for ${w.giveawayCode} / ${w.steamId}`)
    }
    const wonAt = daysAgo(w.wonDaysAgo)
    const playDeadline = new Date(wonAt.getTime() + 90 * 24 * 60 * 60 * 1000)
    const inserted = await insertWinIfAbsent(db, {
      giveawayId,
      userId,
      wonAt,
      playDeadline,
    })
    if (!inserted) continue
    winsInserted += 1

    if (w.baselineMinutes !== undefined && w.currentMinutes !== undefined) {
      const checkedAt = new Date(wonAt.getTime() + 60 * 60 * 1000)
      await recordWinPlaytimeBaseline(db, inserted.id, {
        playtimeAtWinMinutes: w.baselineMinutes,
        currentPlaytimeMinutes: w.baselineMinutes,
        playtime2WeeksMinutes: null,
        hasReview: w.hasReview ?? null,
        screenshotCount: w.screenshotCount ?? null,
        achievementsUnlocked: w.achievementsUnlocked ?? null,
        achievementsTotal: w.achievementsTotal ?? null,
        checkedAt,
      })
      if (w.currentMinutes !== w.baselineMinutes) {
        await recordWinPlaytimeProgress(db, inserted.id, {
          currentPlaytimeMinutes: w.currentMinutes,
          playtime2WeeksMinutes: null,
          hasReview: w.hasReview ?? null,
          screenshotCount: w.screenshotCount ?? null,
          achievementsUnlocked: w.achievementsUnlocked ?? null,
          achievementsTotal: w.achievementsTotal ?? null,
          checkedAt: new Date(),
        })
      }
    }

    if (w.status !== 'pending') {
      await updateWinStatus(db, inserted.id, w.status, new Date())
    }
    if (w.notes) {
      await updateWinNotes(db, inserted.id, w.notes)
    }
  }
  console.log(
    `[fake] inserted ${String(winsInserted)} wins (skipped ${String(WINS.length - winsInserted)} duplicates)`,
  )

  let achievementEventsInserted = 0
  for (const a of ACHIEVEMENTS) {
    const giveawayId = giveawayIdByCode.get(a.giveawayCode)
    const userId = userIdBySteamId.get(a.steamId)
    if (giveawayId === undefined || userId === undefined) {
      throw new Error(`fixture mismatch for achievement ${a.apiname}`)
    }
    const win = await findWinByGiveawayAndUser(db, giveawayId, userId)
    if (!win) throw new Error(`win missing for achievement ${a.apiname}`)
    const achievement = await upsertSteamAchievement(db, {
      appId: a.app.appId,
      apiname: a.apiname,
      displayName: a.displayName,
      description: a.description,
      lastSyncedAt: new Date(),
    })
    const result = await recordAchievementStateIfChanged(db, {
      userId,
      achievementId: achievement.id,
      winId: win.id,
      achieved: true,
      unlockedAt: daysAgo(a.unlockedDaysAgo),
      observedAt: new Date(),
    })
    if (result.inserted) achievementEventsInserted += 1
  }
  console.log(`[fake] inserted ${String(achievementEventsInserted)} achievement events`)

  db.$client.close()
  console.log('[fake] done')
}

main().catch((e: unknown) => {
  console.error('[fake] failed:', e)
  process.exit(1)
})
