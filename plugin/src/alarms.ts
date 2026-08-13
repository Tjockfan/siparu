/**
 * How loud she is right now, read from the notifications Signal K is carrying.
 *
 * This is the only thing about an alert that leaves the boat legible: a carrier has to know
 * that a notification is due, so severity cannot be sealed, and the carrier must not be able
 * to decide that one is not due, so it rides inside her signature. What is actually wrong -
 * fuel, fire, shore power, an anchor dragging - stays in the encrypted body and is
 * indistinguishable from outside.
 *
 * Only conditions that are actually raised are held. A cleared notification is deleted rather
 * than stored as normal, which is what keeps this map the size of the problems a vessel has
 * rather than the size of the notification tree she publishes.
 */
import type { AlertLevel, AlertNote, StandingCondition } from './contract'

/**
 * The ceiling on simultaneously standing conditions.
 *
 * A misbehaving bus member can invent paths without limit and this map would grow with them.
 * Sixty-four is far past anything a real vessel raises at once, and because cleared
 * conditions are deleted rather than kept, the ordinary boat sits at zero.
 */
export const MAX_ACTIVE_ALARMS = 64

/**
 * How much of a message survives into a notification.
 *
 * Signal K puts no ceiling on the sentence a gateway writes, and this one travels sealed and
 * padded on a path with a hard limit. Two lines is what a lock screen shows anyway.
 */
export const MAX_NOTE_MESSAGE = 160

/** Every state the Signal K specification defines, and how loud each one is. */
const LEVEL_OF: Readonly<Record<string, AlertLevel>> = {
  nominal: 'normal',
  normal: 'normal',
  // Two words for the same thing as far as an owner is concerned: something wants attention
  // and it is not an alarm. Plugins in the wild use both.
  alert: 'warning',
  warn: 'warning',
  alarm: 'alarm',
  emergency: 'alarm'
}

const RANK: Readonly<Record<AlertLevel, number>> = { normal: 0, warning: 1, alarm: 2 }

/** The prefix that makes a path a notification rather than a gauge. */
export const NOTIFICATIONS_PREFIX = 'notifications.'

/**
 * How many distinct notification paths are remembered for the sake of offering them.
 *
 * The same misbehaving bus member that could flood {@link MAX_ACTIVE_ALARMS} can invent paths
 * that clear immediately, and those would grow this set without ever standing. A screen
 * offering a list to choose from stops being usable long before this, so the ceiling costs an
 * honest boat nothing.
 */
export const MAX_KNOWN_PATHS = 256

/**
 * Whether one standing condition is allowed to raise the flag.
 *
 * Supplied by the rule store; the default here is what a boat with no rules does, which is
 * ring for everything. Passing nothing must therefore mean the loud answer: this file is
 * about being heard, and a silence chosen by nobody is the one outcome not worth risking.
 */
export type Audible = (path: string, state: Exclude<AlertLevel, 'normal'>) => boolean

const ALWAYS: Audible = () => true

/** A condition being held, minus the path the map already keys it by. */
type Held = Omit<StandingCondition, 'path'>

export class AlarmWatch {
  /** Path to condition, for the ones standing right now. Normal is absence, not an entry. */
  private readonly standing = new Map<string, Held>()
  /** States that arrived in no vocabulary we know, so a boat reporting one can be diagnosed. */
  private readonly unknown = new Set<string>()
  /**
   * Every notification path seen since start, standing or since cleared.
   *
   * Kept because a screen that offers the owner conditions to mute cannot offer him what is
   * standing at that moment: a bilge alarm that comes and goes is exactly the one he wants to
   * silence, and it is rarely raised while he is looking for it.
   */
  private readonly seen = new Set<string>()
  /**
   * The moment the newest audible condition began, and it only ever moves forward.
   *
   * The shore cannot work out on its own whether an arriving frame is a new event. All it is
   * given is how loud the boat is, which is one word for the whole vessel, so a second alarm
   * raised while a first one stands looks identical to the first one still standing - and the
   * owner is never told about the second. She is the only party that can tell them apart, and
   * this is her saying so, without saying which condition it was.
   *
   * Monotonic on purpose. The value is otherwise the newest `since` among the conditions that
   * may be heard, and that number FALLS when the newest of two clears - which would read
   * ashore as a fresh event and ring a bell to announce that a problem went away.
   */
  private risen = 0

  constructor(private readonly debug: (msg: string) => void = () => {}) {}

  /**
   * Take one path/value pair from the delta stream.
   *
   * Shares the subscription with the gauges, so it sees everything that arrives and takes
   * notice of notifications only.
   */
  ingest(path: string, value: unknown, now: number = Date.now()): void {
    if (!path.startsWith(NOTIFICATIONS_PREFIX)) return

    // A notification Signal K has deleted arrives as a null value rather than as a state.
    // Keeping the old one would leave her reporting a condition that no longer exists, on
    // every frame, for as long as she stays up.
    if (value === null || value === undefined) {
      this.standing.delete(path)
      return
    }
    if (typeof value !== 'object') return

    const raw = (value as Record<string, unknown>).state
    if (typeof raw !== 'string') return

    const level = LEVEL_OF[raw]
    if (level === undefined) {
      // Neither an alarm nor quiet: a gateway inventing its own vocabulary must not be able
      // to decide how loud she is in either direction. Said out loud once, because the
      // alternative is a boat whose alarms silently do not reach her owner.
      if (!this.unknown.has(raw)) {
        this.unknown.add(raw)
        this.debug(`notification state not recognised, ignoring: ${raw} (${path})`)
      }
      return
    }

    // Remembered from here rather than at the top of the function: this is the point at which
    // what arrived is known to be a real Signal K notification and not any object that happened
    // to be published under the tree. Quiet ones are remembered too, because a path standing at
    // normal is still one its owner may want silenced before it next goes off.
    if (this.seen.size < MAX_KNOWN_PATHS) this.seen.add(path)

    if (level === 'normal') {
      this.standing.delete(path)
      return
    }

    if (this.standing.size >= MAX_ACTIVE_ALARMS && !this.standing.has(path)) {
      // A flood of invented warnings must not be able to hide the one condition that matters,
      // so a louder state takes the place of a quieter one instead of being turned away at a
      // full map. Nothing displaces an equal: the conditions already held got here first.
      const quietest = this.quietest()
      if (quietest === undefined || RANK[level] <= RANK[quietest[1].state]) return
      this.standing.delete(quietest[0])
    }

    // A message that is not a sentence is not a message: an object or a number here would
    // reach a screen as "[object Object]", which is worse than the honest blank.
    const raw2 = (value as Record<string, unknown>).message
    const message = typeof raw2 === 'string' && raw2.trim() !== '' ? raw2.trim() : null

    // Re-stamped when the state changes, carried otherwise. A condition that has stood as a
    // warning all afternoon and just became an alarm is an alarm that is seconds old, and a
    // phone reading `since` beside the word ALARM must not be told otherwise. An unchanged
    // condition keeps its clock even as the message is refreshed, because it is the same
    // condition and the screen is showing how long it has stood.
    const before = this.standing.get(path)
    const since = before !== undefined && before.state === level ? before.since : now

    this.standing.set(path, { state: level, message, since })
  }

  /**
   * The loudest condition standing that the owner asked to hear about, which is what travels
   * beside the sealed body.
   *
   * The filter belongs here rather than on the list: a muted condition stays in the body and
   * on the screen of anybody who opens the app, and only this word is withheld. That is the
   * whole difference between not being woken and being kept in the dark.
   *
   * What withholding the word buys is that the carrier cannot read which condition was muted
   * and cannot decide that it was not. It does not hide that a condition is standing - an
   * unpadded body grows by the length of one, and sizes are measurable. See the wiring in
   * index.ts, where that limit is written down rather than assumed away.
   */
  level(audible: Audible = ALWAYS): AlertLevel {
    let loudest: AlertLevel = 'normal'
    for (const [path, held] of this.standing) {
      if (!audible(path, held.state)) continue
      if (RANK[held.state] > RANK[loudest]) loudest = held.state
    }
    return loudest
  }

  /**
   * Which event the flag beside the body is about, as a moment in time.
   *
   * The shore rings when this changes and stays quiet when it does not, which is the whole
   * of what it needs and less than it used to be told. Two things follow. A second condition
   * raised under a standing one moves this forward even though the loudness is unchanged, so
   * it is heard; and a condition standing through three hundred frames never moves it, so it
   * is heard once.
   *
   * Read with the same filter as the flag and the sentence. A muted condition must not move
   * a marker the shore rings on, or muting would silence the words and keep the bell.
   *
   * Zero while nothing audible has ever stood. The field is left off the frame then, which
   * also keeps it off every frame of an ordinary quiet day.
   */
  risenAt(audible: Audible = ALWAYS): number {
    for (const [path, held] of this.standing) {
      if (!audible(path, held.state)) continue
      if (held.since > this.risen) this.risen = held.since
    }
    return this.risen
  }

  /**
   * What is actually wrong, for the sealed body.
   *
   * Loudest first, and oldest first within a level: a phone showing one line has to be shown
   * the alarm rather than whichever warning happens to hash first, and an owner reading the
   * list wants the condition that has stood longest at the top of its group.
   */
  conditions(): StandingCondition[] {
    return [...this.standing]
      .map(([path, held]) => ({ path, ...held }))
      .sort((a, b) => RANK[b.state] - RANK[a.state] || a.since - b.since || a.path.localeCompare(b.path))
  }

  /** How many conditions are standing. For the ceiling's own tests, and for diagnosis. */
  active(): number {
    return this.standing.size
  }

  /** States seen that are in no vocabulary we know, in the order they first arrived. */
  unknownStates(): string[] {
    return [...this.unknown]
  }

  /**
   * Every notification path this boat has raised since start, in the order first seen.
   *
   * What a screen offers the owner to choose from. Sent only inside a sealed answer: the list
   * of notifications a vessel is wired for says a good deal about what is aboard her.
   */
  knownPaths(): string[] {
    return [...this.seen]
  }

  /**
   * The one line a notification can show, or nothing when she is quiet.
   *
   * The loudest and longest standing, which is the same line `conditions()` puts first: a
   * pocket buzzing at three in the morning gets one sentence, and it has to be about the
   * condition that earned the bell rather than whichever arrived last.
   *
   * The message is shortened here rather than on the screen. It is sealed, padded and carried
   * on a path with a hard size limit, and a gateway is free to put a paragraph in a
   * notification.
   */
  note(audible: Audible = ALWAYS): AlertNote | undefined {
    // Filtered by the same rule as the flag, and it has to be: the note is the sentence on the
    // lock screen of the bell the flag rang. Taking it from the whole list would put a muted
    // condition's words on a phone that rang for a different one.
    const first = this.conditions().find((c) => audible(c.path, c.state))
    if (first === undefined) return undefined
    return {
      path: first.path,
      state: first.state,
      message: first.message === null ? null : first.message.slice(0, MAX_NOTE_MESSAGE),
      since: first.since
    }
  }

  private quietest(): [string, Held] | undefined {
    let found: [string, Held] | undefined
    for (const entry of this.standing) {
      if (found === undefined || RANK[entry[1].state] < RANK[found[1].state]) found = entry
    }
    return found
  }
}
