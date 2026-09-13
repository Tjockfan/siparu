/**
 * Whether her keys stand between her and the shore.
 *
 * Two states make every frame she seals worthless before it leaves: the shore holds
 * different keys for her (a restored card, a cloned machine, a key file lost and rebuilt),
 * so the relay drops each frame at signature verification and says nothing; or her own key
 * file is there and cannot be read, so she has nothing to sign with. Neither is the
 * sealer's to notice - it sees a device list and a key pair, or the lack of one, and its
 * own sentence for the second case ("no keys of her own yet") is true and useless. Until
 * 2026-09-13 the only correct diagnosis lived in the key poll's last error, read by nobody,
 * while /health said "sealed" and the status line said "Recording", and from ashore she was
 * simply a boat gone quiet.
 *
 * This is the one place that turns the poll's verdict into the silence the sealer already
 * knows how to produce, so that the status line, /health and the socket agree.
 */
export interface KeyGateInput {
  /** The key poll's state. */
  state: string
  /** Its sentence for the skipper, when it has one. */
  lastError: string | null
  /** Whether a key file is there that could not be understood. */
  refused: boolean
}

export interface KeyGateVerdict {
  mode: 'blocked'
  reason: string
}

export function keyGate(input: KeyGateInput): KeyGateVerdict | null {
  if (input.state === 'mismatch') {
    return {
      mode: 'blocked',
      reason: input.lastError ?? 'Siparu already holds different keys for this boat. Unlink her and pair again.'
    }
  }
  if (input.refused) {
    return {
      mode: 'blocked',
      reason:
        input.lastError ??
        'The key file on this boat cannot be read. Restore keys.json from a backup of her data directory, or unlink her and pair again.'
    }
  }
  return null
}
