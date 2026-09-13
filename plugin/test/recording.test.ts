import { describe, expect, it } from 'vitest'
import { statusLine } from '../src/recording'

describe('the status line at the helm', () => {
  it('says Recording while the disk takes the rows', () => {
    expect(statusLine({ ok: true, failures: 0, last_error: null }, 12, 5)).toBe('Recording - 12 rows today')
    expect(statusLine({ ok: true, failures: 0, last_error: null }, 0, null)).toBe('Recording - 0 rows today, no data yet')
    expect(statusLine({ ok: true, failures: 2, last_error: 'EIO: bad sector' }, 40, 90)).toBe(
      'Recording - 40 rows today, data age 90s'
    )
  })

  it('says NOT recording, and why, the moment the disk refuses one', () => {
    const line = statusLine({ ok: false, failures: 1, last_error: 'EROFS: read-only file system' }, 300, 5)
    expect(line.startsWith('NOT recording')).toBe(true)
    expect(line).toContain('EROFS')
    expect(line).toContain('300 rows today')
  })
})
