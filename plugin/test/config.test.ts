import { describe, expect, it } from 'vitest'
import { DEFAULTS, isCalendarMonthDay, resolveOptions, safeRelayUrl } from '../src/config'

describe('seasonStart is a calendar date, not just two numbers', () => {
  it('accepts real month-day pairs', () => {
    expect(resolveOptions({ seasonStart: '01-01' }).seasonStart).toBe('01-01')
    expect(resolveOptions({ seasonStart: '04-15' }).seasonStart).toBe('04-15')
    expect(resolveOptions({ seasonStart: '12-31' }).seasonStart).toBe('12-31')
    // Leap day is allowed: the season window resolves it against each year.
    expect(resolveOptions({ seasonStart: '02-29' }).seasonStart).toBe('02-29')
  })

  it('falls back on dates no calendar holds', () => {
    // These used to pass the bare \d{2}-\d{2} regex and silently produced an
    // empty season - a user reading "no voyages" off a typo.
    expect(resolveOptions({ seasonStart: '99-99' }).seasonStart).toBe(DEFAULTS.seasonStart)
    expect(resolveOptions({ seasonStart: '00-00' }).seasonStart).toBe(DEFAULTS.seasonStart)
    expect(resolveOptions({ seasonStart: '13-01' }).seasonStart).toBe(DEFAULTS.seasonStart)
    expect(resolveOptions({ seasonStart: '02-30' }).seasonStart).toBe(DEFAULTS.seasonStart)
    expect(resolveOptions({ seasonStart: '04-31' }).seasonStart).toBe(DEFAULTS.seasonStart)
    expect(resolveOptions({ seasonStart: '4-1' }).seasonStart).toBe(DEFAULTS.seasonStart)
  })

  it('isCalendarMonthDay pins the boundary, not the middle of the band', () => {
    expect(isCalendarMonthDay('01-31')).toBe(true)
    expect(isCalendarMonthDay('01-32')).toBe(false)
    expect(isCalendarMonthDay('12-31')).toBe(true)
    expect(isCalendarMonthDay('12-32')).toBe(false)
    expect(isCalendarMonthDay('06-30')).toBe(true)
    expect(isCalendarMonthDay('06-31')).toBe(false)
  })
})

describe('ports must sit on the globe', () => {
  const port = (latitude: number, longitude: number) => ({ name: 'X', latitude, longitude, radiusNm: 4 })

  it('accepts coordinates within bounds, including the edges', () => {
    expect(resolveOptions({ ports: [port(90, 180)] }).ports).toHaveLength(1)
    expect(resolveOptions({ ports: [port(-90, -180)] }).ports).toHaveLength(1)
    expect(resolveOptions({ ports: [port(43.7, 7.4)] }).ports).toHaveLength(1)
  })

  it('drops coordinates off the globe instead of feeding them to haversine', () => {
    expect(resolveOptions({ ports: [port(999, 7.4)] }).ports).toHaveLength(0)
    expect(resolveOptions({ ports: [port(90.1, 0)] }).ports).toHaveLength(0)
    expect(resolveOptions({ ports: [port(0, 180.1)] }).ports).toHaveLength(0)
    expect(resolveOptions({ ports: [port(NaN, 0)] }).ports).toHaveLength(0)
    expect(resolveOptions({ ports: [port(0, Infinity)] }).ports).toHaveLength(0)
  })

  it('keeps the good port when a bad one sits next to it', () => {
    const ports = resolveOptions({ ports: [port(999, 0), port(43.7, 7.4)] }).ports
    expect(ports).toHaveLength(1)
    expect(ports[0]?.latitude).toBe(43.7)
  })
})

describe('the relay URL never carries the boat token in clear text', () => {
  it('accepts https and trims a trailing slash', () => {
    expect(resolveOptions({ relayUrl: 'https://relay.example' }).relayUrl).toBe('https://relay.example')
    expect(resolveOptions({ relayUrl: 'https://relay.siparu.app/' }).relayUrl).toBe('https://relay.siparu.app')
  })

  it('falls back to the default for any plain-http URL, loopback included', () => {
    // The relay is on the public internet; there is no loopback exception, so the
    // token never rides plain http even in a hand-edited config.
    expect(resolveOptions({ relayUrl: 'http://evil.example' }).relayUrl).toBe(DEFAULTS.relayUrl)
    expect(resolveOptions({ relayUrl: 'http://localhost:8787' }).relayUrl).toBe(DEFAULTS.relayUrl)
    expect(resolveOptions({ relayUrl: 'http://192.168.1.10:8787' }).relayUrl).toBe(DEFAULTS.relayUrl)
    expect(resolveOptions({ relayUrl: 'ftp://nope' }).relayUrl).toBe(DEFAULTS.relayUrl)
    expect(resolveOptions({ relayUrl: 'not a url' }).relayUrl).toBe(DEFAULTS.relayUrl)
  })

  it('safeRelayUrl is the single gate live.ts derives ws/wss from', () => {
    // live.ts turns https->wss off this value; a plain-http URL passing here would
    // put the token on an unencrypted websocket too.
    expect(safeRelayUrl('http://relay.example')).toBeUndefined()
    expect(safeRelayUrl('https://relay.example')).toBe('https://relay.example')
  })
})
