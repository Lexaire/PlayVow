import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { winStatusLabel } from '#/components/WinsTable'
import type { WinStatus } from '#/db/schema'
import { allowedActionsFrom, targetStatus } from '#/domain/win-status'
import type { ModAction } from '#/domain/win-status'
import { STATUS_PILL_STYLES, formatStatusError } from '#/domain/win-status-ui'
import { setWinStatus } from '#/server/modFns'

export function StatusPillEditor({
  winId,
  status,
}: {
  readonly winId: number
  readonly status: WinStatus
}) {
  const router = useRouter()
  const setStatus = useServerFn(setWinStatus)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<ModAction | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      setOpen(next)
      if (!next) {
        setConfirm(null)
        setError(null)
      }
    },
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply: ({ availableWidth, availableHeight, elements }) => {
          elements.floating.style.maxWidth = `${availableWidth}px`
          elements.floating.style.maxHeight = `${availableHeight}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  const close = () => {
    setOpen(false)
    setConfirm(null)
    setError(null)
  }

  const onConfirm = async () => {
    if (confirm === null) return
    setPending(true)
    setError(null)
    try {
      const result = await setStatus({
        data: { winId, to: targetStatus(confirm) },
      })
      if (!result.ok) {
        setError(formatStatusError(result.error))
        return
      }
      await router.invalidate()
      close()
    } finally {
      setPending(false)
    }
  }

  const actions = allowedActionsFrom(status)

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium hover:ring-2 hover:ring-neutral-300 ${STATUS_PILL_STYLES[status]}`}
        {...getReferenceProps()}
      >
        {winStatusLabel(status)}
      </button>
      {open ? (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="z-50 min-w-40 overflow-auto rounded border border-neutral-200 bg-surface p-2 shadow-lg"
              {...getFloatingProps()}
            >
              {confirm === null ? (
                actions.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-neutral-600">No transitions.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                      Change to
                    </p>
                    {actions.map((a) => {
                      const target = targetStatus(a)
                      return (
                        <button
                          key={a}
                          type="button"
                          onClick={() => {
                            setConfirm(a)
                          }}
                          className="flex items-center rounded px-2 py-1 text-left text-xs hover:bg-neutral-100"
                        >
                          <span
                            className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${STATUS_PILL_STYLES[target]}`}
                          >
                            {winStatusLabel(target)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-neutral-700">
                    Change to{' '}
                    <span
                      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${STATUS_PILL_STYLES[targetStatus(confirm)]}`}
                    >
                      {winStatusLabel(targetStatus(confirm))}
                    </span>
                    ?
                  </p>
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={close}
                      disabled={pending}
                      aria-label="Cancel"
                      className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      onClick={onConfirm}
                      disabled={pending}
                      className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                    >
                      {pending ? '…' : 'Yes'}
                    </button>
                  </div>
                </div>
              )}
              {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  )
}
