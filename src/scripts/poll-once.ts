import { env } from '#/config/env'
import { createDbClient } from '#/db/client'
import { createLogger } from '#/lib/logger'
import { buildJobDeps } from '#/worker/build-deps'
import { pollPlaytime } from '#/worker/jobs/poll-playtime'

// One-shot backfill knob. The poll only examines pending wins whose playDeadline
// >= now - windowDays (default 30 inside pollPlaytime). After a deep scrape:once
// (MAX_PAGES > 1) bump this so old backfilled wins get a baseline written. Edit
// the constant below, or override at runtime with POLL_WINDOW_DAYS=10000.
const POLL_WINDOW_DAYS_OVERRIDE: number | null = process.env.POLL_WINDOW_DAYS
  ? Number(process.env.POLL_WINDOW_DAYS)
  : null

const main = async (): Promise<void> => {
  const logger = createLogger({ bindings: { service: 'poll-once' } })
  logger.info('starting', {
    dbMode: env.db.mode,
    dbUrl: env.db.url,
    pollWindowDaysOverride: POLL_WINDOW_DAYS_OVERRIDE,
  })
  if (env.STEAM_WEB_API_KEY.trim().length === 0) {
    console.error('[poll-once] missing external credentials: STEAM_WEB_API_KEY')
    process.exit(1)
  }

  const dbi = createDbClient()
  const { steam, steamCommunity } = buildJobDeps(dbi, logger)

  const summary = await pollPlaytime({
    db: dbi,
    dbWrite: dbi,
    steam,
    steamCommunity,
    logger,
    ...(POLL_WINDOW_DAYS_OVERRIDE !== null && {
      pollWindowDaysAfterDeadline: POLL_WINDOW_DAYS_OVERRIDE,
    }),
  })
  console.log(
    `[poll-once] examined=${String(summary.winsExamined)} baselines=${String(summary.baselinesWritten)} progress=${String(summary.progressWritten)} private=${String(summary.privateProfiles)} missingGames=${String(summary.missingGames)} steamErrors=${String(summary.steamErrors)} skippedNoContext=${String(summary.skippedNoContext)}`,
  )

  if (env.db.mode === 'replica') {
    await dbi.$client.sync()
    console.log('[poll-once] synced replica → remote')
  }
  dbi.$client.close()
}

main().catch((e: unknown) => {
  console.error('[poll-once] failed:', e)
  process.exit(1)
})
