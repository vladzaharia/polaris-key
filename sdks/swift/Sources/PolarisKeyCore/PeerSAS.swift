// WIRE-CONTRACT-V5 §15.5: the short authentication code of modes v and p, with its commit and
// reveal (CC-11.6). Swift mirror of client-core's `peer/sas.ts`. Nonces and commitments travel as
// 43 canonical base64url characters.

import Foundation

public enum PeerSasError: Error, Sendable, Equatable { case length }

public enum PeerSasMember: String, Sendable {
    case c, nM, nD
}

public enum PeerSAS {
    public static func commit(_ nD: Data) -> Data { PeerNoiseHash.sha256(nD) }

    /// 32 bytes as 43 base64url characters.
    public static func encodeValue(_ b: Data) throws -> String {
        guard b.count == 32 else { throw PeerSasError.length }
        return Base64URL.encode(b)
    }

    /// 43 canonical base64url characters to 32 bytes; anything else is nil.
    public static func decodeValue(_ text: String) -> Data? {
        let s = Array(text.unicodeScalars)
        guard s.count == 43,
            s.allSatisfy({
                ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5a)
                    || ($0.value >= 0x61 && $0.value <= 0x7a) || $0 == "-" || $0 == "_"
            }),
            let d = Base64URL.decodeStrict(text), d.count == 32, Base64URL.encode(d) == text
        else { return nil }
        return d
    }

    /// The body of SAS_COMMIT, SAS_NONCE or SAS_REVEAL: compact JSON, one member.
    public static func body(_ member: PeerSasMember, _ value: Data) throws -> Data {
        Data(#"{"\#(member.rawValue)":"\#(try encodeValue(value))"}"#.utf8)
    }

    /// Read a body; nil when it is anything but the canonical one-member object.
    public static func parseBody(_ member: PeerSasMember, _ body: Data) -> Data? {
        guard let text = String(data: body, encoding: .utf8) else { return nil }
        let prefix = #"{"\#(member.rawValue)":""#
        guard text.hasPrefix(prefix), text.hasSuffix(#""}"#), text.utf8.count > prefix.utf8.count + 2 else {
            return nil
        }
        let inner = text.dropFirst(prefix.count).dropLast(2)
        return decodeValue(String(inner))
    }

    /// The code, 0..999999, from the handshake hash and both nonces.
    public static func value(handshakeHash h: Data, nD: Data, nM: Data, mode: PeerNoiseMode) -> Int {
        let okm = PeerNoiseHash.hkdfSHA256(
            salt: h, ikm: nD + nM, info: Data("pkey-peer/1 sas".utf8) + [0] + Data(mode.rawValue.utf8),
            length: 32)
        let u = okm.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return Int(u % 1_000_000)
    }

    /// Six digits with leading zeros, a space between the triples.
    public static func display(_ n: Int) -> String {
        let s = String(n)
        let padded = String(repeating: "0", count: max(0, 6 - s.count)) + s
        return padded.prefix(3) + " " + padded.dropFirst(3)
    }

    /// Does the revealed nonce match the commitment? Both are the base64url spelling.
    public static func revealOK(commit c: String, nD: String) -> Bool {
        guard let commit = decodeValue(c), let nonce = decodeValue(nD) else { return false }
        let h = PeerNoiseHash.sha256(nonce)
        var diff: UInt8 = 0
        for i in 0..<32 { diff |= h[h.startIndex + i] ^ commit[commit.startIndex + i] }
        return diff == 0
    }
}
