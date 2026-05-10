import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'

import { ModSubNav } from '#/components/ModSubNav'
import { Pagination } from '#/components/Pagination'
import { describeAuditEvent } from '#/components/AuditEntryRow'
import type { AuditAction, AuditTargetType } from '#/db/schema'
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '#/db/schema'
import { isMod } from '#/domain/roles'
import { fetchAuditLogPage, fetchModSession } from '#/server/modFns'
import type { AuditEntry, AuditEntryRead } from '#/repos/auditLog'

const SearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  q: z.string().trim().min(1).max(64).optional(),
})

type Search = z.infer<typeof SearchSchema>

export const Route = createFileRoute('/mod/audit')({
  validateSearch: (search: Record<string, unknown>) => SearchSchema.parse(search),
  beforeLoad: async () => {
    const { user } = await fetchModSession()
    if (!isMod(user)) throw redirect({ to: '/login' })
  },
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    action: search.action,
    targetType: search.targetType,
    q: search.q,
  }),
  loader: async ({ deps }) =>
    fetchAuditLogPage({
      data: {
        page: deps.page,
        ...(deps.action ? { action: deps.action } : {}),
        ...(deps.targetType ? { targetType: deps.targetType } : {}),
        ...(deps.q ? { actorQuery: deps.q } : {}),
      },
    }),
  component: ModAuditPage,
})

const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

const ACTION_FAMILY: Readonly<Record<AuditAction, 'win' | 'group' | 'role' | 'cookie'>> = {
  win_created: 'win',
  win_status_changed: 'win',
  win_notes_updated: 'win',
  group_created: 'group',
  group_updated: 'group',
  giveaway_created: 'group',
  giveaway_deleted: 'group',
  role_granted: 'role',
  role_revoked: 'role',
  cookie_set: 'cookie',
  cookie_cleared: 'cookie',
  cookie_tested: 'cookie',
}

const ACTION_BADGE: Readonly<Record<'win' | 'group' | 'role' | 'cookie', string>> = {
  win: 'bg-sky-100 text-sky-800 ring-sky-200',
  group: 'bg-violet-100 text-violet-800 ring-violet-200',
  role: 'bg-amber-100 text-amber-800 ring-amber-200',
  cookie: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
}

const ACTION_LABEL: Readonly<Record<AuditAction, string>> = {
  win_created: 'win created',
  win_status_changed: 'win status',
  win_notes_updated: 'win notes',
  group_created: 'group created',
  group_updated: 'group updated',
  giveaway_created: 'giveaway created',
  giveaway_deleted: 'giveaway deleted',
  role_granted: 'role granted',
  role_revoked: 'role revoked',
  cookie_set: 'cookie set',
  cookie_cleared: 'cookie cleared',
  cookie_tested: 'cookie tested',
}

const TARGET_LABEL: Readonly<Record<AuditTargetType, string>> = {
  win: 'win',
  group: 'group',
  user: 'user',
  giveaway: 'giveaway',
}

const ACTION_GROUPS: ReadonlyArray<{
  readonly family: 'win' | 'group' | 'role'
  readonly label: string
  readonly actions: ReadonlyArray<AuditAction>
}> = [
  {
    family: 'win',
    label: 'Wins',
    actions: ['win_created', 'win_status_changed', 'win_notes_updated'],
  },
  { family: 'group', label: 'Groups', actions: ['group_created', 'group_updated'] },
  { family: 'role', label: 'Roles', actions: ['role_granted', 'role_revoked'] },
]

function ModAuditPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const router = useRouter()
  const [query, setQuery] = useState(search.q ?? '')

  const navigateTo = (next: Search) => {
    void router.navigate({ to: '/mod/audit', search: next })
  }

  const onSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = query.trim()
    const { q: _q, page: _page, ...rest } = search
    navigateTo(trimmed.length === 0 ? rest : { ...rest, q: trimmed })
  }

  const setAction = (action: AuditAction | undefined) => {
    const { action: _a, page: _page, ...rest } = search
    navigateTo(action === undefined ? rest : { ...rest, action })
  }

  const setTargetType = (targetType: AuditTargetType | undefined) => {
    const { targetType: _t, page: _page, ...rest } = search
    navigateTo(targetType === undefined ? rest : { ...rest, targetType })
  }

  const hasFilters =
    search.action !== undefined || search.targetType !== undefined || search.q !== undefined

  return (
    <div className="space-y-6">
      <ModSubNav active="audit" />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Audit log</h1>
        <p className="text-sm text-neutral-600">
          Every moderation action and role change. Times are UTC.
        </p>
      </header>

      <div className="space-y-3 rounded border border-neutral-200 bg-surface p-4">
        <div className="flex flex-wrap items-end gap-4">
          <form onSubmit={onSearch} className="flex items-end gap-2">
            <label className="block">
              <span className="text-xs font-medium text-neutral-600">Actor</span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="username"
                className="mt-1 w-56 rounded border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded bg-surface-strong px-3 py-1.5 text-sm font-medium text-content-on-strong"
            >
              Search
            </button>
          </form>

          <div>
            <span className="block text-xs font-medium text-neutral-600">Target</span>
            <div className="mt-1 flex items-center gap-1">
              <FilterPill
                active={search.targetType === undefined}
                onClick={() => setTargetType(undefined)}
              >
                all
              </FilterPill>
              {AUDIT_TARGET_TYPES.map((t) => (
                <FilterPill
                  key={t}
                  active={search.targetType === t}
                  onClick={() => setTargetType(t)}
                >
                  {TARGET_LABEL[t]}
                </FilterPill>
              ))}
            </div>
          </div>

          {hasFilters ? (
            <Link
              to="/mod/audit"
              search={{}}
              className="self-end text-xs text-neutral-600 underline-offset-2 hover:underline"
            >
              Reset filters
            </Link>
          ) : null}
        </div>

        <div>
          <span className="block text-xs font-medium text-neutral-600">Action</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <FilterPill active={search.action === undefined} onClick={() => setAction(undefined)}>
              all
            </FilterPill>
            {ACTION_GROUPS.map((group) => (
              <div
                key={group.family}
                className="flex items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-1"
              >
                <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  {group.label}
                </span>
                {group.actions.map((a) => (
                  <FilterPill key={a} active={search.action === a} onClick={() => setAction(a)}>
                    {ACTION_LABEL[a].replace(/^[a-z]+\s/, '')}
                  </FilterPill>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-neutral-200 bg-surface">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {data.rows.map((entry) => (
              <AuditRow key={entryKey(entry)} entry={entry} />
            ))}
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-neutral-500">
                  No audit entries match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        hrefForPage={(page) => ({
          to: '/mod/audit',
          search: { ...search, page },
        })}
      />
    </div>
  )
}

const entryKey = (entry: AuditEntryRead): string =>
  entry.ok ? `e-${String(entry.value.id)}` : `err-${String(entry.error.id)}`

function FilterPill({
  active,
  onClick,
  children,
}: {
  readonly active: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs ${
        active
          ? 'border-neutral-900 bg-surface-strong text-content-on-strong'
          : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
      }`}
    >
      {children}
    </button>
  )
}

function AuditRow({ entry }: { readonly entry: AuditEntryRead }) {
  if (!entry.ok) {
    return (
      <tr className="bg-rose-50/40">
        <td colSpan={5} className="px-3 py-2 text-xs text-rose-800">
          Entry #{entry.error.id} could not be parsed ({entry.error.cause.kind}).
        </td>
      </tr>
    )
  }
  const e = entry.value
  const family = ACTION_FAMILY[actionFromEvent(e.event)]
  return (
    <tr>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
        {dateTimeFormat.format(e.createdAt)}
      </td>
      <td className="px-3 py-2">
        <ActorCell actor={e.actor} />
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ACTION_BADGE[family]}`}
        >
          {ACTION_LABEL[actionFromEvent(e.event)]}
        </span>
      </td>
      <td className="px-3 py-2">
        <TargetCell targetType={e.targetType} targetId={e.targetId} />
      </td>
      <td className="px-3 py-2 text-neutral-700">{describeAuditEvent(e.event)}</td>
    </tr>
  )
}

const actionFromEvent = (event: AuditEntry['event']): AuditAction => event.kind

function ActorCell({ actor }: { readonly actor: AuditEntry['actor'] }) {
  if (actor === null) return <span className="text-neutral-500">system</span>
  if (actor.steamgiftsUsername !== null) {
    return (
      <Link
        to="/u/$username"
        params={{ username: actor.steamgiftsUsername }}
        className="text-blue-700 hover:underline"
      >
        {actor.steamgiftsUsername}
      </Link>
    )
  }
  if (actor.steamId !== null) {
    return (
      <Link
        to="/u/steam/$steamId"
        params={{ steamId: actor.steamId }}
        className="font-mono text-xs text-blue-700 hover:underline"
      >
        steam:{actor.steamId}
      </Link>
    )
  }
  return <span className="text-neutral-500">#{actor.id}</span>
}

function TargetCell({
  targetType,
  targetId,
}: {
  readonly targetType: AuditTargetType
  readonly targetId: number
}) {
  if (targetType === 'win') {
    return (
      <Link
        to="/mod/wins/$winId"
        params={{ winId: String(targetId) }}
        className="text-blue-700 hover:underline"
      >
        win #{targetId}
      </Link>
    )
  }
  return (
    <span className="text-neutral-700">
      {TARGET_LABEL[targetType]} #{targetId}
    </span>
  )
}
