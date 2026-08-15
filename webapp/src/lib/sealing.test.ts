import { describe, it, expect } from 'vitest'
import { sealingNotice, screenRefusals } from './sealing'

describe('sealingNotice', () => {
  it('says nothing while she is sealing to somebody', () => {
    expect(sealingNotice({ devices: 2, mode: 'sealed', reason: null })).toBeNull()
  })

  it('says nothing before she has reported anything at all', () => {
    // A boat that is not paired yet. Nothing has gone wrong, and the pairing panel above this
    // band is already saying what is missing.
    expect(sealingNotice({ devices: 0, mode: 'none', reason: null })).toBeNull()
  })

  it('says nothing when the plugin is too old to report sealing at all', () => {
    expect(sealingNotice(undefined)).toBeNull()
  })

  it("carries the plugin's reason into the sentence rather than inventing one", () => {
    const n = sealingNotice({
      devices: 0,
      mode: 'blocked',
      reason: 'the shore has named no screen this boat can seal to. Authorise one again to bring her back'
    })
    expect(n).not.toBeNull()
    expect(n?.detail).toContain('the shore has named no screen this boat can seal to')
  })

  it('carries the other silence too, which reads differently to a skipper', () => {
    // A boat nobody has authorised yet reports nothing, and what she is owed is the sentence
    // that says so - not the one about screens that went away.
    const n = sealingNotice({
      devices: 0,
      mode: 'blocked',
      reason: 'no screen has been authorised to read her yet'
    })
    expect(n?.detail).toContain('no screen has been authorised to read her yet')
  })

  it('separates the recording that continues from the reporting that stopped', () => {
    const n = sealingNotice({ devices: 0, mode: 'blocked', reason: 'this boat has no keys of her own yet' })
    // A skipper reading this must not conclude the boat has stopped keeping her own history.
    expect(n?.detail.toLowerCase()).toContain('recording')
  })

  it('still speaks when the reason is missing, because silence is the failure being reported', () => {
    const n = sealingNotice({ devices: 0, mode: 'blocked', reason: null })
    expect(n).not.toBeNull()
    expect(n?.detail.length).toBeGreaterThan(0)
  })
})

describe('screenRefusals', () => {
  const sealing = { devices: 2, mode: 'sealed' as const, reason: null, screens_pinned: true }

  it('says nothing about a pinned boat sealing to everybody on her list', () => {
    expect(screenRefusals(sealing)).toBeNull()
  })

  it('says nothing when the plugin is too old to report any of this', () => {
    // The three fields arrived together. A boat running an earlier build answers without them,
    // and a screen that read their absence as "nothing refused" would be right by accident and
    // wrong the day one of them means something.
    expect(screenRefusals({ devices: 1, mode: 'sealed', reason: null })).toBeNull()
  })

  it('names a screen the chain refused, with the reason the boat gave', () => {
    const r = screenRefusals({
      ...sealing,
      screens_skipped: [{ kid: 'k-1', reason: 'no approval from a screen she trusts' }]
    })
    expect(r?.unapproved).toEqual([{ kid: 'k-1', reason: 'no approval from a screen she trusts' }])
    expect(r?.unpinned).toBe(false)
  })

  it('keeps a chain refusal apart from a screen the last frame could not be wrapped to', () => {
    // Same shape, opposite meaning: one is somebody pressing a key onto her list, the other is
    // an authorised screen that got nothing. Pooling them would put an alarm and a fault under
    // one heading.
    const r = screenRefusals({
      ...sealing,
      screens_skipped: [{ kid: 'k-1', reason: 'no approval from a screen she trusts' }],
      screens_rejected: [{ kid: 'k-2', reason: 'duplicate key id' }]
    })
    expect(r?.unapproved.map((x) => x.kid)).toEqual(['k-1'])
    expect(r?.unwrapped.map((x) => x.kid)).toEqual(['k-2'])
  })

  it('speaks for an unpinned boat even though she has refused nothing', () => {
    // The legacy fleet. Nothing is wrong with her, and the thing worth saying is what she
    // cannot do: she checks the shape of a key and never who vouched for it.
    const r = screenRefusals({ ...sealing, screens_pinned: false })
    expect(r).not.toBeNull()
    expect(r?.unpinned).toBe(true)
    expect(r?.unapproved).toEqual([])
  })

  it('stays quiet about an unpinned boat that is not sealing at all', () => {
    // Not paired, or paired with nobody authorised. The band above is already saying so, and a
    // second line telling her owner his screens are unpinned would be noise about a boat with
    // no screens to pin.
    expect(screenRefusals({ devices: 0, mode: 'none', reason: null, screens_pinned: false })).toBeNull()
  })
})
