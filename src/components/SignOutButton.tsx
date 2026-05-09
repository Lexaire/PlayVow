import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'

import { logout } from '#/server/authFns'

export function SignOutButton({ className }: { readonly className?: string }) {
  const router = useRouter()
  const logoutFn = useServerFn(logout)
  const [pending, setPending] = useState(false)

  const onClick = async () => {
    setPending(true)
    try {
      await logoutFn()
      await router.invalidate()
      await router.navigate({ to: '/' })
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => void onClick()}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50'
      }
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" x2="9" y1="12" y2="12" />
      </svg>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
