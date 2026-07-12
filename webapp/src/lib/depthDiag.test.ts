import { describe, it, expect } from 'vitest'
import { depthDiagnosis, depthDiagLabel } from './depthDiag'

const H = 3600_000
const NOW = 1_700_000_000_000

function paths(entries: Record<string, number>) {
  const out: Record<string, { last_seen_ts: number }> = {}
  for (const [k, ts] of Object.entries(entries)) out[k] = { last_seen_ts: ts }
  return out
}

describe('depthDiagnosis', () => {
  it('value present → no note', () => {
    expect(depthDiagnosis(12.4, paths({ 'environment.depth.belowTransducer': NOW }))).toEqual({
      kind: 'none'
    })
  })

  it('health not loaded yet → silent (plain dash)', () => {
    expect(depthDiagnosis(null, undefined)).toEqual({ kind: 'none' })
    expect(depthDiagnosis(null, null)).toEqual({ kind: 'none' })
  })

  it('no depth path ever seen → no-sensor', () => {
    expect(depthDiagnosis(null, paths({ 'navigation.position': NOW }))).toEqual({
      kind: 'no-sensor'
    })
    expect(depthDiagnosis(null, {})).toEqual({ kind: 'no-sensor' })
  })

  it('depth path seen before but value gone → quiet with latest ts', () => {
    const diag = depthDiagnosis(
      null,
      paths({
        'environment.depth.belowTransducer': NOW - 5 * H,
        'environment.depth.belowKeel': NOW - 2 * H
      })
    )
    expect(diag).toEqual({ kind: 'quiet', lastTs: NOW - 2 * H })
  })
})

describe('depthDiagLabel', () => {
  it('none → null (nothing rendered)', () => {
    expect(depthDiagLabel({ kind: 'none' }, NOW)).toBeNull()
  })

  it('no-sensor → calm two-line copy, not an alarm', () => {
    expect(depthDiagLabel({ kind: 'no-sensor' }, NOW)).toBe('NO SENSOR\nNORMAL')
  })

  it('quiet under 24h → clock time', () => {
    const ts = NOW - 3 * H
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    expect(depthDiagLabel({ kind: 'quiet', lastTs: ts }, NOW)).toBe(`QUIET · ${hh}:${mm}`)
  })

  it('quiet over 24h → day count, not a misleading clock time', () => {
    expect(depthDiagLabel({ kind: 'quiet', lastTs: NOW - 26 * H }, NOW)).toBe('QUIET · 1d')
    expect(depthDiagLabel({ kind: 'quiet', lastTs: NOW - 80 * H }, NOW)).toBe('QUIET · 3d')
  })
})
