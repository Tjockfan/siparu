# Sealed frame test vectors

The end-to-end encrypted telemetry frame is agreed between two runtimes that
share no code: the boat runs Node, the phone runs CryptoKit. This directory
fixes the primitives before either side is written, because "both platforms
support it" is an assumption that only fails once transport code exists and is
expensive to unwind.

## The suite

| Layer | Primitive |
|---|---|
| Key agreement | X25519 |
| Key derivation | HKDF-SHA256 |
| Encryption | ChaCha20-Poly1305 |
| Signature | Ed25519 |

One frame carries a body encrypted once under a content key, and that content
key wrapped separately to each authorised device. Confidentiality comes from the
encryption; the claim that a frame arrived when it did and was not altered comes
from the signature, which covers the ciphertext. A relay that cannot read a
frame can still verify it.

## Running

```sh
node dev/e2e-vectors/generate.mjs > dev/e2e-vectors/vectors.json   # only when the format changes
node dev/e2e-vectors/verify.mjs                                    # boat side
swift dev/e2e-vectors/Verify.swift                                 # device side
```

`vectors.json` is committed. Regenerating it is a deliberate act: both verifiers
must be rerun after, and the Node half is also pinned by
`plugin/test/e2e-vectors.test.ts` so drift in the reference or the file goes red
in CI rather than in someone's hand.

Every key in the vector file is generated for it and published on purpose. A
test vector with a secret key is a test vector nobody can run.

## Verified

- Node 20.20.2 (the supported floor) and Node 26: all checks pass.
- Swift 6.3.1 / CryptoKit on macOS 26: all checks pass, against the file Node
  produced, with no adaptation on either side.

Both verifiers were mutation-checked rather than trusted: changing the HKDF
info string turns the decryption checks red while the signature checks stay
green, and changing the signing prefix does the reverse. A verifier that cannot
be made to fail is not measuring anything.

## Not yet decided here

This directory fixes the primitives and the signing input, not the whole
protocol. Key lifecycle, pairing, the cleartext alarm flag and the plan
metadata belong to the spec that follows, and the frame shape here is a draft
until it is written down there.
