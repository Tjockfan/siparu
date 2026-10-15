/**
 * What a voyage does when the boat goes off the air.
 *
 * A boat loses power at the berth within minutes of arriving, before the closing
 * streak has run; she comes back the next morning, still. The passage ended before
 * the gap, not five minutes after the power returned. A dropout mid-passage is the
 * other case: she comes back still making way, and the passage simply continues.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { ReconcileState, VoyageRow, reconcile } from '../src/voyage'

const MIN = 60_000
const MOVING = 3.1 // m/s, ~6 kn
const STILL = 0.02

function rows(spec: { n: number; sog: number; state: string; after?: number }[]): VoyageRow[] {
  const out: VoyageRow[] = []
  let ts = Date.UTC(2026, 5, 1, 10, 0, 0)
  let lat = 43.0
  for (const s of spec) {
    ts += s.after ?? 0
    for (let i = 0; i < s.n; i++) {
      if (s.sog > 1) lat += 0.0008
      out.push({ ts, lat, lon: 7.0, sog: s.sog, nav_state: s.state, path_values: {} })
      ts += MIN
    }
  }
  return out
}

async function run(all: VoyageRow[]) {
  const state: ReconcileState = { voyages: [], nextId: 1 }
  await reconcile(state, all, DEFAULTS.voyage, [], async (from, to) =>
    all.filter((r) => r.ts >= from && r.ts <= to)
  )
  return state.voyages
}

describe('voyage across a data gap', () => {
  it('closes at the last row before the gap when she comes back still', async () => {
    const all = rows([
      { n: 20, sog: STILL, state: 'moored' },
      { n: 41, sog: MOVING, state: 'motoring' },
      { n: 2, sog: STILL, state: 'moored' }, // arrived; power goes before the close streak runs
      { n: 120, sog: STILL, state: 'moored', after: 15 * 60 * MIN } // next morning
    ])
    const lastBeforeGap = all[20 + 41 + 2 - 1]!.ts
    const vs = await run(all)
    expect(vs).toHaveLength(1)
    expect(vs[0]!.status).toBe('closed')
    expect(vs[0]!.end_ts).toBe(lastBeforeGap)
    // A passage of under an hour, not one of fifteen.
    expect(vs[0]!.end_ts! - vs[0]!.start_ts).toBeLessThan(60 * MIN)
  })

  it('leaves the close where she is found when the record stopped with her still at sea', async () => {
    const all = rows([
      { n: 20, sog: STILL, state: 'moored' },
      { n: 41, sog: MOVING, state: 'motoring' }, // the record stops mid-passage
      { n: 120, sog: STILL, state: 'moored', after: 15 * 60 * MIN } // found berthed next morning
    ])
    const berth = all[20 + 41]!
    const vs = await run(all)
    expect(vs).toHaveLength(1)
    // Her arrival fell inside the gap; the end is not dated at sea, so the arrival fix is the berth.
    // The first row back carries the gap and starts no streak; the five after it close her.
    expect(vs[0]!.end_ts).toBe(all[20 + 41 + 5]!.ts)
    expect(vs[0]!.end_lat).toBe(berth.lat)
  })

  it('a second gap keeps the first as the end', async () => {
    const all = rows([
      { n: 20, sog: STILL, state: 'moored' },
      { n: 41, sog: MOVING, state: 'motoring' },
      { n: 2, sog: STILL, state: 'moored' },
      { n: 3, sog: STILL, state: 'moored', after: 60 * MIN }, // back briefly, still
      { n: 120, sog: STILL, state: 'moored', after: 60 * MIN } // and off again
    ])
    const vs = await run(all)
    expect(vs).toHaveLength(1)
    expect(vs[0]!.end_ts).toBe(all[20 + 41 + 2 - 1]!.ts)
  })

  it('carries on when she comes back still making way', async () => {
    const all = rows([
      { n: 20, sog: STILL, state: 'moored' },
      { n: 30, sog: MOVING, state: 'motoring' },
      { n: 30, sog: MOVING, state: 'motoring', after: 20 * MIN }, // a dropout at sea
      { n: 10, sog: STILL, state: 'moored' }
    ])
    const vs = await run(all)
    expect(vs).toHaveLength(1)
    // Closed by the ordinary streak, five minutes into the stop.
    expect(vs[0]!.end_ts).toBe(all[20 + 30 + 30 + 4]!.ts)
  })

  it('does not close on the gap alone if she then gets under way again', async () => {
    const all = rows([
      { n: 20, sog: STILL, state: 'moored' },
      { n: 30, sog: MOVING, state: 'motoring' },
      { n: 1, sog: STILL, state: 'moored' },
      { n: 1, sog: STILL, state: 'moored', after: 30 * MIN }, // back, a single still row
      { n: 30, sog: MOVING, state: 'motoring' },
      { n: 10, sog: STILL, state: 'moored' }
    ])
    const vs = await run(all)
    expect(vs).toHaveLength(1)
    expect(vs[0]!.end_ts).toBe(all[all.length - 10 + 4]!.ts)
  })
})
