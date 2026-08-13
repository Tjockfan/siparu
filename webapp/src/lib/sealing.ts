/* What became of her last report, in a sentence somebody at the helm can act on.
 *
 * A boat that is sealing and has been left with nobody to seal to sends nothing, on purpose.
 * From every screen in the product that looks exactly like a boat whose link is down: the
 * chart stops moving and no error is raised, because from the socket's point of view nothing
 * is wrong. This is where that difference is put into words on the boat's own screen, which
 * is the only place a person can do anything about it.
 */
import type { SealingStatus } from './api'

export interface SealingNotice {
  title: string
  detail: string
}

/**
 * Null unless she is refusing to send, because the ordinary state is already visible: a sealing
 * boat looks like a working boat. Only the silence needs a sentence.
 *
 * The reason is the plugin's, quoted rather than reworded. It is written for a skipper and it
 * knows which of the several silences this one is; a second sentence composed here could only
 * guess, and would compete with the one that knows.
 */
export function sealingNotice(s: SealingStatus | null | undefined): SealingNotice | null {
  if (!s || s.mode !== 'blocked') return null
  const why = s.reason ?? 'she could not seal this report to anybody'
  return {
    title: 'Nothing is going ashore',
    // The recording clause is not padding. Without it the honest reading of this band is that
    // the boat has stopped keeping her history too, and an owner who believes that has a
    // reason to start pulling things apart at the helm over a problem that lives ashore.
    detail: `She is still recording her own history, but no report is leaving this boat: ${why}.`
  }
}
