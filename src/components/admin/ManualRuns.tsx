import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import type { Group } from '#/repos/groups'
import {
  pollOneWinFn,
  runBackfillWinnersFn,
  runPollAllFn,
  runRefreshAppAchievementPercentsFn,
  runScrapeAllFn,
  runScrapeSteamMembersFn,
  scrapeOneGroupFn,
  syncManualSteamUserFn,
  syncOneAppFn,
} from '#/server/manualRunFns'
import type { PendingWinOption } from '#/server/jobsFns'
import type { PollSingleWinResult } from '#/worker/jobs/poll-playtime'
import type { ScrapeGroupSummary } from '#/worker/jobs/scrape-group'

// Manual "Run now" panel for /admin/jobs.
//
// Audience: a non-technical admin keeping the site alive between deploys.
// Section headings, button labels, and result toasts are written for that
// operator — no jargon like "scrape", "poll", "backfill". Single-item
// actions await the result and surface plain English. Background actions
// enqueue a job_triggers row and return immediately; the worker claims it
// on its next 30s drain and only then writes the 'running' job_runs row
// that appears in history.

type Tone = 'ok' | 'warn' | 'err' | 'info'
type Msg = { readonly tone: Tone; readonly text: string }

const TONE_CLS: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  warn: 'bg-amber-50 text-amber-900 border-amber-200',
  err: 'bg-rose-50 text-rose-800 border-rose-200',
  info: 'bg-sky-50 text-sky-800 border-sky-200',
}

export function ManualRuns({
  groups,
  pendingWins,
}: {
  readonly groups: ReadonlyArray<Group>
  readonly pendingWins: ReadonlyArray<PendingWinOption>
}) {
  const router = useRouter()
  const scrapeOneGroup = useServerFn(scrapeOneGroupFn)
  const pollOneWin = useServerFn(pollOneWinFn)
  const syncOneApp = useServerFn(syncOneAppFn)
  const syncManualSteamUser = useServerFn(syncManualSteamUserFn)
  const runScrapeAll = useServerFn(runScrapeAllFn)
  const runPollAll = useServerFn(runPollAllFn)
  const runBackfillWinners = useServerFn(runBackfillWinnersFn)
  const runScrapeSteamMembers = useServerFn(runScrapeSteamMembersFn)
  const runRefreshAppAchievementPercents = useServerFn(runRefreshAppAchievementPercentsFn)

  const [msg, setMsg] = useState<Msg | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<number | null>(groups[0]?.id ?? null)
  const [winId, setWinId] = useState<number | null>(pendingWins[0]?.winId ?? null)
  const [appIdInput, setAppIdInput] = useState('')
  const [steamUserInput, setSteamUserInput] = useState('')

  const wrap = async (key: string, body: () => Promise<Msg>) => {
    setPending(key)
    setMsg(null)
    try {
      setMsg(await body())
      await router.invalidate()
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setPending(null)
    }
  }

  const onScrapeOneGroup = () => {
    if (groupId === null) return
    void wrap('scrapeOne', async () => {
      const r = await scrapeOneGroup({ data: { groupId } })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return { tone: 'ok', text: formatScrapeSummary(r.value.summary) }
    })
  }

  const onPollOneWin = () => {
    if (winId === null) return
    void wrap('pollOne', async () => {
      const r = await pollOneWin({ data: { winId } })
      if (!r.ok) {
        if (r.error.kind === 'poll_threw') {
          return {
            tone: 'err',
            text: `Update failed with an unexpected error: ${r.error.message}`,
          }
        }
        return formatBusyOrNotFound(r.error)
      }
      return formatPollOutcome(r.value.result)
    })
  }

  const onSyncOneApp = () => {
    const appId = Number(appIdInput.trim())
    if (!Number.isInteger(appId) || appId <= 0) {
      setMsg({ tone: 'err', text: 'Enter a Steam app id (a positive number).' })
      return
    }
    void wrap('syncApp', async () => {
      const r = await syncOneApp({ data: { appId } })
      if (!r.ok) {
        if (r.error.kind === 'sync_threw') {
          return {
            tone: 'err',
            text: `Refresh failed with an unexpected error: ${r.error.message}`,
          }
        }
        return formatBusyOrNotFound(r.error)
      }
      return formatSyncOutcome(r.value.result)
    })
  }

  const onSyncSteamUser = () => {
    const trimmed = steamUserInput.trim()
    if (trimmed.length === 0) {
      setMsg({ tone: 'err', text: 'Enter a Steam ID, vanity URL, or vanity handle.' })
      return
    }
    void wrap('syncSteamUser', async () => {
      const r = await syncManualSteamUser({ data: { input: trimmed } })
      if (!r.ok) return formatSyncSteamUserError(r.error)
      setSteamUserInput('')
      return formatSyncSteamUserOk(r.value)
    })
  }

  // Background-action toasts say "queued" rather than "started" — the server
  // fn returns once the job_triggers row is written, but the worker doesn't
  // claim it until its next 30s tick. The history table only shows a
  // 'running' row once the worker actually starts.
  const queuedMsg = (text: string): Msg => ({ tone: 'info', text })

  const onRunScrapeAll = () =>
    void wrap('scrapeAll', async () => {
      const r = await runScrapeAll({ data: {} })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return queuedMsg(
        'Queued: refresh giveaways and winners for every group. The worker will pick this up within 30 seconds.',
      )
    })

  const onRunPollAll = () =>
    void wrap('pollAll', async () => {
      const r = await runPollAll({ data: {} })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return queuedMsg(
        'Queued: update playtime for every pending win. The worker will pick this up within 30 seconds.',
      )
    })

  const onRunBackfillWinners = () =>
    void wrap('backfill', async () => {
      const r = await runBackfillWinners({ data: {} })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return queuedMsg(
        'Queued: find winners for older giveaways. The worker will pick this up within 30 seconds.',
      )
    })

  const onRunScrapeSteamMembers = () =>
    void wrap('steamMembers', async () => {
      const r = await runScrapeSteamMembers({ data: {} })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return queuedMsg(
        'Queued: refresh Steam group member rosters. The worker will pick this up within 30 seconds.',
      )
    })

  const onRunRefreshAppAchievementPercents = () =>
    void wrap('refreshAppAchPercents', async () => {
      const r = await runRefreshAppAchievementPercents({ data: {} })
      if (!r.ok) return formatBusyOrNotFound(r.error)
      return queuedMsg(
        'Queued: refresh community-completion percentages for app achievements. The worker will pick this up within 30 seconds.',
      )
    })

  return (
    <section className="rounded border border-neutral-200 bg-surface p-4">
      <h2 className="text-sm font-semibold">Manual run</h2>
      <p className="mt-0.5 text-xs text-neutral-600">
        The worker handles all of this on a schedule. Only use these buttons for troubleshooting.
      </p>

      {msg ? (
        <div
          className={`mt-3 rounded border px-3 py-2 text-xs ${TONE_CLS[msg.tone]}`}
          role="status"
        >
          {msg.text}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
        <Section
          title="One group"
          caption="Pick a group, then act on just that group."
        >
          <select
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            value={groupId ?? ''}
            onChange={(e) => {
              setGroupId(e.target.value ? Number(e.target.value) : null)
            }}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.slug} · {g.name}
              </option>
            ))}
          </select>
          <Action
            label="Refresh giveaways and winners"
            help="Re-reads this group's giveaway listing pages, picks up new giveaways, and records winners for any that just ended."
            onClick={onScrapeOneGroup}
            busy={pending === 'scrapeOne'}
            disabled={groupId === null}
          />
        </Section>

        <Section
          title="One pending win"
          caption="Asks Steam for fresh playtime and achievements for this win, without waiting for the next hourly check."
        >
          <select
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            value={winId ?? ''}
            onChange={(e) => {
              setWinId(e.target.value ? Number(e.target.value) : null)
            }}
            disabled={pendingWins.length === 0}
          >
            {pendingWins.length === 0 ? <option value="">No pending wins</option> : null}
            {pendingWins.map((w) => (
              <option key={w.winId} value={w.winId}>
                #{String(w.winId)} {w.groupSlug}/{w.giveawayCode}
                {w.lastCheckedAt
                  ? ` · checked ${w.lastCheckedAt.toISOString().slice(0, 10)}`
                  : ' · never checked'}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-neutral-500">
            Showing the {pendingWins.length} pending wins that have gone the longest without an
            update.
          </p>
          <Action
            label="Update playtime and achievements"
            onClick={onPollOneWin}
            busy={pending === 'pollOne'}
            disabled={winId === null}
          />
        </Section>

        <Section
          title="One Steam user"
          caption="Look up a Steam profile and create or update its row in the database. Useful for seeding a user before they appear in any giveaway (e.g. so you can grant them mod access by Steam ID)."
        >
          <input
            type="text"
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-sm"
            placeholder="SteamID64, vanity URL, or vanity handle"
            value={steamUserInput}
            onChange={(e) => {
              setSteamUserInput(e.target.value)
            }}
          />
          <Action
            label="Sync Steam user"
            help="Fetches persona name, avatar, and visibility from the Steam Community profile page."
            onClick={onSyncSteamUser}
            busy={pending === 'syncSteamUser'}
          />
        </Section>

        <Section
          title="One Steam game"
          caption="Refresh a game's name, capsule images, release date, and review score from the Steam store."
        >
          <input
            type="text"
            inputMode="numeric"
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-sm"
            placeholder="Steam app id (e.g. 730)"
            value={appIdInput}
            onChange={(e) => {
              setAppIdInput(e.target.value)
            }}
          />
          <Action
            label="Refresh game info"
            help="Pulls fresh Steam store data for this app. Use this if a game's image is missing or its title looks wrong."
            onClick={onSyncOneApp}
            busy={pending === 'syncApp'}
          />
        </Section>

        <Section
          title="All groups, all wins"
          caption="Run a full refresh in the background. The worker picks these up within 30 seconds — watch the history table below for completion."
        >
          <Action
            label="Refresh giveaways and winners for every group"
            help="Same as the per-group refresh above, but for all groups. Normally runs once a day on its own."
            onClick={onRunScrapeAll}
            busy={pending === 'scrapeAll'}
          />
          <Action
            label="Update playtime for every pending win"
            help="Same as the per-win update above, but for all pending wins. Normally runs hourly on its own."
            onClick={onRunPollAll}
            busy={pending === 'pollAll'}
          />
          <Action
            label="Find winners for older giveaways"
            help="Re-checks giveaways that ended without a winners record yet — useful if the original scrape missed them. Normally runs once a day on its own."
            onClick={onRunBackfillWinners}
            busy={pending === 'backfill'}
          />
          <Action
            label="Refresh Steam group member rosters"
            help="Updates the list of who is currently in each group on Steam itself (separate from the SteamGifts side). Normally runs once a day on its own."
            onClick={onRunScrapeSteamMembers}
            busy={pending === 'steamMembers'}
          />
          <Action
            label="Refresh community achievement percentages"
            help="Asks Steam for the % of all owners who have unlocked each achievement, per game. Powers the 'common achievements' badge. Normally runs once a day; each game is only re-checked every ~90 days."
            onClick={onRunRefreshAppAchievementPercents}
            busy={pending === 'refreshAppAchPercents'}
          />
        </Section>
      </div>
    </section>
  )
}

function Section({
  title,
  caption,
  children,
}: {
  readonly title: string
  readonly caption: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold text-neutral-800">{title}</h3>
        <p className="text-[11px] text-neutral-500">{caption}</p>
      </div>
      {children}
    </div>
  )
}

function Action({
  label,
  help,
  onClick,
  busy,
  disabled,
}: {
  readonly label: string
  readonly help?: string
  readonly onClick: () => void
  readonly busy: boolean
  readonly disabled?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className="shrink-0 rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Working…' : label}
      </button>
      {help ? <p className="text-[11px] leading-snug text-neutral-500">{help}</p> : null}
    </div>
  )
}

const formatScrapeSummary = (s: ScrapeGroupSummary | null): string => {
  if (s === null) return 'Refresh complete. (No details returned.)'
  const seen = pluralize(s.giveawaysSeen, 'giveaway', 'giveaways')
  const updated = pluralize(s.giveawaysCreatedOrUpdated, 'was', 'were')
  const wins = pluralize(s.winsCreated, 'new win', 'new wins')
  const pages = pluralize(s.pagesScraped, 'page', 'pages')
  return `Refresh complete. Saw ${seen}; ${String(s.giveawaysCreatedOrUpdated)} ${updated} added or updated, ${wins} recorded (read ${pages}).`
}

const pluralize = (n: number, singular: string, plural: string): string =>
  `${String(n)} ${n === 1 ? singular : plural}`

// Per-kind toast for "Update playtime and achievements". The operator sees
// exactly why the update didn't return playtime data, so they know whether
// it's something they can fix (refresh the group) or a permanent state
// (sub-only giveaway, unlinked Steam account).
const formatPollOutcome = (kind: PollSingleWinResult['kind']): Msg => {
  switch (kind) {
    case 'success':
      return {
        tone: 'ok',
        text: 'Updated. Pulled the latest playtime and achievements from Steam.',
      }
    case 'win_not_found':
      return { tone: 'err', text: 'Win not found.' }
    case 'user_missing':
      return { tone: 'err', text: 'The user record for this win has been deleted.' }
    case 'giveaway_missing':
      return { tone: 'err', text: 'The giveaway record for this win has been deleted.' }
    case 'user_no_steam_id':
      return {
        tone: 'warn',
        text: 'The winner has not linked a Steam account. There is nothing to update until they sign in with Steam.',
      }
    case 'giveaway_no_app_id':
      return {
        tone: 'warn',
        text: 'This giveaway is not linked to a specific Steam game (it may be a package/sub giveaway). Try refreshing the group to see if it gets resolved.',
      }
    case 'profile_private':
      return {
        tone: 'warn',
        text: "The winner's Steam profile is private, so we cannot see their playtime.",
      }
    case 'owned_games_failed':
      return {
        tone: 'err',
        text: 'Steam refused the request. Try again in a moment.',
      }
  }
}

const formatSyncOutcome = (kind: 'synced' | 'not_found' | 'fetch_failed'): Msg => {
  if (kind === 'synced') {
    return { tone: 'ok', text: 'Updated. Steam returned fresh details for this game.' }
  }
  if (kind === 'not_found') {
    return { tone: 'warn', text: 'Steam does not recognize that app id.' }
  }
  return { tone: 'err', text: 'Steam refused the request. Try again in a moment.' }
}

const formatSyncSteamUserOk = (v: {
  readonly steamId: string
  readonly personaName: string
  readonly profileVisibility: 1 | 3
  readonly wasInsert: boolean
}): Msg => {
  const verb = v.wasInsert ? 'Created' : 'Updated'
  const visibility = v.profileVisibility === 3 ? 'public' : 'private'
  return {
    tone: 'ok',
    text: `${verb} user ${v.personaName} (${v.steamId}, ${visibility} profile).`,
  }
}

const formatSyncSteamUserError = (e: {
  readonly kind: 'invalid_input' | 'profile_lookup_failed'
  readonly cause?: { readonly kind: string; readonly status?: number; readonly message?: string }
}): Msg => {
  if (e.kind === 'invalid_input') {
    return {
      tone: 'err',
      text: 'Could not parse that input. Use a 17-digit SteamID64, a steamcommunity.com profile URL, or a vanity handle.',
    }
  }
  const cause = e.cause
  if (cause?.kind === 'not_found') {
    return { tone: 'warn', text: 'Steam returned no profile for that input.' }
  }
  if (cause?.kind === 'http_status') {
    return { tone: 'err', text: `Steam refused the request (HTTP ${String(cause.status)}).` }
  }
  return { tone: 'err', text: `Profile lookup failed: ${cause?.kind ?? 'unknown'}` }
}

const formatBusyOrNotFound = (e: {
  readonly kind: 'busy' | 'group_not_found' | 'win_not_found'
  readonly jobName?: string
}): Msg => {
  if (e.kind === 'busy') {
    return {
      tone: 'warn',
      text: 'A run of this same kind is already in progress. Wait for it to finish, then try again. (Check the history table below if it looks stuck.)',
    }
  }
  if (e.kind === 'group_not_found') return { tone: 'err', text: 'Group not found.' }
  return { tone: 'err', text: 'Win not found.' }
}
