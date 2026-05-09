import type { WinStatus } from '#/db/schema'
import type { ModAction } from '#/domain/win-status'

export const STATUS_PILL_STYLES: Readonly<Record<WinStatus, string>> = {
  pending: 'bg-yellow-100 text-yellow-800',
  played: 'bg-green-100 text-green-800',
  kicked: 'bg-red-100 text-red-800',
  not_in_group: 'bg-violet-100 text-violet-800',
  exempt: 'bg-blue-100 text-blue-800',
}

export const ACTION_LABELS: Readonly<Record<ModAction, string>> = {
  mark_played: 'Mark played',
  kick: 'Kick',
  not_in_group: 'Not in group',
  exempt: 'Exempt',
  reset: 'Reset to pending',
}

export const ACTION_STYLES: Readonly<Record<ModAction, string>> = {
  mark_played: 'bg-emerald-700 hover:bg-emerald-800',
  kick: 'bg-rose-700 hover:bg-rose-800',
  not_in_group: 'bg-violet-700 hover:bg-violet-800',
  exempt: 'bg-sky-700 hover:bg-sky-800',
  reset: 'bg-neutral-700 hover:bg-neutral-800',
}

export const ACTION_PROMPTS: Readonly<Record<ModAction, string>> = {
  mark_played: 'Mark this win as played?',
  kick: 'Kick this user from the group?',
  not_in_group: 'Mark this winner as not in the group?',
  exempt: 'Exempt this win from the deadline?',
  reset: 'Reset this win to pending?',
}

export const formatStatusError = (e: { readonly kind: string }): string => {
  switch (e.kind) {
    case 'win_not_found':
      return 'Win not found.'
    case 'no_op':
      return 'Already in that state.'
    default:
      return 'Unknown error.'
  }
}
