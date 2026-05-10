import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import type { AddManualGiveawayError } from '#/server/manualGroupFns'
import { addManualGiveawayFn } from '#/server/manualGroupFns'

const formatError = (e: AddManualGiveawayError): string => {
  switch (e.kind) {
    case 'group_not_found':
      return 'Group not found.'
    case 'group_not_manual':
      return 'This is not a manual group.'
    case 'invalid_date_range':
      return 'Both start and end dates must be set, with start no later than end.'
    case 'item_not_found':
      return 'Steam returned no result for that ID. Double-check appId / subId.'
    case 'steam_api_failed':
      return `Steam API error: ${e.cause.kind}`
    case 'invalid_input':
      return `${capitalize(e.field)} is empty or unrecognized. Use a SteamID64 or vanity URL.`
    case 'vanity_failed': {
      const cause = e.cause
      if (cause.kind === 'not_found') {
        return `${capitalize(e.field)} vanity not found: ${cause.vanity}`
      }
      return `${capitalize(e.field)} vanity lookup failed: ${cause.kind}`
    }
  }
}

// `<input type="datetime-local">` returns "YYYY-MM-DDTHH:mm" interpreted in
// the browser's local timezone. new Date(s) parses that as local, which is
// the right behavior here — the mod is entering the time in their wall
// clock. Empty string → undefined so the server falls back to "now".
const parseLocalDateTimeInput = (value: string): Date | undefined => {
  if (value.trim().length === 0) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function ManualEntryPanel({
  groupId,
  groupSlug,
}: {
  readonly groupId: number
  readonly groupSlug: string
}) {
  const router = useRouter()
  const addGiveaway = useServerFn(addManualGiveawayFn)

  const [kind, setKind] = useState<'app' | 'sub'>('app')
  const [steamId, setSteamId] = useState('')
  const [creator, setCreator] = useState('')
  const [winner, setWinner] = useState('')
  const [startedAt, setStartedAt] = useState('')
  const [endedAt, setEndedAt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const idNum = Number(steamId)
    if (!Number.isInteger(idNum) || idNum < 0) {
      setError('Enter a numeric Steam app or sub ID.')
      return
    }
    if (creator.trim().length === 0) {
      setError('Creator is required.')
      return
    }
    if (winner.trim().length === 0) {
      setError('Winner is required.')
      return
    }
    const startedAtDate = parseLocalDateTimeInput(startedAt)
    const endedAtDate = parseLocalDateTimeInput(endedAt)
    // Either both dates must be set or both empty — partial input is
    // ambiguous. The server enforces the same rule but rejecting client-
    // side gives a faster, clearer message.
    if ((startedAtDate === undefined) !== (endedAtDate === undefined)) {
      setError('Set both Started and Ended, or leave both empty.')
      return
    }
    if (
      startedAtDate !== undefined &&
      endedAtDate !== undefined &&
      startedAtDate.getTime() > endedAtDate.getTime()
    ) {
      setError('Started must be on or before Ended.')
      return
    }
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await addGiveaway({
        data: {
          groupId,
          item: { kind, id: idNum },
          creator: creator.trim(),
          winner: winner.trim(),
          ...(startedAtDate !== undefined ? { startedAt: startedAtDate } : {}),
          ...(endedAtDate !== undefined ? { endedAt: endedAtDate } : {}),
        },
      })
      if (!result.ok) {
        setError(formatError(result.error))
        return
      }
      setSuccess(`Added "${result.value.itemName}" + winner.`)
      setSteamId('')
      setCreator('')
      setWinner('')
      setStartedAt('')
      setEndedAt('')
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="space-y-3 rounded border border-emerald-200 bg-emerald-50 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Add manual giveaway</h2>
        <span className="text-xs text-neutral-600">group: {groupSlug}</span>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-end">
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">Type</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'app' | 'sub')}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            >
              <option value="app">App</option>
              <option value="sub">Sub (package)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">
              {kind === 'app' ? 'App ID' : 'Sub ID'}
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={steamId}
              onChange={(e) => setSteamId(e.target.value)}
              placeholder={kind === 'app' ? 'e.g. 730' : 'e.g. 12345'}
              required
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">Creator</span>
            <input
              type="text"
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
              placeholder="SteamID64 or vanity URL"
              required
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">Winner</span>
            <input
              type="text"
              value={winner}
              onChange={(e) => setWinner(e.target.value)}
              placeholder="SteamID64 or vanity URL"
              required
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">
              Started <span className="text-neutral-500">(optional)</span>
            </span>
            <input
              type="datetime-local"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700">
              Ended <span className="text-neutral-500">(optional)</span>
            </span>
            <input
              type="datetime-local"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="h-[34px] self-end rounded bg-emerald-700 px-3 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {pending ? 'Adding…' : 'Add'}
          </button>
        </div>
        <p className="text-xs text-neutral-600">
          Leave dates empty to use “now” for both. Times use your local timezone.
        </p>
      </form>
      {error !== null && <p className="text-sm text-red-700">{error}</p>}
      {success !== null && <p className="text-sm text-emerald-800">{success}</p>}
    </section>
  )
}
