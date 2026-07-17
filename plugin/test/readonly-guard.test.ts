/**
 * The read-only guards, held to what they are advertised to catch.
 *
 * The guards themselves live in .github/workflows/ci.yml as greps, and the README
 * sends people to run one: "grep this codebase and see for yourself". That makes the
 * patterns a published claim rather than a lint rule, and a published claim wants a
 * test, because the way a grep dies is silently. Widen one character and it still
 * exits zero on a clean tree, still shows green, and still says nothing when the
 * thing it was written for walks past.
 *
 * This file exists because that already happened once. The server-api guard was read
 * as proving "no writes reach the vessel" when it only ever read one door: a
 * `fetch(boatUrl, { method: 'PUT' })` in plugin/src passed the whole set, and the
 * exact pattern that catches it was sitting in the same file, scoped to webapp/src
 * alone.
 *
 * The patterns are lifted out of the workflow rather than restated here. A copy would
 * be a second thing to keep in step, which is the failure this repo has spent several
 * releases on: what CI runs is what gets tested, or the test is testing its own
 * opinion.
 *
 * Pure string matching, no shell. `npm test` runs on Windows in the plugin-ci matrix,
 * where the guards' own `grep -rniE` does not exist.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CI_YML = join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml')

/**
 * The ERE a named guard hands to grep, as a JavaScript RegExp.
 *
 * Fails loudly rather than skipping when the step is gone or renamed: a guard that
 * has been deleted must not read here as a guard with nothing to say.
 */
function guardPattern(stepName: string): RegExp {
  const yml = readFileSync(CI_YML, 'utf8')
  const step = yml.split(/^      - name: /m).find((s) => s.startsWith(stepName))
  if (!step) throw new Error(`no CI step named "${stepName}" - was it renamed or removed?`)

  const m = /grep -rniE "(.+?)" plugin\/src/.exec(step)
  if (!m) throw new Error(`step "${stepName}" no longer greps plugin/src with -rniE`)

  // The workflow is a YAML block scalar, so the shell's escaping survives into the
  // text: inside grep's double quotes, \" is a literal quote.
  return new RegExp(m[1]!.replace(/\\"/g, '"'), 'i')
}

/** Lines that are in plugin/src today, and are the reason POST is not guarded. */
const LEGITIMATE = [
  "      const res = await fetch(`${this.deps.relayUrl}/telemetry`, {", // uplink.ts:199
  "        method: 'POST',", // uplink.ts:200, pairing.ts:165
  '      res = await fetch(`${url}${path}`, {', // pairing.ts:164
  "    const url = `${this.deps.relayUrl.replace(/^http/, 'ws')}/live/boat`" // live.ts:241
]

describe('the write-method guard', () => {
  const guard = guardPattern('Read-only proof - no write method leaves the plugin')

  it.each([
    ["await fetch(boatUrl, { method: 'PUT', body: x })", 'the write this guard was written for'],
    ['await fetch(boatUrl, { method: "PUT" })', 'double quotes'],
    ["await fetch(boatUrl, {method:'PUT'})", 'no space after the colon'],
    ["await fetch(boatUrl, { method: 'put' })", 'lowercase, which fetch uppercases for us'],
    ["await fetch(boatUrl, { method: 'DELETE' })", 'delete'],
    ["await fetch(boatUrl, { method: 'PATCH' })", 'patch']
  ])('catches %j (%s)', (line) => {
    expect(guard.test(line)).toBe(true)
  })

  it('lets the relay POSTs through, which is why they are still POSTs', () => {
    for (const line of LEGITIMATE) expect(guard.test(line)).toBe(false)
  })

  /**
   * The edge, pinned so that nobody has to find it the hard way. A verb the source
   * never spells is a verb this grep cannot read, and that is deliberate: the address
   * guard below is the other half, and a write needs an address as much as a verb.
   */
  it('cannot read a verb the source never spells', () => {
    expect(guard.test("const m = 'P' + 'UT'; await fetch(boatUrl, { method: m })")).toBe(false)
  })
})

describe('the vessel-address guard', () => {
  const guard = guardPattern("Read-only proof - the plugin never addresses the vessel's own API")

  it.each([
    ['await fetch("http://localhost:3000/signalk/v1/api/vessels/self/navigation/state")', 'the boat by name and port'],
    ['await fetch("http://127.0.0.1:3000/signalk/v2/api/x")', 'the boat by loopback address'],
    ['await fetch("http://[::1]:3000/signalk/v1/api/x")', 'the boat by IPv6 loopback'],
    ['await fetch(`${base}/signalk/v1/api/vessels/self`, { method: "PUT" })', 'her API path with the host hidden'],
    ["const ws = new WS('ws://localhost:3000/signalk/v1/stream')", 'her delta stream, which takes writes too']
  ])('catches %j (%s)', (line) => {
    expect(guard.test(line)).toBe(true)
  })

  it('leaves the relay alone, which is on the public internet and not the boat', () => {
    for (const line of LEGITIMATE) expect(guard.test(line)).toBe(false)
    expect(guard.test("  relayUrl: 'https://relay.siparu.app',")).toBe(false)
  })
})

/**
 * The pair, on the line that matters most: the two guards read different halves of the
 * same write, and either one alone leaves a way through. This is the assertion that
 * fails if somebody decides one of them is redundant.
 */
describe('the two guards together', () => {
  const method = guardPattern('Read-only proof - no write method leaves the plugin')
  const address = guardPattern("Read-only proof - the plugin never addresses the vessel's own API")

  it('needs both halves: the verb guard alone misses a verb held in a variable', () => {
    const line = "const m = 'PUT'; await fetch('http://localhost:3000/signalk/v1/api/x', { method: m })"
    expect(method.test(line)).toBe(false)
    expect(address.test(line)).toBe(true)
  })

  it('needs both halves: the address guard alone misses a write to a host from config', () => {
    const line = "await fetch(`${someUrl}/vessels/self`, { method: 'PUT' })"
    expect(address.test(line)).toBe(false)
    expect(method.test(line)).toBe(true)
  })
})
