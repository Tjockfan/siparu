import { describe, it, expect } from 'vitest'
import { recordingNotice } from './recording'

describe('recordingNotice', () => {
  it('says nothing while the disk is taking her rows', () => {
    expect(recordingNotice({ ok: true, failures: 0, last_error: null })).toBeNull()
  })

  it('says nothing when the plugin is too old to report its writes at all', () => {
    // A boat on an earlier build sends no verdict. Silence there is not a refusal, and a band
    // that reads "not recording" on every older boat would be a claim about a mechanism she
    // does not have.
    expect(recordingNotice(undefined)).toBeNull()
    expect(recordingNotice(null)).toBeNull()
  })

  it('names the refusal in the disk\'s own words', () => {
    const n = recordingNotice({ ok: false, failures: 3, last_error: 'EROFS: read-only file system' })
    expect(n).not.toBeNull()
    expect(n?.title).toContain('Not recording')
    expect(n?.detail).toContain('EROFS: read-only file system')
  })

  it('ties the cause to the code on the band rather than to a fixed list', () => {
    // EACCES is neither a full partition nor a read-only card. A sentence naming those under
    // that code would send a skipper to the wrong thing; the sentence follows the code.
    const acc = recordingNotice({ ok: false, failures: 1, last_error: "EACCES: permission denied, open '/x/raw/h.ndjson'" })
    expect(acc?.detail).toContain('cannot write to that directory')
    expect(acc?.detail).not.toContain('full')
    expect(acc?.detail).not.toContain('read-only')
    const full = recordingNotice({ ok: false, failures: 1, last_error: 'ENOSPC: no space left on device' })
    expect(full?.detail).toContain('partition is full')
    const ro = recordingNotice({ ok: false, failures: 1, last_error: 'EROFS: read-only file system' })
    expect(ro?.detail).toContain('mounted read-only')
  })

  it('offers no cause for a code it does not know', () => {
    const n = recordingNotice({ ok: false, failures: 1, last_error: 'EIO: i/o error' })
    expect(n?.detail).toContain('EIO: i/o error')
    expect(n?.detail.trim().endsWith('has a hole here.')).toBe(true)
  })

  it('claims only what the flag measures: the row, not every file aboard', () => {
    const n = recordingNotice({ ok: false, failures: 1, last_error: 'EIO: i/o error' })
    expect(n?.detail).not.toMatch(/nothing .* is being kept/i)
  })

  it('still speaks when the disk gave no words', () => {
    const n = recordingNotice({ ok: false, failures: 1, last_error: null })
    expect(n?.detail).not.toContain('null')
    expect(n?.detail.length).toBeGreaterThan(20)
  })
})
