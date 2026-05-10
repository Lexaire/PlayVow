import { createFileRoute, getRouteApi, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'

import { SteamIcon } from '#/components/BrandIcons'
import { Pagination } from '#/components/Pagination'
import { UserCreatedGiveawaysTable } from '#/components/UserCreatedGiveawaysTable'
import { WinsTable } from '#/components/WinsTable'
import { isModForGroup } from '#/domain/roles'
import { steamAssetUrl } from '#/lib/steam-assets'
import { fetchGamePage } from '#/server/publicFns'

const rootApi = getRouteApi('__root__')

type GameTabKey = 'wins' | 'giveaways'

// `tab` defaults to 'wins' (omitted in the URL on the default tab so links
// stay clean). `winsPage` and `giveawaysPage` are independent so flipping
// tabs preserves the other panel's pagination.
const PositivePage = z.coerce.number().int().min(1).optional()
const SearchSchema = z.object({
  tab: z.enum(['wins', 'giveaways']).optional(),
  winsPage: PositivePage,
  giveawaysPage: PositivePage,
})

const ParamsSchema = z.object({ appId: z.string().regex(/^\d+$/) })

export const Route = createFileRoute('/app/$appId')({
  parseParams: (raw) => ParamsSchema.parse(raw),
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({
    winsPage: search.winsPage,
    giveawaysPage: search.giveawaysPage,
  }),
  loader: async ({ params, deps }) => {
    const data = await fetchGamePage({
      data: {
        appId: Number(params.appId),
        ...(deps.winsPage !== undefined && { winsPage: deps.winsPage }),
        ...(deps.giveawaysPage !== undefined && { giveawaysPage: deps.giveawaysPage }),
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: GamePage,
})

function GamePage() {
  const { app, wins, giveaways, commonByWinId } = Route.useLoaderData()
  const commonMap = new Map(commonByWinId)
  const { currentUser, moderatedGroupIds } = rootApi.useLoaderData()
  const moderatedSet = new Set(moderatedGroupIds)
  // Cross-group page: each row's win belongs to a different group, so the
  // mod-link predicate is per-row.
  const canViewModWin = (groupId: number) => isModForGroup(currentUser, groupId, moderatedSet)
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/app/$appId' })
  const [capsuleFailed, setCapsuleFailed] = useState(false)
  const activeTab: GameTabKey = search.tab ?? 'wins'

  const capsuleUrl = steamAssetUrl(app.assetUrlFormat, app.assetMainCapsule, {
    kind: 'app',
    id: app.appId,
    filename: 'capsule_616x353.jpg',
  })
  const steamUrl = `https://store.steampowered.com/app/${String(app.appId)}/`

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {capsuleUrl && !capsuleFailed ? (
          <img
            src={capsuleUrl}
            alt={app.name}
            width={616}
            height={353}
            onError={() => setCapsuleFailed(true)}
            className="h-auto w-full max-w-123 rounded"
          />
        ) : null}
        <h1 className="text-2xl font-bold">{app.name}</h1>
        <div className="flex gap-3 text-sm">
          <a
            href={steamUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-blue-700 hover:underline"
          >
            <SteamIcon />
            Steam Store ↗
          </a>
        </div>
      </header>

      <GameTabs
        active={activeTab}
        winsTotal={wins.total}
        giveawaysTotal={giveaways.total}
        onSelect={(tab) => {
          void navigate({
            search: (prev) => ({ ...prev, tab: tab === 'wins' ? undefined : tab }),
          })
        }}
      />

      {activeTab === 'wins' ? (
        <section className="space-y-3">
          <WinsTable
            wins={wins.rows}
            showGame={false}
            canViewModWin={canViewModWin}
            commonByWinId={commonMap}
          />
          <Pagination
            page={wins.page}
            pageSize={wins.pageSize}
            total={wins.total}
            hrefForPage={(p) =>
              ({
                to: '/app/$appId',
                params: { appId: String(app.appId) },
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  winsPage: p === 1 ? undefined : p,
                }),
              }) as const
            }
          />
        </section>
      ) : (
        <section className="space-y-3">
          {giveaways.rows.length === 0 ? (
            <p className="text-sm text-neutral-600">No giveaways for this game yet.</p>
          ) : (
            <UserCreatedGiveawaysTable giveaways={giveaways.rows} />
          )}
          <Pagination
            page={giveaways.page}
            pageSize={giveaways.pageSize}
            total={giveaways.total}
            hrefForPage={(p) =>
              ({
                to: '/app/$appId',
                params: { appId: String(app.appId) },
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  giveawaysPage: p === 1 ? undefined : p,
                }),
              }) as const
            }
          />
        </section>
      )}
    </div>
  )
}

// Local tab strip — mirrors the styling of ProfileTabs but with game-page
// labels and counts. Hoisting this into a shared component is premature
// while only two pages have tabs; revisit if a third lands.
function GameTabs({
  active,
  winsTotal,
  giveawaysTotal,
  onSelect,
}: {
  readonly active: GameTabKey
  readonly winsTotal: number
  readonly giveawaysTotal: number
  readonly onSelect: (tab: GameTabKey) => void
}) {
  const tabs: ReadonlyArray<{ readonly key: GameTabKey; readonly label: string; readonly count: number }> = [
    { key: 'wins', label: 'Wins', count: winsTotal },
    { key: 'giveaways', label: 'Giveaways', count: giveawaysTotal },
  ]
  return (
    <div role="tablist" aria-label="Game sections" className="flex gap-1 border-b border-neutral-200">
      {tabs.map((t) => {
        const isActive = active === t.key
        return (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onSelect(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'border-emerald-700 text-emerald-800'
                : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-xs font-normal text-neutral-500">({t.count})</span>
          </button>
        )
      })}
    </div>
  )
}
