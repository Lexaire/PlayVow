import type { Db } from '#/db/client'
import type { SteamAppId } from '#/db/schema'
import type { SteamApiClient, StoreItemRequest } from '#/external/steam-api'
import type { Logger } from '#/lib/logger'
import {
  findAppIdsNeedingDetails,
  markAppDetailsAttempted,
  upsertSteamAppDetails,
} from '#/repos/steamApps'
import {
  findSubIdsNeedingDetails,
  markSubDetailsAttempted,
  upsertSteamSubDetails,
} from '#/repos/steamSubs'

// IStoreBrowseService/GetItems accepts arbitrary-size `ids` arrays, but the
// official Steam frontend chunks at ~50 and we follow suit to keep individual
// payloads predictable. MAX_PER_RUN bounds an initial backfill so a single
// scrape doesn't sit on Steam for minutes. Apps and subs share the same call:
// each batch can mix both kinds, since IStoreBrowseService treats them as
// equivalent in the `ids` array.
const BATCH_SIZE = 50
const MAX_PER_RUN = 500

export type SyncAppDetailsDeps = {
  readonly db: Db
  readonly dbWrite: Db
  readonly steam: SteamApiClient
  readonly logger: Logger
  readonly now?: () => Date
}

export type SyncAppDetailsSummary = {
  readonly considered: number
  readonly synced: number
  readonly notFound: number
  readonly batchErrors: number
}

export const syncAppDetails = async (deps: SyncAppDetailsDeps): Promise<SyncAppDetailsSummary> => {
  const now = (deps.now ?? (() => new Date()))()
  const log = deps.logger.child({ job: 'sync_app_details' })
  const appIds = await findAppIdsNeedingDetails(deps.db, MAX_PER_RUN)
  // After picking apps, fill the remaining budget with subs. We could split
  // 50/50 but apps dominate volume in practice — preferring apps lets the
  // per-run cap finish faster on backfills.
  const subBudget = Math.max(0, MAX_PER_RUN - appIds.length)
  const subIds = subBudget > 0 ? await findSubIdsNeedingDetails(deps.db, subBudget) : []

  const requests: StoreItemRequest[] = [
    ...appIds.map((appId): StoreItemRequest => ({ kind: 'app', appId })),
    ...subIds.map((subId): StoreItemRequest => ({ kind: 'sub', subId })),
  ]

  let synced = 0
  let notFound = 0
  let batchErrors = 0

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE)
    const r = await deps.steam.getStoreItems(batch)
    if (!r.ok) {
      batchErrors += 1
      log.warn('store_items_failed', { batchSize: batch.length, error: r.error.kind })
      continue
    }
    for (const entry of r.value) {
      if (entry.kind === 'app') {
        if (entry.item === null) {
          notFound += 1
          await markAppDetailsAttempted(deps.dbWrite, entry.appId, now)
          continue
        }
        await upsertSteamAppDetails(deps.dbWrite, { ...entry.item, detailsSyncedAt: now })
        synced += 1
      } else {
        if (entry.item === null) {
          notFound += 1
          await markSubDetailsAttempted(deps.dbWrite, entry.subId, now)
          continue
        }
        await upsertSteamSubDetails(deps.dbWrite, { ...entry.item, detailsSyncedAt: now })
        synced += 1
      }
    }
  }

  log.info('sync_app_details_done', {
    considered: requests.length,
    synced,
    notFound,
    batchErrors,
  })

  return { considered: requests.length, synced, notFound, batchErrors }
}

export type SyncOneAppResult =
  | { readonly kind: 'synced' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'fetch_failed'; readonly error: string }

// Manual entry point for /admin/jobs "Sync one Steam app". Fetches a single
// app's store metadata and upserts unconditionally — even if it was synced
// recently — because the operator clicked the button to force a refresh.
export const syncOneApp = async (
  deps: SyncAppDetailsDeps,
  appId: SteamAppId,
): Promise<SyncOneAppResult> => {
  const now = (deps.now ?? (() => new Date()))()
  const log = deps.logger.child({ job: 'sync_app_details', appId })
  const r = await deps.steam.getStoreItems([{ kind: 'app', appId }])
  if (!r.ok) {
    log.warn('store_items_failed', { error: r.error.kind })
    return { kind: 'fetch_failed', error: r.error.kind }
  }
  const entry = r.value[0]
  if (!entry || entry.kind !== 'app') return { kind: 'not_found' }
  if (entry.item === null) {
    await markAppDetailsAttempted(deps.dbWrite, entry.appId, now)
    return { kind: 'not_found' }
  }
  await upsertSteamAppDetails(deps.dbWrite, { ...entry.item, detailsSyncedAt: now })
  return { kind: 'synced' }
}
