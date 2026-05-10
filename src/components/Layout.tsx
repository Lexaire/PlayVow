import { Link } from '@tanstack/react-router'
import { useState, useRef, useEffect, type ReactNode } from 'react'

import { isAdmin, isAnyMod } from '#/domain/roles'
import type { CurrentUserInfo } from '#/server/modFns'
import type { GroupSummary } from '#/server/queries'

export function AppLayout({
  groups,
  activeSlug,
  currentUser,
  moderatedGroupIds,
  children,
}: {
  readonly groups: ReadonlyArray<GroupSummary>
  readonly activeSlug: string | null
  readonly currentUser: CurrentUserInfo | null
  // Group ids the viewer can moderate. Empty for admins (who see /mod
  // unconditionally) and for users with no per-group grants.
  readonly moderatedGroupIds: ReadonlyArray<number>
  readonly children: ReactNode
}) {
  const userIsMod = isAnyMod(currentUser, new Set(moderatedGroupIds))
  const userIsAdmin = isAdmin(currentUser)
  return (
    <div className="min-h-screen bg-surface-muted text-neutral-900">
      <header className="border-b border-neutral-200 bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
            <img src="/logo64.png" alt="" width={39} height={48} className="h-12 w-auto" />
            PlayVow
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            {groups.length === 0 ? (
              <span className="text-neutral-500">no groups</span>
            ) : (
              groups.map((g) => (
                <Link
                  key={g.id}
                  to="/g/$slug"
                  params={{ slug: g.slug }}
                  className={`rounded px-3 py-1 ${
                    activeSlug === g.slug
                      ? 'bg-surface-strong text-content-on-strong'
                      : 'text-neutral-700 hover:bg-neutral-100'
                  }`}
                >
                  {g.name}
                </Link>
              ))
            )}
            {/* Desktop: separate links */}
            {userIsMod && (
              <Link
                to="/mod"
                className="hidden rounded px-3 py-1 sm:block"
                activeProps={{ className: 'bg-surface-strong text-content-on-strong' }}
                inactiveProps={{ className: 'text-neutral-500 hover:bg-neutral-100' }}
              >
                Mod
              </Link>
            )}
            {userIsAdmin && (
              <Link
                to="/admin"
                className="hidden rounded px-3 py-1 sm:block"
                activeProps={{ className: 'bg-surface-strong text-content-on-strong' }}
                inactiveProps={{ className: 'text-neutral-500 hover:bg-neutral-100' }}
              >
                Admin
              </Link>
            )}
            {/* Mobile: collapsed dropdown */}
            {(userIsMod || userIsAdmin) && <StaffMenu mod={userIsMod} admin={userIsAdmin} />}
            {currentUser === null ? (
              <Link
                to="/login"
                className="rounded px-3 py-1"
                activeProps={{ className: 'bg-surface-strong text-content-on-strong' }}
                inactiveProps={{ className: 'text-neutral-700 hover:bg-neutral-100' }}
              >
                Sign in
              </Link>
            ) : (
              <UserMenu user={currentUser} />
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

function StaffMenu({ mod, admin }: { readonly mod: boolean; readonly admin: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => {
      document.removeEventListener('click', close)
    }
  }, [open])

  return (
    <div ref={ref} className="relative sm:hidden">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
        }}
        className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100"
        aria-label="Staff menu"
        aria-expanded={open}
      >
        &#9776;
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 min-w-28 rounded border border-neutral-200 bg-surface py-1 shadow-lg">
          {mod && (
            <Link
              to="/mod"
              onClick={() => {
                setOpen(false)
              }}
              className="block px-3 py-1.5 text-neutral-700 hover:bg-neutral-100"
              activeProps={{ className: 'bg-surface-strong text-content-on-strong!' }}
            >
              Mod
            </Link>
          )}
          {admin && (
            <>
              <Link
                to="/admin/users"
                onClick={() => {
                  setOpen(false)
                }}
                className="block px-3 py-1.5 text-neutral-700 hover:bg-neutral-100"
                activeProps={{ className: 'bg-surface-strong text-content-on-strong!' }}
              >
                Admin · Users
              </Link>
              <Link
                to="/admin/cookies"
                onClick={() => {
                  setOpen(false)
                }}
                className="block px-3 py-1.5 text-neutral-700 hover:bg-neutral-100"
                activeProps={{ className: 'bg-surface-strong text-content-on-strong!' }}
              >
                Admin · Cookies
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function UserMenu({ user }: { readonly user: CurrentUserInfo }) {
  const label = user.steamgiftsUsername ?? `user #${user.id}`
  const initial = label.charAt(0).toUpperCase()

  if (user.steamId === null) {
    return <span className="text-sm text-neutral-600">{label}</span>
  }

  return (
    <Link
      to="/u/steam/$steamId"
      params={{ steamId: user.steamId }}
      className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 hover:bg-neutral-100"
    >
      <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-neutral-300 bg-neutral-100">
        {user.avatarUrl !== null ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-sm font-medium text-neutral-700">{initial}</span>
        )}
      </span>
      <span className="text-sm font-medium text-neutral-800">{label}</span>
    </Link>
  )
}
