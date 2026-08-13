import { describe, it, expect } from 'vitest'
import { sealingNotice } from './sealing'

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
