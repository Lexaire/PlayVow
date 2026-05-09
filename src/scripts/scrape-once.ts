import { env } from '#/config/env'
import { createDbClient } from '#/db/client'
import { createLogger } from '#/lib/logger'
import { findGroupBySlug } from '#/repos/groups'
import { buildJobDeps } from '#/worker/build-deps'
import type { ScrapeGroupSummary } from '#/worker/jobs/scrape-group'
import { scrapeAllGroups, scrapeGroup } from '#/worker/jobs/scrape-group'
import { syncAppDetails } from '#/worker/jobs/sync-app-details'

const main = async (): Promise<void> => {
  const logger = createLogger({ bindings: { service: 'scrape-once' } })
  logger.info('starting', { dbMode: env.db.mode, dbUrl: env.db.url })
  if (env.STEAM_WEB_API_KEY.trim().length === 0) {
    console.error(`[scrape-once] missing external credentials: STEAM_WEB_API_KEY`)
    process.exit(1)
  }

  const dbi = createDbClient()
  const { sgClientForGroup, steam } = buildJobDeps(dbi, logger)

  const slug = process.argv[2]
  let summaries: ReadonlyArray<ScrapeGroupSummary>

  if (slug) {
    const group = await findGroupBySlug(dbi, slug)
    if (!group) {
      console.error(`[scrape-once] no group with slug "${slug}"`)
      dbi.$client.close()
      process.exit(1)
    }
    const sg = await sgClientForGroup(group.id)
    if (!sg.hasCookie) {
      console.warn(
        `[scrape-once] group "${slug}" has no cookie set — running anonymous scrape (multi-copy 3+ winners will stay unsettled).`,
      )
    }
    summaries = [await scrapeGroup({ db: dbi, dbWrite: dbi, sg, logger }, group)]
    // Single-group path skips scrapeAllGroups, so call sync directly here.
    await syncAppDetails({ db: dbi, dbWrite: dbi, steam, logger })
  } else {
    summaries = await scrapeAllGroups({
      db: dbi,
      dbWrite: dbi,
      sgClientForGroup,
      steam,
      logger,
    })
  }

  for (const s of summaries) {
    console.log(
      `[scrape-once] group=${String(s.groupId)} giveaways=${String(s.giveawaysSeen)} updated=${String(s.giveawaysCreatedOrUpdated)} creatorErrors=${String(s.creatorErrors)} winners=${String(s.winnersSeen)} created=${String(s.winsCreated)} existing=${String(s.winsExisting)} winnerErrors=${String(s.winnerErrors)}`,
    )
  }

  if (env.db.mode === 'replica') {
    await dbi.$client.sync()
    console.log('[scrape-once] synced replica → remote')
  }
  dbi.$client.close()
}

main().catch((e: unknown) => {
  console.error('[scrape-once] failed:', e)
  process.exit(1)
})
