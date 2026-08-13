/**
 * Generate the sealed answer vectors, from the place the boat actually seals one.
 *
 * The reader on a device does not open a reply. It opens whatever the boat put inside the
 * envelope she sealed, and what that is is decided in `LiveUplink.reply` - not in the sealing
 * module, and not by anything a fixture generator could decide for itself. So this file drives
 * the shipping uplink over an injected socket, asks it a question the way the relay does, and
 * records the frame it puts on the wire. A generator that called `sealer.answer(result, id)`
 * directly would produce a file that agrees with itself and disagrees with the boat, which is
 * exactly the fault these vectors exist to catch.
 *
 * Build first: this reads the compiled plugin, and a stale `dist` would pin an answer no
 * shipping build produces.
 *
 *   npm run build
 *   node dev/e2e-vectors/generate-answer.mjs > /tmp/answer-vectors.json
 *
 * The keys are the ones in `vectors.json`, published on purpose there and read here so a device
 * that can open a frame can open an answer with the same key.
 */
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

const { LiveUplink } = require(path.join(root, 'plugin/dist/live.js'))
const { Sealer } = require(path.join(root, 'plugin/dist/sealer.js'))
const { ed25519PrivateFromRaw } = require(path.join(root, 'plugin/dist/sealing.js'))

const vectors = JSON.parse(readFileSync(path.join(here, 'vectors.json'), 'utf8'))

const BOAT = vectors.frame.boat
const ANSWERED = 'c41d9a70-0000-4000-8000-0000000000a3'
const ANOTHER = 'c41d9a70-0000-4000-8000-0000000000b7'
const REFUSED = 'c41d9a70-0000-4000-8000-0000000000c5'

/** What she reports back, invented for this file and shaped like a real voyage list. */
const VOYAGES = {
  voyages: [{ id: 7, startTs: 1753142400000, distanceNm: 12.4 }]
}

/** A socket the generator drives by hand, standing in for the relay. */
class Wire {
  constructor() {
    this.sent = []
    this.handlers = {}
  }
  send(data) {
    this.sent.push(data)
  }
  close() {}
  terminate() {}
  onOpen(cb) {
    this.handlers.open = cb
  }
  onMessage(cb) {
    this.handlers.message = cb
  }
  onClose(cb) {
    this.handlers.close = cb
  }
  onError(cb) {
    this.handlers.error = cb
  }
  onRefused(cb) {
    this.handlers.refused = cb
  }
  open() {
    this.handlers.open?.()
  }
  say(msg) {
    this.handlers.message?.(msg)
  }
  answers() {
    return this.sent
      .filter((s) => s !== 'ping')
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'answer')
  }
}

/**
 * The uplink, sealing, wired to a store that answers one question and refuses another.
 *
 * `openAsk` is a stub rather than the boat's own opener because the question side is pinned by
 * its own file (`request-vectors.json`): what is being recorded here is what she puts INSIDE the
 * envelope on the way back, and that is chosen after the question has already been opened.
 */
function sealer() {
  const identity = ed25519PrivateFromRaw(
    Buffer.from(vectors.boat_identity.private, 'base64url'),
    Buffer.from(vectors.boat_identity.public, 'base64url')
  )
  const inbox = generateKeyPairSync('x25519').privateKey
  return new Sealer({
    keys: { get: () => ({ identity, inbox }) },
    devices: () => vectors.devices.map((d) => ({ kid: d.kid, pub: d.public })),
    latched: () => true,
    boatId: () => BOAT,
    debug: () => {}
  })
}

function boat(wire, seal) {
  return new LiveUplink({
    relayUrl: 'wss://relay.invalid',
    getRemote: () => ({ boatId: BOAT, boatToken: 'token-not-used-here' }),
    frame: () => ({ ts: 1753142400000 }),
    seal: (frame) => seal.seal(frame),
    sealed: () => true,
    openAsk: (envelope) =>
      envelope && typeof envelope.body === 'string'
        ? { id: envelope.id, plaintext: envelope.body }
        : undefined,
    sealAnswer: (payload, id) => seal.answer(payload, id),
    onVoyagesQuery: async (limit) => {
      if (limit === 0) throw new Error('the store could not be read')
      return VOYAGES
    },
    debug: () => {},
    connect: () => wire
  })
}

/** Ask her the way the relay does while she is sealing: an envelope, with the id in the clear. */
function ask(wire, id, limit) {
  wire.say(
    JSON.stringify({
      type: 'ask',
      v: 1,
      id,
      eph: 'not-read-by-the-stub',
      body: JSON.stringify({ type: 'voyages', v: 1, id, limit })
    })
  )
}

const wire = new Wire()
const seal = sealer()
const uplink = boat(wire, seal)
uplink.start()
wire.open()

ask(wire, ANSWERED, 5)
ask(wire, ANOTHER, 5)
ask(wire, REFUSED, 0)

// The handlers are promises resolved on the microtask queue; nothing here is timed.
await new Promise((resolve) => setImmediate(resolve))
uplink.stop()

const answers = wire.answers()
const found = (id) => {
  const answer = answers.find((a) => a.id === id)
  if (!answer) throw new Error(`she did not answer ${id}`)
  return answer.frame
}

process.stdout.write(
  JSON.stringify(
    {
      note:
        'Sealed answers recorded from the boat plugin as it replies over its live uplink, so the ' +
        'body is the whole reply envelope she seals, not the result alone. Generated by ' +
        'dev/e2e-vectors/generate-answer.mjs. Keys are the test-only ones from the frame vectors, ' +
        'published on purpose.',
      request_id: ANSWERED,
      /** The body of `frame`, once opened: the envelope, with the reply under `result`. */
      expected_answer: { type: 'voyages', id: ANSWERED, result: VOYAGES },
      /** The body of `refusal_frame`: the same envelope, carrying her refusal instead. */
      expected_refusal: {
        type: 'voyages',
        id: REFUSED,
        error: { code: 'VOYAGES_FAILED', message: 'voyages query failed' }
      },
      refused_request_id: REFUSED,
      frame: found(ANSWERED),
      frame_for_another_question: found(ANOTHER),
      refusal_frame: found(REFUSED),
      /**
       * The one answer no shipping boat produces, and the reason a reader checks both ids: the
       * signed extension names the question that was asked and the sealed envelope inside names a
       * different one. Neither copy can be rewritten in transit, so this is not a carrier's doing
       * - it is what a build that got its own bookkeeping wrong would send, and a screen that
       * trusted the outer id alone would draw somebody else's voyages under this question.
       *
       * Sealed directly rather than through the uplink, because the uplink is what makes the two
       * agree.
       */
      frame_with_another_question_inside: seal.answer(
        { type: 'voyages', id: ANOTHER, result: VOYAGES },
        ANSWERED
      ).frame
    },
    null,
    2
  ) + '\n'
)
