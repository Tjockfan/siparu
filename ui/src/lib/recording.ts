/* Whether her history is still being kept, in a sentence somebody at the helm can act on.
 *
 * Every other figure on the board goes on looking healthy when the disk stops taking rows: the
 * frames arrive, the instruments move, the count on the plugin's status line rises. A card
 * remounted read-only, or a full partition, is found months later as a hole in the logbook. The
 * plugin now counts only rows on disk and says so on its status line; this is the same verdict
 * put where an owner is actually looking.
 */

export interface WriteVerdict {
  ok: boolean
  failures: number
  last_error: string | null
}

export interface RecordingNotice {
  title: string
  detail: string
}

/**
 * One sentence of cause, read off the code the plugin puts at the head of the disk's own
 * message. A fixed list of causes under a code that says otherwise sends a skipper to pull
 * the wrong thing apart, so an unknown code gets no sentence: the disk's words are already
 * on the band.
 */
function cause(error: string | null): string {
  const code = error?.match(/^([A-Z]{3,10})\b/)?.[1]
  switch (code) {
    case 'ENOSPC':
      return ' The data partition is full.'
    case 'EROFS':
      return ' The card is mounted read-only, which is what a card does after an I/O error.'
    case 'EACCES':
    case 'EPERM':
      return ' The user the plugin runs as cannot write to that directory.'
    default:
      return ''
  }
}

/**
 * Null unless the disk refused, because the ordinary state is already visible: a recording boat
 * looks like a working boat. A plugin from before the verdict existed sends none, and that
 * silence is not a refusal.
 *
 * The claim is kept to what the verdict measures: the raw row. The voyage and phase engines are
 * fed whether or not the disk took it and keep their own files, so "nothing is being kept"
 * would be more than the flag knows.
 */
export function recordingNotice(w: WriteVerdict | null | undefined): RecordingNotice | null {
  if (!w || w.ok) return null
  const why = w.last_error ?? 'no reason was given'
  return {
    title: 'Not recording her history',
    detail: `No row has reached her disk since the last one was refused (${why}). She tries again on every frame and this clears the moment one lands; until it does, the logbook has a hole here.${cause(w.last_error)}`
  }
}
