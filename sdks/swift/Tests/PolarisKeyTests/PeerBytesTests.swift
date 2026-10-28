// @pkey-feature connect.protocol
// CC-11.3: the byte layer of `pkey-peer/1` (WIRE-CONTRACT-V5 §15.6, §15.7) against the `frames`
// and `relayEnvelopes` rows of `conformance/corpus/v2/peer-matrix.json`, read in place. Records
// (`records`) are the next slice's.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private struct Matrix: Decodable {
    struct Encode: Decodable { let noise, frame: String }
    struct Want: Decodable {
        let refused: Bool?
        let header: String?
        let frameSha256: String?
        let frames: [String]?
        let rest: String?
        let error: String?
    }
    struct Limit: Decodable {
        let len: Int
        let want: Want
    }
    struct Decode: Decodable {
        let id, stream: String
        let want: Want
    }
    struct Frames: Decodable {
        let encode: [Encode]
        let limits: [Limit]
        let decode: [Decode]
    }
    struct Msg: Decodable {
        let op: String
        let to, from, noise, data, device: String?
        let session: UInt64?
        let devices: [String]?
        let epoch: UInt64?
        let reason: Int?
    }
    struct Row: Decodable {
        let id, dir, bytes: String
        let message: Msg?
    }
    struct Prefix: Decodable { let prefix, fill: String }
    struct Size: Decodable {
        struct W: Decodable { let ok, refused: Bool? }
        let id, dir: String
        let total: Int
        let bytes: Prefix
        let want: W
    }
    struct Relay: Decodable {
        let maxMessage: Int
        let messages: [Row]
        let refused: [Row]
        let sizes: [Size]
    }
    let frames: Frames
    let relayEnvelopes: Relay
}

private func message(_ m: Matrix.Msg) -> PeerRelayMessage {
    switch m.op {
    case "send": return .send(to: unhex(m.to!), session: UInt32(m.session!), noise: unhex(m.noise!))
    case "recv": return .recv(from: unhex(m.from!), session: UInt32(m.session!), noise: unhex(m.noise!))
    case "list": return .list
    case "ping": return .ping(unhex(m.data!))
    case "pong": return .pong(unhex(m.data!))
    case "members": return .members(m.devices!.map(unhex))
    case "ring": return .ring(epoch: m.epoch!)
    case "gone": return .gone(unhex(m.device!))
    default: return .limit(reason: UInt8(m.reason!))
    }
}

private func dir(_ s: String) -> PeerRelayDirection { s == "toRoom" ? .toRoom : .toClient }

final class PeerBytesTests: XCTestCase {
    private let m = try! CorpusLocator.load(Matrix.self, "peer-matrix")

    func testFrameEncode() throws {
        for r in m.frames.encode { XCTAssertEqual(hex(try PeerFrame.encode(unhex(r.noise))), r.frame) }
    }

    func testFrameLimits() throws {
        for r in m.frames.limits {
            let body = Data(repeating: 0x5a, count: r.len)
            if r.want.refused == true {
                XCTAssertThrowsError(try PeerFrame.encode(body), "\(r.len)")
            } else {
                let f = try PeerFrame.encode(body)
                XCTAssertEqual(hex(f.prefix(2)), r.want.header)
                XCTAssertEqual(hex(Data(SHA256.hash(data: f))), r.want.frameSha256, "\(r.len)")
            }
        }
        XCTAssertThrowsError(try PeerFrame.encode(Data(count: 65536)))
    }

    func testFrameDecodeAndReaderAgree() throws {
        for r in m.frames.decode {
            let stream = unhex(r.stream)
            var reader = PeerFrameReader()
            if r.want.error != nil {
                XCTAssertThrowsError(try PeerFrame.decode(stream), r.id) {
                    XCTAssertEqual($0 as? PeerFrame.BadFrame, PeerFrame.BadFrame())
                }
                XCTAssertThrowsError(try reader.push(stream), r.id)
            } else {
                let got = try PeerFrame.decode(stream)
                XCTAssertEqual(got.frames.map(hex), r.want.frames, r.id)
                XCTAssertEqual(hex(got.rest), r.want.rest, r.id)
                // The reader gives the same frames whole, and one byte at a time.
                XCTAssertEqual(try reader.push(stream).map(hex), r.want.frames, r.id)
                var slow = PeerFrameReader()
                var all: [Data] = []
                for b in stream { all += try slow.push(Data([b])) }
                XCTAssertEqual(all.map(hex), r.want.frames, r.id)
            }
        }
    }

    func testReaderCostIsLinearWhenATrickleFillsAFrame() throws {
        var reader = PeerFrameReader()
        let frame = try PeerFrame.encode(Data(repeating: 7, count: 65535))
        var got: [Data] = []
        for b in frame { got += try reader.push(Data([b])) }
        XCTAssertEqual(got.count, 1)
        XCTAssertLessThan(reader.copied, 4 * frame.count)
    }

    func testRelayMessagesRoundTripBothWays() throws {
        XCTAssertEqual(m.relayEnvelopes.maxMessage, peerRelayMaxMessage)
        for r in m.relayEnvelopes.messages {
            let msg = message(r.message!)
            XCTAssertEqual(hex(try PeerRelayEnvelope.encode(msg)), r.bytes, r.id)
            XCTAssertEqual(PeerRelayEnvelope.decode(dir(r.dir), unhex(r.bytes)), msg, r.id)
        }
    }

    func testRelayRefused() {
        for r in m.relayEnvelopes.refused {
            XCTAssertNil(PeerRelayEnvelope.decode(dir(r.dir), unhex(r.bytes)), r.id)
        }
    }

    func testRelaySizes() {
        for r in m.relayEnvelopes.sizes {
            var b = Data(repeating: unhex(r.bytes.fill)[0], count: r.total)
            let prefix = unhex(r.bytes.prefix)
            b.replaceSubrange(0..<prefix.count, with: prefix)
            let got = PeerRelayEnvelope.decode(dir(r.dir), b)
            if r.want.refused == true { XCTAssertNil(got, r.id) } else { XCTAssertNotNil(got, r.id) }
        }
    }

    func testRelayEncodeRefusesWhatTheLayoutCannotHold() {
        let dev = Data(count: 24)
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.send(to: Data(count: 23), session: 0, noise: Data([1]))))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.send(to: dev, session: 0, noise: Data())))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.ping(Data(count: 7))))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.limit(reason: 0)))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.limit(reason: 5)))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.members(Array(repeating: dev, count: 256))))
        XCTAssertThrowsError(try PeerRelayEnvelope.encode(.ring(epoch: 9_007_199_254_740_992)))
        XCTAssertNil(PeerRelayEnvelope.decode(.toClient, Data([0x83, 0x00, 0x20, 0, 0, 0, 0, 0, 0])))
        // A direction mismatch is refused.
        XCTAssertNil(PeerRelayEnvelope.decode(.toClient, Data([0x02])))
        XCTAssertNil(PeerRelayEnvelope.decode(.toRoom, Data([0x86, 1])))
    }
}
