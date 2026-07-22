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

enum FrameError: Error, CustomStringConvertible {
    case malformed(String)

    var description: String {
        switch self {
        case .malformed(let why): return why
        }
    }
}

let alphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

// Decode base64url, refusing any spelling but the canonical one.
//
// Foundation is stricter than Node here, and that difference is itself the
// hazard: a frame Node accepts as authentic can be one Foundation refuses, so
// a device that force-unwrapped its decoder would crash on input a hostile
// relay could choose. Both sides therefore reject the same set, and this
// function returns rather than traps.
func strictDecode(_ value: Any?, _ expectedBytes: Int? = nil) throws -> Data {
    guard let s = value as? String else { throw FrameError.malformed("not a base64url string") }
    guard s.allSatisfy({ alphabet.contains($0) }) else {
        throw FrameError.malformed("base64url field has invalid characters")
    }
    var padded = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while padded.count % 4 != 0 { padded += "=" }
    guard let data = Data(base64Encoded: padded) else {
        throw FrameError.malformed("base64url field does not decode")
    }
    guard encodeB64u(data) == s else { throw FrameError.malformed("base64url field is not canonical") }
    if let want = expectedBytes, data.count != want {
        throw FrameError.malformed("expected \(want) bytes, got \(data.count)")
    }
    return data
}

func encodeB64u(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

// Length-prefixed field, matching the boat side: four bytes of length, big
// endian. Thirty-two bits because history answers will travel in this envelope.
func lp(_ d: Data) -> Data {
    var out = Data()
    for shift in stride(from: 24, through: 0, by: -8) { out.append(UInt8((d.count >> shift) & 0xFF)) }
    out.append(d)
    return out
}

func u16be(_ n: Int) -> Data { Data([UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)]) }

func u64be(_ n: UInt64) -> Data {
    var out = Data()
    for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((n >> UInt64(shift)) & 0xFF)) }
    return out
}

let knownFields: Set<String> = ["v", "boat", "ts", "eph", "nonce", "body", "keys", "sig"]

func signingInput(_ frame: [String: Any]) throws -> Data {
    guard let v = frame["v"] as? Int, v >= 0, v <= 0xFFFF else {
        throw FrameError.malformed("frame version must fit sixteen bits")
    }
    guard let ts = frame["ts"] as? Int, ts >= 0 else {
        throw FrameError.malformed("frame timestamp must be a non-negative integer")
    }
    guard let boat = frame["boat"] as? String else { throw FrameError.malformed("boat id must be a string") }
    guard let keys = frame["keys"] as? [[String: Any]] else {
        throw FrameError.malformed("keys must be an array")
    }

    var out = Data("siparu-frame-v1\0".utf8)
    out.append(u16be(v))
    out.append(lp(Data(boat.utf8)))
    out.append(u64be(UInt64(ts)))
    out.append(lp(try strictDecode(frame["eph"], 32)))
    out.append(lp(try strictDecode(frame["nonce"], 12)))
    out.append(lp(try strictDecode(frame["body"])))

    out.append(u16be(keys.count))
    var seen = Set<String>()
    for k in keys {
        guard let kid = k["kid"] as? String, !kid.isEmpty else {
            throw FrameError.malformed("wrapped key needs a kid")
        }
        guard !seen.contains(kid) else { throw FrameError.malformed("duplicate key id \(kid)") }
        seen.insert(kid)
        out.append(lp(Data(kid.utf8)))
        out.append(lp(try strictDecode(k["wrap"])))
    }

    // Extension fields, in canonical order. The alarm severity flag is the
    // first of these: cleartext by necessity, since the relay has to know a
    // push is due, and signed so that it cannot be downgraded in transit.
    let extKeys = frame.keys.filter { !knownFields.contains($0) }.sorted()
    out.append(u16be(extKeys.count))
    for key in extKeys {
        guard key.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil else {
            throw FrameError.malformed("extension field \(key) is not a legal name")
        }
        guard let value = frame[key] as? String else {
            throw FrameError.malformed("extension field \(key) must be a string")
        }
        out.append(lp(Data(key.utf8)))
        out.append(lp(Data(value.utf8)))
    }
    return out
}

// The wrapping key and nonce for one device: the agreement salted with the
// ephemeral public key, bound to the boat, the timestamp and the device's key
// id. The nonce is derived rather than fixed, so a repeated ephemeral pair
// (a cloned disk image, a restored virtual machine) is not an instant
// keystream reuse.
func wrapSecrets(shared: SharedSecret, ephPub: Data, boat: String, ts: Int, kid: String)
    -> (key: SymmetricKey, nonce: ChaChaPoly.Nonce)
{
    let derived = shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: ephPub,
        sharedInfo: Data("siparu/frame-key/v1/\(boat)/\(ts)/\(kid)".utf8),
        outputByteCount: 44
    )
    let bytes = derived.withUnsafeBytes { Data($0) }
    return (SymmetricKey(data: bytes.prefix(32)), try! ChaChaPoly.Nonce(data: bytes.suffix(12)))
}

func aeadOpen(key: SymmetricKey, nonce: ChaChaPoly.Nonce, sealed: Data) throws -> Data {
    guard sealed.count >= 16 else { throw FrameError.malformed("sealed value is too short for a tag") }
    let box = try ChaChaPoly.SealedBox(
        nonce: nonce,
        ciphertext: sealed.prefix(sealed.count - 16),
        tag: sealed.suffix(16)
    )
    return try ChaChaPoly.open(box, using: key)
}

func verifyFrame(_ frame: [String: Any], _ boatPub: Curve25519.Signing.PublicKey) -> Bool {
    do {
        let sig = try strictDecode(frame["sig"], 64)
        var unsigned = frame
        unsigned.removeValue(forKey: "sig")
        guard let keys = unsigned["keys"] as? [[String: Any]], keys.count <= 5 else { return false }
        return boatPub.isValidSignature(sig, for: try signingInput(unsigned))
    } catch {
        return false
    }
}

// The signature is checked by the reader, not only by the relay. Decryption
// says nothing about the timestamp, which travels in the open: a relay that
// kept an old frame, moved its timestamp to now and passed it on unchanged
// would leave a device showing a stale position as current.
func openFrame(_ frame: [String: Any], _ boatPub: Curve25519.Signing.PublicKey, kid: String, priv: Data)
    throws -> String
{
    guard verifyFrame(frame, boatPub) else { throw FrameError.malformed("signature does not verify") }
    guard frame["v"] as? Int == 1 else { throw FrameError.malformed("unsupported frame version") }
    guard let keys = frame["keys"] as? [[String: Any]],
          let entry = keys.first(where: { $0["kid"] as? String == kid })
    else { throw FrameError.malformed("no wrapped key for \(kid)") }
    guard let boat = frame["boat"] as? String, let ts = frame["ts"] as? Int else {
        throw FrameError.malformed("frame is missing its metadata")
    }

    let ephPub = try strictDecode(frame["eph"], 32)
    let shared = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
        .sharedSecretFromKeyAgreement(
            with: try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephPub)
        )
    let secrets = wrapSecrets(shared: shared, ephPub: ephPub, boat: boat, ts: ts, kid: kid)
    let cek = try aeadOpen(key: secrets.key, nonce: secrets.nonce, sealed: try strictDecode(entry["wrap"]))
    let body = try aeadOpen(
        key: SymmetricKey(data: cek),
        nonce: try ChaChaPoly.Nonce(data: try strictDecode(frame["nonce"], 12)),
        sealed: try strictDecode(frame["body"])
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
    rawRepresentation: try! strictDecode((v["boat_identity"] as! [String: String])["public"]!)
)

check(
    "signing input matches the committed bytes",
    (try? signingInput(frame))?.map { String(format: "%02x", $0) }.joined()
        == v["expected_signing_input_hex"] as? String
)

check("the boat signature verifies", verifyFrame(frame, boatPub))

let devices = v["devices"] as! [[String: String]]
for d in devices {
    var plaintext: String? = nil
    do {
        plaintext = try openFrame(frame, boatPub, kid: d["kid"]!, priv: try strictDecode(d["private"]!))
    } catch {
        print("      \(d["kid"]!): \(error)")
    }
    check("device \(d["kid"]!) opens the body", plaintext == expected)
}

// A device must not be able to read a frame that was not sealed to it.
do {
    _ = try openFrame(frame, boatPub, kid: devices[0]["kid"]!, priv: try strictDecode(devices[1]["private"]!))
    check("a device cannot open the wrapped key of another", false)
} catch {
    check("a device cannot open the wrapped key of another", true)
}

// A reader runs the proof layer itself, or a replayed frame reads as current.
do {
    let replayed = (v["must_not_verify"] as! [String: [String: Any]])["ts_rewritten"]!
    _ = try openFrame(replayed, boatPub, kid: devices[0]["kid"]!, priv: try strictDecode(devices[0]["private"]!))
    check("a device refuses a frame whose timestamp was rewritten", false)
} catch {
    check("a device refuses a frame whose timestamp was rewritten", true)
}

for (name, tampered) in (v["must_not_verify"] as! [String: [String: Any]]).sorted(by: { $0.key < $1.key }) {
    check("tampered frame rejected: \(name)", !verifyFrame(tampered, boatPub))
}

print(failures == 0 ? "\nall vectors pass" : "\n\(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
