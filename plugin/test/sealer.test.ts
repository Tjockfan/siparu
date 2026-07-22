import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DevicePublicKey } from '../src/contract'
import { BoatKeyStore } from '../src/keystore'
import { Sealer } from '../src/sealer'
import { openFrame, rawPublic, verifyFrame } from '../src/sealing'
import { generateKeyPairSync } from 'crypto'

/**
 * The switch between reporting in the clear and reporting sealed.
 *
 * The interesting cases are all on one side of it: what she does when something is wrong.
 * A boat that quietly fell back to cleartext would look identical from the bridge to one
 * that never sealed at all, and nobody would find out until it mattered.
 */

let dir: string
let keys: BoatKeyStore

/** A screen, with the private half kept here so a test can actually read what she sent. */
function device(kid: string) {
  const pair = generateKeyPairSync('x25519')
  return {
    kid,
    priv: pair.privateKey,
    pub: rawPublic(pair.publicKey),
    wire: { kid, pub: rawPublic(pair.publicKey).toString('base64url') } as DevicePublicKey
  }
}

function sealer(devices: DevicePublicKey[], over: { boatId?: string | undefined } = {}) {
  const said: string[] = []
  const s = new Sealer({
    keys,
    devices: () => devices,
    boatId: () => ('boatId' in over ? over.boatId : 'boat-0001'),
    debug: (m) => said.push(m)
  })
  return { s, said }
}

const FRAME = { ts: 1_753_142_400_000, lat: 43.5528, lon: 7.0174, sog: 6.2 }

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-sealer-'))
  keys = new BoatKeyStore(dir)
  keys.load()
  await keys.ensure()
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('deciding how a frame goes out', () => {
  it('reports in the clear while nobody is authorised', () => {
    // The ordinary state of every boat until her owner adds a screen, and the reason this
    // can ship without taking anyone's live view away.
    expect(sealer([]).s.seal(FRAME)).toEqual({ mode: 'clear' })
  })

  it('seals to an authorised screen, and that screen can read it', () => {
    const phone = device('kid-phone')
    const verdict = sealer([phone.wire]).s.seal(FRAME)

    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return

    const identityPub = keys.get()!.identity
    // End to end: what she sent verifies as hers, and opens to exactly what she meant.
    expect(verifyFrame(verdict.frame, identityPub)).toBe(true)
    const opened = openFrame(
      verdict.frame,
      identityPub,
      phone.kid,
      Buffer.from(phone.priv.export({ format: 'jwk' }).d as string, 'base64url'),
      phone.pub
    )
    expect(JSON.parse(opened)).toEqual(FRAME)
  })

  it('puts nothing readable on the wire', () => {
    const verdict = sealer([device('kid-phone').wire]).s.seal(FRAME)
    const wire = JSON.stringify(verdict)
    expect(wire).not.toContain('43.55')
    expect(wire).not.toContain('lat')
    expect(wire).not.toContain('sog')
  })

  it('seals one body to several screens rather than one body each', () => {
    const many = [device('a').wire, device('b').wire, device('c').wire]
    const verdict = sealer(many).s.seal(FRAME)

    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect(verdict.frame.keys.map((k) => k.kid)).toEqual(['a', 'b', 'c'])
  })

  it('keeps sealing when one screen carries an unusable key', () => {
    // The list is assembled ashore, over a channel the boat does not control. One bad row
    // in it must never take a vessel off the air; it takes one screen off, and says so.
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const { s, said } = sealer([good.wire, bad])

    const verdict = s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect(verdict.frame.keys.map((k) => k.kid)).toEqual(['kid-good'])
    expect(said.join(' ')).toContain('kid-bad')
  })

  it('sends NOTHING rather than falling back when no authorised screen can be sealed to', () => {
    // The load-bearing case. Screens are authorised, so somebody is expecting privacy; not
    // one of their keys can be used. Cleartext here would be a silent betrayal, and silence
    // is at least visible on her owner's screen.
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    expect(sealer([bad]).s.seal(FRAME).mode).toBe('blocked')
  })

  it('sends nothing when she has no id ashore', () => {
    expect(sealer([device('kid-phone').wire], { boatId: undefined }).s.seal(FRAME).mode).toBe(
      'blocked'
    )
  })

  it('sends nothing when she has no keys of her own', () => {
    const empty = new BoatKeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-nokeys-')))
    empty.load()
    const s = new Sealer({
      keys: empty,
      devices: () => [device('kid-phone').wire],
      boatId: () => 'boat-0001',
      debug: () => {}
    })
    expect(s.seal(FRAME).mode).toBe('blocked')
  })

  it('complains once about the same bad key, not once per frame', () => {
    // This runs every couple of seconds. A log line per frame is a log nobody reads.
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const { s, said } = sealer([good.wire, bad])

    s.seal(FRAME)
    s.seal(FRAME)
    s.seal(FRAME)

    expect(said).toHaveLength(1)
  })

  it('says she is sealing exactly when screens are authorised', () => {
    // What the slow POST path asks before deciding whether it may carry a frame at all.
    expect(sealer([]).s.active()).toBe(false)
    expect(sealer([device('kid-phone').wire]).s.active()).toBe(true)
  })
})
