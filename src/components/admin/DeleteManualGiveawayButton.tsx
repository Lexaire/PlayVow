import { useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import type { DeleteManualGiveawayError } from '#/server/manualGroupFns'
import { deleteManualGiveawayFn } from '#/server/manualGroupFns'

const formatError = (e: DeleteManualGiveawayError): string => {
  switch (e.kind) {
    case 'not_found':
      return 'Giveaway not found.'
    case 'not_manual':
      return 'Only manual giveaways can be deleted.'
    case 'already_deleted':
      return 'This giveaway is already deleted.'
  }
}

// Admin-only soft delete for manual giveaways. The route loader 404s once
// the row is marked deleted, so the button on the giveaway detail page
// navigates back to the group page after success — there's nowhere on the
// detail page to land.
export function DeleteManualGiveawayButton({
  giveawayId,
  groupSlug,
  itemName,
}: {
  readonly giveawayId: number
  readonly groupSlug: string
  readonly itemName: string
}) {
  const navigate = useNavigate()
  const deleteFn = useServerFn(deleteManualGiveawayFn)

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onClick = async () => {
    if (pending) return
    const ok = window.confirm(
      `Soft-delete "${itemName}"? Wins will be hidden from views; observation history is preserved.`,
    )
    if (!ok) return
    setPending(true)
    setError(null)
    try {
      const r = await deleteFn({ data: { giveawayId } })
      if (!r.ok) {
        setError(formatError(r.error))
        return
      }
      await navigate({ to: '/g/$slug', params: { slug: groupSlug } })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={pending}
        className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50"
      >
        {pending ? 'Deleting…' : 'Delete (admin)'}
      </button>
      {error !== null && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  )
}
