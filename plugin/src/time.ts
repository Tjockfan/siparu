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

/**
 * Epoch ms of the hour a rollup line names ("2026-07-10T21" -> 21:00:00Z that day).
 *
 * A summarised line is an hour rather than a moment, and this is that hour. Derived from the
 * key the line is filed under rather than from the samples inside it: the key is what decides
 * which readings went into the line, so it is the only stamp that cannot disagree with them.
 */
export function hourStartOf(hour: string): number {
  return Date.parse(`${hour}:00:00Z`)
}

/** Epoch ms of the day a rollup line names ("2026-07-10" -> midnight UTC that day). */
export function dayStartOf(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/** Epoch ms of UTC midnight for the day containing ts. */
export function startOfUtcDay(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
