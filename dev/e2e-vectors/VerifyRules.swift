// Verify the committed rule write vectors with CryptoKit, the side the phone runs.
//
// Written from the spec of the message rather than from the Node source. A port that mirrors
// the other implementation line for line proves only that it was copied; what is being tested
// is whether Apple's primitives and Node's produce the same bytes with neither side adapted to
// the other.
//
//   swift dev/e2e-vectors/VerifyRules.swift
//
// This is the only message that travels from a device to a boat and is not a read, so it is
// the only one carrying a proof of who sent it. The boat's inbox key is public: without this,
// anybody who knew it could silence an owner's alarms, and he would find out the next time
// something went wrong and his phone stayed quiet.

import CryptoKit
import Foundation

func b64u(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func unb64u(_ s: String) -> Data {
    var padded = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while padded.count % 4 != 0 { padded += "=" }
    return Data(base64Encoded: padded) ?? Data()
}

// Length-prefixed field, four bytes of length, big endian. The same discipline as the frame
// signing input, and for the same reason: no two different values may produce the same bytes.
func lp(_ d: Data) -> Data {
    var out = Data()
    for shift in stride(from: 24, through: 0, by: -8) { out.append(UInt8((d.count >> shift) & 0xFF)) }
    out.append(d)
    return out
}

func lp(_ s: String) -> Data { lp(Data(s.utf8)) }

func u16be(_ n: Int) -> Data { Data([UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)]) }

func u32be(_ n: Int) -> Data {
    var out = Data()
    for shift in stride(from: 24, through: 0, by: -8) { out.append(UInt8((n >> shift) & 0xFF)) }
    return out
}

func u64be(_ n: UInt64) -> Data {
    var out = Data()
    for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((n >> UInt64(shift)) & 0xFF)) }
    return out
}

struct Rule {
    let path: String
    let ringFrom: String
}

struct Write {
    let v: Int
    let id: String
    let kid: String
    let ts: UInt64
    let rules: [Rule]
    let proof: String
}

// The exact bytes both ends compute the proof over.
//
// Rules are covered in the order they were sent rather than sorted, so a carrier that
// reordered them fails the check. Raw fields with explicit lengths rather than re-serialised
// JSON: this side and the boat's are written in different languages, and a disagreement
// between their JSON encoders about key order or spacing would refuse every write in the fleet
// at once.
func proofInput(_ w: Write, boat: String) -> Data {
    var out = Data("siparu/rule-proof/v1".utf8)
    out.append(u16be(w.v))
    out.append(lp(boat))
    out.append(lp(w.kid))
    out.append(lp(w.id))
    out.append(u64be(w.ts))
    out.append(u32be(w.rules.count))
    for rule in w.rules {
        out.append(lp(rule.path))
        out.append(lp(rule.ringFrom))
    }
    return out
}

// The key both ends reach from opposite ends of one agreement. The device holds the static
// X25519 private half it already uses to open her frames, so nothing new exists to be stolen:
// whoever has that key is reading every report she sends.
func proofKey(shared: SharedSecret, devicePub: Data, boat: String, kid: String, id: String) -> SymmetricKey {
    shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: devicePub,
        sharedInfo: Data("siparu/rule-proof/v1/\(boat)/\(kid)/\(id)".utf8),
        outputByteCount: 32
    )
}

func makeProof(_ w: Write, boat: String, devicePriv: Data, devicePub: Data, inboxPub: Data) throws -> String {
    let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: devicePriv)
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: inboxPub)
    let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
    let key = proofKey(shared: shared, devicePub: devicePub, boat: boat, kid: w.kid, id: w.id)
    let mac = HMAC<SHA256>.authenticationCode(for: proofInput(w, boat: boat), using: key)
    return b64u(Data(mac))
}

// The boat's half, kept here so the vector proves the agreement is symmetric rather than only
// that one side is self-consistent.
func checkProof(_ w: Write, boat: String, inboxPriv: Data, devicePub: Data) throws -> Bool {
    let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: inboxPriv)
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: devicePub)
    let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
    let key = proofKey(shared: shared, devicePub: devicePub, boat: boat, kid: w.kid, id: w.id)
    let mac = HMAC<SHA256>.authenticationCode(for: proofInput(w, boat: boat), using: key)
    return Data(mac) == unb64u(w.proof)
}

func readWrite(_ any: Any?) -> Write {
    let d = any as? [String: Any] ?? [:]
    let rules = (d["rules"] as? [[String: Any]] ?? []).map {
        Rule(path: $0["path"] as? String ?? "", ringFrom: $0["ring_from"] as? String ?? "")
    }
    return Write(
        v: d["v"] as? Int ?? 0,
        id: d["id"] as? String ?? "",
        kid: d["kid"] as? String ?? "",
        ts: UInt64(d["ts"] as? Double ?? 0),
        rules: rules,
        proof: d["proof"] as? String ?? ""
    )
}

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let raw = try Data(contentsOf: here.appendingPathComponent("rule-vectors.json"))
let v = try JSONSerialization.jsonObject(with: raw) as! [String: Any]

var failures = 0
func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "ok  " : "FAIL")  \(name)")
    if !ok { failures += 1 }
}

let boat = v["boat"] as! String
let inbox = v["boat_inbox"] as! [String: String]
let inboxPub = unb64u(inbox["public"]!)
let inboxPriv = unb64u(inbox["private"]!)
let phone = (v["devices"] as! [[String: String]])[0]
let phonePub = unb64u(phone["public"]!)
let phonePriv = unb64u(phone["private"]!)
let write = readWrite(v["write"])

check(
    "proof input matches the committed bytes",
    proofInput(write, boat: boat).map { String(format: "%02x", $0) }.joined()
        == v["expected_proof_input_hex"] as! String
)

check(
    "the device recomputes the committed proof",
    try makeProof(write, boat: boat, devicePriv: phonePriv, devicePub: phonePub, inboxPub: inboxPub)
        == write.proof
)

check(
    "the boat reaches the same proof from her end of the agreement",
    try checkProof(write, boat: boat, inboxPriv: inboxPriv, devicePub: phonePub)
)

let other = v["other_boat"] as! [String: Any]
check(
    "the same write does not verify at another vessel",
    try !checkProof(
        readWrite(other["write"]),
        boat: other["boat"] as! String,
        inboxPriv: inboxPriv,
        devicePub: phonePub
    )
)

for (name, tampered) in (v["must_not_verify"] as! [String: Any]).sorted(by: { $0.key < $1.key }) {
    check(
        "refused: \(name)",
        try !checkProof(readWrite(tampered), boat: boat, inboxPriv: inboxPriv, devicePub: phonePub)
    )
}

print(failures == 0 ? "\nall rule vectors pass" : "\n\(failures) failed")
exit(failures == 0 ? 0 : 1)
