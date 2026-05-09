import { Link } from '@tanstack/react-router'

export type AdminTabKey = 'health' | 'users' | 'cookies' | 'jobs'

const TABS: ReadonlyArray<{
  readonly key: AdminTabKey
  readonly label: string
  readonly to: '/admin' | '/admin/users' | '/admin/cookies' | '/admin/jobs'
}> = [
  { key: 'health', label: 'Health', to: '/admin' },
  { key: 'users', label: 'Users', to: '/admin/users' },
  { key: 'cookies', label: 'Cookies', to: '/admin/cookies' },
  { key: 'jobs', label: 'Jobs', to: '/admin/jobs' },
]

export function AdminTabs({ active }: { readonly active: AdminTabKey }) {
  return (
    <div
      role="tablist"
      aria-label="Admin sections"
      className="flex gap-1 border-b border-neutral-200"
    >
      {TABS.map((t) => {
        const isActive = active === t.key
        return (
          <Link
            key={t.key}
            to={t.to}
            role="tab"
            aria-selected={isActive}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'border-emerald-700 text-emerald-800'
                : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
