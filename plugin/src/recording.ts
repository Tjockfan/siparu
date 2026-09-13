/**
 * The one line a person reads at the helm about whether her history is being kept.
 *
 * Kept apart from the plugin body so that it can be pinned on its own: the plugin's test
 * harness starts and stops the plugin, it does not tick the clock, and the sentence below is
 * the difference between finding a read-only card today and finding a hole in the logbook
 * months from now.
 */
export interface WriteVerdict {
  ok: boolean
  failures: number
  last_error: string | null
}

export function statusLine(writes: WriteVerdict, rowsToday: number, dataAgeSeconds: number | null): string {
  const age = dataAgeSeconds === null ? ', no data yet' : dataAgeSeconds > 60 ? `, data age ${dataAgeSeconds}s` : ''
  if (!writes.ok) {
    return `NOT recording - the disk refused the last row (${writes.last_error ?? 'unknown error'}); ${rowsToday} rows today before it did${age}`
  }
  return `Recording - ${rowsToday} rows today${age}`
}
