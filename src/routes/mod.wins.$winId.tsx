import { Link, createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'

import { AuditEntryRow } from '#/components/AuditEntryRow'
import { GameActivityFeed } from '#/components/GameActivityFeed'
import { LocalDate } from '#/components/LocalDate'
import { PlaytimeAchievementsChart } from '#/components/PlaytimeAchievementsChart'
import { StatusBadge, renderAchievements } from '#/components/WinsTable'
import { allowedActionsFrom, targetStatus } from '#/domain/win-status'
import type { ModAction } from '#/domain/win-status'
import {
  ACTION_LABELS,
  ACTION_PROMPTS,
  ACTION_STYLES,
  formatStatusError,
} from '#/domain/win-status-ui'
import { isMod } from '#/domain/roles'
import { formatPlaytimeCompact, formatPlaytimePrecise } from '#/lib/playtime'
import { fetchModSession, fetchModWinDetail, setWinStatus, updateWinNotesFn } from '#/server/modFns'
import type { MembershipStatusView, WinAuditEntry } from '#/server/queries'

const ParamsSchema = z.object({ winId: z.string().regex(/^\d+$/) })

// Mod views pin to UTC so moderators across timezones see the same number when
// coordinating, and the label removes ambiguity.
const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

export const Route = createFileRoute('/mod/wins/$winId')({
  parseParams: (raw) => ParamsSchema.parse(raw),
  beforeLoad: async () => {
    const { user } = await fetchModSession()
    if (!isMod(user)) throw redirect({ to: '/login' })
  },
  loader: async ({ params }) => {
    const data = await fetchModWinDetail({ data: { winId: Number(params.winId) } })
    if (!data) throw notFound()
    return data
  },
  component: ModWinDetailPage,
})

function ModWinDetailPage() {
  const { win, auditEntries, observations, achievementUnlocks, membershipStatus } =
    Route.useLoaderData()
  const router = useRouter()
  const setStatus = useServerFn(setWinStatus)
  const updateNotes = useServerFn(updateWinNotesFn)
  const [pending, setPending] = useState<ModAction | 'notes' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [armed, setArmed] = useState<ModAction | null>(null)
  const [notes, setNotes] = useState(win.modNotes ?? '')

  const onArm = (action: ModAction) => {
    setArmed(action)
    setError(null)
  }

  const onCancel = () => {
    setArmed(null)
    setError(null)
  }

  const onConfirm = async () => {
    if (armed === null) return
    setPending(armed)
    setError(null)
    try {
      const result = await setStatus({
        data: { winId: win.id, to: targetStatus(armed) },
      })
      if (!result.ok) {
        setError(formatStatusError(result.error))
        return
      }
      setArmed(null)
      await router.invalidate()
    } finally {
      setPending(null)
    }
  }

  const onSaveNotes = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setPending('notes')
    setError(null)
    try {
      const result = await updateNotes({
        data: { winId: win.id, notes: notes.length === 0 ? null : notes },
      })
      if (!result.ok) {
        setError(formatStatusError(result.error))
        return
      }
      await router.invalidate()
    } finally {
      setPending(null)
    }
  }

  const actions = allowedActionsFrom(win.status)

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          to="/mod/g/$slug"
          params={{ slug: win.giveaway.groupSlug }}
          className="text-sm text-blue-700 hover:underline"
        >
          ← Pending past deadline
        </Link>
        <h1 className="text-2xl font-bold">{win.giveaway.target.name}</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <StatusBadge status={win.status} />
          <span>·</span>
          <Link
            to="/u/$username"
            params={{ username: win.user.steamgiftsUsername }}
            className="text-blue-700 hover:underline"
          >
            {win.user.steamgiftsUsername}
          </Link>
          <MembershipBadge status={membershipStatus} groupName={win.giveaway.groupName} />
          <span>·</span>
          <Link
            to="/g/$slug/giveaways/$code"
            params={{
              slug: win.giveaway.groupSlug,
              code: win.giveaway.steamgiftsCode,
            }}
            className="text-blue-700 hover:underline"
          >
            Giveaway
          </Link>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-neutral-500">Won</dt>
          <dd>{dateTimeFormat.format(win.wonAt)}</dd>
          <dt className="text-neutral-500">Deadline</dt>
          <dd>{dateTimeFormat.format(win.playDeadline)}</dd>
          <dt className="text-neutral-500">Resolved</dt>
          <dd>{win.resolvedAt ? dateTimeFormat.format(win.resolvedAt) : '—'}</dd>
          <dt className="text-neutral-500">Playtime baseline</dt>
          <dd>{renderPlaytimeCell(win.playtimeAtWinMinutes)}</dd>
          <dt className="text-neutral-500">Playtime current</dt>
          <dd>{renderPlaytimeCell(win.currentPlaytimeMinutes)}</dd>
          <dt className="text-neutral-500">Last 2 weeks</dt>
          <dd>{renderPlaytimeCell(win.playtime2WeeksMinutes)}</dd>
          <dt className="text-neutral-500">Achievements</dt>
          <dd>{renderAchievements(win, { showAltLinks: true })}</dd>
        </dl>
      </header>

      {error ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Status</h2>
        {actions.length === 0 ? (
          <p className="text-sm text-neutral-600">No transitions available.</p>
        ) : armed !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-neutral-800">{ACTION_PROMPTS[armed]}</span>
            <button
              type="button"
              disabled={pending !== null}
              onClick={onConfirm}
              className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${ACTION_STYLES[armed]}`}
            >
              {pending === armed ? 'Working…' : 'Yes'}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={onCancel}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                disabled={pending !== null}
                onClick={() => onArm(a)}
                className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${ACTION_STYLES[a]}`}
              >
                {ACTION_LABELS[a]}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        <form onSubmit={onSaveNotes} className="space-y-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Internal notes, reminders, links…"
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={pending !== null}
            className="rounded bg-surface-strong px-3 py-1.5 text-sm font-medium text-content-on-strong disabled:opacity-50"
          >
            {pending === 'notes' ? 'Saving…' : 'Save notes'}
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Audit log</h2>
        <AuditLogList entries={auditEntries} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Game activity</h2>
        <PlaytimeAchievementsChart observations={observations} unlocks={achievementUnlocks} />
        <GameActivityFeed observations={observations} unlocks={achievementUnlocks} />
      </section>
    </div>
  )
}

function AuditLogList({ entries }: { readonly entries: ReadonlyArray<WinAuditEntry> }) {
  if (entries.length === 0) {
    return <p className="text-sm text-neutral-600">No audit entries.</p>
  }
  return (
    <ol className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface text-sm">
      {entries.map((entry, idx) => (
        <li key={entry.ok ? entry.value.id : entry.error.id} className="px-3 py-2">
          {entry.ok ? <AuditEntryRow entry={entry.value} /> : <AuditEntryError id={idx} />}
        </li>
      ))}
    </ol>
  )
}

function AuditEntryError({ id }: { readonly id: number }) {
  return <span className="text-rose-700">Unparseable audit entry #{id}</span>
}

const renderPlaytimeCell = (m: number | null) => {
  if (m === null) return <span className="text-neutral-400">—</span>
  return <span title={formatPlaytimePrecise(m)}>{formatPlaytimeCompact(m)}</span>
}

function MembershipBadge({
  status,
  groupName,
}: {
  readonly status: MembershipStatusView | null
  readonly groupName: string
}) {
  if (status?.inGroup) {
    return (
      <>
        <span>·</span>
        <span className="text-emerald-700">
          In {groupName} · last checked <LocalDate date={status.lastSeenAt} />
        </span>
      </>
    )
  }
  if (status) {
    return (
      <>
        <span>·</span>
        <span className="text-rose-700">
          Left {groupName} {status.leftAt ? <LocalDate date={status.leftAt} /> : '—'}
        </span>
      </>
    )
  }
  return (
    <>
      <span>·</span>
      <span className="text-rose-700">Not in {groupName}</span>
    </>
  )
}
