import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { GiveawaysTable } from '#/components/GiveawaysTable'
import { GroupActivityFeed } from '#/components/GroupActivityFeed'
import { GroupHeader } from '#/components/GroupHeader'
import { Pagination } from '#/components/Pagination'
import { fetchGroupOverviewPage } from '#/server/publicFns'

// Only one group exists today, so the home page renders Tale Play's overview
// inline. When a second group ships, restore the listing below and move group
// discovery to /groups.
const FEATURED_SLUG = 'taleplay'

const PositivePage = z.coerce.number().int().min(1).optional()
const SearchSchema = z.object({
  ip: PositivePage,
  page: PositivePage,
})

export const Route = createFileRoute('/')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({
    inProgressPage: search.ip ?? 1,
    feedPage: search.page ?? 1,
  }),
  loader: async ({ deps }) => {
    const data = await fetchGroupOverviewPage({
      data: {
        slug: FEATURED_SLUG,
        inProgressPage: deps.inProgressPage,
        feedPage: deps.feedPage,
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: Home,
})

function Home() {
  const { group, inProgress, feed } = Route.useLoaderData()
  return (
    <div className="space-y-6">
      <GroupHeader group={group} />
      {inProgress.total > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            In progress{' '}
            <span className="text-sm font-normal text-neutral-500">
              ({String(inProgress.total)})
            </span>
          </h2>
          <GiveawaysTable giveaways={inProgress.rows} groupSlug={group.slug} />
          <Pagination
            page={inProgress.page}
            pageSize={inProgress.pageSize}
            total={inProgress.total}
            hrefForPage={(p) =>
              ({
                to: '/',
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  ip: p === 1 ? undefined : p,
                }),
              }) as const
            }
          />
        </section>
      ) : null}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Activity{' '}
          <span className="text-sm font-normal text-neutral-500">({String(feed.total)})</span>
        </h2>
        <GroupActivityFeed rows={feed.rows} groupSlug={group.slug} />
        <Pagination
          page={feed.page}
          pageSize={feed.pageSize}
          total={feed.total}
          hrefForPage={(p) =>
            ({
              to: '/',
              search: (prev: Record<string, unknown>) => ({
                ...prev,
                page: p === 1 ? undefined : p,
              }),
            }) as const
          }
        />
      </section>
    </div>
  )
}
