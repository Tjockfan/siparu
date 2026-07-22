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

## Not decided here

This directory fixes the format. Key lifecycle, pairing, the notification
preference channel and the plan metadata belong to the specification, and
replay defence belongs to the client: a reader must remember the newest
timestamp it has accepted, because no stateless check can catch a whole frame
delivered twice.
