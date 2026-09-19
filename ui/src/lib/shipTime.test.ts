/**
 * A log row is read on the ship's clock, not the reader's.
 *
 * The hour on a row is the hour at the position the row was taken, with the offset written
 * beside it. It depends on where the boat was and on nothing about who is looking: an owner at
 * a desk in another zone and a captain aboard read the same four digits.
 *
 * The reader is fixed somewhere that is neither UTC nor the boat's zone on purpose. From a
 * machine in either of those, a version that quietly used the reader's clock would pass.
 */
declare const process: { env: Record<string, string | undefined> }

process.env.TZ = 'America/New_York'

import { describe, expect, it, vi } from 'vitest'
import tzlookup from 'tz-lookup'
import { pageZones, shipClock, shipDayLine, shipOffset, shipTimes } from './shipTime'

// Valletta: UTC+2 in September, and nowhere near the reader this suite is run as.
const PORT = { lat: 35.9, lon: 14.52 }
const at = (h: number, m = 0) => Date.UTC(2026, 8, 17, h, m)

describe('the hour on a row is the hour where the boat was', () => {
  it('prints the hour in port for a row taken in port, wherever the reader sits', () => {
    expect(shipClock(at(0, 59), 'Europe/Malta')).toBe('02:59')
    expect(shipClock(at(22, 59), 'Europe/Malta')).toBe('00:59')
  })

  it('stays on UTC when the boat never said where she was', () => {
    expect(shipClock(at(0, 59), null)).toBe('00:59')
    expect(shipOffset(at(0, 59), null)).toBe('UTC')
  })

  it('writes the offset the way a log margin does', () => {
    expect(shipOffset(at(12), 'Asia/Riyadh')).toBe('UTC+3')
    expect(shipOffset(at(12), 'Asia/Kolkata')).toBe('UTC+5:30')
    expect(shipOffset(at(12), 'America/Halifax')).toBe('UTC-3')
    expect(shipOffset(at(12), 'UTC')).toBe('UTC')
  })

  it('follows the clocks when they change, because the offset belongs to the moment', () => {
    // Europe falls back on 25 Oct 2026 at 01:00 UTC.
    expect(shipOffset(Date.UTC(2026, 9, 25, 0, 30), 'Europe/Paris')).toBe('UTC+2')
    expect(shipOffset(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Paris')).toBe('UTC+1')
  })

  it('turns the day at the ship\'s midnight', () => {
    // 22:59 UTC on the 17th is already Friday the 18th aboard.
    expect(shipDayLine(at(21, 59), 'Europe/Malta')).toMatch(/^THU · 17 /)
    expect(shipDayLine(at(22, 59), 'Europe/Malta')).toMatch(/^FRI · 18 /)
    expect(shipDayLine(at(22, 59), null)).toMatch(/^THU · 17 /)
  })

  it('refuses a zone the runtime does not know rather than throwing a page away', () => {
    expect(shipClock(at(0, 59), 'Not/AZone')).toBe('00:59')
    expect(shipOffset(at(0, 59), 'Not/AZone')).toBe('UTC')
  })
})

describe('each row takes the zone of its own position', () => {
  const lookup = (_lat: number, lon: number) => (lon > 20 ? 'Europe/Athens' : 'Europe/Malta')

  it('reads the zone off the row, so a passage that changes zone changes clock with it', () => {
    const rows = [
      { ts: 1, lat: 38, lon: 15 },
      { ts: 2, lat: 37, lon: 27 },
    ]
    const z = pageZones(rows, lookup)
    expect(z.get(1)).toBe('Europe/Malta')
    expect(z.get(2)).toBe('Europe/Athens')
  })

  it('lends a row with no fix the zone of the nearest row that has one', () => {
    const rows = [
      { ts: 1, lat: null, lon: null },
      { ts: 2, lat: 37, lon: 27 },
      { ts: 3, lat: null, lon: null },
      { ts: 4, lat: 38, lon: 15 },
      { ts: 5, lat: null, lon: null },
    ]
    const z = pageZones(rows, lookup)
    expect([1, 2, 3, 4, 5].map((t) => z.get(t))).toEqual([
      'Europe/Athens',
      'Europe/Athens',
      'Europe/Athens',
      'Europe/Malta',
      'Europe/Malta',
    ])
  })

  it('does not care what order the page hands the rows over in', () => {
    const rows = [
      { ts: 3, lat: null, lon: null },
      { ts: 1, lat: 37, lon: 27 },
    ]
    expect(pageZones(rows, lookup).get(3)).toBe('Europe/Athens')
  })

  it('leaves every row on UTC when no row has a fix, or the lookup never loaded', () => {
    const rows = [{ ts: 1, lat: null, lon: null }]
    expect(pageZones(rows, lookup).get(1)).toBeNull()
    expect(pageZones([{ ts: 1, lat: 37, lon: 27 }], null).get(1)).toBeNull()
  })

  it('survives a lookup that throws on a position it cannot place', () => {
    const bad = () => {
      throw new Error('out of range')
    }
    expect(pageZones([{ ts: 1, lat: 95, lon: 27 }], bad).get(1)).toBeNull()
  })

  it('places a real harbour with the lookup the app ships', () => {
    const z = pageZones([{ ts: at(0, 59), ...PORT }], tzlookup)
    expect(z.get(at(0, 59))).toBe('Europe/Malta')
    expect(shipClock(at(0, 59), z.get(at(0, 59)) ?? null)).toBe('02:59')
  })
})

describe('a page of rows, read on the ship\'s clock', () => {
  const lookup = (_lat: number, lon: number) => (lon > 20 ? 'Europe/Athens' : 'Europe/Malta')

  it('names the one offset over the column when every row shares it', () => {
    const t = shipTimes([{ ts: at(0, 59), ...PORT }, { ts: at(1, 59), ...PORT }], lookup)
    expect(t.head).toBe('UTC+2')
    expect(t.mixed).toBe(false)
    expect(t.clock(at(0, 59))).toBe('02:59')
  })

  it('says UTC over an empty page and over a page with no fix, which is what the rows are in', () => {
    expect(shipTimes([], lookup).head).toBe('UTC')
    const t = shipTimes([{ ts: at(0, 59), lat: null, lon: null }], lookup)
    expect(t.head).toBe('UTC')
    expect(t.clock(at(0, 59))).toBe('00:59')
  })

  it('cannot name one offset over a page that holds two, and says so', () => {
    const t = shipTimes(
      [
        { ts: at(10), lat: 38, lon: 15 },
        { ts: at(11), lat: 37, lon: 27 },
      ],
      lookup,
    )
    expect(t.mixed).toBe(true)
    expect(t.head).toBe('SHIP')
    expect(t.clock(at(10))).toBe('12:00')
    expect(t.clock(at(11))).toBe('14:00')
    expect(t.dayLine(at(10))).toMatch(/ · UTC\+2$/)
    expect(t.dayLine(at(11))).toMatch(/ · UTC\+3$/)
  })

  it('writes the offset into the day line, so the line turns when either one does', () => {
    const t = shipTimes([{ ts: at(21, 59), ...PORT }, { ts: at(22, 59), ...PORT }], lookup)
    expect(t.dayLine(at(21, 59))).toMatch(/^THU · 17 .* · UTC\+2$/)
    expect(t.dayLine(at(22, 59))).toMatch(/^FRI · 18 .* · UTC\+2$/)
  })

  it('hands the date and the offset over apart as well, for a sheet that sets them apart', () => {
    const t = shipTimes([{ ts: at(22, 59), ...PORT }], lookup)
    expect(t.day(at(22, 59))).toMatch(/^FRI · 18 .*2026$/)
    expect(t.offset(at(22, 59))).toBe('UTC+2')
    expect(t.dayLine(at(22, 59))).toBe(`${t.day(at(22, 59))} · ${t.offset(at(22, 59))}`)
  })

  it('reads a moment that is not on the page in UTC rather than guessing', () => {
    const t = shipTimes([{ ts: at(0, 59), ...PORT }], lookup)
    expect(t.clock(at(5))).toBe('05:00')
  })
})

/**
 * `shortOffset` is the newest thing this file asks of the runtime, and a browser a few years old
 * refuses it with a RangeError. The offset is what stands over the lane, so a runtime that
 * cannot name one cannot be shown the ship's hours either: hours under a head that says UTC
 * would be the one failure this module exists to prevent. The page reads in UTC, all of it.
 */
describe('a runtime that cannot name an offset', () => {
  it('reads the whole page in UTC, head and hours together, and does not throw it away', async () => {
    const Real = Intl.DateTimeFormat
    const old = Object.create(Intl)
    old.DateTimeFormat = function (l: string, o: Intl.DateTimeFormatOptions) {
      if ((o?.timeZoneName as string) === 'shortOffset') throw new RangeError('shortOffset')
      return new Real(l, o)
    }
    vi.stubGlobal('Intl', old)
    vi.resetModules()
    try {
      // A fresh copy of the module: the one above has already built its formatters.
      const fresh = await import('./shipTime')
      const t = fresh.shipTimes([{ ts: at(0, 59), ...PORT }], () => 'Europe/Malta')
      expect(t.head).toBe('UTC')
      expect(t.clock(at(0, 59))).toBe('00:59')
      expect(t.dayLine(at(0, 59))).toMatch(/^THU · 17 .* · UTC$/)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
