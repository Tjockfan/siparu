// Verify the committed vectors with CryptoKit, the side the phone runs.
//
// Written from the spec of the frame rather than from the Node source, because
// a port that mirrors the other implementation line for line proves only that
// it was copied. What is being tested is whether Apple's primitives and Node's
// produce the same bytes without either side being adapted to the other.
//
//   swift dev/e2e-vectors/Verify.swift
//
// This is a standalone script, not part of the app target: it runs before any
// transport code exists, which is the whole point of running it.

import CryptoKit
import Foundation

func b64u(_ s: String) -> Data {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)!
}

// Length-prefixed field, matching the boat side: two bytes of length, big endian.
func lp(_ d: Data) -> Data {
    var out = Data([UInt8(d.count >> 8), UInt8(d.count & 0xFF)])
    out.append(d)
    return out
}

func u64be(_ n: UInt64) -> Data {
    var out = Data()
    for shift in stride(from: 56, through: 0, by: -8) {
        out.append(UInt8((n >> UInt64(shift)) & 0xFF))
    }
    return out
}

func signingInput(_ frame: [String: Any]) -> Data {
    var out = Data("siparu-frame-v1\0".utf8)
    out.append(UInt8(frame["v"] as! Int))
    out.append(lp(Data((frame["boat"] as! String).utf8)))
    out.append(u64be(UInt64(frame["ts"] as! Int)))
    out.append(lp(b64u(frame["eph"] as! String)))
    out.append(lp(b64u(frame["nonce"] as! String)))
    out.append(lp(b64u(frame["body"] as! String)))
    let keys = frame["keys"] as! [[String: String]]
    out.append(UInt8(keys.count >> 8))
    out.append(UInt8(keys.count & 0xFF))
    for k in keys {
        out.append(lp(Data(k["kid"]!.utf8)))
        out.append(lp(b64u(k["wrap"]!)))
    }
    return out
}

// The wrapping key for one device: the agreement salted with the ephemeral
// public key, bound to that device's key id so two devices on one frame never
// derive the same key.
func wrapKey(shared: SharedSecret, ephPub: Data, kid: String) -> SymmetricKey {
    shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: ephPub,
        sharedInfo: Data("siparu/frame-key/v1/\(kid)".utf8),
        outputByteCount: 32
    )
}

// The wrap nonce is twelve zero bytes; it is safe only because the wrapping key
// is derived from an ephemeral pair unique to this frame.
let wrapNonce = try! ChaChaPoly.Nonce(data: Data(repeating: 0, count: 12))

func aeadOpen(key: SymmetricKey, nonce: ChaChaPoly.Nonce, sealed: Data) throws -> Data {
    let ct = sealed.prefix(sealed.count - 16)
    let tag = sealed.suffix(16)
    let box = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
    return try ChaChaPoly.open(box, using: key)
}

func openFrame(_ frame: [String: Any], kid: String, priv: Data) throws -> String {
    let keys = frame["keys"] as! [[String: String]]
    guard let entry = keys.first(where: { $0["kid"] == kid }) else {
        throw NSError(domain: "siparu", code: 1, userInfo: [NSLocalizedDescriptionKey: "no wrapped key for \(kid)"])
    }
    let ephPub = b64u(frame["eph"] as! String)
    let shared = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
        .sharedSecretFromKeyAgreement(
            with: try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephPub)
        )
    let cek = try aeadOpen(
        key: wrapKey(shared: shared, ephPub: ephPub, kid: kid),
        nonce: wrapNonce,
        sealed: b64u(entry["wrap"]!)
    )
    let bodyNonce = try ChaChaPoly.Nonce(data: b64u(frame["nonce"] as! String))
    let body = try aeadOpen(
        key: SymmetricKey(data: cek),
        nonce: bodyNonce,
        sealed: b64u(frame["body"] as! String)
    )
    return String(decoding: body, as: UTF8.self)
}

var failures = 0
func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "ok  " : "FAIL")  \(name)")
    if !ok { failures += 1 }
}

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let raw = try! Data(contentsOf: here.appendingPathComponent("vectors.json"))
let v = try! JSONSerialization.jsonObject(with: raw) as! [String: Any]

let frame = v["frame"] as! [String: Any]
let expected = v["expected_plaintext"] as! String
let boatPub = try! Curve25519.Signing.PublicKey(
    rawRepresentation: b64u((v["boat_identity"] as! [String: String])["public"]!)
)

check(
    "signing input matches the committed bytes",
    signingInput(frame).map { String(format: "%02x", $0) }.joined()
        == v["expected_signing_input_hex"] as! String
)

check(
    "the boat signature verifies",
    boatPub.isValidSignature(b64u(frame["sig"] as! String), for: signingInput(frame))
)

let devices = v["devices"] as! [[String: String]]
for d in devices {
    var plaintext: String? = nil
    do {
        plaintext = try openFrame(frame, kid: d["kid"]!, priv: b64u(d["private"]!))
    } catch {
        print("      \(d["kid"]!): \(error)")
    }
    check("device \(d["kid"]!) opens the body", plaintext == expected)
}

// A device must not be able to read a frame that was not sealed to it.
do {
    _ = try openFrame(frame, kid: devices[0]["kid"]!, priv: b64u(devices[1]["private"]!))
    check("a device cannot open the wrapped key of another", false)
} catch {
    check("a device cannot open the wrapped key of another", true)
}

for (name, tampered) in (v["must_not_verify"] as! [String: [String: Any]]).sorted(by: { $0.key < $1.key }) {
    check(
        "tampered frame rejected: \(name)",
        !boatPub.isValidSignature(b64u(tampered["sig"] as! String), for: signingInput(tampered))
    )
}

print(failures == 0 ? "\nall vectors pass" : "\n\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
