/* What became of her last report, in a sentence somebody at the helm can act on.
 *
 * A boat that is sealing and has been left with nobody to seal to sends nothing, on purpose.
 * From every screen in the product that looks exactly like a boat whose link is down: the
 * chart stops moving and no error is raised, because from the socket's point of view nothing
 * is wrong. This is where that difference is put into words on the boat's own screen, which
 * is the only place a person can do anything about it.
 */
import type { SealingStatus } from '../data/api'

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

/** A screen she will not seal to, and the boat's own words for why. */
export interface RefusedScreen {
  kid: string
  reason: string
}

export interface ScreenRefusals {
  /** Refused by the approval chain: nothing she trusts vouches for them. */
  unapproved: RefusedScreen[]
  /** Accepted by the chain and still unwrapped on the last frame: a duplicate id, a bad key. */
  unwrapped: RefusedScreen[]
  /** She has no root, so she checks the shape of a key and never who vouched for it. */
  unpinned: boolean
}

/**
 * What the boat is refusing, and what she cannot check, for the one screen where somebody can
 * act on it.
 *
 * The two lists are kept apart deliberately. A row in `unapproved` is the alarm this whole
 * mechanism exists to raise: it is a key on her list that no screen she trusts has vouched
 * for, which is what somebody quietly adding a reader of their own looks like from here. A row
 * in `unwrapped` is a fault: a screen her owner authorised, that the cryptography would not
 * take. Under one heading an owner would learn to dismiss both.
 *
 * Null when there is nothing to say, so a healthy boat renders nothing at all.
 */
export function screenRefusals(s: SealingStatus | null | undefined): ScreenRefusals | null {
  // Only a boat that is actually sealing has screens to speak about. Unpinned and silent is a
  // boat with no screens at all, and the band above already says so in the words that fit.
  if (!s || s.mode !== 'sealed') return null

  // An older plugin answers with none of the three fields and falls out below on its own:
  // nothing refused, and `screens_pinned` absent rather than false. That is why the unpinned
  // test below is written against `=== false`. A truthiness check would tell every boat on an
  // earlier build that her screens are unpinned, which is a claim about a mechanism she does
  // not have, and the test named for that case is what holds this line in place.

  const unapproved = s.screens_skipped ?? []
  const unwrapped = s.screens_rejected ?? []
  const unpinned = s.screens_pinned === false
  if (!unpinned && unapproved.length === 0 && unwrapped.length === 0) return null
  return { unapproved, unwrapped, unpinned }
}
