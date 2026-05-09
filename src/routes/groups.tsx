import { Link, createFileRoute } from '@tanstack/react-router'

import { fetchGroupSummaries } from '#/server/publicFns'

export const Route = createFileRoute('/groups')({
  loader: () => fetchGroupSummaries(),
  component: GroupsIndex,
})

function GroupsIndex() {
  const groups = Route.useLoaderData()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Groups</h1>
      {groups.length === 0 ? (
        <p className="text-neutral-600">No groups yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface">
          {groups.map((g) => (
            <li key={g.id}>
              <Link
                to="/g/$slug"
                params={{ slug: g.slug }}
                className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50"
              >
                <div>
                  <div className="font-medium">{g.name}</div>
                  {g.description ? (
                    <div className="text-sm text-neutral-600">{g.description}</div>
                  ) : null}
                </div>
                <span className="text-xs text-neutral-500">{g.playWindowDays}-day play window</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
