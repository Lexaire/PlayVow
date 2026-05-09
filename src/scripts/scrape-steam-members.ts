import { env } from '#/config/env'
import { createDbClient } from '#/db/client'
import { createSteamCommunityClient } from '#/external/steam-community'
import { createLogger } from '#/lib/logger'
import { createRateLimitedFetcher } from '#/lib/rate-limiter'
import { scrapeAllSteamGroupMembers } from '#/worker/jobs/scrape-steam-group-members'

const STEAM_MIN_INTERVAL_MS = 1000
const STEAM_JITTER_MS = 250

const main = async (): Promise<void> => {
  const logger = createLogger({ bindings: { service: 'scrape-steam-members' } })
  logger.info('starting', { dbMode: env.db.mode, dbUrl: env.db.url })

  const dbi = createDbClient()
  const steamFetcher = createRateLimitedFetcher({
    fetcher: fetch,
    minIntervalMs: STEAM_MIN_INTERVAL_MS,
    jitterMs: STEAM_JITTER_MS,
  })
  const steamCommunity = createSteamCommunityClient({ fetcher: steamFetcher })

  const result = await scrapeAllSteamGroupMembers({
    db: dbi,
    dbWrite: dbi,
    steam: steamCommunity,
    logger,
  })

  for (const s of result.groups) {
    console.log(
      `[scrape-steam-members] group=${String(s.groupId)} members=${String(s.membersSeen)} joined=${String(s.joined)} stillPresent=${String(s.stillPresent)} left=${String(s.left)}`,
    )
  }
  for (const e of result.errors) {
    console.error(`[scrape-steam-members] error: ${e}`)
  }

  if (env.db.mode === 'replica') {
    await dbi.$client.sync()
    console.log('[scrape-steam-members] synced replica → remote')
  }
  dbi.$client.close()
}

main().catch((e: unknown) => {
  console.error('[scrape-steam-members] failed:', e)
  process.exit(1)
})
