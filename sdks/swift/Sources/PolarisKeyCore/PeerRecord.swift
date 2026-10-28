// WIRE-CONTRACT-V5 §15.6: records inside one Noise transport plaintext (`u16be type ‖ u8 flags ‖
// body`), the type table, MORE reassembly and the order of checks. Swift mirror of client-core's
// `peer/record.ts`. Pure bytes: no I/O, no clock. (The byte layer CC-11.3 listed records; they
// arrive here, with the session that needs them.)

import Foundation

public let peerMaxMessageBytes = 1_048_576
/// A Noise message is at most 65,535 bytes; 16 are the tag and 3 the record header.
public let peerMaxRecordBody = 65535 - 16 - 3
/// Records in one MORE chain: a full 1 MiB message in the smallest records, plus one.
public let peerMaxChainRecords = (peerMaxMessageBytes + peerMaxRecordBody - 1) / peerMaxRecordBody + 1

public enum PeerRecordMode: String, Sendable, Equatable { case a, v, p, c }

public enum PeerCloseCode: String, Sendable, Equatable, CaseIterable {
    case peerRevoked = "peer_revoked"
    case peerExpired = "peer_expired"
    case peerBadFrame = "peer_bad_frame"
    case peerUnknownCritical = "peer_unknown_critical"
    case peerNotAllowed = "peer_not_allowed"
    case peerBusy = "peer_busy"
    case peerTimeout = "peer_timeout"
    case peerBye = "peer_bye"
}

public enum PeerRecordType {
    public static let hello = 0x8001
    public static let ring = 0x0002
    public static let trust = 0x0003
    public static let ping = 0x0004
    public static let pong = 0x0005
    public static let candidates = 0x0006
    public static let vouchReq = 0x8010
    public static let vouchResult = 0x8011
    public static let confirm = 0x8012
    public static let contact = 0x0013
    public static let sasCommit = 0x8014
    public static let sasNonce = 0x8015
    public static let sasReveal = 0x8016
    public static let keyringWrap = 0x0030
    public static let rekey = 0x80fe
    public static let close = 0x80ff
}

struct PeerRecordRow {
    let from: Int
    let to: Int
    let modes: String
    let bodyLen: Int?
}

let peerRecordTypes: [PeerRecordRow] = [
    PeerRecordRow(from: 0x8001, to: 0x8001, modes: "avpc", bodyLen: nil),
    PeerRecordRow(from: 0x0002, to: 0x0002, modes: "a", bodyLen: nil),
    PeerRecordRow(from: 0x0003, to: 0x0003, modes: "a", bodyLen: nil),
    PeerRecordRow(from: 0x0004, to: 0x0004, modes: "avpc", bodyLen: 8),
    PeerRecordRow(from: 0x0005, to: 0x0005, modes: "avpc", bodyLen: 8),
    PeerRecordRow(from: 0x0006, to: 0x0006, modes: "a", bodyLen: nil),
    PeerRecordRow(from: 0x8010, to: 0x8010, modes: "v", bodyLen: nil),
    PeerRecordRow(from: 0x8011, to: 0x8011, modes: "v", bodyLen: nil),
    PeerRecordRow(from: 0x8012, to: 0x8012, modes: "p", bodyLen: nil),
    PeerRecordRow(from: 0x0013, to: 0x0013, modes: "p", bodyLen: nil),
    PeerRecordRow(from: 0x8014, to: 0x8014, modes: "vp", bodyLen: nil),
    PeerRecordRow(from: 0x8015, to: 0x8015, modes: "vp", bodyLen: nil),
    PeerRecordRow(from: 0x8016, to: 0x8016, modes: "vp", bodyLen: nil),
    PeerRecordRow(from: 0x0020, to: 0x0025, modes: "ac", bodyLen: nil),
    PeerRecordRow(from: 0x0030, to: 0x003f, modes: "v", bodyLen: nil),
    PeerRecordRow(from: 0x0100, to: 0x7fff, modes: "ac", bodyLen: nil),
    PeerRecordRow(from: 0x8100, to: 0xfffd, modes: "ac", bodyLen: nil),
    PeerRecordRow(from: 0x80fe, to: 0x80fe, modes: "avpc", bodyLen: 0),
    PeerRecordRow(from: 0x80ff, to: 0x80ff, modes: "avpc", bodyLen: nil),
]

public struct PeerRecord: Sendable, Equatable {
    public let type: Int
    public let flags: UInt8
    public let body: Data

    public init(type: Int, flags: UInt8, body: Data) {
        self.type = type
        self.flags = flags
        self.body = body
    }
}

public enum PeerRecords {
    /// A record from a Noise plaintext; nil (the session closes with `peer_bad_frame`) when it is
    /// shorter than the three header bytes or sets a flag bit other than `MORE`.
    public static func parse(_ plain: Data) -> PeerRecord? {
        let b = [UInt8](plain)
        guard b.count >= 3, b[2] & 0xfe == 0 else { return nil }
        return PeerRecord(type: Int(b[0]) << 8 | Int(b[1]), flags: b[2], body: Data(b[3...]))
    }

    public static func encode(_ r: PeerRecord) -> Data {
        var out = Data(capacity: 3 + r.body.count)
        out.append(UInt8(r.type >> 8))
        out.append(UInt8(r.type & 0xff))
        out.append(r.flags)
        out.append(r.body)
        return out
    }

    public struct MessageTooLarge: Error, Sendable, Equatable {}

    /// A message split into records, `MORE` on all but the last.
    public static func split(type: Int, body: Data) throws -> [Data] {
        guard body.count <= peerMaxMessageBytes else { throw MessageTooLarge() }
        var out: [Data] = []
        var at = 0
        repeat {
            let end = min(body.count, at + peerMaxRecordBody)
            let slice = body.subdata(in: (body.startIndex + at)..<(body.startIndex + end))
            out.append(encode(PeerRecord(type: type, flags: end < body.count ? 1 : 0, body: slice)))
            at = end
        } while at < body.count
        return out
    }
}

public enum PeerAssembleResult: Sendable, Equatable {
    case message(type: Int, body: Data)
    case pending
    case ignored
    case close(PeerCloseCode)
}

/// Reads records in order, in a session of one mode (the checks run in the order §15.6 lists).
public struct PeerRecordAssembler: Sendable {
    private var open: (type: Int, parts: [Data], size: Int)?
    /// Set once a non-critical unknown type opened a chain that is being dropped.
    private var dropping: Int?
    private let mode: PeerRecordMode

    public init(mode: PeerRecordMode) { self.mode = mode }

    public mutating func push(_ r: PeerRecord) -> PeerAssembleResult {
        if r.flags & 0xfe != 0 { return .close(.peerBadFrame) }
        let more = r.flags & 1 != 0
        if let d = dropping {
            if d != r.type { return .close(.peerBadFrame) }
            if !more { dropping = nil }
            return .ignored
        }
        if let o = open, o.type != r.type { return .close(.peerBadFrame) }
        guard let row = peerRecordTypes.first(where: { r.type >= $0.from && r.type <= $0.to }) else {
            if r.type & 0x8000 != 0 { return .close(.peerUnknownCritical) }
            if more { dropping = r.type }
            return .ignored
        }
        if !row.modes.contains(mode.rawValue) { return .close(.peerNotAllowed) }
        // An empty MORE record is accepted (corpus `more-empty-parts`), so the chain's record
        // count is what bounds the work.
        let size = (open?.size ?? 0) + r.body.count
        if size > peerMaxMessageBytes { return .close(.peerBadFrame) }
        var parts = open?.parts ?? []
        if parts.count >= peerMaxChainRecords { return .close(.peerBadFrame) }
        parts.append(r.body)
        if more {
            open = (r.type, parts, size)
            return .pending
        }
        open = nil
        var body = Data(capacity: size)
        for p in parts { body.append(p) }
        if let n = row.bodyLen, body.count != n { return .close(.peerBadFrame) }
        return .message(type: r.type, body: body)
    }
}
