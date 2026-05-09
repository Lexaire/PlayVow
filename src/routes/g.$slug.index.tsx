import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { GiveawaysTable } from '#/components/GiveawaysTable'
import { GroupActivityFeed } from '#/components/GroupActivityFeed'
import { GroupHeader } from '#/components/GroupHeader'
import { Pagination } from '#/components/Pagination'
import { fetchGroupOverviewPage } from '#/server/publicFns'

// `ip` paginates the In-progress section; `page` paginates the activity feed.
// Both are independent so users can advance one without resetting the other.
const PositivePage = z.coerce.number().int().min(1).optional()
const SearchSchema = z.object({
  ip: PositivePage,
  page: PositivePage,
})

export const Route = createFileRoute('/g/$slug/')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({
    inProgressPage: search.ip ?? 1,
    feedPage: search.page ?? 1,
  }),
  loader: async ({ params, deps }) => {
    const data = await fetchGroupOverviewPage({
      data: {
        slug: params.slug,
        inProgressPage: deps.inProgressPage,
        feedPage: deps.feedPage,
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: GroupOverviewPage,
})

function GroupOverviewPage() {
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
                to: '/g/$slug',
                params: { slug: group.slug },
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
              to: '/g/$slug',
              params: { slug: group.slug },
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
