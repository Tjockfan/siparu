/** UTC time keys used for raw file names and rollup lines. */

/** "2026-07-10T21" for the UTC hour containing ts. */
export function hourKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13)
}

/** "2026-07-10" for the UTC day containing ts. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

export function dayOfHourKey(hour: string): string {
  return hour.slice(0, 10)
}

/** "2026-07" month prefix for a rollup file, from an hour key. */
export function monthOfHourKey(hour: string): string {
  return hour.slice(0, 7)
}

/** Epoch ms of UTC midnight for the day containing ts. */
export function startOfUtcDay(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
