import { describe, expect, it } from 'vitest'
import { AlarmWatch, MAX_ACTIVE_ALARMS } from '../src/alarms'

/**
 * How loud she is, from the notifications Signal K is carrying.
 *
 * This is the one thing about an alert that leaves the boat in the clear, so it is worth
 * being exact about what it means: not "a notification exists" but "the loudest condition
 * currently standing". Everything about WHAT is wrong stays in the sealed body.
 */
describe('reading a severity off the notification tree', () => {
  it('is quiet on a boat with nothing wrong', () => {
    expect(new AlarmWatch().level()).toBe('normal')
  })

  it('maps every state Signal K defines', () => {
    // The vocabulary is fixed by the specification, and all six appear on real boats: a
    // plugin that raises "warn" and one that raises "alert" are both saying the same thing
    // to an owner, and neither is an alarm.
    const cases: Array<[string, 'normal' | 'warning' | 'alarm']> = [
      ['nominal', 'normal'],
      ['normal', 'normal'],
      ['alert', 'warning'],
      ['warn', 'warning'],
      ['alarm', 'alarm'],
      ['emergency', 'alarm']
    ]
    for (const [state, expected] of cases) {
      const w = new AlarmWatch()
      w.ingest('notifications.tanks.fuel.0.currentLevel', { state })
      expect(w.level(), state).toBe(expected)
    }
  })

  it('answers with the loudest condition standing, not the newest', () => {
    const w = new AlarmWatch()
    w.ingest('notifications.electrical.batteries.0.voltage', { state: 'alarm' })
    w.ingest('notifications.environment.depth.belowKeel', { state: 'warn' })
    // The depth warning arrived last. An owner woken for the quieter of two live conditions
    // would have been told the wrong thing.
    expect(w.level()).toBe('alarm')
  })

  it('goes quiet when a condition clears, and says so', () => {
    // Load-bearing, and the reason the level is sent on every frame rather than only when
    // something is wrong: ashore, the fall back to normal is what re-arms the bell. A boat
    // that stopped mentioning a cleared alarm would never ring for the second one.
    const w = new AlarmWatch()
    w.ingest('notifications.tanks.fuel.0.currentLevel', { state: 'alarm' })
    expect(w.level()).toBe('alarm')

    w.ingest('notifications.tanks.fuel.0.currentLevel', { state: 'normal' })
    expect(w.level()).toBe('normal')
  })

  it('drops a notification that Signal K deleted', () => {
    // A cleared notification arrives as a null value, not as a state. Keeping the old one
    // would leave her reporting an alarm that no longer exists, on every frame, for as long
    // as she stays up.
    const w = new AlarmWatch()
    w.ingest('notifications.mob', { state: 'emergency' })
    expect(w.level()).toBe('alarm')

    w.ingest('notifications.mob', null)
    expect(w.level()).toBe('normal')
  })

  it('ignores a state it does not recognise rather than guessing at it', () => {
    // A gateway inventing its own vocabulary must not be able to decide how loud she is in
    // either direction: calling an unknown word an alarm would wake an owner for nothing,
    // and calling it normal would swallow whatever it meant. Silence about it is the honest
    // answer, and it is visible in the log rather than only in the absence of a bell.
    const w = new AlarmWatch()
    w.ingest('notifications.something.odd', { state: 'catastrophe' })
    w.ingest('notifications.something.else', { state: 42 })
    w.ingest('notifications.something.empty', {})
    w.ingest('notifications.something.plain', 'alarm')
    expect(w.level()).toBe('normal')
    expect(w.unknownStates()).toEqual(['catastrophe'])
  })

  it('takes no notice of paths that are not notifications', () => {
    // The subscription is shared with the gauges, so this class sees everything that arrives.
    const w = new AlarmWatch()
    w.ingest('tanks.fuel.0.currentLevel', { state: 'alarm' })
    w.ingest('navigation.speedOverGround', 4.2)
    expect(w.level()).toBe('normal')
  })

  it('holds a bounded number of standing conditions', () => {
    // A misbehaving bus member can invent paths without limit, and this map would grow with
    // them. Only conditions that are actually raised are held at all - a cleared one is
    // deleted rather than stored as normal - so the ceiling is on simultaneous alarms, where
    // sixty-four is already far past anything a real vessel produces.
    const w = new AlarmWatch()
    for (let i = 0; i < MAX_ACTIVE_ALARMS + 20; i++) {
      w.ingest(`notifications.invented.${i}`, { state: 'warn' })
    }
    expect(w.active()).toBe(MAX_ACTIVE_ALARMS)
    expect(w.level()).toBe('warning')
  })

  it('carries what is wrong, not only how loud it is', () => {
    // The half of an alert that goes inside the sealed body. Without it a phone can say
    // "something aboard is wrong" and nothing more, which is a bell with no message behind
    // it: the owner still has to get to the boat to find out what rang.
    const w = new AlarmWatch()
    w.ingest(
      'notifications.tanks.blackWater.0.currentLevel',
      { state: 'alarm', message: 'Holding tank is nearly full.' },
      1_000
    )
    expect(w.conditions()).toEqual([
      {
        path: 'notifications.tanks.blackWater.0.currentLevel',
        state: 'alarm',
        message: 'Holding tank is nearly full.',
        since: 1_000
      }
    ])
  })

  it('has nothing to say about a boat with nothing wrong', () => {
    expect(new AlarmWatch().conditions()).toEqual([])
  })

  it('offers no message rather than a shape a screen cannot print', () => {
    // Signal K does not promise a message, and a gateway may put anything in the field. An
    // object reaching a phone would be rendered "[object Object]", which reads as a bug in
    // the app rather than as an absent sentence.
    const w = new AlarmWatch()
    w.ingest('notifications.a', { state: 'alarm' }, 1)
    w.ingest('notifications.b', { state: 'alarm', message: { text: 'nope' } }, 1)
    w.ingest('notifications.c', { state: 'alarm', message: '   ' }, 1)
    expect(w.conditions().map((c) => c.message)).toEqual([null, null, null])
  })

  it('re-stamps `since` when the state changes, and holds it when it does not', () => {
    // A warning that has stood all afternoon and became an alarm a minute ago is an alarm a
    // minute old. A phone printing "3 hours" beside the word ALARM would be telling its
    // reader something untrue about how long the boat has been in this state.
    const w = new AlarmWatch()
    const path = 'notifications.environment.depth.belowKeel'
    w.ingest(path, { state: 'warn', message: 'Shallow.' }, 1_000)
    // Same condition, refreshed message: the clock is measuring how long it has stood.
    w.ingest(path, { state: 'warn', message: 'Still shallow.' }, 5_000)
    expect(w.conditions()[0]).toMatchObject({ since: 1_000, message: 'Still shallow.' })

    w.ingest(path, { state: 'alarm', message: 'Aground soon.' }, 9_000)
    expect(w.conditions()[0]).toMatchObject({ state: 'alarm', since: 9_000 })
  })

  it('drops a cleared condition out of the list, not just out of the level', () => {
    // The list and the severity have to agree. A phone shown `alert: normal` beside a body
    // still listing an alarm would have to decide which of the two the boat meant.
    const w = new AlarmWatch()
    w.ingest('notifications.mob', { state: 'emergency', message: 'Man overboard.' }, 1)
    w.ingest('notifications.mob', { state: 'normal' }, 2)
    expect(w.level()).toBe('normal')
    expect(w.conditions()).toEqual([])
  })

  it('puts the loudest first, and the longest standing first within a level', () => {
    // A notification shows one line. It has to be the alarm rather than whichever warning
    // happens to have been ingested first, and within a level the oldest is the one an owner
    // reading a list expects at the top of its group.
    const w = new AlarmWatch()
    w.ingest('notifications.b', { state: 'warn' }, 1_000)
    w.ingest('notifications.a', { state: 'alarm' }, 3_000)
    w.ingest('notifications.c', { state: 'alarm' }, 2_000)
    expect(w.conditions().map((c) => c.path)).toEqual([
      'notifications.c', // alarm, older
      'notifications.a', // alarm, newer
      'notifications.b' // warning
    ])
  })

  it('still hears an alarm once the ceiling is full of warnings', () => {
    // The case that decides whether the ceiling is a safety measure or a hole in one: a flood
    // of invented warnings must not be able to hide the one condition that matters. A louder
    // state takes the place of a quieter one rather than being turned away at a full map.
    const w = new AlarmWatch()
    for (let i = 0; i < MAX_ACTIVE_ALARMS; i++) {
      w.ingest(`notifications.invented.${i}`, { state: 'warn' })
    }
    w.ingest('notifications.mob', { state: 'emergency' })
    expect(w.level()).toBe('alarm')
    expect(w.active()).toBe(MAX_ACTIVE_ALARMS)
  })
})

/**
 * Which of those conditions is allowed to reach a pocket.
 *
 * The filter runs over the flag and the sentence beside it, and deliberately not over the
 * list in the body. That difference is the whole feature: the owner asked not to be woken,
 * not to be kept in the dark, and because the filtering happens aboard the carrier never
 * learns a muted event occurred at all.
 */
describe('a severity the owner asked not to hear', () => {
  const loud = () => {
    const w = new AlarmWatch()
    w.ingest('notifications.tanks.blackWater.0.currentLevel', { state: 'alarm', message: 'Full.' }, 1_000)
    w.ingest('notifications.environment.depth.belowKeel', { state: 'warn', message: 'Shallow.' }, 2_000)
    return w
  }

  it('is loud for everything when nothing was asked', () => {
    expect(loud().level()).toBe('alarm')
    expect(loud().note()?.path).toBe('notifications.tanks.blackWater.0.currentLevel')
  })

  it('falls to the loudest condition still allowed to ring', () => {
    const w = loud()
    const audible = (p: string): boolean => p !== 'notifications.tanks.blackWater.0.currentLevel'
    expect(w.level(audible)).toBe('warning')
  })

  it('is quiet when every standing condition is muted', () => {
    expect(loud().level(() => false)).toBe('normal')
  })

  it('takes the sentence from the condition that rang, not the one that was muted', () => {
    // The note is the line on a lock screen. Taking it from the whole list would put a muted
    // condition's words on a phone that rang for a different one.
    const w = loud()
    const note = w.note((p) => p !== 'notifications.tanks.blackWater.0.currentLevel')
    expect(note?.message).toBe('Shallow.')
    expect(w.note(() => false)).toBeUndefined()
  })

  it('leaves the body alone, so anybody who opens the app sees the lot', () => {
    // Not being woken is not the same as not being told, and this is the line between them.
    const w = loud()
    w.level(() => false)
    expect(w.conditions()).toHaveLength(2)
  })

  it('can mute a warning without muting the alarm on the same path', () => {
    const w = new AlarmWatch()
    w.ingest('notifications.tanks.fuel.0.currentLevel', { state: 'warn' })
    const fromAlarm = (_p: string, s: 'warning' | 'alarm'): boolean => s === 'alarm'
    expect(w.level(fromAlarm)).toBe('normal')
    w.ingest('notifications.tanks.fuel.0.currentLevel', { state: 'alarm' })
    expect(w.level(fromAlarm)).toBe('alarm')
  })
})

describe('offering the owner something to choose from', () => {
  it('remembers a path that has since gone quiet', () => {
    // The condition worth muting is the one that comes and goes, and it is rarely standing at
    // the moment he goes looking for it.
    const w = new AlarmWatch()
    w.ingest('notifications.tanks.bilge.0.currentLevel', { state: 'alarm' })
    w.ingest('notifications.tanks.bilge.0.currentLevel', { state: 'normal' })
    expect(w.active()).toBe(0)
    expect(w.knownPaths()).toEqual(['notifications.tanks.bilge.0.currentLevel'])
  })

  it('does not offer a path that never carried a notification', () => {
    const w = new AlarmWatch()
    w.ingest('notifications.junk', 'not an object')
    w.ingest('notifications.invented', { state: 'whenever' })
    w.ingest('tanks.fuel.0.currentLevel', { state: 'alarm' })
    expect(w.knownPaths()).toEqual([])
  })
})

/**
 * Which event the severity is about.
 *
 * The shore is handed one word for the whole vessel, so a second alarm raised while a first
 * one stands is byte-for-byte the first one still standing, and the bell rings on the rise:
 * the second condition is never heard. The boat is the only party that can tell them apart.
 * This is her saying "that is a different one" without saying which one.
 */
describe('the marker that names an event', () => {
  const BLACKWATER = 'notifications.tanks.blackWater.0.currentLevel'
  const DEPTH = 'notifications.environment.depth.belowKeel'
  const FUEL = 'notifications.tanks.fuel.0.currentLevel'

  it('is nothing at all on a boat that has never raised one', () => {
    expect(new AlarmWatch().risenAt()).toBe(0)
  })

  it('does not move while one condition stands', () => {
    // Three hundred frames of the same alarm are one event. This is what stops the vessel
    // waking her owner every two seconds for ten minutes.
    const w = new AlarmWatch()
    w.ingest(BLACKWATER, { state: 'alarm' }, 1_000)
    const first = w.risenAt()
    w.ingest(BLACKWATER, { state: 'alarm', message: 'Still full.' }, 5_000)
    expect(w.risenAt()).toBe(first)
  })

  /** The hole this exists to close. Both conditions are alarms, so the severity never moves. */
  it('moves when a second condition rises under a standing one', () => {
    const w = new AlarmWatch()
    w.ingest(BLACKWATER, { state: 'alarm' }, 1_000)
    const first = w.risenAt()
    expect(w.level()).toBe('alarm')

    w.ingest(DEPTH, { state: 'alarm' }, 9_000)
    expect(w.level()).toBe('alarm') // unchanged: the word ashore says nothing new
    expect(w.risenAt()).toBeGreaterThan(first) // and this does
  })

  it('moves when a standing warning becomes an alarm', () => {
    const w = new AlarmWatch()
    w.ingest(FUEL, { state: 'warn' }, 1_000)
    const first = w.risenAt()
    w.ingest(FUEL, { state: 'alarm' }, 4_000)
    expect(w.risenAt()).toBeGreaterThan(first)
  })

  /**
   * The reason it only ever moves forward. Without that, clearing the newer of two conditions
   * drops the marker back to the older one's clock, which reads ashore as a fresh event: a
   * bell rung to announce that a problem went away.
   */
  it('does not move backwards when the newer of two clears', () => {
    const w = new AlarmWatch()
    w.ingest(BLACKWATER, { state: 'alarm' }, 1_000)
    w.ingest(DEPTH, { state: 'alarm' }, 9_000)
    const peak = w.risenAt()

    w.ingest(DEPTH, null, 10_000)
    expect(w.level()).toBe('alarm') // the first one is still standing
    expect(w.risenAt()).toBe(peak)
  })

  it('moves again when a condition clears and comes back', () => {
    const w = new AlarmWatch()
    w.ingest(FUEL, { state: 'alarm' }, 1_000)
    const first = w.risenAt()
    w.ingest(FUEL, { state: 'normal' }, 2_000)
    expect(w.level()).toBe('normal')
    w.ingest(FUEL, { state: 'alarm' }, 6_000)
    expect(w.risenAt()).toBeGreaterThan(first)
  })

  /**
   * Read with the same filter as the flag and the sentence. A muted condition that moved a
   * marker the shore rings on would silence the words and keep the bell, which is the exact
   * opposite of what the owner asked for.
   */
  it('ignores a condition the owner muted', () => {
    const w = new AlarmWatch()
    w.ingest(BLACKWATER, { state: 'alarm' }, 1_000)
    const audible = (p: string): boolean => p !== DEPTH
    const before = w.risenAt(audible)

    w.ingest(DEPTH, { state: 'alarm' }, 9_000)
    expect(w.risenAt(audible)).toBe(before)
    // And the same boat, with nothing muted, does hear it.
    expect(w.risenAt()).toBeGreaterThan(before)
  })
})
