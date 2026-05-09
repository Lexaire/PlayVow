import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { ModSubNav } from '#/components/ModSubNav'
import { isMod } from '#/domain/roles'
import { fetchGroupSummaries } from '#/server/publicFns'
import { fetchModSession } from '#/server/modFns'

export const Route = createFileRoute('/mod/')({
  beforeLoad: async () => {
    const { user } = await fetchModSession()
    if (!isMod(user)) throw redirect({ to: '/login' })
  },
  loader: async () => {
    const groups = await fetchGroupSummaries()
    return { groups }
  },
  component: ModIndex,
})

function ModIndex() {
  const { groups } = Route.useLoaderData()

  return (
    <div className="space-y-6">
      <ModSubNav active="queue" />
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Groups</h2>
        {groups.length === 0 ? (
          <p className="text-sm text-neutral-600">No groups.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface">
            {groups.map((g) => (
              <li key={g.id}>
                <Link
                  to="/mod/g/$slug"
                  params={{ slug: g.slug }}
                  className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50"
                >
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-neutral-500">All pending →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
