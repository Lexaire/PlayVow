import type { CreatorStats } from '#/server/queries'

type Pill = {
  readonly label: string
  readonly value: number
  readonly className: string
}

export function CreatorStatsStrip({ stats }: { readonly stats: CreatorStats }) {
  const pills: ReadonlyArray<Pill> = [
    { label: 'Active', value: stats.active, className: 'bg-amber-100 text-amber-900' },
    { label: 'Ended', value: stats.ended, className: 'bg-neutral-200 text-neutral-700' },
    { label: 'Keys given', value: stats.keysGiven, className: 'bg-emerald-100 text-emerald-900' },
    {
      label: 'Winners drawn',
      value: stats.winnersDrawn,
      className: 'bg-emerald-100 text-emerald-900',
    },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {pills.map((p) => (
        <span key={p.label} className={`rounded px-2.5 py-1 text-xs font-medium ${p.className}`}>
          {p.label} <span className="font-semibold">{String(p.value)}</span>
        </span>
      ))}
    </div>
  )
}
