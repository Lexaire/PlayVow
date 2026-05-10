import { LocalDateTime } from '#/components/LocalDate'
import { formatPlaytimeCompact, formatPlaytimePrecise } from '#/lib/playtime'
import type { AchievementUnlockView, WinObservationView } from '#/server/queries'

type ObservationEntry = {
  readonly kind: 'observation'
  readonly id: number
  readonly at: Date
  readonly playtime: number | null
  readonly playtimeDelta: number
  readonly achievementsUnlocked: number | null
  readonly achievementsTotal: number | null
  readonly achievementsDelta: number
}

type UnlockEntry = {
  readonly kind: 'unlock'
  readonly id: number
  readonly at: Date
  readonly name: string
}

type FeedEntry = ObservationEntry | UnlockEntry

const buildObservationEntries = (
  observations: ReadonlyArray<WinObservationView>,
): ReadonlyArray<ObservationEntry> => {
  let prevPlaytime: number | null = null
  let prevUnlocked: number | null = null
  const out: ObservationEntry[] = []
  for (const o of observations) {
    const playtimeDelta =
      o.currentPlaytimeMinutes !== null && prevPlaytime !== null
        ? o.currentPlaytimeMinutes - prevPlaytime
        : 0
    const achievementsDelta =
      o.achievementsUnlocked !== null && prevUnlocked !== null
        ? o.achievementsUnlocked - prevUnlocked
        : 0
    out.push({
      kind: 'observation',
      id: o.id,
      at: o.observedAt,
      playtime: o.currentPlaytimeMinutes,
      playtimeDelta,
      achievementsUnlocked: o.achievementsUnlocked,
      achievementsTotal: o.achievementsTotal,
      achievementsDelta,
    })
    if (o.currentPlaytimeMinutes !== null) prevPlaytime = o.currentPlaytimeMinutes
    if (o.achievementsUnlocked !== null) prevUnlocked = o.achievementsUnlocked
  }
  return out
}

const unlockName = (u: AchievementUnlockView): string => u.displayName ?? u.apiname

const entryKey = (e: FeedEntry): string => `${e.kind}-${String(e.id)}`

export function GameActivityFeed({
  observations,
  unlocks,
}: {
  readonly observations: ReadonlyArray<WinObservationView>
  readonly unlocks: ReadonlyArray<AchievementUnlockView>
}) {
  if (observations.length === 0 && unlocks.length === 0) {
    return <p className="text-sm text-neutral-600">No game activity recorded.</p>
  }

  const obsEntries = buildObservationEntries(observations)
  const unlockEntries: ReadonlyArray<UnlockEntry> = unlocks.map((u) => ({
    kind: 'unlock',
    id: u.id,
    at: u.unlockedAt,
    name: unlockName(u),
  }))
  const merged: FeedEntry[] = [...obsEntries, ...unlockEntries]
  merged.sort((a, b) => b.at.getTime() - a.at.getTime())

  return (
    <ol className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface text-sm">
      {merged.map((entry) => (
        <li key={entryKey(entry)} className="px-3 py-2">
          <div className="flex items-baseline justify-between gap-4">
            <div className="min-w-0 flex-1">
              {entry.kind === 'observation' ? (
                <ObservationRow entry={entry} />
              ) : (
                <UnlockRow entry={entry} />
              )}
            </div>
            <div className="whitespace-nowrap text-xs text-neutral-500">
              <LocalDateTime date={entry.at} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ObservationRow({ entry }: { readonly entry: ObservationEntry }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span>
        <span className="text-neutral-500">Playtime: </span>
        {entry.playtime === null ? (
          <span className="text-neutral-400">— (private)</span>
        ) : (
          <>
            <span className="text-neutral-900" title={formatPlaytimePrecise(entry.playtime)}>
              {formatPlaytimeCompact(entry.playtime)}
            </span>
            {entry.playtimeDelta > 0 ? (
              <span
                className="ml-1 text-emerald-600"
                title={`+${formatPlaytimePrecise(entry.playtimeDelta)} since previous observation`}
              >
                ▴ +{formatPlaytimeCompact(entry.playtimeDelta)}
              </span>
            ) : null}
          </>
        )}
      </span>
      <span>
        <span className="text-neutral-500">Achievements: </span>
        {entry.achievementsUnlocked === null || entry.achievementsTotal === null ? (
          <span className="text-neutral-400">—</span>
        ) : (
          <>
            <span className="text-neutral-900">
              {entry.achievementsUnlocked}/{entry.achievementsTotal}
            </span>
            {entry.achievementsDelta > 0 ? (
              <span className="ml-1 text-emerald-600">▴ +{entry.achievementsDelta}</span>
            ) : null}
          </>
        )}
      </span>
    </div>
  )
}

function UnlockRow({ entry }: { readonly entry: UnlockEntry }) {
  return (
    <div>
      <span className="text-amber-700">🏆 Unlocked:</span>{' '}
      <span className="text-neutral-900">{entry.name}</span>
    </div>
  )
}
