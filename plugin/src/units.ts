/**
 * What a gauge is, and how a person reads it.
 *
 * Signal K carries everything in SI, because the standard says so: metres per second, radians,
 * kelvin, pascals. Nobody reads a chart in pascals. The conversion has to happen somewhere, and
 * the somewhere matters: the boat draws these readings on her own screen and the shore draws
 * the same readings from the same sensors, so if each side owns a copy then the first edit to
 * either one makes two screens disagree about one engine. An owner looking at 4.2 bar aboard
 * and 4.3 bar from a hotel room has no way to tell which is lying, and the whole reason to
 * watch from ashore is trusting what you see.
 *
 * This is where that stops being two copies. It lives in the package the boat ships because
 * that package is the one thing both sides can hold: the boat runs it, and it is on a public
 * registry for the shore to depend on. Nothing here knows what a screen is - no DOM, no clock,
 * no I/O, a path and a number in and a string or a scaled number out - which is what lets it
 * live on both sides at all.
 *
 * WHERE THIS ACTUALLY STANDS, because the guarantee above is worth exactly what is true. The
 * boat's screen reads this file directly: it is in the same package, so a knot and a force 6
 * are this file's answer aboard, today. The shore reads it as a pinned dependency, which means
 * a fix here reaches it when someone bumps that pin and not before. Nothing forces that, and no
 * test on either side notices if it is left behind. So the copies are gone and the drift is
 * not: it moved from a comment asking two files to agree, to a version number asking a person
 * to remember. That is a better place for it and it is not nowhere.
 */
import type { MetricField } from './contract'

/**
 * The factor, spelled out rather than inlined, because it is the hinge of every speed on both
 * screens. Note that `voyage.ts` and `voyagelog.ts` each declare their own: those two are
 * pinned by golden fixtures and were left where they are.
 */
export const MS_TO_KN = 1.94384

/**
 * Speed over ground, with the anchor swing taken out of it.
 *
 * A GPS on a boat lying to her anchor invents 0.1 to 0.3 knots of motion, with a course to
 * match. Anything under this reads as zero. Aboard that is tidiness; from a hundred miles away
 * at three in the morning it is the whole point, because "0.3 kn" on a boat at anchor reads as
 * a boat that has begun to drag and the owner cannot look out of the window to check.
 *
 * The threshold is exported rather than hidden because both screens zero at the same number or
 * neither of them means anything.
 */
export const SOG_VALID_KN = 0.4

/**
 * The scale itself, on the knots it is written in.
 *
 * Private, and the only place the thresholds appear. Both doors below come through here, so a
 * document and a dashboard cannot end up disagreeing about what a force 6 is.
 *
 * It reads knots because that is the unit Beaufort is defined in. That sounds like a detail and
 * was a bug: this used to live on the metres-per-second door, and the knots door reached it by
 * dividing by the knot factor so it could be multiplied straight back. The round trip does not
 * always land where it started - (1/1.94384)*1.94384 is 0.9999999999999999 - so a wind of
 * exactly 1.00 kn came out a flat calm. One input in nine million, and the kind that turns up in
 * a document rather than off an instrument, because a document holds rounded numbers.
 */
function forceFromKn(kn: number): number {
  if (kn < 1) return 0
  if (kn <= 3) return 1
  if (kn <= 6) return 2
  if (kn <= 10) return 3
  if (kn <= 16) return 4
  if (kn <= 21) return 5
  if (kn <= 27) return 6
  if (kn <= 33) return 7
  if (kn <= 40) return 8
  if (kn <= 47) return 9
  if (kn <= 55) return 10
  if (kn <= 63) return 11
  return 12
}

/**
 * Beaufort, from true wind only, in the metres per second Signal K delivers.
 *
 * The same gust cannot be a 6 on the bridge and a 7 in the owner's hand: the moment those two
 * disagree, neither can be trusted.
 */
export function beaufort(ms: number | null | undefined): number | null {
  return typeof ms !== 'number' || Number.isNaN(ms) ? null : forceFromKn(ms * MS_TO_KN)
}

/**
 * Beaufort from knots, for a table that already holds them.
 *
 * The NaN guard is not decoration. `typeof NaN === 'number'`, and every comparison against NaN
 * is false, so a NaN walking into the ladder falls off the end of it and comes out force 12: a
 * missing reading printed as a hurricane. This used to be covered by accident, because the
 * kelvin-door guard caught it on the way through.
 */
export function beaufortFromKn(kn: number | null | undefined): number | null {
  return typeof kn !== 'number' || Number.isNaN(kn) ? null : forceFromKn(kn)
}

/**
 * The dynamic system paths, grouped and read once, for every screen that draws them.
 *
 * These are the engine, tank and generator paths a boat exposes beyond the fixed navigation
 * core. Signal K carries each in SI and the path's last segment fixes the quantity: a
 * `.temperature` is always kelvin, a `.currentLevel` always a fraction of one. So the
 * conversion needs nothing from the boat but the number, which is why it can be decided here
 * rather than by whoever happens to be rendering.
 */
export type SystemTab = 'engine' | 'generator' | 'tanks'

export interface SystemReading {
  tab: SystemTab
  /** What the cell is: "Port", "Fuel 0", "Generator 1". */
  label: string
  /** The metric under the label, or null when the label already says it (a tank's level). */
  sub: string | null
}

/**
 * The order the panels are drawn in, and what they are called.
 *
 * Here rather than on a screen because there are two screens and a tab that reads Engine aboard
 * and Engines ashore is the same failure as a cell that reads 4.2 bar aboard and 4.3 ashore,
 * only louder. The order is a judgement about what an owner reaches for first and it is the
 * same judgement in both places.
 *
 * Which of these a given boat actually gets is not decided here and cannot be: a panel exists
 * if she reports something that falls in it. A motorboat has no wind and a sailing boat may have
 * no generator, and neither is a case anybody writes.
 */
export const SYSTEM_TABS: readonly SystemTab[] = ['engine', 'generator', 'tanks']

export const SYSTEM_TAB_NAMES: Record<SystemTab, string> = {
  engine: 'Engine',
  generator: 'Generator',
  tanks: 'Tanks'
}

/** camelCase or a bare word into a sentence: `oilPressure` -> "Oil pressure", `port` -> "Port". */
function humanize(s: string): string {
  const spaced = s.replace(/([a-z])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/**
 * Signal K carries a volume rate in cubic metres per second and a volume in cubic metres. A
 * fuel gauge is read in litres per hour and litres. The scale is not a nicety: an engine
 * burning 36.6 L/h reports 1.016e-5 in SI, and printed unscaled that is "0.0", a working engine
 * reading as an engine burning nothing at all.
 */
const M3S_TO_LH = 3_600_000
const M3_TO_L = 1000

interface SystemMetric {
  sub: boolean
  fmt: (n: number) => string
  scale: (n: number) => number
  unit: string
}

/**
 * The metrics we know how to read. `sub: false` means the label alone is enough (a tank cell
 * says "Fuel 0" over "72%", not "Fuel 0 / Current level").
 *
 * Keys come in two shapes and are matched longest first (see lookup). One segment
 * ("temperature") claims that word on every path that ends in it, which is right for a
 * quantity the segment alone pins: a `.temperature` is always kelvin, whoever reports it. Two
 * segments ("fuel.rate") claim a family, and the fuel metrics have to be keyed that way. A
 * bare `rate` key would claim `.rate` on every path any boat ever reports - a charger's, a
 * pump's - and dress it in litres per hour on no evidence. That is exactly the accident
 * CORE_SERIES exists to prevent for the barometer's `.pressure`, further down; do not repeat it
 * here by widening a key to save a segment.
 *
 * `fmt` is the cell's one-line reading. `scale` and `unit` are the same conversion pulled
 * apart for a graph, which needs the number on its own to plot and the unit on its own for an
 * axis - `fmt` bakes them together and rounds, and a chart must not round the band it draws.
 */
const kelvin = (): SystemMetric => ({
  sub: true,
  fmt: (k) => `${(k - 273.15).toFixed(1)} °C`,
  scale: (k) => k - 273.15,
  unit: '°C'
})

const pascals = (): SystemMetric => ({
  sub: true,
  fmt: (pa) => `${(pa / 1e5).toFixed(1)} bar`,
  scale: (pa) => pa / 1e5,
  unit: 'bar'
})

/** A fraction of one that the schema itself says is a percentage. Read the note on `gearRatio`. */
const percent = (sub: boolean): SystemMetric => ({
  sub,
  fmt: (r) => `${Math.round(r * 100)}%`,
  scale: (r) => r * 100,
  unit: '%'
})

const SYSTEM_METRIC: Record<string, SystemMetric> = {
  revolutions: { sub: true, fmt: (hz) => `${Math.round(hz * 60)} rpm`, scale: (hz) => hz * 60, unit: 'rpm' },
  runTime: { sub: true, fmt: (s) => `${Math.round(s / 3600)} h`, scale: (s) => s / 3600, unit: 'h' },

  /**
   * Every temperature the schema carries in kelvin, not just the one called `temperature`.
   *
   * This table matches a last segment exactly, so for a long time it claimed `temperature` and
   * silently let the other five through to the unknown-metric fallback: a coolant loop at 82 C
   * printed "355.1", no unit, under a label reading Coolant temperature. Nobody caught it because
   * the boat it was written against reports the short name.
   *
   * Enumerated rather than matched by suffix. A `/Temperature$/` rule would be shorter and would
   * be the same mistake in a new coat: it would claim a segment no schema has published yet, on
   * evidence of nothing but its spelling.
   */
  temperature: kelvin(),
  oilTemperature: kelvin(),
  coolantTemperature: kelvin(),
  intakeManifoldTemperature: kelvin(),
  exhaustTemperature: kelvin(),

  /** The same, for pressure. `transmission.oilPressure` is already caught by its last segment. */
  oilPressure: pascals(),
  coolantPressure: pascals(),
  boostPressure: pascals(),

  currentLevel: percent(false),

  /**
   * The three ratios the schema says out loud are percentages: each is documented
   * "0<=ratio<=1, 1 is 100%".
   *
   * `transmission.gearRatio` is NOT here and must never be, which is the whole reason these are
   * listed one by one instead of a rule saying "ratio means percent". Its unit is `ratio` too,
   * but the schema calls it "engine rotations per propeller shaft rotation": a 2.5:1 gearbox is
   * 2.5, and a screen that read it as 250% would be inventing a reading. It falls through to the
   * plain-number fallback and prints "2.5", which is exactly right, so there is nothing to fix
   * and something to protect.
   */
  engineLoad: percent(true),
  engineTorque: percent(true),
  trimState: percent(true),

  // The fuel family, keyed by family for the reason above: an engine has more than one rate.
  'fuel.rate': {
    sub: true,
    fmt: (v) => `${(v * M3S_TO_LH).toFixed(1)} L/h`,
    scale: (v) => v * M3S_TO_LH,
    unit: 'L/h'
  },
  'fuel.averageRate': {
    sub: true,
    fmt: (v) => `${(v * M3S_TO_LH).toFixed(1)} L/h`,
    scale: (v) => v * M3S_TO_LH,
    unit: 'L/h'
  },
  // A totaliser, and nobody reads a tank's worth of fuel to a tenth of a litre.
  'fuel.used': {
    sub: true,
    fmt: (v) => `${Math.round(v * M3_TO_L)} L`,
    scale: (v) => v * M3_TO_L,
    unit: 'L'
  },
  'fuel.pressure': {
    sub: true,
    fmt: (pa) => `${(pa / 1e5).toFixed(1)} bar`,
    scale: (pa) => pa / 1e5,
    unit: 'bar'
  }
}

/**
 * The sub a metric prints, where its own last segment does not read as one. Keyed exactly as
 * SYSTEM_METRIC is, so one path resolves both tables the same way.
 *
 * Apart from SYSTEM_METRIC because a name is not a conversion, and the two do not line up. A
 * `.type` is an enum word ("diesel", "sterndrive"): it has a sub to print and no scale to print
 * it on, and an `fmt` invented to carry its label would be a number-formatter that never sees a
 * number. Every fuel sub names fuel, because the engine's label and the metric together are the
 * whole reading and "Port / Rate" over a figure leaves a person guessing which of an engine's
 * rates he has.
 *
 * `fuel.type` and `drive.type` are the reason this table is not optional: both are real
 * subscribed paths, both end in `type`, and humanize() subs both as "Type". On a boat reporting
 * the pair, that is two Engine cells reading "Port / Type" - one saying "diesel", one saying
 * "sterndrive" - and nothing on the screen to tell them apart.
 */
const SYSTEM_SUB: Record<string, string> = {
  'fuel.rate': 'Fuel rate',
  'fuel.averageRate': 'Fuel rate (average)',
  // Signal K: "Used fuel since last reset. Resetting is at user discretion", under a PGN called
  // Trip Parameters. So the epoch is unknown and 12400 L is a tank's worth of diesel since
  // nobody knows when. The sub carries that caveat because no other part of the cell can: "Trip
  // fuel used" would be a lie on a counter that has run for years, and a bare "Fuel used"
  // invites a reading of "this trip" that we have no right to.
  'fuel.used': 'Fuel used (since reset)',
  'fuel.pressure': 'Fuel pressure',
  'fuel.type': 'Fuel type',
  'drive.type': 'Drive type'
}

/**
 * The metrics a tab will not show, whatever it can read, keyed as the tables above are.
 *
 * `fuel.economyRate` is a burn rate in m3/s, exactly like `fuel.rate` and `fuel.averageRate`:
 * the schema says so and NMEA 2000 PGN 127497 carries it as "Fuel Rate, Economy | L/h", beside
 * a separate "Instantaneous Fuel Economy" that is also L/h. The standard is muddled and there
 * is no honest plain-English name left: to a person "economy" means distance per volume, and a
 * derived L/nm cell called "Fuel economy" would name a different quantity. Two cells both
 * saying economy while meaning different things is a lie the screen tells, and range and money
 * are the one number a motorboat owner cannot be left guessing at. A gauge we cannot name is a
 * gauge we do not show.
 *
 * It is suppressed HERE, and not by dropping its entry from SYSTEM_METRIC, because dropping the
 * entry does not remove the cell: the path falls through to the unknown-metric fallback and
 * prints raw m3/s as "0.0" under the sub "Economy rate", which is the very bug this file exists
 * to have fixed. Returning null is the same answer describePath already gives a path no tab
 * claims (electrical.batteries.0.voltage), and every caller already handles it: no cell, no
 * export column, no chart.
 *
 * A table rather than a set, so that lookup() resolves it too and a key here cannot come to
 * mean something narrower or wider than the same key in the two tables above.
 */
const SUPPRESSED: Record<string, true> = { 'fuel.economyRate': true }

/**
 * A path's entry in the tables above: its family key ("fuel.rate") first, then its last segment
 * alone ("temperature").
 *
 * Longest first, so a family that has claimed a word keeps it and nothing else is touched: a
 * `.rate` on a path no family claims matches neither key, falls through, and stays the plain
 * number it was. Nothing here reads the value, so a caller with only a path in hand (a chart
 * asking what to write on its axis) gets the same answer as one holding a reading.
 */
function lookup<T>(table: { [key: string]: T }, path: string): T | undefined {
  const seg = path.split('.')
  return table[seg.slice(-2).join('.')] ?? table[seg[seg.length - 1]!]
}

/**
 * What a family of tanks is called on board, where the schema's own word for it is not.
 *
 * Only one entry, and it earns itself. Signal K calls grey water `wasteWater` and its own
 * description reads "Waste water tank (grey water)", so the parenthesis is the schema admitting
 * the path name is not what anyone says. On a boat "waste water" is ambiguous - black is waste
 * too - and grey is not. A tank is a thing a person pumps out in a marina at a particular hour,
 * and the cell has to name it the way the notice on the quay does.
 *
 * Every other family reads correctly from its own segment (freshWater, blackWater, fuel,
 * lubrication, liveWell, baitWell, gas, ballast - the whole published set, verified against the
 * schema), so there is nothing else here and nothing to keep in step.
 */
const TANK_FAMILY: Record<string, string> = { wasteWater: 'Grey water' }

/**
 * A tank or generator's own id, as a person would read it.
 *
 * Almost always an instance number off the bus, and humanize leaves digits exactly as they came,
 * so "Fuel 0" needs no special case here and does not get one. A hand-configured server can name
 * them instead, and then the id is camelCase like every other Signal K segment and wants the same
 * reading: `tanks.fuel.portForward` is the port forward fuel tank, not the "portForward" one.
 *
 * Lowercased because it follows a word rather than opening one.
 */
function unitId(id: string): string {
  return humanize(id).toLowerCase()
}

/**
 * Which tab a path belongs to and how to label it, or null for a path no tab claims.
 *
 * Nothing here counts anything. A boat with three engines, two generators and nine tanks is not
 * a case anybody wrote: the label comes out of the path's own id, so the families do not know
 * how many of anything there are, and a boat that grows a fourth fuel tank tomorrow gets a
 * fourth cell without this file hearing about it.
 *
 * The families are deliberately narrow: `electrical.generators.*` is a generator, but the rest
 * of `electrical.*` (batteries, inverters) is not a gauge this package knows how to read.
 */
export function describePath(path: string): SystemReading | null {
  if (lookup(SUPPRESSED, path)) return null

  const seg = path.split('.')
  const metric = seg[seg.length - 1]!
  const known = lookup(SYSTEM_METRIC, path)
  const sub = known && !known.sub ? null : (lookup(SYSTEM_SUB, path) ?? humanize(metric))

  if (path.startsWith('propulsion.') && seg.length >= 3) {
    return { tab: 'engine', label: humanize(seg[1]!), sub }
  }
  if (path.startsWith('electrical.generators.') && seg.length >= 4) {
    return { tab: 'generator', label: `Generator ${unitId(seg[2]!)}`, sub }
  }
  if (path.startsWith('tanks.') && seg.length >= 4) {
    const family = TANK_FAMILY[seg[1]!] ?? humanize(seg[1]!)
    return { tab: 'tanks', label: `${family} ${unitId(seg[2]!)}`, sub }
  }
  return null
}

/**
 * A system path's value, in the units a person says. A string (an engine state) passes through;
 * a number is converted by its metric, and a metric we do not recognise is shown as the plain
 * number rather than dressed in a unit we would be guessing at.
 */
export function systemValue(path: string, value: number | string): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) return '·'
  const m = lookup(SYSTEM_METRIC, path)
  if (m) return m.fmt(value)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * The core navigation gauges the boat records a history for, and the declaration point for
 * which paths those are.
 *
 * Wind and barometer live in the fixed Snapshot fields (and in each rollup's `metrics`), not in
 * the dynamic `path_values`/`path_metrics` maps, so a caller reads them from there instead.
 * True wind is a concept (speedTrue with speedOverGround as fallback) already folded into
 * `wind_speed_true`; speedTrue is its canonical name.
 *
 * Written in this direction on purpose. The tuple is declared first and CORE_SERIES is checked
 * against it, so a gauge listed here and described nowhere fails to build. Deriving the union
 * the other way round (`keyof typeof CORE_SERIES`) would compile forever and check nothing: the
 * union would simply become whatever was written, which is the same unenforced promise this
 * replaced, with extra steps.
 */
export const CORE_SERIES_PATHS = ['environment.wind.speedTrue', 'environment.outside.pressure'] as const

export type CoreSeriesPath = (typeof CORE_SERIES_PATHS)[number]

export interface CoreSeries {
  /** The Snapshot field the boat records it in, and the key its rollup aggregate is filed under. */
  field: MetricField
  /**
   * SI as Signal K delivers it, into the unit the gauge is read in. No rounding, unlike the
   * system metrics' `fmt`: a chart draws its band on the real value, and a reading rounds at
   * the point it prints.
   */
  scale: (n: number) => number
  unit: string
}

/**
 * Keyed whole, by full path, rather than by a last segment like SYSTEM_METRIC is.
 *
 * `.pressure` on some other path must never pick up the barometer's scaling by accident: a
 * charger's pressure is not 1013 hPa. The dynamic system families can be keyed by segment
 * because a `.temperature` is kelvin whoever reports it. These two are not that kind of fact.
 *
 * The type is the rule now: add a path above and describe it nowhere and this fails to build,
 * which a paragraph asking the next person to remember never did. But the type only sees what
 * compiles WITH it, and the shore's screen still keeps its own copy of this table and its own
 * list of these paths, out of reach of any compiler here until it depends on this package. Add
 * a third core gauge and the shore will ask for a series and open onto an empty chart, and
 * nothing will have gone red. That is the one drift this file has not yet closed, and it is the
 * reason the second copy has to go rather than merely be discouraged.
 */
export const CORE_SERIES: Record<CoreSeriesPath, CoreSeries> = {
  'environment.wind.speedTrue': { field: 'wind_speed_true', scale: (ms) => ms * MS_TO_KN, unit: 'kn' },
  'environment.outside.pressure': { field: 'air_pressure_pa', scale: (pa) => pa / 100, unit: 'hPa' }
}

/**
 * Whether a plain path off the wire names a core gauge.
 *
 * CORE_SERIES is keyed by the union, which an arbitrary string cannot index, so a caller
 * holding a path a boat sent comes through here. The narrowing is the check.
 */
export function isCoreSeriesPath(path: string): path is CoreSeriesPath {
  return (CORE_SERIES_PATHS as readonly string[]).includes(path)
}

/** The core gauge a plain path names, or nothing. */
export function coreSeriesFor(path: string): CoreSeries | undefined {
  return isCoreSeriesPath(path) ? CORE_SERIES[path] : undefined
}

/**
 * A path's SI value, scaled into the unit a graph plots and paired with that unit's name for
 * the axis. The same conversion `systemValue` prints, but as a number rather than a sentence: a
 * chart needs to draw a band between a min and a max, which a formatted string cannot be. A
 * metric we do not recognise keeps its raw number and carries no unit, rather than being
 * dressed in one we would be guessing at.
 */
export function systemNumeric(path: string, value: number): { value: number; unit: string } {
  const core = coreSeriesFor(path)
  if (core) return { value: core.scale(value), unit: core.unit }
  const m = lookup(SYSTEM_METRIC, path)
  return m ? { value: m.scale(value), unit: m.unit } : { value, unit: '' }
}
