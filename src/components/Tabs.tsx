export type ProfileTabKey = 'wins' | 'giveaways'

const TABS: ReadonlyArray<{ readonly key: ProfileTabKey; readonly label: string }> = [
  { key: 'wins', label: 'My wins' },
  { key: 'giveaways', label: 'My giveaways' },
]

export function ProfileTabs({
  active,
  onSelect,
  counts,
}: {
  readonly active: ProfileTabKey
  readonly onSelect: (tab: ProfileTabKey) => void
  readonly counts: Readonly<Record<ProfileTabKey, number>>
}) {
  return (
    <div
      role="tablist"
      aria-label="Profile sections"
      className="flex gap-1 border-b border-neutral-200"
    >
      {TABS.map((t) => {
        const isActive = active === t.key
        return (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => {
              onSelect(t.key)
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'border-emerald-700 text-emerald-800'
                : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-xs font-normal text-neutral-500">({counts[t.key]})</span>
          </button>
        )
      })}
    </div>
  )
}
