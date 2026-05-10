import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { AdminTabs } from '#/components/admin/AdminTabs'
import { GROUP_SOURCES } from '#/db/schema'
import type { GroupSource } from '#/db/schema'
import type { AdminGroupRow, CreateGroupError, UpdateGroupError } from '#/server/groupAdminFns'
import { createGroupFn, listGroupsForAdmin, updateGroupFn } from '#/server/groupAdminFns'

export const Route = createFileRoute('/admin/groups')({
  loader: async () => listGroupsForAdmin(),
  component: AdminGroupsPage,
})

const formatCreateError = (e: CreateGroupError): string => {
  switch (e.kind) {
    case 'slug_taken':
      return 'A group with that slug already exists.'
    case 'sg_code_required':
      return 'Steam Gifts group code is required for SG-source groups.'
  }
}

const formatUpdateError = (e: UpdateGroupError): string => {
  switch (e.kind) {
    case 'group_not_found':
      return 'Group not found.'
    case 'sg_fields_required':
      return 'Steam Gifts groups need both the SG group code and the Steam group slug.'
  }
}

const SOURCE_LABEL: Readonly<Record<GroupSource, string>> = {
  steamgifts: 'Steam Gifts',
  manual: 'Manual',
}

const SOURCE_BADGE: Readonly<Record<GroupSource, string>> = {
  steamgifts: 'bg-violet-100 text-violet-800 ring-violet-200',
  manual: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
}

function AdminGroupsPage() {
  const groups = Route.useLoaderData()
  const router = useRouter()
  const createGroup = useServerFn(createGroupFn)
  const updateGroup = useServerFn(updateGroupFn)

  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  return (
    <div className="space-y-6">
      <AdminTabs active="groups" />
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Groups</h1>
          <p className="text-sm text-neutral-600">
            Create new groups and edit existing ones. Manual groups have no Steam Gifts presence —
            mods add games and winners by hand from the moderation page.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCreate((s) => !s)
            setCreateError(null)
          }}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          {showCreate ? 'Cancel' : 'New group'}
        </button>
      </header>

      {showCreate && (
        <CreateGroupForm
          onSubmit={async (form) => {
            setPending(true)
            setCreateError(null)
            try {
              const r = await createGroup({ data: form })
              if (!r.ok) {
                setCreateError(formatCreateError(r.error))
                return
              }
              setShowCreate(false)
              await router.invalidate()
            } finally {
              setPending(false)
            }
          }}
          pending={pending}
          error={createError}
        />
      )}

      <div className="overflow-hidden rounded border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600">
            <tr>
              <th className="px-3 py-2">Slug</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Window</th>
              <th className="px-3 py-2">Wins</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {groups.map((g) => (
              <tr key={g.id}>
                <td className="px-3 py-2 font-mono text-xs">{g.slug}</td>
                <td className="px-3 py-2">{g.name}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ${SOURCE_BADGE[g.source]}`}
                  >
                    {SOURCE_LABEL[g.source]}
                  </span>
                </td>
                <td className="px-3 py-2 text-neutral-700">{String(g.playWindowDays)}d</td>
                <td className="px-3 py-2 text-neutral-700">
                  {String(g.totalWins)} ({String(g.pendingWins)} pending)
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId((id) => (id === g.id ? null : g.id))
                      setEditError(null)
                    }}
                    className="text-xs font-medium text-blue-700 hover:underline"
                  >
                    {editingId === g.id ? 'Close' : 'Edit'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingId !== null && (
        <EditGroupForm
          group={groups.find((g) => g.id === editingId)!}
          onSubmit={async (form) => {
            setPending(true)
            setEditError(null)
            try {
              const r = await updateGroup({ data: form })
              if (!r.ok) {
                setEditError(formatUpdateError(r.error))
                return
              }
              setEditingId(null)
              await router.invalidate()
            } finally {
              setPending(false)
            }
          }}
          pending={pending}
          error={editError}
        />
      )}
    </div>
  )
}

type CreateGroupFormValue = {
  readonly slug: string
  readonly name: string
  readonly source: GroupSource
  readonly playWindowDays: number
  readonly description: string
  readonly steamgiftsGroupCode: string
  readonly steamGroupId: string
  readonly steamGroupSlug: string
}

function CreateGroupForm({
  onSubmit,
  pending,
  error,
}: {
  readonly onSubmit: (form: CreateGroupFormValue) => Promise<void>
  readonly pending: boolean
  readonly error: string | null
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState<GroupSource>('manual')
  const [playWindowDays, setPlayWindowDays] = useState(90)
  const [description, setDescription] = useState('')
  const [steamgiftsGroupCode, setSteamgiftsGroupCode] = useState('')
  const [steamGroupId, setSteamGroupId] = useState('')
  const [steamGroupSlug, setSteamGroupSlug] = useState('')

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void onSubmit({
      slug,
      name,
      source,
      playWindowDays,
      description,
      steamgiftsGroupCode,
      steamGroupId,
      steamGroupSlug,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded border border-neutral-200 bg-neutral-50 p-4">
      <h2 className="text-lg font-semibold">New group</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Slug" hint="alphanumeric + hyphens, used in URLs">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Source">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as GroupSource)}
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          >
            {GROUP_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Play window (days)">
          <input
            type="number"
            value={playWindowDays}
            onChange={(e) => setPlayWindowDays(Number(e.target.value))}
            min={1}
            max={3650}
            required
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
        />
      </Field>

      <fieldset className="space-y-2 rounded border border-neutral-200 bg-surface p-3">
        <legend className="px-1 text-xs font-medium text-neutral-600">
          Steam Gifts settings {source === 'steamgifts' ? '(required)' : '(optional)'}
        </legend>
        <Field label="SteamGifts group code">
          <input
            value={steamgiftsGroupCode}
            onChange={(e) => setSteamgiftsGroupCode(e.target.value)}
            placeholder="e.g. xBp7E"
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-2 rounded border border-neutral-200 bg-surface p-3">
        <legend className="px-1 text-xs font-medium text-neutral-600">
          Steam group (optional — enables roster/kick tracking)
        </legend>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Steam group ID (gid64)">
            <input
              value={steamGroupId}
              onChange={(e) => setSteamGroupId(e.target.value)}
              placeholder="e.g. 103582791467874127"
              className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="Steam group slug">
            <input
              value={steamGroupSlug}
              onChange={(e) => setSteamGroupSlug(e.target.value)}
              placeholder="e.g. taleplay"
              className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </Field>
        </div>
      </fieldset>

      {error !== null && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? 'Creating…' : 'Create group'}
        </button>
      </div>
    </form>
  )
}

function EditGroupForm({
  group,
  onSubmit,
  pending,
  error,
}: {
  readonly group: AdminGroupRow
  readonly onSubmit: (form: {
    readonly id: number
    readonly name: string
    readonly playWindowDays: number
    readonly description: string
    readonly steamgiftsGroupCode: string
    readonly steamGroupId: string
    readonly steamGroupSlug: string
  }) => Promise<void>
  readonly pending: boolean
  readonly error: string | null
}) {
  const [name, setName] = useState(group.name)
  const [playWindowDays, setPlayWindowDays] = useState(group.playWindowDays)
  const [description, setDescription] = useState(group.description ?? '')
  const [steamgiftsGroupCode, setSteamgiftsGroupCode] = useState(group.steamgiftsGroupCode ?? '')
  const [steamGroupId, setSteamGroupId] = useState(group.steamGroupId ?? '')
  const [steamGroupSlug, setSteamGroupSlug] = useState(group.steamGroupSlug ?? '')

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void onSubmit({
      id: group.id,
      name,
      playWindowDays,
      description,
      steamgiftsGroupCode,
      steamGroupId,
      steamGroupSlug,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded border border-blue-200 bg-blue-50 p-4">
      <h2 className="text-lg font-semibold">
        Edit {group.slug}{' '}
        <span className="text-xs font-normal text-neutral-500">({SOURCE_LABEL[group.source]})</span>
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Play window (days)">
          <input
            type="number"
            value={playWindowDays}
            onChange={(e) => setPlayWindowDays(Number(e.target.value))}
            min={1}
            max={3650}
            required
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
        />
      </Field>
      <fieldset className="space-y-2 rounded border border-neutral-200 bg-surface p-3">
        <legend className="px-1 text-xs font-medium text-neutral-600">Steam Gifts settings</legend>
        <Field label="SteamGifts group code">
          <input
            value={steamgiftsGroupCode}
            onChange={(e) => setSteamgiftsGroupCode(e.target.value)}
            className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
      </fieldset>
      <fieldset className="space-y-2 rounded border border-neutral-200 bg-surface p-3">
        <legend className="px-1 text-xs font-medium text-neutral-600">Steam group (optional)</legend>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Steam group ID (gid64)">
            <input
              value={steamGroupId}
              onChange={(e) => setSteamGroupId(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="Steam group slug">
            <input
              value={steamGroupSlug}
              onChange={(e) => setSteamGroupSlug(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </Field>
        </div>
      </fieldset>
      {error !== null && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-700">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>}
    </label>
  )
}
