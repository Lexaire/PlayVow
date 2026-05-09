// Single source of truth for the "community-common achievement" threshold.
//
// Definition: an achievement counts as "community-common" if at least
// COMMON_ACHIEVEMENT_THRESHOLD percent of all owners have unlocked it.
//
// Why 50, not Vasharal's 60: Steam's denominator for
// GetGlobalAchievementPercentagesForApp is "all app owners" (including
// people who own the game but never launched it). That inflates every
// number relative to "% of players who actually played." Starting at 50
// roughly compensates; expect to tune by ±10 once we see real distributions.
// See YIRG-ACHIEVEMENTS.md for the full rationale.
export const COMMON_ACHIEVEMENT_THRESHOLD = 50

// The three states a per-win progress lookup can produce. Distinguishing
// them at the type level lets the UI render "—" for 'no_percent_data'
// (transient: refresh job will populate within ~24h), hide the row
// entirely for 'no_achievements' (criterion doesn't apply), and show real
// numbers for 'computed'. See YIRG-ACHIEVEMENTS.md for display rules.
export type CommonAchievementProgress =
  | {
      readonly status: 'computed'
      readonly unlocked: number
      readonly total: number
      readonly threshold: number
    }
  | { readonly status: 'no_percent_data' }
  | { readonly status: 'no_achievements' }
