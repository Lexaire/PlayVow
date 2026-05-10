import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'

import type {
  AddGroupModeratorError,
  AdminGroupModeratorRow,
  RemoveGroupModeratorError,
} from '#/server/groupAdminFns'
import {
  addGroupModeratorFn,
  listGroupModeratorsFn,
  removeGroupModeratorFn,
} from '#/server/groupAdminFns'

const formatAddError = (e: AddGroupModeratorError): string => {
  switch (e.kind) {
    case 'group_not_found':
      return 'Group not found.'
    case 'already_moderator':
      return 'That user is already a moderator of this group.'
    case 'invalid_input':
      return 'Enter a SteamID64 or vanity URL.'
    case 'vanity_failed': {
      const cause = e.cause
      if (cause.kind === 'not_found') return `Vanity not found: ${cause.vanity}`
      return `Vanity lookup failed: ${cause.kind}`
    }
  }
}

const formatRemoveError = (e: RemoveGroupModeratorError): string => {
  switch (e.kind) {
    case 'group_not_found':
      return 'Group not found.'
    case 'not_a_moderator':
      return 'That user is not currently a moderator of this group.'
  }
}

const labelForMod = (m: AdminGroupModeratorRow): string =>
  m.steamgiftsUsername ?? `Steam ${m.steamId?.slice(-6) ?? '?'}`

// Inline panel rendered under a group's row on /admin/groups when the
// admin clicks "Manage moderators." Loads the current list lazily on
// mount and exposes add (by SteamID/vanity) + revoke actions. Both
// actions are admin-only on the server side too — this UI just presents
// the affordance.
export function GroupModeratorsPanel({ groupId }: { readonly groupId: number }) {
  const router = useRouter()
  const listFn = useServerFn(listGroupModeratorsFn)
  const addFn = useServerFn(addGroupModeratorFn)
  const removeFn = useServerFn(removeGroupModeratorFn)

  const [mods, setMods] = useState<ReadonlyArray<AdminGroupModeratorRow> | null>(null)
  const [loading, setLoading] = useState(true)
  const [identifier, setIdentifier] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void listFn({ data: { groupId } }).then((rows) => {
      if (!cancelled) {
        setMods(rows)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [groupId, listFn])

  const refresh = async () => {
    const rows = await listFn({ data: { groupId } })
    setMods(rows)
    await router.invalidate()
  }

  const onAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (identifier.trim().length === 0) {
      setError('Enter a SteamID64 or vanity URL.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await addFn({ data: { groupId, identifier: identifier.trim() } })
      if (!r.ok) {
        setError(formatAddError(r.error))
        return
      }
      setIdentifier('')
      await refresh()
    } finally {
      setPending(false)
    }
  }

  const onRemove = async (userId: number) => {
    setPending(true)
    setError(null)
    try {
      const r = await removeFn({ data: { groupId, userId } })
      if (!r.ok) {
        setError(formatRemoveError(r.error))
        return
      }
      await refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3 rounded border border-neutral-200 bg-neutral-50 p-3">
      <h3 className="text-sm font-semibold">Moderators</h3>
      {loading ? (
        <p className="text-xs text-neutral-500">Loading…</p>
      ) : mods === null || mods.length === 0 ? (
        <p className="text-xs text-neutral-500">
          No moderators assigned. Admins moderate every group automatically; add a moderator
          below to delegate group-scoped access.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-surface text-sm">
          {mods.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="font-mono text-xs">{labelForMod(m)}</span>
              <button
                type="button"
                onClick={() => void onRemove(m.userId)}
                disabled={pending}
                className="text-xs text-rose-700 hover:underline disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onAdd} className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="block text-xs font-medium text-neutral-700">Add moderator</span>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="SteamID64 or vanity URL"
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="h-[34px] rounded bg-emerald-700 px-3 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error !== null && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  )
}
