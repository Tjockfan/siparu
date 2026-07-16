/**
 * A logbook is kept in UTC.
 *
 * The column says UTC, the whole stack underneath is UTC (the plugin stamps rows in
 * epoch ms, /snapshots windows on startOfUtcDay), and at sea a log time is UTC: it is
 * what an MRCC, a position report and an insurance statement all assume. The screen
 * was the one place that quietly used the reader's own clock - a number that looks
 * plausible, is internally consistent, and is wrong by the reader's offset.
 *
 * These tests fix the reader somewhere other than UTC on purpose. Run from a machine
 * already in UTC they would all pass while proving nothing, which is exactly how this
 * survived.
 */
// Declared rather than pulled in from @types/node: this is the one file in a browser
// bundle that needs the test runner's clock, and widening the app's types to reach it
// would loosen the whole webapp to buy one line.
declare const process: { env: Record<string, string | undefined> }

process.env.TZ = 'Europe/Oslo' // CEST in summer: UTC+2. Norway, where this bites today.

import { describe, expect, it } from 'vitest'
import { dateInputToMs, dateToInput } from './format'

describe('a logbook day is a UTC day, wherever the reader sits', () => {
  it('starts the day at midnight UTC, not the reader\'s midnight', () => {
    expect(dateInputToMs('2026-07-16')).toBe(Date.UTC(2026, 6, 16))
  })

  it('names the day the row belongs to, not the reader\'s calendar', () => {
    // 23:30 UTC on the 16th is already the 17th in Oslo. The logbook says the 16th.
    expect(dateToInput(new Date(Date.UTC(2026, 6, 16, 23, 30)))).toBe('2026-07-16')
    // 00:30 UTC on the 16th is still the 15th in New York, and still the 16th here.
    expect(dateToInput(new Date(Date.UTC(2026, 6, 16, 0, 30)))).toBe('2026-07-16')
  })

  it('gives every day exactly 24 hours, including the two that do not locally', () => {
    // useLogbookData windows a day as dayStart + 24h. On a local clock the DST days
    // are 23 and 25 hours long, so that window silently slips an hour and the rows
    // at the edge land in the wrong day. A UTC day is always 24h, which kills it.
    for (const [day, next] of [
      ['2026-03-29', '2026-03-30'], // Europe springs forward
      ['2026-10-25', '2026-10-26'] // and falls back
    ]) {
      const start = dateInputToMs(day as string)
      expect(dateInputToMs(next as string) - start).toBe(24 * 3600_000)
    }
  })

  it('round-trips: a day named, parsed and named again is the same day', () => {
    for (const day of ['2026-01-01', '2026-03-29', '2026-07-16', '2026-10-25', '2026-12-31']) {
      expect(dateToInput(new Date(dateInputToMs(day)))).toBe(day)
    }
  })
})
