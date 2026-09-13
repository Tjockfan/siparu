import { describe, expect, it } from 'vitest'
import { keyGate } from '../src/keygate'

describe('whether her keys stand between her and the shore', () => {
  it('lets a published boat through', () => {
    expect(keyGate({ state: 'published', lastError: null, refused: false })).toBeNull()
    expect(keyGate({ state: 'failing', lastError: 'Cannot reach Siparu. Is the boat online?', refused: false })).toBeNull()
  })

  it('silences a boat the shore holds different keys for, with the cure in the sentence', () => {
    const verdict = keyGate({
      state: 'mismatch',
      lastError: 'Siparu already holds different keys for this boat. Unlink her and pair again.',
      refused: false
    })
    expect(verdict?.mode).toBe('blocked')
    expect(verdict?.reason).toContain('Unlink her and pair again')
  })

  it('silences a boat whose key file could not be read, naming the file', () => {
    const verdict = keyGate({ state: 'failing', lastError: null, refused: true })
    expect(verdict?.mode).toBe('blocked')
    expect(verdict?.reason).toContain('keys.json')
  })
})
