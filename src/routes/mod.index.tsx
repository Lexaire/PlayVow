import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { ModSubNav } from '#/components/ModSubNav'
import { isAnyMod } from '#/domain/roles'
import { fetchGroupSummaries } from '#/server/publicFns'
import { fetchModSession } from '#/server/modFns'

export const Route = createFileRoute('/mod/')({
  beforeLoad: async () => {
    const { user, moderatedGroupIds } = await fetchModSession()
    // Admin satisfies "any mod"; non-admin needs at least one row in
    // group_moderators. moderatedGroupIds is empty for admins (we don't
    // populate it on that path), so isAnyMod short-circuits on role.
    if (!isAnyMod(user, new Set(moderatedGroupIds))) {
      throw redirect({ to: '/login' })
    }
  },
  loader: async () => {
    const [{ user, moderatedGroupIds }, groups] = await Promise.all([
      fetchModSession(),
      fetchGroupSummaries(),
    ])
    // Admin sees every group; non-admin sees only the groups they moderate.
    const visible =
      user?.role === 'admin'
        ? groups
        : groups.filter((g) => moderatedGroupIds.includes(g.id))
    return { groups: visible }
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
