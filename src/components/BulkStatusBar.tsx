import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { winStatusLabel } from '#/components/WinsTable'
import type { WinStatus } from '#/db/schema'
import { targetsForBulk } from '#/domain/win-status'
import { STATUS_PILL_STYLES, formatStatusError } from '#/domain/win-status-ui'
import { setWinStatusBulk } from '#/server/modFns'

export function BulkStatusBar({
  selectedIds,
  sourceStatuses,
  onClear,
  onApplied,
}: {
  readonly selectedIds: ReadonlySet<number>
  readonly sourceStatuses: ReadonlySet<WinStatus>
  readonly onClear: () => void
  readonly onApplied: () => void
}) {
  const router = useRouter()
  const bulkUpdate = useServerFn(setWinStatusBulk)
  const targets = targetsForBulk(sourceStatuses)
  const [target, setTarget] = useState<WinStatus | ''>('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  if (selectedIds.size === 0) return null

  const validTarget = target !== '' && targets.includes(target) ? target : null

  const onApply = async () => {
    if (!validTarget) return
    setPending(true)
    setMessage(null)
    try {
      const result = await bulkUpdate({
        data: { winIds: Array.from(selectedIds), to: validTarget },
      })
      if (result.errors.length === 0) {
        setMessage(null)
        await router.invalidate()
        setTarget('')
        onApplied()
        return
      }
      const summary = `${String(result.updated.length)} updated, ${String(
        result.errors.length,
      )} skipped (${result.errors.map((e) => formatStatusError(e.error)).join('; ')})`
      setMessage(summary)
      await router.invalidate()
      onApplied()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-surface shadow-lg">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
        <span className="text-sm font-medium">{String(selectedIds.size)} selected</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="text-xs text-neutral-600" htmlFor="bulk-status-target">
            Move to
          </label>
          <select
            id="bulk-status-target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as WinStatus | '')
            }}
            disabled={pending || targets.length === 0}
            className="rounded border border-neutral-300 bg-surface px-2 py-1 text-sm"
          >
            <option value="">
              {targets.length === 0 ? 'No common transition' : 'Select status…'}
            </option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {winStatusLabel(t)}
              </option>
            ))}
          </select>
          {validTarget ? (
            <span
              className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_STYLES[validTarget]}`}
            >
              {winStatusLabel(validTarget)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void onApply()
            }}
            disabled={pending || !validTarget}
            className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {pending ? '…' : 'Apply'}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50"
          >
            Clear
          </button>
        </div>
        {message ? <p className="basis-full text-xs text-rose-700">{message}</p> : null}
      </div>
    </div>
  )
}
