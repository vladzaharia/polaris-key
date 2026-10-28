// WIRE-CONTRACT-V5 §15.7: relay envelopes, one binary WebSocket message each (CC-11.3). Swift
// mirror of client-core's `peer/relay.ts`. A device is its 24 decoded device-id bytes. A message
// that does not match its layout exactly is refused.

import Foundation

public let peerRelayMaxMessage = 65564

public enum PeerRelayMessage: Sendable, Equatable {
    case send(to: Data, session: UInt32, noise: Data)
    case list
    case ping(Data)
    case recv(from: Data, session: UInt32, noise: Data)
    case members([Data])
    case ring(epoch: UInt64)
    case pong(Data)
    case gone(Data)
    case limit(reason: UInt8)
}

/// Who sent the message: a client to the room, or the room to a client.
public enum PeerRelayDirection: Sendable {
    case toRoom, toClient
}

/// A value the layout cannot hold.
public struct PeerRelayEnvelopeError: Error, Sendable, Equatable {}

public enum PeerRelayEnvelope {
    private static func u32(_ n: UInt32) -> Data {
        Data([UInt8(n >> 24), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
    }

    private static func need(_ ok: Bool) throws { if !ok { throw PeerRelayEnvelopeError() } }

    /// Encode one message; throws on a value its layout cannot hold.
    public static func encode(_ m: PeerRelayMessage) throws -> Data {
        var out = Data()
        switch m {
        case .send(let to, let session, let noise):
            try need(to.count == 24 && noise.count >= 1 && noise.count <= 65535)
            out = Data([0x01]) + to + u32(session) + noise
        case .recv(let from, let session, let noise):
            try need(from.count == 24 && noise.count >= 1 && noise.count <= 65535)
            out = Data([0x81]) + from + u32(session) + noise
        case .list:
            out = Data([0x02])
        case .ping(let d):
            try need(d.count == 8)
            out = Data([0x03]) + d
        case .pong(let d):
            try need(d.count == 8)
            out = Data([0x84]) + d
        case .members(let devices):
            try need(devices.count <= 255 && devices.allSatisfy { $0.count == 24 })
            out = Data([0x82, UInt8(devices.count)])
            for d in devices { out.append(d) }
        case .ring(let epoch):
            // The decoder refuses an epoch above 2^53 - 1, so the encoder does too.
            try need(epoch <= 9_007_199_254_740_991)
            out = Data([0x83]) + Data((0..<8).map { UInt8((epoch >> UInt64(56 - 8 * $0)) & 0xff) })
        case .gone(let d):
            try need(d.count == 24)
            out = Data([0x85]) + d
        case .limit(let reason):
            try need(reason >= 1 && reason <= 4)
            out = Data([0x86, reason])
        }
        try need(out.count <= peerRelayMaxMessage)
        return out
    }

    /// Decode one message. nil means refused (the caller closes the socket).
    public static func decode(_ dir: PeerRelayDirection, _ bytes: Data) -> PeerRelayMessage? {
        let b = [UInt8](bytes)
        guard b.count >= 1, b.count <= peerRelayMaxMessage else { return nil }
        let op = b[0]
        let rest = Array(b[1...])
        func session() -> UInt32 {
            rest[24..<28].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        }
        if dir == .toRoom {
            if op == 0x01 && rest.count >= 29 {
                return .send(to: Data(rest[0..<24]), session: session(), noise: Data(rest[28...]))
            }
            if op == 0x02 && rest.isEmpty { return .list }
            if op == 0x03 && rest.count == 8 { return .ping(Data(rest)) }
            return nil
        }
        if op == 0x81 && rest.count >= 29 {
            return .recv(from: Data(rest[0..<24]), session: session(), noise: Data(rest[28...]))
        }
        if op == 0x82 && rest.count >= 1 && rest.count == 1 + Int(rest[0]) * 24 {
            return .members(
                (0..<Int(rest[0])).map { Data(rest[(1 + $0 * 24)..<(25 + $0 * 24)]) })
        }
        if op == 0x83 && rest.count == 8 {
            let epoch = rest.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            return epoch > 9_007_199_254_740_991 ? nil : .ring(epoch: epoch)
        }
        if op == 0x84 && rest.count == 8 { return .pong(Data(rest)) }
        if op == 0x85 && rest.count == 24 { return .gone(Data(rest)) }
        if op == 0x86 && rest.count == 1 && rest[0] >= 1 && rest[0] <= 4 { return .limit(reason: rest[0]) }
        return nil
    }
}
