import '#/lib/server-only'

import { env } from '#/config/env'
import type { Db } from '#/db/client'
import { createSteamApiClient } from '#/external/steam-api'
import type { SteamApiClient } from '#/external/steam-api'
import { createSteamCommunityClient } from '#/external/steam-community'
import type { SteamCommunityClient } from '#/external/steam-community'
import { createSgClient } from '#/external/steamgifts'
import { createCountingFetcher } from '#/lib/counting-fetcher'
import type { CountingFetcher } from '#/lib/counting-fetcher'
import type { Logger } from '#/lib/logger'
import { createRateLimitedFetcher } from '#/lib/rate-limiter'
import { getDecryptedCookie } from '#/repos/groupSecrets'
import type { SgClientFactory } from '#/worker/jobs/scrape-group'

// Rate-limit constants for outbound Steam / SteamGifts traffic. Mirrored from
// src/worker/index.ts so manual one-shot runs from the web process apply the
// same throttle the cron worker does. See worker/index.ts for the prose
// explaining each value.
const SG_MIN_INTERVAL_MS = 2500
const SG_JITTER_MS = 1000
const STEAM_MIN_INTERVAL_MS = 1000
const STEAM_JITTER_MS = 250

export type JobDeps = {
  readonly sgClientForGroup: SgClientFactory
  readonly steam: SteamApiClient
  readonly steamCommunity: SteamCommunityClient
  readonly counters: { readonly steam: CountingFetcher; readonly sg: CountingFetcher }
}

// Build a fresh dep bag with its own rate-limited+counting fetchers. Used by:
//   - the worker entrypoint (long-lived, one bag for the process)
//   - one-off scripts (scrape-once / poll-once)
//   - /admin/jobs "Run now" server fns
// The web process and worker process each have their own bag, so the rate
// limits are per-process — concurrent SG calls between a manual run and a
// cron run are possible. That's accepted: manual runs are rare and the
// concurrency guard in hasUnfinishedJobRun() refuses overlapping runs of the
// same job.
export const buildJobDeps = (dbRead: Db, logger: Logger): JobDeps => {
  const sgFetcher = createCountingFetcher(
    createRateLimitedFetcher({
      fetcher: fetch,
      minIntervalMs: SG_MIN_INTERVAL_MS,
      jitterMs: SG_JITTER_MS,
    }),
  )
  const steamFetcher = createCountingFetcher(
    createRateLimitedFetcher({
      fetcher: fetch,
      minIntervalMs: STEAM_MIN_INTERVAL_MS,
      jitterMs: STEAM_JITTER_MS,
    }),
  )
  const sgClientForGroup: SgClientFactory = async (groupId) => {
    const r = await getDecryptedCookie(dbRead, groupId)
    if (!r.ok) {
      if (r.error.kind === 'decrypt_failed') {
        logger.error('sg_cookie_decrypt_failed', { groupId, cause: r.error.cause.kind })
      }
      return createSgClient({ fetcher: sgFetcher })
    }
    return createSgClient({ cookie: r.value, fetcher: sgFetcher })
  }
  const steam = createSteamApiClient({ apiKey: env.STEAM_WEB_API_KEY, fetcher: steamFetcher })
  const steamCommunity = createSteamCommunityClient({ fetcher: steamFetcher })
  return {
    sgClientForGroup,
    steam,
    steamCommunity,
    counters: { steam: steamFetcher, sg: sgFetcher },
  }
}
