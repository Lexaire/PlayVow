import { createFileRoute, getRouteApi, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'

import { SteamIcon } from '#/components/BrandIcons'
import { Pagination } from '#/components/Pagination'
import { UserCreatedGiveawaysTable } from '#/components/UserCreatedGiveawaysTable'
import { WinsTable } from '#/components/WinsTable'
import { isMod } from '#/domain/roles'
import { steamAssetUrl } from '#/lib/steam-assets'
import { fetchSubPage } from '#/server/publicFns'

const rootApi = getRouteApi('__root__')

type SubTabKey = 'wins' | 'giveaways'

const PositivePage = z.coerce.number().int().min(1).optional()
const SearchSchema = z.object({
  tab: z.enum(['wins', 'giveaways']).optional(),
  winsPage: PositivePage,
  giveawaysPage: PositivePage,
})

const ParamsSchema = z.object({ subId: z.string().regex(/^\d+$/) })

export const Route = createFileRoute('/sub/$subId')({
  parseParams: (raw) => ParamsSchema.parse(raw),
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({
    winsPage: search.winsPage,
    giveawaysPage: search.giveawaysPage,
  }),
  loader: async ({ params, deps }) => {
    const data = await fetchSubPage({
      data: {
        subId: Number(params.subId),
        ...(deps.winsPage !== undefined && { winsPage: deps.winsPage }),
        ...(deps.giveawaysPage !== undefined && { giveawaysPage: deps.giveawaysPage }),
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: SubPage,
})

function SubPage() {
  const { sub, wins, giveaways } = Route.useLoaderData()
  const { currentUser } = rootApi.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/sub/$subId' })
  const userIsMod = isMod(currentUser)
  const [capsuleFailed, setCapsuleFailed] = useState(false)
  const activeTab: SubTabKey = search.tab ?? 'wins'

  const capsuleUrl = steamAssetUrl(sub.assetUrlFormat, sub.assetMainCapsule, {
    kind: 'sub',
    id: sub.subId,
    filename: 'capsule_616x353.jpg',
  })
  const steamUrl = `https://store.steampowered.com/sub/${String(sub.subId)}/`

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {capsuleUrl && !capsuleFailed ? (
          <img
            src={capsuleUrl}
            alt={sub.name}
            width={616}
            height={353}
            onError={() => setCapsuleFailed(true)}
            className="h-auto w-full max-w-123 rounded"
          />
        ) : null}
        <h1 className="text-2xl font-bold">
          {sub.name}
          <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium uppercase text-violet-900">
            sub
          </span>
        </h1>
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

      <SubTabs
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
          <WinsTable wins={wins.rows} showGame={false} canViewModWin={userIsMod} />
          <Pagination
            page={wins.page}
            pageSize={wins.pageSize}
            total={wins.total}
            hrefForPage={(p) =>
              ({
                to: '/sub/$subId',
                params: { subId: String(sub.subId) },
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
            <p className="text-sm text-neutral-600">No giveaways for this sub yet.</p>
          ) : (
            <UserCreatedGiveawaysTable giveaways={giveaways.rows} />
          )}
          <Pagination
            page={giveaways.page}
            pageSize={giveaways.pageSize}
            total={giveaways.total}
            hrefForPage={(p) =>
              ({
                to: '/sub/$subId',
                params: { subId: String(sub.subId) },
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

function SubTabs({
  active,
  winsTotal,
  giveawaysTotal,
  onSelect,
}: {
  readonly active: SubTabKey
  readonly winsTotal: number
  readonly giveawaysTotal: number
  readonly onSelect: (tab: SubTabKey) => void
}) {
  const tabs: ReadonlyArray<{ readonly key: SubTabKey; readonly label: string; readonly count: number }> = [
    { key: 'wins', label: 'Wins', count: winsTotal },
    { key: 'giveaways', label: 'Giveaways', count: giveawaysTotal },
  ]
  return (
    <div role="tablist" aria-label="Sub sections" className="flex gap-1 border-b border-neutral-200">
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
