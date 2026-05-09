import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { formatPlaytimeCompact, formatPlaytimePrecise } from '#/lib/playtime'
import type { AchievementUnlockView, WinObservationView } from '#/server/queries'

const tickDateFormat = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
})

const tooltipDateFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

const unlockName = (u: AchievementUnlockView): string => u.displayName ?? u.apiname

const numericDomain = (times: ReadonlyArray<number>): [number, number] => {
  const min = Math.min(...times)
  const max = Math.max(...times)
  return min === max ? [min - 1, max + 1] : [min, max]
}

export function PlaytimeAchievementsChart({
  observations,
  unlocks,
}: {
  readonly observations: ReadonlyArray<WinObservationView>
  readonly unlocks: ReadonlyArray<AchievementUnlockView>
}) {
  const hasPlaytime = observations.length > 0
  const hasUnlocks = unlocks.length > 0
  if (!hasPlaytime && !hasUnlocks) return null

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {hasPlaytime ? <PlaytimeChart observations={observations} /> : null}
      {hasUnlocks ? <AchievementsChart unlocks={unlocks} /> : null}
    </div>
  )
}

type PlaytimePoint = { readonly t: number; readonly playtime: number | null }

function PlaytimeChart({
  observations,
}: {
  readonly observations: ReadonlyArray<WinObservationView>
}) {
  const data: ReadonlyArray<PlaytimePoint> = observations.map((o) => ({
    t: o.observedAt.getTime(),
    playtime: o.currentPlaytimeMinutes,
  }))
  const domain = numericDomain(data.map((d) => d.t))

  return (
    <ChartCard title="Playtime">
      <LineChart data={[...data]} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#e5e5e5" strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="t"
          domain={domain}
          scale="time"
          tickFormatter={(v: number) => tickDateFormat.format(new Date(v))}
          stroke="#737373"
          fontSize={11}
        />
        <YAxis
          tickFormatter={(v: number) => formatPlaytimeCompact(v)}
          stroke="#737373"
          fontSize={11}
          width={56}
        />
        <Tooltip content={<PlaytimeTooltip />} />
        <Line
          type="monotone"
          dataKey="playtime"
          name="Playtime"
          stroke="#2563eb"
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartCard>
  )
}

type UnlockPoint = { readonly t: number; readonly count: number; readonly name: string }

function AchievementsChart({
  unlocks,
}: {
  readonly unlocks: ReadonlyArray<AchievementUnlockView>
}) {
  const data: ReadonlyArray<UnlockPoint> = unlocks.map((u, i) => ({
    t: u.unlockedAt.getTime(),
    count: i + 1,
    name: unlockName(u),
  }))
  const domain = numericDomain(data.map((d) => d.t))

  return (
    <ChartCard title={`Achievements (${String(unlocks.length)})`}>
      <LineChart data={[...data]} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="#e5e5e5" strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="t"
          domain={domain}
          scale="time"
          tickFormatter={(v: number) => tickDateFormat.format(new Date(v))}
          stroke="#737373"
          fontSize={11}
        />
        <YAxis allowDecimals={false} stroke="#737373" fontSize={11} width={32} />
        <Tooltip content={<AchievementsTooltip />} />
        <Line
          type="stepAfter"
          dataKey="count"
          name="Achievements"
          stroke="#a16207"
          strokeWidth={2}
          dot={{ r: 3, fill: '#a16207' }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartCard>
  )
}

function ChartCard({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactElement
}) {
  return (
    <div className="rounded border border-neutral-200 bg-surface p-3">
      <div className="mb-2 text-xs font-medium uppercase text-neutral-500">{title}</div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

type TooltipPayloadEntry = {
  readonly value?: unknown
  readonly payload?: unknown
}

function PlaytimeTooltip({
  active,
  payload,
}: {
  readonly active?: boolean
  readonly payload?: ReadonlyArray<TooltipPayloadEntry>
}) {
  if (active !== true || !payload || payload.length === 0) return null
  const point = payload[0]?.payload as PlaytimePoint | undefined
  if (!point) return null
  return (
    <div className="rounded border border-neutral-300 bg-surface px-2 py-1.5 text-xs shadow-sm">
      <div className="font-medium text-neutral-900">
        {tooltipDateFormat.format(new Date(point.t))}
      </div>
      <div className="text-blue-700">
        {point.playtime === null
          ? 'Playtime: —'
          : `Playtime: ${formatPlaytimePrecise(point.playtime)}`}
      </div>
    </div>
  )
}

function AchievementsTooltip({
  active,
  payload,
}: {
  readonly active?: boolean
  readonly payload?: ReadonlyArray<TooltipPayloadEntry>
}) {
  if (active !== true || !payload || payload.length === 0) return null
  const point = payload[0]?.payload as UnlockPoint | undefined
  if (!point) return null
  return (
    <div className="rounded border border-neutral-300 bg-surface px-2 py-1.5 text-xs shadow-sm">
      <div className="font-medium text-neutral-900">
        {tooltipDateFormat.format(new Date(point.t))}
      </div>
      <div className="text-amber-700">
        #{point.count}: {point.name}
      </div>
    </div>
  )
}
