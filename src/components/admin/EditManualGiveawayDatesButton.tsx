import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import type { UpdateManualGiveawayDatesError } from '#/server/manualGroupFns'
import { updateManualGiveawayDatesFn } from '#/server/manualGroupFns'

const formatError = (e: UpdateManualGiveawayDatesError): string => {
  switch (e.kind) {
    case 'not_found':
      return 'Giveaway not found.'
    case 'not_manual':
      return 'Only manual giveaways can have their dates edited.'
    case 'already_deleted':
      return 'This giveaway has been deleted.'
    case 'invalid_range':
      return 'Started must be on or before Ended.'
  }
}

// `<input type="datetime-local">` value format is "YYYY-MM-DDTHH:mm" in
// local time, with no offset. Build that from a Date in the browser tz.
const toLocalInputValue = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fromLocalInputValue = (s: string): Date | null => {
  if (s.trim().length === 0) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

// Group-moderator gated edit of a manual giveaway's lifecycle dates. The
// server fn re-verifies the gate; this component only renders when the
// caller already knows the viewer can mod this group, so a non-mod never
// sees the button. Errors from the server (e.g., not_manual) surface as
// inline text rather than throwing, matching DeleteManualGiveawayButton.
export function EditManualGiveawayDatesButton({
  giveawayId,
  startedAt,
  endedAt,
}: {
  readonly giveawayId: number
  readonly startedAt: Date
  readonly endedAt: Date
}) {
  const router = useRouter()
  const updateFn = useServerFn(updateManualGiveawayDatesFn)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [start, setStart] = useState(() => toLocalInputValue(startedAt))
  const [end, setEnd] = useState(() => toLocalInputValue(endedAt))

  const reset = () => {
    setStart(toLocalInputValue(startedAt))
    setEnd(toLocalInputValue(endedAt))
    setError(null)
  }

  const onCancel = () => {
    setOpen(false)
    reset()
  }

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    const startDate = fromLocalInputValue(start)
    const endDate = fromLocalInputValue(end)
    if (startDate === null || endDate === null) {
      setError('Both dates are required.')
      return
    }
    if (startDate.getTime() > endDate.getTime()) {
      setError('Started must be on or before Ended.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const r = await updateFn({
        data: { giveawayId, startedAt: startDate, endedAt: endDate },
      })
      if (!r.ok) {
        setError(formatError(r.error))
        return
      }
      setOpen(false)
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          reset()
          setOpen(true)
        }}
        className="rounded border border-neutral-300 bg-surface px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
      >
        Edit dates
      </button>
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-2 rounded border border-neutral-300 bg-surface p-3"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-medium text-neutral-700">Started</span>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-700">Ended</span>
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      {error !== null && <p className="text-xs text-rose-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded border border-neutral-300 bg-surface px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
