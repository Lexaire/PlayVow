import { env } from '#/config/env'
import { createDbClient } from '#/db/client'
import { groups } from '#/db/schema'
import type { SteamGiftsGroupCode, SteamGroupId } from '#/db/schema'

type GroupSeed = {
  readonly slug: string
  readonly name: string
  readonly playWindowDays: number
  readonly steamgiftsGroupCode: SteamGiftsGroupCode
  readonly steamGroupId: SteamGroupId
  readonly steamGroupSlug: string
  readonly description: string | null
}

const SEED_GROUPS: ReadonlyArray<GroupSeed> = [
  {
    slug: 'taleplay',
    name: 'TalePlay',
    playWindowDays: 90,
    steamgiftsGroupCode: 'xBp7E' as SteamGiftsGroupCode,
    steamGroupId: '103582791467874127' as SteamGroupId,
    steamGroupSlug: 'taleplay',
    description: null,
  },
]

const main = async (): Promise<void> => {
  const db = createDbClient()
  console.log(`[seed] target: ${env.db.mode} (${env.db.url})`)
  for (const g of SEED_GROUPS) {
    await db
      .insert(groups)
      .values(g)
      .onConflictDoUpdate({
        target: groups.slug,
        set: {
          name: g.name,
          playWindowDays: g.playWindowDays,
          steamgiftsGroupCode: g.steamgiftsGroupCode,
          steamGroupId: g.steamGroupId,
          steamGroupSlug: g.steamGroupSlug,
          description: g.description,
        },
      })
    console.log(`[seed] upserted group ${g.slug}`)
  }
  if (env.db.mode === 'replica') {
    await db.$client.sync()
  }
  db.$client.close()
  console.log('[seed] done')
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
