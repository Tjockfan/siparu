/**
 * Where the boat keeps the two keys that are hers alone.
 *
 * The identity key signs every frame she sends. The inbox key receives what
 * her owner's devices seal to her. Neither can decrypt her own reports: a
 * frame's content key is wrapped only to the devices, never to the vessel, so
 * seizing the boat's disk opens no past traffic. That is a deliberate property
 * and this file is where it is kept true, by holding nothing else.
 *
 * They live in the plugin's data directory beside the relay credential, and
 * for the same reason they are not in the plugin's options: Signal K serves
 * plugin options wholesale over GET /plugins/<id>/config, and with security
 * off, which is the default install, that answers anyone on the boat's
 * network. The data directory is served by no route at all.
 *
 * Written 0600 and write-then-rename, like every other credential write
 * aboard. A power cut in the middle of a write must not leave half a key.
 */
import * as fs from 'fs'
import * as path from 'path'
import { generateKeyPairSync, type KeyObject } from 'crypto'
import {
  ed25519PrivateFromRaw,
  publicFromPrivate,
  rawPrivate,
  rawPublic,
  x25519PrivateFromRaw
} from './sealing'

/** The boat's own key pair, in the form the sealing code wants it. */
export interface BoatKeys {
  /** Ed25519. Signs frames. Cannot decrypt anything. */
  identity: KeyObject
  /** X25519. Opens what devices seal to the boat. */
  inbox: KeyObject
}

/** The halves that may be published: what a device needs to talk to this boat. */
export interface BoatPublicKeys {
  identity: string
  inbox: string
}

interface StoredPair {
  priv: string
  pub: string
}

interface FileShape {
  v: number
  identity: StoredPair
  inbox: StoredPair
}

const FILE_VERSION = 1

function isPair(value: unknown): value is StoredPair {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<StoredPair>
  return typeof p.priv === 'string' && typeof p.pub === 'string'
}

export class BoatKeyStore {
  private readonly file: string
  private keys: BoatKeys | undefined
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'keys.json')
  }

  /**
   * Read once at start. A file that cannot be read, parsed, or rebuilt into
   * working keys leaves the boat with none, and she generates a fresh pair on
   * the next call to `ensure`.
   *
   * That is the right failure for a torn file, but it has a consequence worth
   * being explicit about: a boat that loses her identity key is a boat her
   * devices no longer recognise, and she has to be paired again. So this does
   * not quietly replace a file it merely failed to understand. It refuses to
   * load, and the caller decides.
   */
  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.keys = undefined
      return
    }
    const raw = (parsed ?? {}) as Partial<FileShape>
    if (raw.v !== FILE_VERSION || !isPair(raw.identity) || !isPair(raw.inbox)) {
      this.keys = undefined
      return
    }
    try {
      // Two failures are being caught here, both torn-write shaped, and only
      // one of them by the runtime.
      //
      // A truncated scalar is refused by Node on import. A private half that
      // does not match the public one stored beside it is NOT: Node 20 and 22
      // import that pair without complaint, and only Node 26 rejects it. A
      // boat that loaded such a file would sign with one key and publish
      // another, and every frame she sent would fail verification everywhere,
      // silently. So the halves are checked against each other explicitly,
      // by deriving the public one from the private one.
      const identity = ed25519PrivateFromRaw(
        Buffer.from(raw.identity.priv, 'base64url'),
        Buffer.from(raw.identity.pub, 'base64url')
      )
      const inbox = x25519PrivateFromRaw(
        Buffer.from(raw.inbox.priv, 'base64url'),
        Buffer.from(raw.inbox.pub, 'base64url')
      )
      assertHalvesAgree(identity, Buffer.from(raw.identity.pub, 'base64url'))
      assertHalvesAgree(inbox, Buffer.from(raw.inbox.pub, 'base64url'))
      this.keys = { identity, inbox }
    } catch {
      this.keys = undefined
    }
  }

  /** The keys, if this boat has any yet. */
  get(): BoatKeys | undefined {
    return this.keys
  }

  /** What a device needs in order to reach this boat, raw and base64url. */
  publicKeys(): BoatPublicKeys | undefined {
    if (!this.keys) return undefined
    return {
      identity: rawPublic(this.keys.identity).toString('base64url'),
      inbox: rawPublic(this.keys.inbox).toString('base64url')
    }
  }

  /**
   * The boat's keys, generating them the first time she needs them.
   *
   * Generation happens once in a vessel's life and is never repeated behind
   * her back: if keys are already loaded they are returned untouched. Rolling
   * them would silently cut off every paired device.
   */
  async ensure(): Promise<BoatKeys> {
    if (this.keys) return this.keys
    const identity = generateKeyPairSync('ed25519')
    const inbox = generateKeyPairSync('x25519')
    this.keys = { identity: identity.privateKey, inbox: inbox.privateKey }
    await this.persist({
      v: FILE_VERSION,
      identity: storedPair(identity.privateKey, identity.publicKey),
      inbox: storedPair(inbox.privateKey, inbox.publicKey)
    })
    return this.keys
  }

  private persist(shape: FileShape): Promise<void> {
    const run = async (): Promise<void> => {
      const tmp = `${this.file}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(shape, null, 2), { mode: 0o600 })
      await fs.promises.rename(tmp, this.file)
    }
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }
}

/** The stored public half must be the one this private half actually implies. */
function assertHalvesAgree(priv: KeyObject, storedPub: Buffer): void {
  if (!publicFromPrivate(priv).equals(storedPub)) {
    throw new Error('stored key halves belong to different pairs')
  }
}

function storedPair(priv: KeyObject, pub: KeyObject): StoredPair {
  return {
    priv: rawPrivate(priv).toString('base64url'),
    pub: rawPublic(pub).toString('base64url')
  }
}
