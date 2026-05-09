import { WIN_STATUSES, type WinStatus } from '#/db/schema'

export const MOD_ACTIONS = ['mark_played', 'kick', 'not_in_group', 'exempt', 'reset'] as const
export type ModAction = (typeof MOD_ACTIONS)[number]

const ACTION_TARGET: Readonly<Record<ModAction, WinStatus>> = {
  mark_played: 'played',
  kick: 'kicked',
  not_in_group: 'not_in_group',
  exempt: 'exempt',
  reset: 'pending',
}

export const targetStatus = (action: ModAction): WinStatus => ACTION_TARGET[action]

export const isValidTransition = (from: WinStatus, to: WinStatus): boolean => from !== to

export const isValidAction = (from: WinStatus, action: ModAction): boolean =>
  isValidTransition(from, ACTION_TARGET[action])

export const allowedActionsFrom = (from: WinStatus): ReadonlyArray<ModAction> =>
  MOD_ACTIONS.filter((a) => isValidAction(from, a))

export const targetsForBulk = (sources: ReadonlySet<WinStatus>): ReadonlyArray<WinStatus> =>
  WIN_STATUSES.filter((t) => !sources.has(t))

export type StatusTransitionError =
  | { readonly kind: 'no_op'; readonly status: WinStatus }
  | { readonly kind: 'action_not_allowed'; readonly from: WinStatus; readonly action: ModAction }
