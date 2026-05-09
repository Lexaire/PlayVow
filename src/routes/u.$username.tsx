import { Link, createFileRoute, getRouteApi, notFound, useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { z } from 'zod'

import { BulkStatusBar } from '#/components/BulkStatusBar'
import { Pagination } from '#/components/Pagination'
import { SignOutButton } from '#/components/SignOutButton'
import { ProfileTabs, type ProfileTabKey } from '#/components/Tabs'
import { ThemeToggle } from '#/components/ThemeToggle'
import { UserCreatedGiveawaysTable } from '#/components/UserCreatedGiveawaysTable'
import { WinsTable, type WinsTableSelection } from '#/components/WinsTable'
import type { WinStatus } from '#/db/schema'
import { WIN_STATUSES } from '#/db/schema'
import { isMod } from '#/domain/roles'
import { fetchUserPageByUsername } from '#/server/publicFns'
import type { CreatorStats, Page, UserCreatedGiveawayView, WinView } from '#/server/queries'

const rootApi = getRouteApi('__root__')

// Each status section paginates independently. URL params for the "My wins"
// tab use the bare status name (`?pending=2&played=3`); the "My giveaways" tab
// uses a `c_` prefix to namespace its wins-on-created status sections
// (`?c_pending=2`), with `c_no_winners` for the giveaways-without-winners
// section. `tab` selects the active tab; defaults to `wins`. All omitted on
// page 1.
const PositivePage = z.coerce.number().int().min(1).optional()
const SearchSchema = z.object({
  tab: z.enum(['wins', 'giveaways']).optional(),
  pending: PositivePage,
  played: PositivePage,
  kicked: PositivePage,
  not_in_group: PositivePage,
  exempt: PositivePage,
  c_pending: PositivePage,
  c_played: PositivePage,
  c_kicked: PositivePage,
  c_not_in_group: PositivePage,
  c_exempt: PositivePage,
  c_no_winners: PositivePage,
})

export const Route = createFileRoute('/u/$username')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({
    winsPages: {
      pending: search.pending,
      played: search.played,
      kicked: search.kicked,
      not_in_group: search.not_in_group,
      exempt: search.exempt,
    },
    createdWinsPages: {
      pending: search.c_pending,
      played: search.c_played,
      kicked: search.c_kicked,
      not_in_group: search.c_not_in_group,
      exempt: search.c_exempt,
    },
    noWinnersPage: search.c_no_winners,
  }),
  loader: async ({ params, deps }) => {
    const data = await fetchUserPageByUsername({
      data: {
        username: params.username,
        winsPages: deps.winsPages,
        createdWinsPages: deps.createdWinsPages,
        noWinnersPage: deps.noWinnersPage,
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: UserPage,
})

const STATUS_HEADINGS: Readonly<Record<WinStatus, string>> = {
  pending: 'Pending',
  played: 'Played',
  kicked: 'Kicked',
  not_in_group: 'Not in group',
  exempt: 'Exempt',
}

const CREATED_WINS_PARAM: Readonly<
  Record<WinStatus, 'c_pending' | 'c_played' | 'c_kicked' | 'c_not_in_group' | 'c_exempt'>
> = {
  pending: 'c_pending',
  played: 'c_played',
  kicked: 'c_kicked',
  not_in_group: 'c_not_in_group',
  exempt: 'c_exempt',
}

function UserPage() {
  const {
    user,
    winsByStatus,
    winsOnCreatedByStatus,
    noWinnersGiveaways,
    creatorStats,
    groupMemberships,
  } = Route.useLoaderData()
  const { currentUser } = rootApi.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/u/$username' })
  const isOwnProfile = currentUser?.id === user.id
  const canEditStatus = isMod(currentUser ?? null)
  const totalWins = WIN_STATUSES.reduce((acc, s) => acc + winsByStatus[s].total, 0)
  const activeTab: ProfileTabKey = search.tab ?? 'wins'

  const visibleStatusById = useMemo(() => {
    const m = new Map<number, WinStatus>()
    for (const s of WIN_STATUSES) {
      for (const w of winsByStatus[s].rows) m.set(w.id, w.status)
      for (const w of winsOnCreatedByStatus[s].rows) m.set(w.id, w.status)
    }
    return m
  }, [winsByStatus, winsOnCreatedByStatus])

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set())

  const onToggle = useCallback((winId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(winId)) next.delete(winId)
      else next.add(winId)
      return next
    })
  }, [])

  const onToggleAll = useCallback((winIds: ReadonlyArray<number>, select: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (select) for (const id of winIds) next.add(id)
      else for (const id of winIds) next.delete(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const selection: WinsTableSelection | undefined = canEditStatus
    ? { selectedIds, onToggle, onToggleAll }
    : undefined

  const sourceStatuses = useMemo(() => {
    const s = new Set<WinStatus>()
    for (const id of selectedIds) {
      const status = visibleStatusById.get(id)
      if (status) s.add(status)
    }
    return s
  }, [selectedIds, visibleStatusById])

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="h-12 w-12 rounded border border-neutral-200"
          />
        ) : null}
        <div className="flex-1 space-y-1">
          <h1 className="text-2xl font-bold">{user.steamgiftsUsername}</h1>
          <p className="text-xs text-neutral-500">
            Steam ID {user.steamId ?? '—'} · {totalWins} wins
            {creatorStats.total > 0
              ? ` · ${String(creatorStats.total)} giveaways created · ${String(
                  creatorStats.keysGiven,
                )} keys given`
              : null}
          </p>
          {groupMemberships.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
              {groupMemberships.map((m) => (
                <Link
                  key={m.groupSlug}
                  to="/g/$slug"
                  params={{ slug: m.groupSlug }}
                  className="text-blue-700 hover:underline"
                >
                  {m.groupName}
                </Link>
              ))}
            </div>
          ) : null}
          <div className="flex gap-3 text-sm">
            <a
              href={`https://www.steamgifts.com/user/${user.steamgiftsUsername}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-700 hover:underline"
            >
              SteamGifts ↗
            </a>
            {user.steamId ? (
              <a
                href={`https://steamcommunity.com/profiles/${user.steamId}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 hover:underline"
              >
                Steam ↗
              </a>
            ) : null}
          </div>
        </div>
        {isOwnProfile ? (
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton />
          </div>
        ) : null}
      </header>
      <ProfileTabs
        active={activeTab}
        onSelect={(tab) => {
          void navigate({
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              tab: tab === 'wins' ? undefined : tab,
            }),
          })
        }}
        counts={{ wins: totalWins, giveaways: creatorStats.total }}
      />
      {activeTab === 'wins' ? (
        <MyWinsPanel
          winsByStatus={winsByStatus}
          username={user.steamgiftsUsername}
          canEditStatus={canEditStatus}
          selection={selection}
        />
      ) : (
        <MyGiveawaysPanel
          winsOnCreatedByStatus={winsOnCreatedByStatus}
          noWinnersGiveaways={noWinnersGiveaways}
          creatorStats={creatorStats}
          username={user.steamgiftsUsername}
          canEditStatus={canEditStatus}
          selection={selection}
        />
      )}
      {canEditStatus ? (
        <BulkStatusBar
          selectedIds={selectedIds}
          sourceStatuses={sourceStatuses}
          onClear={clearSelection}
          onApplied={clearSelection}
        />
      ) : null}
    </div>
  )
}

function MyWinsPanel({
  winsByStatus,
  username,
  canEditStatus,
  selection,
}: {
  readonly winsByStatus: Readonly<Record<WinStatus, Page<WinView>>>
  readonly username: string
  readonly canEditStatus: boolean
  readonly selection?: WinsTableSelection | undefined
}) {
  return (
    <div className="space-y-6">
      {WIN_STATUSES.map((status) => {
        const page = winsByStatus[status]
        if (page.total === 0) return null
        return (
          <section key={status} className="space-y-3">
            <h2 className="text-lg font-semibold">
              {STATUS_HEADINGS[status]}{' '}
              <span className="text-sm font-normal text-neutral-500">({page.total})</span>
            </h2>
            <WinsTable
              wins={page.rows}
              showWinner={false}
              canEditStatus={canEditStatus}
              selection={selection}
            />
            <Pagination
              page={page.page}
              pageSize={page.pageSize}
              total={page.total}
              hrefForPage={(p) =>
                ({
                  to: '/u/$username',
                  params: { username },
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    [status]: p === 1 ? undefined : p,
                  }),
                }) as const
              }
            />
          </section>
        )
      })}
    </div>
  )
}

function MyGiveawaysPanel({
  winsOnCreatedByStatus,
  noWinnersGiveaways,
  creatorStats,
  username,
  canEditStatus,
  selection,
}: {
  readonly winsOnCreatedByStatus: Readonly<Record<WinStatus, Page<WinView>>>
  readonly noWinnersGiveaways: Page<UserCreatedGiveawayView>
  readonly creatorStats: CreatorStats
  readonly username: string
  readonly canEditStatus: boolean
  readonly selection?: WinsTableSelection | undefined
}) {
  if (creatorStats.total === 0) {
    return <p className="text-sm text-neutral-600">No giveaways created.</p>
  }
  return (
    <div className="space-y-6">
      {WIN_STATUSES.map((status) => {
        const page = winsOnCreatedByStatus[status]
        if (page.total === 0) return null
        const param = CREATED_WINS_PARAM[status]
        return (
          <section key={status} className="space-y-3">
            <h2 className="text-lg font-semibold">
              {STATUS_HEADINGS[status]}{' '}
              <span className="text-sm font-normal text-neutral-500">({page.total})</span>
            </h2>
            <WinsTable
              wins={page.rows}
              showWinner={true}
              canEditStatus={canEditStatus}
              selection={selection}
            />
            <Pagination
              page={page.page}
              pageSize={page.pageSize}
              total={page.total}
              hrefForPage={(p) =>
                ({
                  to: '/u/$username',
                  params: { username },
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    [param]: p === 1 ? undefined : p,
                  }),
                }) as const
              }
            />
          </section>
        )
      })}
      {noWinnersGiveaways.total > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            No winners{' '}
            <span className="text-sm font-normal text-neutral-500">
              ({noWinnersGiveaways.total})
            </span>
          </h2>
          <UserCreatedGiveawaysTable giveaways={noWinnersGiveaways.rows} />
          <Pagination
            page={noWinnersGiveaways.page}
            pageSize={noWinnersGiveaways.pageSize}
            total={noWinnersGiveaways.total}
            hrefForPage={(p) =>
              ({
                to: '/u/$username',
                params: { username },
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  c_no_winners: p === 1 ? undefined : p,
                }),
              }) as const
            }
          />
        </section>
      ) : null}
    </div>
  )
}
