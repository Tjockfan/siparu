/**
 * The boat's own keys, on disk.
 *
 * What matters here is not that a file appears but that what comes back out of
 * it still works: a stored key is only a key if it can sign a frame the fleet
 * verifies and agree with a device that seals to it. Every test that claims a
 * key survived a restart proves it by using the key, not by comparing strings.
 */
import { createPublicKey, diffieHellman, generateKeyPairSync, sign, verify } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoatKeyStore } from '../src/keystore'
import { ed25519PublicFromRaw, rawPublic, sealFrame, verifyFrame } from '../src/sealing'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-keys-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const reload = (): BoatKeyStore => {
  const store = new BoatKeyStore(dir)
  store.load()
  return store
}

describe('generating', () => {
  it('has nothing before it is asked', () => {
    expect(reload().get()).toBeUndefined()
    expect(reload().publicKeys()).toBeUndefined()
  })

  it('generates one pair and keeps it', async () => {
    const store = reload()
    const first = await store.ensure()
    const second = await store.ensure()
    // Rolling the identity behind the boat's back would cut off every paired
    // device at once, so a second call must be a no-op.
    expect(second).toBe(first)
    expect(rawPublic(second.identity)).toEqual(rawPublic(first.identity))
  })

  it('survives a restart as a working signing key', async () => {
    const before = await reload().ensure()
    const after = reload().get()
    expect(after).toBeDefined()

    const message = Buffer.from('a frame')
    const signature = sign(null, message, after!.identity)
    expect(verify(null, message, ed25519PublicFromRaw(rawPublic(before.identity)), signature)).toBe(
      true
    )
  })

  it('survives a restart as a working agreement key', async () => {
    await reload().ensure()
    const loaded = reload().get()!
    const device = generateKeyPairSync('x25519')
    // Both directions of the agreement must land on the same secret, or a
    // device sealing to this boat's published inbox key seals to nothing.
    const boatSide = diffieHellman({ privateKey: loaded.inbox, publicKey: device.publicKey })
    const deviceSide = diffieHellman({
      privateKey: device.privateKey,
      publicKey: inboxPublic(loaded)
    })
    expect(deviceSide.equals(boatSide)).toBe(true)
  })

  it('publishes exactly the two public halves, and no private material', async () => {
    const store = reload()
    const keys = await store.ensure()
    const published = store.publicKeys()!
    expect(Object.keys(published).sort()).toEqual(['identity', 'inbox'])
    expect(published.identity).toBe(rawPublic(keys.identity).toString('base64url'))
    expect(published.inbox).toBe(rawPublic(keys.inbox).toString('base64url'))

    const onDisk = fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')
    for (const value of Object.values(published)) {
      expect(onDisk).toContain(value)
    }
    // The published form must not carry a private scalar, whatever else it says.
    expect(JSON.stringify(published)).not.toContain(
      JSON.parse(onDisk).identity.priv as string
    )
  })

  it('seals a frame the fleet verifies, using the stored identity', async () => {
    await reload().ensure()
    const keys = reload().get()!
    const device = generateKeyPairSync('x25519')
    const { frame } = sealFrame({
      boat: 'boat-test',
      ts: 1_753_142_400_000,
      plaintext: '{"sog":6}',
      devices: [{ kid: 'phone', pub: rawPublic(device.publicKey) }],
      identity: keys.identity
    })
    expect(verifyFrame(frame, ed25519PublicFromRaw(rawPublic(keys.identity)))).toBe(true)
  })
})

describe('the file itself', () => {
  it.skipIf(process.platform === 'win32')('keeps the file out of group and world hands', async () => {
    await reload().ensure()
    expect(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind', async () => {
    await reload().ensure()
    expect(fs.readdirSync(dir)).toEqual(['keys.json'])
  })
})

describe('refusing a file it cannot understand', () => {
  const write = (body: string): void => fs.writeFileSync(path.join(dir, 'keys.json'), body)

  it.each([
    ['not JSON at all', 'half a fi'],
    ['an empty object', '{}'],
    ['a future version', '{"v":2,"identity":{"priv":"AA","pub":"AA"},"inbox":{"priv":"AA","pub":"AA"}}'],
    ['a missing inbox', '{"v":1,"identity":{"priv":"AA","pub":"AA"}}'],
    ['a non-string scalar', '{"v":1,"identity":{"priv":7,"pub":"AA"},"inbox":{"priv":"AA","pub":"AA"}}']
  ])('loads nothing from %s', (_name, body) => {
    write(body)
    expect(reload().get()).toBeUndefined()
  })

  it('loads nothing from a truncated key that still parses as JSON', async () => {
    // The failure this exists for: a torn write leaves valid JSON holding
    // twenty bytes of a thirty-two byte scalar. Nothing about the shape is
    // wrong, and it fails at the first signature unless it is caught here.
    await reload().ensure()
    const file = path.join(dir, 'keys.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      identity: { priv: string }
    }
    stored.identity.priv = Buffer.from(stored.identity.priv, 'base64url')
      .subarray(0, 20)
      .toString('base64url')
    fs.writeFileSync(file, JSON.stringify(stored))
    expect(reload().get()).toBeUndefined()
  })

  it('loads nothing when the private and public halves do not match', async () => {
    // A file can be intact, well shaped and still wrong: two halves of
    // different pairs. The boat would sign with one key and publish another,
    // and every frame she sent would fail verification everywhere. Nothing in
    // this module checks for it explicitly; Node's JWK import does, and this
    // test is what holds that runtime behaviour in place.
    await reload().ensure()
    const file = path.join(dir, 'keys.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { identity: { pub: string } }
    const stranger = generateKeyPairSync('ed25519')
    stored.identity.pub = rawPublic(stranger.publicKey).toString('base64url')
    fs.writeFileSync(file, JSON.stringify(stored))
    expect(reload().get()).toBeUndefined()
  })

  it('does not overwrite a file it merely failed to understand', () => {
    // A boat that loses her identity is a boat her devices no longer know, so
    // load refuses rather than replacing. Only an explicit ensure writes.
    write('half a fi')
    const store = reload()
    expect(store.get()).toBeUndefined()
    expect(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).toBe('half a fi')
  })
})

/** The inbox public half, as a key object a device would agree against. */
function inboxPublic(keys: { inbox: import('node:crypto').KeyObject }): import('node:crypto').KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: rawPublic(keys.inbox).toString('base64url') },
    format: 'jwk'
  })
}
