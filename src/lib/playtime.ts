// Storage matches Steam's native unit (minutes). UI helpers below convert
// for compact display vs. tooltip-precise display.

export const formatPlaytimeCompact = (minutes: number): string => {
  if (minutes === 0) return '0 min'
  if (minutes < 60) return `${String(minutes)} min`
  return `${(minutes / 60).toFixed(1)}h`
}

// Tooltip form — keeps the exact hours+minutes breakdown.
export const formatPlaytimePrecise = (minutes: number): string => {
  if (minutes === 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${String(m)}m`
  if (m === 0) return `${String(h)}h`
  return `${String(h)}h ${String(m)}m`
}
