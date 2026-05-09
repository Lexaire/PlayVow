import { Link } from '@tanstack/react-router'

const TAB_BASE = 'rounded-md px-3 py-1.5 text-sm font-medium transition-colors'
const TAB_ACTIVE = 'bg-surface-strong text-content-on-strong'
const TAB_INACTIVE = 'text-neutral-700 hover:bg-neutral-100'

export function ModSubNav({ active }: { readonly active: 'queue' | 'audit' }) {
  return (
    <nav
      aria-label="Moderator sections"
      className="flex items-center gap-1 border-b border-neutral-200 pb-3"
    >
      <Link to="/mod" className={`${TAB_BASE} ${active === 'queue' ? TAB_ACTIVE : TAB_INACTIVE}`}>
        Queue
      </Link>
      <Link
        to="/mod/audit"
        className={`${TAB_BASE} ${active === 'audit' ? TAB_ACTIVE : TAB_INACTIVE}`}
      >
        Audit log
      </Link>
    </nav>
  )
}
