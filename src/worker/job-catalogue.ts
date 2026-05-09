// Static catalogue of scheduled jobs — the source of truth for "which jobs
// exist and what's their cron." Imported by the worker entry to seed the
// scheduler, and by /admin/jobs so jobs that have never run still appear in
// the UI. The actual run() implementations stay in src/worker/index.ts where
// they have access to the wired-up clients (db, sg factory, steam, etc.).

export type JobCatalogueEntry = {
  readonly name: string
  readonly cron: string
  readonly description: string
  // Overdue threshold for health monitoring: how long after the last success
  // before the job is considered behind schedule. Set to 1.5× the run interval
  // to absorb cron jitter and overlap with a currently-running job.
  readonly expectedIntervalMs: number
}

const HOUR = 60 * 60 * 1000

export const JOB_CATALOGUE: ReadonlyArray<JobCatalogueEntry> = [
  {
    name: 'scrape_groups',
    cron: '30 4 * * *',
    description: 'Scrape SteamGifts group listings, giveaways, and winners.',
    expectedIntervalMs: 36 * HOUR,
  },
  {
    name: 'scrape_steam_group_members',
    cron: '30 5 * * *',
    description: 'Diff Steam group rosters; record joins and leaves.',
    expectedIntervalMs: 36 * HOUR,
  },
  {
    name: 'backfill_winners',
    cron: '30 6 * * *',
    description: 'Reconcile multi-copy giveaways via the dedicated winners page.',
    expectedIntervalMs: 36 * HOUR,
  },
  {
    name: 'poll_playtime',
    cron: '0 * * * *',
    description: 'Poll Steam playtime and achievement progress for pending wins.',
    expectedIntervalMs: 90 * 60 * 1000,
  },
  {
    name: 'refresh_app_achievement_percents',
    // Daily at 07:30 — runs after the 06:30 backfill so we're not competing
    // for the Steam rate limiter at the same minute. Picks up apps whose
    // global_percent is null or > 90 days stale.
    cron: '30 7 * * *',
    description: 'Refresh community-completion percentages for known app achievements.',
    expectedIntervalMs: 36 * HOUR,
  },
]

export const findJobInCatalogue = (name: string): JobCatalogueEntry | undefined =>
  JOB_CATALOGUE.find((j) => j.name === name)
