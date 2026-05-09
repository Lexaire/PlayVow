import { useSyncExternalStore, type SVGProps } from 'react'

import { readThemePref, writeThemePref, applyTheme, type ThemePref } from '#/lib/theme'

type IconComponent = (props: SVGProps<SVGSVGElement>) => React.JSX.Element

const Icon = (children: React.ReactNode): IconComponent => {
  return (props) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

const Monitor = Icon(
  <>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </>,
)

const Moon = Icon(
  <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />,
)

const Sun = Icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </>,
)

const OPTIONS: ReadonlyArray<{ value: ThemePref; label: string; Icon: IconComponent }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => {
    window.removeEventListener('storage', cb)
    mq.removeEventListener('change', cb)
  }
}

export function ThemeToggle() {
  const pref = useSyncExternalStore<ThemePref>(
    subscribe,
    () => readThemePref(),
    () => 'system',
  )

  const setPref = (next: ThemePref) => {
    writeThemePref(next)
    applyTheme(next)
    // Nudge useSyncExternalStore — localStorage events don't fire on the
    // same window that wrote them.
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme' }))
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-surface p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setPref(value)}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              active
                ? 'bg-surface-strong text-content-on-strong'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800'
            }`}
          >
            <Icon />
          </button>
        )
      })}
    </div>
  )
}
