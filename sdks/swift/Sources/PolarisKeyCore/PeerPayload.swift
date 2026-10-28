// WIRE-CONTRACT-V5 §15.5: handshake payloads (CC-11.6). Swift mirror of client-core's
// `peer/payload.ts`. Strict JSON (§1.2), an object, at most 8 KiB.

import Foundation

public let peerMaxHandshakePayload = 8192
public let peerMaxCaps = 32

public enum PeerPayloadError: Error, Sendable, Equatable { case account, size }

public struct PeerPayloadVerdict: Sendable, Equatable {
    public let ok: Bool
    public let caps: [String]
    public let ring: Int?
    public let cert: String?

    static let no = PeerPayloadVerdict(ok: false, caps: [], ring: nil, cert: nil)
}

public enum PeerPayload {
    /// Parse a payload as strict JSON; nil on any failure. Also gives the integer rule's pointers.
    static func parseStrictObject(_ bytes: Data) -> (object: [String: JSONValue], nonWire: NonWireIntegers)? {
        guard String(data: bytes, encoding: .utf8) != nil, !bytes.starts(with: [0xEF, 0xBB, 0xBF]),
            let nonWire = StrictJSON.validate(bytes),
            let v = try? JSONDecoder().decode(JSONValue.self, from: bytes), case .object(let o) = v
        else { return nil }
        return (o, nonWire)
    }

    private static func isCap(_ s: String) -> Bool {
        let parts = s.unicodeScalars.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return false }
        return parts[0].allSatisfy { ($0.value >= 0x61 && $0.value <= 0x7a) || ($0.value >= 0x30 && $0.value <= 0x39) }
            && parts[1].allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
    }

    /// Judge one handshake payload: message 1, or message 2 or 3 in a mode.
    public static func parse(mode: PeerNoiseMode, message: Int, _ bytes: Data) -> PeerPayloadVerdict {
        let no = PeerPayloadVerdict.no
        guard bytes.count <= peerMaxHandshakePayload, let (o, nonWire) = parseStrictObject(bytes),
            case .int(let v)? = o["v"], wireInteger(v, pointer: "/v", min: 1, in: nonWire), v == 1
        else { return no }
        if message == 1 { return o["cert"] != nil ? no : PeerPayloadVerdict(ok: true, caps: [], ring: nil, cert: nil) }
        guard case .array(let items)? = o["caps"], items.count <= peerMaxCaps else { return no }
        var caps: [String] = []
        for item in items {
            guard case .string(let c) = item, isCap(c) else { return no }
            caps.append(c)
        }
        if mode != .a {
            return o["cert"] != nil ? no : PeerPayloadVerdict(ok: true, caps: caps, ring: nil, cert: nil)
        }
        guard case .string(let cert)? = o["cert"], !cert.isEmpty, case .int(let ring)? = o["ring"],
            wireInteger(ring, pointer: "/ring", min: 1, in: nonWire)
        else { return no }
        return PeerPayloadVerdict(ok: true, caps: caps, ring: ring, cert: cert)
    }

    /// The capabilities both sides list, once each, in byte order.
    public static func capsIntersection(_ a: [String], _ b: [String]) -> [String] {
        Array(Set(a.filter { b.contains($0) })).sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
    }

    /// The bytes of message 1's payload.
    public static func payload1() -> Data { Data(#"{"v":1}"#.utf8) }

    private static func quoted(_ s: String) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self)
    }

    /// The bytes of message 2 or 3: `cert` and `ring` in mode a only.
    public static func payload23(
        mode: PeerNoiseMode, caps: [String], account: (cert: String, ring: Int)? = nil
    ) throws -> Data {
        var s = #"{"v":1"#
        if mode == .a {
            guard let account else { throw PeerPayloadError.account }
            s += #","cert":\#(quoted(account.cert)),"ring":\#(account.ring)"#
        }
        s += #","caps":[\#(caps.map(quoted).joined(separator: ","))]}"#
        let bytes = Data(s.utf8)
        guard bytes.count <= peerMaxHandshakePayload else { throw PeerPayloadError.size }
        return bytes
    }
}
