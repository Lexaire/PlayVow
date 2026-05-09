import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'

import { AdminTabs } from '#/components/admin/AdminTabs'
import { ROLE_PILL, allowedTransitions, formatRoleError } from '#/components/admin/role-ui'
import { USER_ROLES } from '#/db/schema'
import type { UserRole } from '#/db/schema'
import { listUsersForAdmin, setUserRoleFn } from '#/server/adminFns'

const SearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  role: z.enum(USER_ROLES).optional(),
  q: z.string().trim().min(1).max(64).optional(),
})

export const Route = createFileRoute('/admin/users')({
  validateSearch: (search: Record<string, unknown>) => SearchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    role: search.role,
    search: search.q,
  }),
  loader: async ({ deps }) => {
    return await listUsersForAdmin({
      data: {
        page: deps.page,
        ...(deps.role ? { role: deps.role } : {}),
        ...(deps.search ? { search: deps.search } : {}),
      },
    })
  },
  component: AdminUsersPage,
})

function AdminUsersPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const router = useRouter()
  const setRole = useServerFn(setUserRoleFn)
  const [query, setQuery] = useState(search.q ?? '')
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<number | null>(null)

  const onSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void router.navigate({
      to: '/admin/users',
      search: query.length === 0 ? {} : { q: query },
    })
  }

  const onRoleChange = async (userId: number, newRole: UserRole) => {
    setPendingId(userId)
    setActionError(null)
    try {
      const result = await setRole({ data: { userId, newRole } })
      if (!result.ok) {
        setActionError(formatRoleError(result.error.kind))
        return
      }
      await router.invalidate()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <AdminTabs active="users" />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-sm text-neutral-600">
          Promote or demote moderators. All changes are audit-logged.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4">
        <form onSubmit={onSearch} className="flex items-end gap-2">
          <label className="block">
            <span className="text-xs font-medium text-neutral-600">Search</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="username or steam id"
              className="mt-1 w-64 rounded border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-surface-strong px-3 py-1.5 text-sm font-medium text-content-on-strong"
          >
            Search
          </button>
        </form>
        <div className="flex items-end gap-1">
          <span className="mb-1 text-xs font-medium text-neutral-600">Role</span>
          <Link
            to="/admin/users"
            search={search.q ? { q: search.q } : {}}
            className={`rounded border px-2 py-1 text-xs ${
              search.role === undefined
                ? 'border-neutral-900 bg-surface-strong text-content-on-strong'
                : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            all
          </Link>
          {USER_ROLES.map((r) => (
            <Link
              key={r}
              to="/admin/users"
              search={{ ...(search.q ? { q: search.q } : {}), role: r }}
              className={`rounded border px-2 py-1 text-xs ${
                search.role === r
                  ? 'border-neutral-900 bg-surface-strong text-content-on-strong'
                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              {r}
            </Link>
          ))}
        </div>
      </div>

      {actionError ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {actionError}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded border border-neutral-200 bg-surface">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-semibold uppercase text-neutral-600">
            <tr>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Steam ID</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Joined</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {data.rows.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">
                  {u.steamgiftsUsername !== null ? (
                    <Link
                      to="/u/$username"
                      params={{ username: u.steamgiftsUsername }}
                      className="text-blue-700 hover:underline"
                    >
                      {u.steamgiftsUsername}
                    </Link>
                  ) : u.steamId !== null ? (
                    <Link
                      to="/u/steam/$steamId"
                      params={{ steamId: u.steamId }}
                      className="text-blue-700 hover:underline"
                    >
                      {`(no SG) #${u.id}`}
                    </Link>
                  ) : (
                    <span className="text-neutral-500">{`(no SG) #${u.id}`}</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-600">{u.steamId ?? '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_PILL[u.role]}`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-3 py-2 text-neutral-600">
                  {u.createdAt.toISOString().slice(0, 10)}
                </td>
                <td className="px-3 py-2">
                  <RoleControls
                    options={allowedTransitions({
                      viewerId: data.viewerId,
                      viewerIsEnvAdmin: data.viewerIsEnvAdmin,
                      target: { id: u.id, role: u.role },
                    })}
                    pending={pendingId === u.id}
                    onChange={(r) => void onRoleChange(u.id, r)}
                  />
                </td>
              </tr>
            ))}
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-500">
                  No users match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-neutral-600">
        <span>
          Page {data.page} · {data.total} total
        </span>
        <div className="flex gap-2">
          {data.page > 1 ? (
            <Link
              to="/admin/users"
              search={{ ...search, page: data.page - 1 }}
              className="rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
            >
              ← Prev
            </Link>
          ) : null}
          {data.page * data.pageSize < data.total ? (
            <Link
              to="/admin/users"
              search={{ ...search, page: data.page + 1 }}
              className="rounded border border-neutral-300 px-3 py-1 hover:bg-neutral-100"
            >
              Next →
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RoleControls({
  options,
  pending,
  onChange,
}: {
  readonly options: ReadonlyArray<UserRole>
  readonly pending: boolean
  readonly onChange: (r: UserRole) => void
}) {
  if (options.length === 0) {
    return <span className="text-xs text-neutral-400">—</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((r) => (
        <button
          key={r}
          type="button"
          disabled={pending}
          onClick={() => onChange(r)}
          className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
        >
          → {r}
        </button>
      ))}
    </div>
  )
}
