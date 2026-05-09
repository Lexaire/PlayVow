import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'

import { AuditEntryRow } from '#/components/AuditEntryRow'
import { ROLE_PILL, allowedTransitions, formatRoleError } from '#/components/admin/role-ui'
import type { UserRole } from '#/db/schema'
import { fetchAdminUserDetail, setUserRoleFn } from '#/server/adminFns'

const ParamsSchema = z.object({ userId: z.string().regex(/^\d+$/) })

const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

export const Route = createFileRoute('/admin/users/$userId')({
  parseParams: (raw) => ParamsSchema.parse(raw),
  loader: async ({ params }) => fetchAdminUserDetail({ data: { userId: Number(params.userId) } }),
  component: AdminUserDetail,
})

function AdminUserDetail() {
  const { user, audit, viewerId, viewerIsEnvAdmin } = Route.useLoaderData()
  const router = useRouter()
  const setRole = useServerFn(setUserRoleFn)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState<UserRole | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isSelf = user.id === viewerId
  const allowedRoles = allowedTransitions({
    viewerId,
    viewerIsEnvAdmin,
    target: { id: user.id, role: user.role },
  })

  const onChange = async (newRole: UserRole) => {
    setPending(newRole)
    setError(null)
    try {
      const result = await setRole({
        data: {
          userId: user.id,
          newRole,
          ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        },
      })
      if (!result.ok) {
        setError(formatRoleError(result.error.kind))
        return
      }
      setReason('')
      await router.invalidate()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/admin/users" className="text-sm text-blue-700 hover:underline">
        ← All users
      </Link>
      <header className="space-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">{user.steamgiftsUsername ?? `User #${user.id}`}</h1>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_PILL[user.role]}`}
          >
            {user.role}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-neutral-500">User ID</dt>
          <dd>{user.id}</dd>
          <dt className="text-neutral-500">Steam ID</dt>
          <dd className="font-mono text-xs">{user.steamId ?? '—'}</dd>
          <dt className="text-neutral-500">SG username</dt>
          <dd>{user.steamgiftsUsername ?? '—'}</dd>
          <dt className="text-neutral-500">Joined</dt>
          <dd>{dateTimeFormat.format(user.createdAt)}</dd>
        </dl>
      </header>

      <section className="space-y-3 rounded border border-neutral-200 bg-surface p-4">
        <h2 className="text-lg font-semibold">Change role</h2>
        {error ? (
          <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        ) : null}
        <label className="block">
          <span className="text-xs font-medium text-neutral-600">Reason (optional)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {allowedRoles.length === 0 ? (
            <p className="text-sm text-neutral-500">
              {isSelf
                ? "You can't change your own role."
                : 'Only an admin listed in ADMIN_STEAM_IDS can change this role.'}
            </p>
          ) : (
            allowedRoles.map((r) => (
              <button
                key={r}
                type="button"
                disabled={pending !== null}
                onClick={() => void onChange(r)}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
              >
                {pending === r ? 'Working…' : `Set ${r}`}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Audit log</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-neutral-600">No audit entries.</p>
        ) : (
          <ol className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface text-sm">
            {audit.map((entry, idx) => (
              <li key={entry.ok ? entry.value.id : idx} className="px-3 py-2">
                {entry.ok ? (
                  <AuditEntryRow entry={entry.value} />
                ) : (
                  <span className="text-rose-700">Unparseable entry #{entry.error.id}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
