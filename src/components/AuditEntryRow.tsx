import type { AuditEntry } from '#/repos/auditLog'

const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`

const summarizeNotesUpdate = (before: string | null, after: string | null): string => {
  if (before === null && after !== null) return `Notes added: ${truncate(after, 80)}`
  if (before !== null && after === null) return 'Notes cleared'
  if (after !== null) return `Notes updated: ${truncate(after, 80)}`
  return 'Notes unchanged'
}

// Single source of truth for human-readable audit-event descriptions. New
// event kinds added to AuditEvent will surface a TS exhaustiveness error
// here, forcing every reader to be updated in one place.
export const describeAuditEvent = (event: AuditEntry['event']): string => {
  switch (event.kind) {
    case 'win_created':
      return `Win created (${event.source})`
    case 'win_status_changed':
      return `Status: ${event.from} → ${event.to}`
    case 'win_notes_updated':
      return summarizeNotesUpdate(event.before, event.after)
    case 'group_created':
      return `Group created: ${event.name}`
    case 'group_updated':
      return `Group updated: ${event.after.name}`
    case 'role_granted':
      return `Role granted: ${event.before} → ${event.after}${event.reason ? ` (${event.reason})` : ''}`
    case 'role_revoked':
      return `Role revoked: ${event.before} → ${event.after}${event.reason ? ` (${event.reason})` : ''}`
    case 'cookie_set':
      return 'SteamGifts cookie set'
    case 'cookie_cleared':
      return 'SteamGifts cookie cleared'
    case 'cookie_tested':
      return `SteamGifts cookie tested: ${event.result}`
  }
}

const actorLabel = (actor: AuditEntry['actor']): string => {
  if (actor === null) return 'system'
  return actor.steamgiftsUsername ?? actor.steamId ?? `#${actor.id}`
}

export function AuditEntryRow({ entry }: { readonly entry: AuditEntry }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-2">
        <span>{describeAuditEvent(entry.event)}</span>
        <span className="text-xs text-neutral-500">by {actorLabel(entry.actor)}</span>
      </div>
      <span className="shrink-0 text-xs text-neutral-500">
        {dateTimeFormat.format(entry.createdAt)}
      </span>
    </div>
  )
}
