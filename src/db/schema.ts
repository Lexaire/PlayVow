import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export type SteamId = string & { readonly __brand: 'SteamId' }
export type SteamAppId = number & { readonly __brand: 'SteamAppId' }
export type SteamSubId = number & { readonly __brand: 'SteamSubId' }
export type SteamGroupId = string & { readonly __brand: 'SteamGroupId' }
export type SteamGiftsGroupCode = string & { readonly __brand: 'SteamGiftsGroupCode' }
export type SteamGiftsGiveawayCode = string & { readonly __brand: 'SteamGiftsGiveawayCode' }
export type SteamGiftsUsername = string & { readonly __brand: 'SteamGiftsUsername' }

export const WIN_STATUSES = ['pending', 'played', 'kicked', 'not_in_group', 'exempt'] as const
export type WinStatus = (typeof WIN_STATUSES)[number]

export const AUDIT_ACTIONS = [
  'win_created',
  'win_status_changed',
  'win_notes_updated',
  'group_created',
  'group_updated',
  'role_granted',
  'role_revoked',
  'cookie_set',
  'cookie_cleared',
  'cookie_tested',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_TARGET_TYPES = ['win', 'group', 'user'] as const
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

export const SG_COOKIE_TEST_RESULTS = [
  'ok',
  'login_required',
  'http_error',
  'network_error',
] as const
export type SgCookieTestResult = (typeof SG_COOKIE_TEST_RESULTS)[number]

export const USER_ROLES = ['user', 'moderator', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

export type ProfileVisibility = 1 | 3

const timestamp = (name: string) => integer(name, { mode: 'timestamp' })

const createdAt = () =>
  timestamp('created_at')
    .notNull()
    .default(sql`(unixepoch())`)

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  playWindowDays: integer('play_window_days').notNull(),
  steamgiftsGroupCode: text('steamgifts_group_code').$type<SteamGiftsGroupCode>().notNull(),
  steamGroupId: text('steam_group_id').$type<SteamGroupId>().notNull(),
  steamGroupSlug: text('steam_group_slug').notNull(),
  description: text('description'),
  lastScrapedAt: timestamp('last_scraped_at'),
  // Denormalized win counters maintained by the wins repo (insertWinIfAbsent
  // and updateWinStatus). Avoids count(*) joins on every group/mod page load.
  // Reseeded from scratch in the migration backfill if they ever drift.
  totalWins: integer('total_wins').notNull().default(0),
  pendingWins: integer('pending_wins').notNull().default(0),
  lastSteamMembersScrapedAt: timestamp('last_steam_members_scraped_at'),
  createdAt: createdAt(),
})

export const groupSecrets = sqliteTable('group_secrets', {
  groupId: integer('group_id')
    .primaryKey()
    .references(() => groups.id),
  steamgiftsCookieEncrypted: text('steamgifts_cookie_encrypted'),
  steamgiftsCookieUpdatedAt: timestamp('steamgifts_cookie_updated_at'),
  steamgiftsCookieUpdatedByUserId: integer('steamgifts_cookie_updated_by_user_id').references(
    () => users.id,
  ),
  steamgiftsCookieLastTestedAt: timestamp('steamgifts_cookie_last_tested_at'),
  steamgiftsCookieLastTestResult: text('steamgifts_cookie_last_test_result', {
    enum: SG_COOKIE_TEST_RESULTS,
  }),
  steamgiftsCookieLastSuccessAt: timestamp('steamgifts_cookie_last_success_at'),
})

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    steamgiftsUsername: text('steamgifts_username').$type<SteamGiftsUsername>().unique(),
    steamId: text('steam_id').$type<SteamId>().unique(),
    role: text('role', { enum: USER_ROLES }).notNull().default('user'),
    avatarUrl: text('avatar_url'),
    profileVisibility: integer('profile_visibility').$type<ProfileVisibility>(),
    lastSyncedAt: timestamp('last_synced_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('users_role_idx')
      .on(t.role)
      .where(sql`role != 'user'`),
    // SG usernames are case-insensitive, so lookups use lower(username) =
    // lower(?). Without this expression index that predicate forces a full
    // scan even though the unique constraint covers the raw column.
    index('users_username_lower_idx').on(sql`lower(${t.steamgiftsUsername})`),
  ],
)

export const steamApps = sqliteTable('steam_apps', {
  appId: integer('app_id').$type<SteamAppId>().primaryKey(),
  name: text('name').notNull(),
  lastSyncedAt: timestamp('last_synced_at'),
  // Asset paths: each is the full string from IStoreBrowseService/GetItems
  // `assets.<key>` (e.g. "5980b81c.../capsule_231x87.jpg" or just
  // "capsule_231x87.jpg" for legacy hashless apps). Combine with
  // assetUrlFormat via steamAssetUrl(). Each asset family has its own hash,
  // so we persist them all to avoid re-polling when we want a different one.
  assetSmallCapsule: text('asset_small_capsule'),
  assetMainCapsule: text('asset_main_capsule'),
  assetHeader: text('asset_header'),
  assetHeroCapsule: text('asset_hero_capsule'),
  assetLibraryCapsule: text('asset_library_capsule'),
  assetLibraryHero: text('asset_library_hero'),
  assetCommunityIcon: text('asset_community_icon'),
  assetPageBackground: text('asset_page_background'),
  // e.g. "steam/apps/2997230/${FILENAME}?t=1776154869" — substitute filename
  assetUrlFormat: text('asset_url_format'),
  releaseDate: timestamp('release_date'),
  shortDescription: text('short_description'),
  appType: integer('app_type'),
  reviewScore: integer('review_score'),
  reviewScoreLabel: text('review_score_label'),
  reviewPercentPositive: integer('review_percent_positive'),
  reviewCount: integer('review_count'),
  detailsSyncedAt: timestamp('details_synced_at'),
})

export const steamSubs = sqliteTable('steam_subs', {
  subId: integer('sub_id').$type<SteamSubId>().primaryKey(),
  name: text('name').notNull(),
  lastSyncedAt: timestamp('last_synced_at'),
  // Same scheme as steam_apps but no library_*/community_icon (subs don't
  // have library/community pages). One extra: package_header (sub-specific).
  // assetUrlFormat for subs is "steam/subs/{subId}/${FILENAME}?t=…" — already
  // encoded in the response so steamAssetUrl() works without any sub-vs-app
  // branching.
  assetSmallCapsule: text('asset_small_capsule'),
  assetMainCapsule: text('asset_main_capsule'),
  assetHeader: text('asset_header'),
  assetHeroCapsule: text('asset_hero_capsule'),
  assetPackageHeader: text('asset_package_header'),
  assetPageBackground: text('asset_page_background'),
  assetUrlFormat: text('asset_url_format'),
  releaseDate: timestamp('release_date'),
  shortDescription: text('short_description'),
  reviewScore: integer('review_score'),
  reviewScoreLabel: text('review_score_label'),
  reviewPercentPositive: integer('review_percent_positive'),
  reviewCount: integer('review_count'),
  detailsSyncedAt: timestamp('details_synced_at'),
})

export const giveaways = sqliteTable(
  'giveaways',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    steamgiftsCode: text('steamgifts_code').$type<SteamGiftsGiveawayCode>().notNull(),
    steamAppId: integer('steam_app_id')
      .$type<SteamAppId>()
      .references(() => steamApps.appId),
    steamSubId: integer('steam_sub_id')
      .$type<SteamSubId>()
      .references(() => steamSubs.subId),
    creatorUserId: integer('creator_user_id')
      .notNull()
      .references(() => users.id),
    quantity: integer('quantity').notNull(),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at').notNull(),
    scrapedAt: timestamp('scraped_at').notNull(),
    slug: text('slug'),
    winnersScrapedAt: timestamp('winners_scraped_at'),
  },
  (t) => [
    uniqueIndex('giveaways_group_code_uniq').on(t.groupId, t.steamgiftsCode),
    index('giveaways_group_ended_idx').on(t.groupId, t.endedAt),
    // Creator-stats and user-page queries filter by creatorUserId, often with
    // an additional endedAt predicate (active count) or an endedAt sort
    // (no-winner giveaways list). The composite leading on creatorUserId
    // also covers the queries that filter by creator alone.
    index('giveaways_creator_ended_idx').on(t.creatorUserId, t.endedAt),
  ],
)

export const wins = sqliteTable(
  'wins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    giveawayId: integer('giveaway_id')
      .notNull()
      .references(() => giveaways.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    wonAt: timestamp('won_at').notNull(),
    playDeadline: timestamp('play_deadline').notNull(),
    playtimeAtWinMinutes: integer('playtime_at_win_minutes'),
    currentPlaytimeMinutes: integer('current_playtime_minutes'),
    playtime2WeeksMinutes: integer('playtime_2weeks_minutes'),
    hasReview: integer('has_review', { mode: 'boolean' }),
    screenshotCount: integer('screenshot_count'),
    achievementsUnlocked: integer('achievements_unlocked'),
    achievementsTotal: integer('achievements_total'),
    status: text('status', { enum: WIN_STATUSES }).notNull().default('pending'),
    lastCheckedAt: timestamp('last_checked_at'),
    resolvedAt: timestamp('resolved_at'),
    modNotes: text('mod_notes'),
  },
  (t) => [
    uniqueIndex('wins_giveaway_user_uniq').on(t.giveawayId, t.userId),
    index('wins_status_deadline_idx').on(t.status, t.playDeadline),
    index('wins_user_idx').on(t.userId),
  ],
)

export const winObservations = sqliteTable(
  'win_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    winId: integer('win_id')
      .notNull()
      .references(() => wins.id),
    observedAt: timestamp('observed_at').notNull(),
    // Nullable because Steam's "Friends Only" / "Private" per-game privacy
    // hides the game from third-party getOwnedGames responses. We write null
    // to mean "we polled but couldn't see playtime" — distinct from 0 which
    // means "owned, never played."
    currentPlaytimeMinutes: integer('current_playtime_minutes'),
    playtime2WeeksMinutes: integer('playtime_2weeks_minutes'),
    hasReview: integer('has_review', { mode: 'boolean' }),
    screenshotCount: integer('screenshot_count'),
    achievementsUnlocked: integer('achievements_unlocked'),
    achievementsTotal: integer('achievements_total'),
  },
  (t) => [index('win_observations_win_observed_idx').on(t.winId, t.observedAt)],
)

export const steamAchievements = sqliteTable(
  'steam_achievements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    appId: integer('app_id')
      .$type<SteamAppId>()
      .notNull()
      .references(() => steamApps.appId),
    apiname: text('apiname').notNull(),
    displayName: text('display_name'),
    description: text('description'),
    // Populated from GetSchemaForGame in a future work item; null until then.
    iconUrl: text('icon_url'),
    grayIconUrl: text('gray_icon_url'),
    hidden: integer('hidden', { mode: 'boolean' }),
    lastSyncedAt: timestamp('last_synced_at'),
  },
  (t) => [uniqueIndex('steam_achievements_app_apiname_uniq').on(t.appId, t.apiname)],
)

export const achievementEvents = sqliteTable(
  'achievement_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    achievementId: integer('achievement_id')
      .notNull()
      .references(() => steamAchievements.id),
    winId: integer('win_id')
      .notNull()
      .references(() => wins.id),
    achieved: integer('achieved', { mode: 'boolean' }).notNull(),
    // null when achieved=false; also null for pre-2010 legacy unlocks where
    // Steam reports achieved=1 with unlocktime=0.
    unlockedAt: timestamp('unlocked_at'),
    observedAt: timestamp('observed_at').notNull(),
  },
  (t) => [
    // Hot path: "what's the latest event for this (user, achievement)?"
    index('achievement_events_key_idx').on(t.userId, t.achievementId, t.id),
    // For "all events for this win" queries.
    index('achievement_events_win_idx').on(t.winId),
  ],
)

export const steamGroupMemberships = sqliteTable(
  'steam_group_memberships',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    steamId: text('steam_id').$type<SteamId>().notNull(),
    joinedAt: timestamp('joined_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    leftAt: timestamp('left_at'),
    isSticky: integer('is_sticky', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('sgm_group_steam_joined_uniq').on(t.groupId, t.steamId, t.joinedAt),
    index('sgm_group_open_idx')
      .on(t.groupId)
      .where(sql`left_at IS NULL`),
    index('sgm_steam_open_idx')
      .on(t.steamId)
      .where(sql`left_at IS NULL`),
  ],
)

export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number]

export const JOB_RUN_TRIGGERS = ['cron', 'manual'] as const
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number]

// Append-only history of every scheduled job invocation. Written by the
// worker scheduler in src/worker/scheduler.ts; read by /admin/jobs. Worker
// liveness ("did it check in recently?") is intentionally not stored here —
// see worker_heartbeats (future) for that signal.
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobName: text('job_name').notNull(),
    status: text('status', { enum: JOB_RUN_STATUSES }).notNull(),
    // 'cron' = scheduler fired it. 'manual' = an admin clicked a "Run now"
    // button on /admin/jobs. The triggered_by_user_id (when present) is the
    // admin who clicked. Together they let /admin/jobs distinguish ambient
    // scheduled work from one-off operator runs without polluting job_name.
    triggeredBy: text('triggered_by', { enum: JOB_RUN_TRIGGERS }).notNull().default('cron'),
    triggeredByUserId: integer('triggered_by_user_id').references(() => users.id),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),
    steamCalls: integer('steam_calls'),
    sgCalls: integer('sg_calls'),
    errorMessage: text('error_message'),
    // Per-job structured summary (e.g. ScrapeGroupSummary[],
    // PollPlaytimeSummary). Shape varies per job — kept opaque so adding
    // fields to a job's summary doesn't require a migration.
    summary: text('summary', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('job_runs_job_started_idx').on(t.jobName, t.startedAt)],
)

export const JOB_TRIGGER_STATUSES = ['queued', 'claimed', 'done', 'failed'] as const
export type JobTriggerStatus = (typeof JOB_TRIGGER_STATUSES)[number]

// Mailbox table for "run a full job now" requests from the web/admin process.
// The web fn writes a 'queued' row; the worker polls, atomically flips it to
// 'claimed', runs the job in-process (with the same dep bag the cron uses),
// then finalizes to 'done' or 'failed'. Keeps long-running jobs out of the
// web process where they competed with HTTP traffic for sockets/GC/dbWrite.
export const jobTriggers = sqliteTable(
  'job_triggers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobName: text('job_name').notNull(),
    requestedByUserId: integer('requested_by_user_id').references(() => users.id),
    status: text('status', { enum: JOB_TRIGGER_STATUSES }).notNull().default('queued'),
    requestedAt: timestamp('requested_at')
      .notNull()
      .default(sql`(unixepoch())`),
    claimedAt: timestamp('claimed_at'),
    finishedAt: timestamp('finished_at'),
    jobRunId: integer('job_run_id').references(() => jobRuns.id),
    errorMessage: text('error_message'),
  },
  (t) => [index('job_triggers_status_idx').on(t.status, t.id)],
)

// Singleton: only one worker process today, so a fixed PK of 1 keeps the
// upsert trivial. If we ever scale to multiple workers, swap `id` for a
// (hostname, pid) composite PK and keep the read-side semantics. Updated
// every 5 min by the worker; /admin/jobs derives "stale" from last_seen_at.
export const workerHeartbeats = sqliteTable('worker_heartbeats', {
  id: integer('id').primaryKey(),
  startedAt: timestamp('started_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  pid: integer('pid').notNull(),
})

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorUserId: integer('actor_user_id').references(() => users.id),
    action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
    targetType: text('target_type', { enum: AUDIT_TARGET_TYPES }).notNull(),
    targetId: integer('target_id').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_target_idx').on(t.targetType, t.targetId, t.createdAt)],
)
