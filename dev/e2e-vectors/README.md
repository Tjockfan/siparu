# Sealed frame test vectors

The end-to-end encrypted telemetry frame is agreed between three
implementations that share no code: the boat runs Node, the phone runs
CryptoKit, and a third reference implementation lives here. This directory
fixes the format before any of them is wired to a transport, because "both
platforms support it" is an assumption that only fails once transport code
exists and is expensive to unwind.

## The suite

| Layer | Primitive |
|---|---|
| Key agreement | X25519 |
| Key derivation | HKDF-SHA256 |
| Encryption | ChaCha20-Poly1305 |
| Signature | Ed25519 |

One frame carries a body encrypted once under a content key, and that content
key wrapped separately to each authorised device. Confidentiality comes from
the encryption; the claim that a frame arrived when it did and was not altered
comes from the signature, which covers the ciphertext, the cleartext metadata
and any extension fields. A relay that cannot read a frame can still verify it.

## Running

```sh
node dev/e2e-vectors/generate.mjs > dev/e2e-vectors/vectors.json   # only when the format changes
node dev/e2e-vectors/verify.mjs                                    # boat side
swift dev/e2e-vectors/Verify.swift                                 # device side
npx vitest run plugin/test/sealing.test.ts                         # the shipping module
```

The rule write proof is a second format with its own file, and its own four
commands:

```sh
node dev/e2e-vectors/generate-rules.mjs > dev/e2e-vectors/rule-vectors.json
node dev/e2e-vectors/verify-rules.mjs                              # boat side
swift dev/e2e-vectors/VerifyRules.swift                            # device side
npx vitest run plugin/test/alertrules.test.ts                      # the shipping module
```

The answers she seals to a question are a third file, and the one command that
produces them runs the shipping uplink rather than the sealing module:

```sh
npm run build                                                      # it reads dist
node dev/e2e-vectors/generate-answer.mjs > answer-vectors.json     # the app keeps this file
```

It drives `LiveUplink` over an injected socket and records what she puts on the
wire, because what a device has to open is not chosen by the sealing module: it
is chosen at the call site, which seals the whole reply envelope. A generator
that called `sealer.answer(result, id)` itself produced a fixture that agreed
with the reader and disagreed with every boat afloat, and the phone's tests
stayed green through all of it. The output lives with the app, in
`Tests/Fixtures/answer-vectors.json`, since nothing on this side reads it.

The fingerprint an owner compares by eye is a fourth file, and the only one
whose output is read by a person rather than by code:

```sh
node dev/e2e-vectors/generate-fingerprint.mjs > dev/e2e-vectors/fingerprint-vectors.json
npx vitest run plugin/test/fingerprint.test.ts   # the reference and the boat, together
```

Its third implementation is the app's, held to the same file by the phone's own
suite. What that format has to survive is not an attacker with a decoder but a
person holding a phone up beside a screen in a dim saloon, which is why the
alphabet drops the letters that can be read as each other and why the vectors
include a key whose digest begins with zero bits.

They are kept apart deliberately. Regenerating a vector file costs a pass over
every verifier including the CryptoKit one, run by hand, and a change to the
message a device writes is no reason to redo the frame format that did not
change.

`vectors.json` is committed. Regenerating it is a deliberate act: all three
verifiers must be rerun after. Two of them are pinned in CI,
`plugin/test/e2e-vectors.test.ts` for the reference and
`plugin/test/sealing.test.ts` for the shipping module, so drift in either goes
red on the commit that caused it. The CryptoKit side is run by hand.

Every key in the vector file is generated for it and published on purpose. A
test vector with a secret key is a test vector nobody can run.

## Why three implementations

`plugin/src/sealing.ts` is the code that ships. `frame.mjs` here is a separate
implementation of the same format, and it is **not** a wrapper around the
shipping one. Two implementations agreeing on committed vectors catch the class
of fault a single implementation never can: code that reads its own output
perfectly and is wrong in a way only another reader would notice. This was not
hypothetical. Breaking the HKDF info string leaves the shipping module's own
round-trip tests green and turns only the cross-check red.

The two are allowed to differ in one respect: the shipping module carries the
operational guards (device ceiling, skipping unusable keys, reporting who was
left out) and the reference does not, since nothing operates it.

## Verified

- Node 20.20.2 (the supported floor) and Node 26: all checks pass.
- armv7 under QEMU on the Node 20 floor, in CI: passes. That is the Venus OS
  hardware class this plugin ships to, and a build of OpenSSL without
  ChaCha20-Poly1305 would have failed there rather than in the field.
- Swift 6.3.1 / CryptoKit on macOS 26: all checks pass, against the file Node
  produced, with no adaptation on either side.

Both verifiers were mutation-checked rather than trusted: changing the HKDF
info string turns the decryption checks red while the signature checks stay
green, and changing the signing prefix does the reverse. A verifier that cannot
be made to fail is not measuring anything.

## The negative vectors

`must_not_verify` carries frames that must be refused, and each one is an
attack rather than an illustration:

| Vector | What it proves |
|---|---|
| `body_bit_flipped` | The signature covers the ciphertext |
| `ts_rewritten` | Departure time cannot be moved, which is the proof claim itself |
| `wraps_swapped` | Per-device wraps are bound to their key id |
| `eph_respelled` | A different spelling of identical bytes is refused, so the signature commits to the text on the wire |
| `body_whitespace` | Same, through a character a lax decoder ignores |
| `version_rewritten` | The version field cannot wrap and collide with another version |
| `alert_downgraded` | Extension fields are signed, so an alarm cannot be turned into a normal reading in transit |

The last four exist because a security review found them. The format changed
to close them, before anything shipped, which was the point of doing this
first.

## The rule write vectors

`rule-vectors.json` fixes the one message that travels the other way and is not
a read: the list of which conditions may raise the alarm flag. A read needs no
proof of its sender, because the answer is sealed to the owner's screens
whoever asked. A write does, because the boat's inbox key is public, and
without one anybody who knew it could silence an owner's alarms.

The proof creates no new credential. It is an HMAC under a key derived from the
X25519 private half the device already holds to open her frames: whoever has
that key is reading every report she sends, so there is no fresh secret to
steal.

| Vector | What it proves |
|---|---|
| `rules_reordered` | The rules are covered in the order sent, so a carrier cannot shuffle them |
| `ts_rewritten` | The timestamp is covered, which is what the replay floor rests on |
| `id_rewritten` | The write is bound to its envelope, so a proof cannot be moved to another request |
| `ring_relaxed` | A severity cannot be loosened in transit |
| `rule_dropped` | The count is covered, so an entry cannot be removed from the list |
| `path_rewritten` | A mute cannot be moved from one condition to another |
| `kid_borrowed` | Knowing an authorised key id is not enough without its private half |

Verified by hand on Node 26 and on Swift 6.3.1 / CryptoKit under macOS 26,
against the file Node produced, with no adaptation on either side. The Node 20
floor and Node 22 cover it in CI, where both vector tests run. Both verifiers were
mutation-checked rather than trusted: drifting the HKDF info string turns the
proof checks red while the committed input bytes stay green, and dropping the
rules from the input turns both red. A verifier that cannot be made to fail is
not measuring anything.

## Not decided here

This directory fixes the format. Key lifecycle, pairing, the notification
preference channel and the plan metadata belong to the specification, and
replay defence belongs to the client: a reader must remember the newest
timestamp it has accepted, because no stateless check can catch a whole frame
delivered twice.
