/**
 * What the client asks the boat for when a reader asks for minutes.
 *
 * Two things are being pinned here, and they are the same mistake seen from two sides. The
 * boat serves a limited number of rows and cuts the rest; which end she cuts is decided by
 * the order the request carries, so a request for "the last hour, newest first" that reaches
 * her as "oldest first" comes back as the FIRST hour of the window - the right count of rows,
 * every one of them wrong. And the window where minutes stop belongs to the boat, not to a
 * calendar: she says where it starts, and what lies before it is filled from the hourly
 * rollup rather than assumed to be missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

type Call = { url: string; params: URLSearchParams }
let calls: Call[]
let rawRows: { ts: number; sog: number }[]
let minutesFrom: number | undefined
let hourRows: { last_ts: number; metrics: Record<string, { last: number }> }[]

const NOW = Date.UTC(2026, 0, 16, 12, 30, 0)
const DAY = 86_400_000

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  calls = []
  rawRows = []
  minutesFrom = undefined
  hourRows = []
  vi.stubGlobal('fetch', async (url: string) => {
    const [path, qs] = url.split('?')
    calls.push({ url: path!, params: new URLSearchParams(qs ?? '') })
    if (path!.endsWith('/snapshots')) return jsonResponse({ rows: rawRows, clamped: false, minutesFrom })
    if (path!.endsWith('/rollups/hourly')) return jsonResponse({ rows: hourRows })
    throw new Error(`unexpected fetch: ${url}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const snapshotsCall = () => calls.find((c) => c.url.endsWith('/snapshots'))!
const hourlyCall = () => calls.find((c) => c.url.endsWith('/rollups/hourly'))

describe('logbook.minutes', () => {
  it('carries the reader order to the boat, so a small limit keeps the end he asked for', async () => {
    rawRows = [{ ts: NOW - 60_000, sog: 7 }]
    minutesFrom = NOW - 7 * DAY

    await api.logbook.minutes({ limit: 61, order: 'desc' })

    expect(snapshotsCall().params.get('order')).toBe('desc')
    expect(snapshotsCall().params.get('bucket')).toBe('1')
  })

  it('fills what lies before the boat minute floor from the hourly rollup', async () => {
    const floor = NOW - 3 * DAY
    minutesFrom = floor
    rawRows = [{ ts: floor + 60_000, sog: 7 }]
    hourRows = [{ last_ts: floor - 3_600_000, metrics: { sog: { last: 4 } } }]

    const r = await api.logbook.minutes({ from: NOW - 10 * DAY, order: 'asc', limit: 5000 })

    expect(hourlyCall(), 'nothing asked the rollup for the days before the floor').toBeDefined()
    expect(Number(hourlyCall()!.params.get('to'))).toBe(floor - 1)
    expect(r.rows.map((x) => x.sog)).toEqual([4, 7])
    expect(r.minutesFrom).toBe(floor)
  })

  it('asks the rollup for nothing when the window sits inside the minutes', async () => {
    minutesFrom = NOW - 7 * DAY
    rawRows = [{ ts: NOW - 60_000, sog: 7 }]

    await api.logbook.minutes({ from: NOW - 3600_000, order: 'asc', limit: 5000 })

    expect(hourlyCall()).toBeUndefined()
  })
})
