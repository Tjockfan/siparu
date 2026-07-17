import { describe, expect, it } from 'vitest'
import {
  CORE_SERIES,
  CORE_SERIES_PATHS,
  beaufort,
  beaufortFromKn,
  coreSeriesFor,
  describePath,
  isCoreSeriesPath,
  systemNumeric,
  systemValue
} from '../src/units'

/**
 * The boat and the shore render the same reading on two different screens. If they disagree,
 * one of them is lying and the owner has no way of knowing which. These pin the conversions
 * that both sides read: same thresholds, same rounding, same wording.
 *
 * The values are not invented. They are the numbers this physics was written against: a real
 * engine's 1.0159543841063499e-5 m3/s, a real tank at 0.72, a barometer at 101325 Pa.
 */

describe('beaufort', () => {
  // Straddling each boundary rather than landing on it: a value converted to m/s and back
  // lands a hair either side of the round number, and pinning the hair is testing the float
  // unit, not the scale. A test that only samples the middle of each band passes just as
  // happily against the wrong scale.
  const fromKn = (kn: number) => kn / 1.94384

  // EVERY boundary, not a sample of them. The first version of this test straddled five of the
  // twelve and the other seven could be moved a whole knot with the suite still green: force 6
  // could be made to run to 28 kn and nothing objected. A scale is twelve promises and a test
  // that keeps five of them is not a weaker version of this test, it is a different one that
  // happens to share its name.
  const LADDER: [number, number][] = [
    [0.99, 0],
    [1.01, 1],
    [2.99, 1],
    [3.05, 2],
    [5.99, 2],
    [6.05, 3],
    [9.99, 3],
    [10.1, 4],
    [15.99, 4],
    [16.1, 5],
    [20.99, 5],
    [21.1, 6],
    [26.99, 6],
    [27.1, 7],
    [32.99, 7],
    [33.5, 8],
    [39.99, 8],
    [40.1, 9],
    [46.99, 9],
    [47.1, 10],
    [54.99, 10],
    [55.1, 11],
    [62.99, 11],
    [63.5, 12]
  ]

  it('breaks where the scale breaks, on every boundary it has', () => {
    for (const [kn, force] of LADDER) {
      expect({ kn, force: beaufort(fromKn(kn)) }).toEqual({ kn, force })
    }
  })

  it('is null with no true wind, and does not guess from apparent', () => {
    expect(beaufort(null)).toBeNull()
    expect(beaufort(undefined)).toBeNull()
    expect(beaufort(NaN)).toBeNull()
  })

  it('reads the same force from knots, against the scale rather than against itself', () => {
    // beaufortFromKn exists so a table already holding knots does not restate the thresholds.
    // Asserting it against beaufort() would compare the function to itself: both route through
    // the same ladder, so any threshold is self-consistent and every mutation stays green. The
    // numbers are the oracle here, not the other function.
    for (const [kn, force] of LADDER) {
      expect({ kn, force: beaufortFromKn(kn) }).toEqual({ kn, force })
    }
    expect(beaufortFromKn(null)).toBeNull()
    expect(beaufortFromKn(undefined)).toBeNull()
  })

  it('does not drop a wind of exactly one knot to a calm', () => {
    // It used to. The knots door divided by the knot factor so the ladder could multiply it
    // straight back, and (1/1.94384)*1.94384 is 0.9999999999999999, a hair under force 1. The
    // ladder now reads knots, which is the unit Beaufort is defined in, and nothing round trips.
    expect(beaufortFromKn(1)).toBe(1)
    expect(beaufortFromKn(0.99)).toBe(0)
    expect(beaufortFromKn(1.01)).toBe(1)
  })

  it('calls a missing reading nothing, rather than a hurricane', () => {
    // typeof NaN === "number" and every comparison against NaN is false, so a NaN that reaches
    // the ladder falls off the end of it and comes out force 12. The guard used to be borrowed
    // from the other door; now each has its own.
    expect(beaufortFromKn(NaN)).toBeNull()
    expect(beaufort(NaN)).toBeNull()
    expect(beaufortFromKn(undefined)).toBeNull()
  })
})

describe('system readings', () => {
  it('places a path under the right tab, and refuses one it does not understand', () => {
    expect(describePath('propulsion.port.revolutions')?.tab).toBe('engine')
    expect(describePath('electrical.generators.0.runTime')?.tab).toBe('generator')
    expect(describePath('tanks.fuel.0.currentLevel')?.tab).toBe('tanks')
    expect(describePath('sensors.foo.bar')).toBeNull()
    expect(describePath('electrical.batteries.0.voltage')).toBeNull()
  })

  it('labels an engine reading by its side and its metric', () => {
    const d = describePath('propulsion.starboard.oilPressure')
    expect(d?.label).toBe('Starboard')
    expect(d?.sub).toBe('Oil pressure')
  })

  it('labels a tank by type and index, with no redundant metric under it', () => {
    const d = describePath('tanks.freshWater.0.currentLevel')
    expect(d?.label).toBe('Fresh water 0')
    expect(d?.sub).toBeNull()
  })

  it('labels a generator by its index', () => {
    expect(describePath('electrical.generators.1.revolutions')?.label).toBe('Generator 1')
  })

  it('converts each SI quantity to what a gauge shows', () => {
    expect(systemValue('propulsion.port.revolutions', 24.4)).toBe('1464 rpm')
    expect(systemValue('propulsion.port.oilPressure', 423634)).toBe('4.2 bar')
    expect(systemValue('propulsion.port.runTime', 481200)).toBe('134 h')
    expect(systemValue('tanks.fuel.0.currentLevel', 0.72)).toBe('72%')
  })

  it('reads a temperature out of kelvin', () => {
    // 358.15 K is 85.0 C. Pinned on the boundary, not mid-band: a broken offset still passes a
    // test that only asks for "some number of degrees".
    expect(systemValue('propulsion.port.temperature', 358.15)).toBe('85.0 °C')
  })

  it('passes a string state through untouched', () => {
    expect(systemValue('propulsion.port.state', 'started')).toBe('started')
  })

  it('shows an unknown numeric metric without inventing a unit', () => {
    expect(systemValue('propulsion.port.somethingNew', 5)).toBe('5')
    expect(systemValue('propulsion.port.somethingNew', 5.27)).toBe('5.3')
  })

  it('refuses to print a number that is not one', () => {
    // The fallback is integer-CONDITIONAL, so a NaN reaching it would render "NaN" in a cell
    // that is meant to read as a quantity. An unknown metric and an unusable value are two
    // different answers and the screen must not confuse them.
    expect(systemValue('propulsion.port.somethingNew', NaN)).toBe('·')
    expect(systemValue('propulsion.port.somethingNew', Infinity)).toBe('·')
  })

  it('reads a fuel rate out of cubic metres per second, where the raw number reads as a dead engine', () => {
    // 1.0159543841063499e-05 m3/s x 3_600_000 is 36.574 L/h. These are live bench numbers.
    // Unscaled, a running engine printed "0.0" and said it was burning nothing at all.
    expect(systemValue('propulsion.port.fuel.rate', 1.0159543841063499e-5)).toBe('36.6 L/h')
    expect(systemValue('propulsion.starboard.fuel.rate', 9.71e-6)).toBe('35.0 L/h') // 34.956 L/h
    expect(systemValue('propulsion.port.fuel.averageRate', 1.0159543841063499e-5)).toBe('36.6 L/h')
  })

  it('reads a fuel totaliser in whole litres and fuel pressure in bar', () => {
    // 12.4 m3 is 12400 L. Nobody reads a tank's worth of fuel to a tenth of a litre.
    expect(systemValue('propulsion.port.fuel.used', 12.4)).toBe('12400 L')
    expect(systemValue('propulsion.port.fuel.pressure', 350000)).toBe('3.5 bar') // Pa, as oilPressure is
  })

  it("says fuel in a fuel gauge's sub, which its last segment alone never does", () => {
    // "Port" over "Rate" is a riddle: an engine has several rates. The label and the sub
    // together are the whole reading, so the sub is never dropped the way a tank's level is.
    const d = describePath('propulsion.port.fuel.rate')
    expect(d?.label).toBe('Port')
    expect(d?.sub).toBe('Fuel rate')
    expect(d?.tab).toBe('engine')
    expect(describePath('propulsion.port.fuel.averageRate')?.sub).toBe('Fuel rate (average)')
    expect(describePath('propulsion.port.fuel.pressure')?.sub).toBe('Fuel pressure')
  })

  it('anchors the fuel totaliser to the reset it counts from, which is all the epoch there is', () => {
    // Signal K: "Used fuel since last reset. Resetting is at user discretion", under PGN Trip
    // Parameters. 12400 L since nobody knows when. The sub says which, and stays honest on a
    // counter that has never been reset. "Trip fuel used" would not.
    expect(describePath('propulsion.port.fuel.used')?.sub).toBe('Fuel used (since reset)')
  })

  it('shows no cell at all for economyRate, which is a burn rate no honest name is left for', () => {
    // economyRate is m3/s like the other two rates (PGN 127497 "Fuel Rate, Economy | L/h"), but
    // to a person "economy" means L/nm. Two cells saying economy about different quantities is
    // a lie, so this one is not drawn. null is the same answer a path no tab claims gets, and
    // it takes the cell, the export column and the chart with it.
    expect(describePath('propulsion.port.fuel.economyRate')).toBeNull()
    expect(describePath('propulsion.starboard.fuel.economyRate')).toBeNull()
    // Suppressed, not merely unscaled. Drop the SYSTEM_METRIC entry and leave it at that and
    // this path renders raw m3/s as "0.0" under "Economy rate", the exact bug this fixed.
    expect(systemValue('propulsion.port.fuel.economyRate', 8.534647714220893e-6)).toBe('0.0')
  })

  it('subs no burn rate as an economy, so an L/nm cell cannot collide with one', () => {
    // Any rate that reaches a sub says "rate", and the one that could not is gone from the
    // screen entirely.
    for (const path of [
      'propulsion.port.fuel.rate',
      'propulsion.port.fuel.averageRate',
      'propulsion.port.fuel.economyRate'
    ]) {
      expect(describePath(path)?.sub ?? '').not.toMatch(/economy/i)
    }
  })

  it('keeps the fuel scale to fuel: a .rate no family claims stays a plain number', () => {
    // THE COLLISION. The metrics are keyed by family ("fuel.rate"), never by the bare word
    // "rate". Every path here ends in exactly "rate" and belongs to no fuel family, so a bare
    // "rate" key would claim every one of them and quietly dress it in litres per hour. That
    // is what these assertions are for, and a path ending "someRate" would not test it: the
    // lookup is an exact match, and "someRate" misses a bare "rate" key as surely as it misses
    // "fuel.rate".
    expect(systemValue('electrical.generators.0.rate', 5.27)).toBe('5.3')
    expect(systemNumeric('electrical.generators.0.rate', 5.27)).toEqual({ value: 5.27, unit: '' })
    expect(describePath('electrical.generators.0.rate')?.sub).toBe('Rate')
    // Nor is the family word a metric on its own: "fuel" carries no scale, only "fuel.<metric>".
    expect(systemValue('tanks.fuel.0.rate', 5.27)).toBe('5.3')
  })

  it("names both of an engine's .type paths, which humanize alone renders identical", () => {
    // fuel.type and drive.type are both real subscribed paths and both end in "type", so subbed
    // by their last segment a boat reporting the pair draws two Engine cells reading
    // "Port / Type", one "diesel", one "sterndrive", with nothing to tell them apart.
    expect(describePath('propulsion.port.fuel.type')?.sub).toBe('Fuel type')
    expect(describePath('propulsion.port.drive.type')?.sub).toBe('Drive type')
  })

  it('passes fuel.type through as the word it is, with no scale laid on it', () => {
    // fuel.type is an enum string (diesel, petrol, electric), not a quantity. It carries a sub
    // and no scale, which is why the sub table is not the metric table.
    expect(systemValue('propulsion.port.fuel.type', 'diesel')).toBe('diesel')
    expect(systemValue('propulsion.port.drive.type', 'sterndrive')).toBe('sterndrive')
  })
})

/**
 * The paths that made a screen wide, on the boats that report them.
 *
 * Every path here is longer than the two-and-three-segment names the tables were first written
 * against, and each one exercises a different rule: a segment claimed on a deep path, a
 * numeric index in the middle of a family, a camelCase tank type. A boat with three engines is
 * the case the physics has to hold for, and the only place to find out is a test.
 */
describe('the long paths a real boat reports', () => {
  it('names an engine from its own id, so the table never counts engines', () => {
    const d = describePath('propulsion.portEngine.exhaustTemperature')
    expect(d?.tab).toBe('engine')
    expect(d?.label).toBe('Port engine')
    expect(d?.sub).toBe('Exhaust temperature')
  })

  it('names a generator by its index, coolant and all', () => {
    const d = describePath('electrical.generators.0.coolantTemperature')
    expect(d?.tab).toBe('generator')
    expect(d?.label).toBe('Generator 0')
    expect(d?.sub).toBe('Coolant temperature')
  })

  it('reads a black water level and does not repeat the metric under the label', () => {
    const d = describePath('tanks.blackWater.0.currentLevel')
    expect(d?.tab).toBe('tanks')
    expect(d?.label).toBe('Black water 0')
    expect(d?.sub).toBeNull()
    expect(systemValue('tanks.blackWater.0.currentLevel', 0.34)).toBe('34%')
  })

  /**
   * Every temperature and pressure the schema publishes, not just the ones the boat this was
   * written against happens to report.
   *
   * The list is taken from @signalk/path-metadata rather than from memory. It used to be one
   * `temperature` key, and the other five went out to the unknown-metric fallback as raw SI: a
   * coolant loop at 82 C read "355.1", no unit, under a label saying Coolant temperature. It is
   * the fuel-rate bug (a running engine reading "0.0") wearing a different segment, and it hid
   * for the same reason: the boat on the bench does not report these paths.
   */
  it('reads every temperature the schema publishes, not only the short one', () => {
    expect(systemValue('propulsion.port.temperature', 355.15)).toBe('82.0 °C')
    expect(systemValue('propulsion.portEngine.exhaustTemperature', 623.15)).toBe('350.0 °C')
    expect(systemValue('electrical.generators.0.coolantTemperature', 355.15)).toBe('82.0 °C')
    expect(systemValue('propulsion.port.oilTemperature', 363.15)).toBe('90.0 °C')
    expect(systemValue('propulsion.port.intakeManifoldTemperature', 313.15)).toBe('40.0 °C')
    // A transmission's is read too: its last segment is one the table claims, and the depth of
    // the path was never what the lookup was matching.
    expect(systemValue('propulsion.port.transmission.oilTemperature', 363.15)).toBe('90.0 °C')
  })

  it('reads every pressure the schema publishes, in the bar an engine gauge shows', () => {
    expect(systemValue('propulsion.port.oilPressure', 423634)).toBe('4.2 bar')
    expect(systemValue('propulsion.port.coolantPressure', 101325)).toBe('1.0 bar')
    expect(systemValue('propulsion.port.boostPressure', 180000)).toBe('1.8 bar')
    expect(systemValue('propulsion.port.transmission.oilPressure', 3.5e5)).toBe('3.5 bar')
    expect(systemValue('propulsion.port.fuel.pressure', 350000)).toBe('3.5 bar')
  })

  it('reads the ratios the schema calls percentages, and leaves the one it does not alone', () => {
    // THE SECOND COLLISION, and the reason these are enumerated rather than ruled. engineLoad,
    // engineTorque and trimState are each documented "0<=ratio<=1, 1 is 100%", so they are
    // percentages and read as one. gearRatio carries the same `ratio` unit and is documented
    // "engine rotations per propeller shaft rotation": a 2.5:1 gearbox is 2.5, and a rule saying
    // "ratio means percent" would put 250% on the screen. It falls through to the plain number,
    // which is the correct reading, so this assertion protects a gap rather than closing one.
    expect(systemValue('propulsion.port.engineLoad', 0.72)).toBe('72%')
    expect(systemValue('propulsion.port.engineTorque', 0.45)).toBe('45%')
    expect(systemValue('propulsion.port.drive.trimState', 0.3)).toBe('30%')
    expect(systemValue('propulsion.port.transmission.gearRatio', 2.5)).toBe('2.5')
    expect(systemNumeric('propulsion.port.transmission.gearRatio', 2.5)).toEqual({ value: 2.5, unit: '' })
    expect(describePath('propulsion.port.transmission.gearRatio')?.sub).toBe('Gear ratio')
  })

  it('tells three engines apart rather than folding them into one cell', () => {
    // Some boats carry three. The label comes from the path's own id, so the table never has
    // to know how many there are, and a centre engine is not a special case anybody wrote.
    const labels = ['propulsion.port.revolutions', 'propulsion.centre.revolutions', 'propulsion.starboard.revolutions'].map(
      (p) => describePath(p)?.label
    )
    expect(labels).toEqual(['Port', 'Centre', 'Starboard'])
    expect(new Set(labels).size).toBe(3)
  })
})

describe('systemNumeric: the same conversion, as a number for a graph', () => {
  it('scales each known metric into its graph unit, without rounding the band away', () => {
    // Hz to rpm: the axis plots rpm, and a chart must keep the real value, not the rounded cell
    // reading. 14.2 Hz is 852 rpm, not 850.
    expect(systemNumeric('propulsion.port.revolutions', 14.2)).toEqual({ value: 852, unit: 'rpm' })
    expect(systemNumeric('propulsion.port.temperature', 355.15)).toEqual({ value: 82, unit: '°C' })
    expect(systemNumeric('propulsion.port.oilPressure', 3.5e5)).toEqual({ value: 3.5, unit: 'bar' })
    expect(systemNumeric('electrical.generators.0.runTime', 7200)).toEqual({ value: 2, unit: 'h' })
    expect(systemNumeric('tanks.fuel.0.currentLevel', 0.72)).toEqual({ value: 72, unit: '%' })
  })

  it("keeps an unknown metric's raw number and carries no unit rather than guessing one", () => {
    expect(systemNumeric('propulsion.port.somethingNew', 5.27)).toEqual({ value: 5.27, unit: '' })
  })

  it('plots a fuel gauge on the scale the cell prints, so a chart cannot contradict it', () => {
    // The band keeps the real value, unrounded; the cell is the same number, rounded once for
    // reading. A chart that plotted raw m3/s under a blank axis was the other half of this bug.
    const rate = systemNumeric('propulsion.port.fuel.rate', 1.0159543841063499e-5)
    expect(rate.value).toBeCloseTo(36.574, 3)
    expect(rate.unit).toBe('L/h')
    expect(systemValue('propulsion.port.fuel.rate', 1.0159543841063499e-5)).toBe(`${rate.value.toFixed(1)} L/h`)
    expect(systemNumeric('propulsion.port.fuel.used', 12.4)).toEqual({ value: 12400, unit: 'L' })
    expect(systemNumeric('propulsion.port.fuel.pressure', 3.5e5)).toEqual({ value: 3.5, unit: 'bar' })
  })

  it("names a unit from the path alone, which is all a chart's axis has to ask with", () => {
    // A chart takes its axis label from systemNumeric(path, 0): the keying must not read the
    // value, or an axis would be labelled by whatever number happened to arrive first.
    expect(systemNumeric('propulsion.port.fuel.rate', 0)).toEqual({ value: 0, unit: 'L/h' })
    expect(systemNumeric('propulsion.port.fuel.used', 0).unit).toBe('L')
  })

  it('scales the core gauges (wind, barometer) the same way the cell reads them', () => {
    // Wind: m/s to knots, no rounding. The graph band must keep the real value, and the cell
    // shows "kn" too, so the axis and the reading it opened from agree.
    const wind = systemNumeric('environment.wind.speedTrue', 10)
    expect(wind.value).toBeCloseTo(19.4384, 3)
    expect(wind.unit).toBe('kn')
    // Barometer: Pa to hPa.
    expect(systemNumeric('environment.outside.pressure', 101325)).toEqual({ value: 1013.25, unit: 'hPa' })
  })
})

/**
 * The core gauges, and the rule that used to be a comment.
 *
 * Three tables once held the same two paths and a paragraph in each asked the next person to
 * remember the others. Two of those paragraphs named one sibling and the third named two; none
 * named all of them. This is what replaced it. The type does the asking now, so these tests
 * pin what the type cannot: that the paths mean what the rest of the boat thinks they mean.
 */
describe('core series', () => {
  it('describes every path it declares, and declares every path it describes', () => {
    // The compile error is the real gate: CORE_SERIES is Record<CoreSeriesPath, CoreSeries>, so
    // a path added to the tuple and described nowhere fails to build, and a description with no
    // path in the tuple fails too. This is the runtime shadow of that, and it is what catches a
    // future maintainer who reaches for Record<string, ...> to make an error go away.
    expect(Object.keys(CORE_SERIES).sort()).toEqual([...CORE_SERIES_PATHS].sort())
  })

  it('files each core gauge under the snapshot field the boat actually records it in', () => {
    // If these two ever point at the wrong field, a chart opens on someone else's history and
    // nothing anywhere says so: both are numbers, both plot.
    expect(CORE_SERIES['environment.wind.speedTrue'].field).toBe('wind_speed_true')
    expect(CORE_SERIES['environment.outside.pressure'].field).toBe('air_pressure_pa')
  })

  it('narrows a path off the wire rather than trusting it', () => {
    expect(isCoreSeriesPath('environment.wind.speedTrue')).toBe(true)
    expect(isCoreSeriesPath('environment.wind.speedApparent')).toBe(false)
    expect(coreSeriesFor('environment.outside.pressure')?.unit).toBe('hPa')
    expect(coreSeriesFor('propulsion.port.revolutions')).toBeUndefined()
  })

  it("keeps the barometer's scaling to the barometer, and off every other .pressure", () => {
    // The core gauges are keyed whole, by full path, precisely so this cannot happen. A
    // charger's pressure is not 1013 hPa, and an engine's is read in bar.
    expect(systemNumeric('propulsion.port.oilPressure', 101325)).toEqual({ value: 1.01325, unit: 'bar' })
    expect(systemNumeric('electrical.chargers.0.pressure', 101325)).toEqual({ value: 101325, unit: '' })
  })
})
