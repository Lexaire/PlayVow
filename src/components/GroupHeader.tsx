import type { GroupSummary } from '#/server/queries'

export type GroupHeaderProps = {
  readonly group: GroupSummary
}

export function GroupHeader({ group }: GroupHeaderProps) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-bold">{group.name}</h1>
      {group.description ? <p className="text-neutral-600">{group.description}</p> : null}
      <p className="text-xs text-neutral-500">{group.playWindowDays}-day play window</p>
    </header>
  )
}
