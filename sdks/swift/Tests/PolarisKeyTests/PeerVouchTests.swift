// @pkey-feature identity.nearby
// CC-15.S1: the mode-v vouch codecs (WIRE-CONTRACT-V5 §15.6.1) against the `vouch` rows of
// `conformance/corpus/v2/peer-matrix.json`, read in place, and the unit rules the rows cannot show: the
// decoys, the advert instance, the failure budget and the 16 KiB open-chain cap of modes v and p. Mirrors
// client-core's `peerVouch.test.ts` and the Node runner's `vouch` suite.

import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private struct FlowRecord: VouchRecordLike {
    let type: Int
    let body: Data
    let at: Int
}

final class PeerVouchTests: XCTestCase {
    private struct Matrix: Decodable {
        struct Hello: Decodable {
            let label: String?
            let platform: String
        }
        struct Pad: Decodable {
            let prefix, fill, suffix: String
            let count: Int
        }
        struct Shown: Decodable {
            let request, deviceId, signKey, agreeKey: String
            let label: String?
            let platform: String
        }
        struct Request: Decodable {
            let id, slug, hHex, verdict: String
            let hello: Hello
            let body, bodyHex: String?
            let bodyPad: Pad?
            let length: Int?
            let result: Shown?
            let close: String?
        }
        struct Result: Decodable {
            let id: String
            let body, bodyHex, status, refuse: String?
        }
        struct Step: Decodable {
            let ev: String?
            let capsD, capsM: [String]?
            let dir, type, status: String?
            let bytes: Int?
        }
        struct Want: Decodable {
            let close: String?
            let at: Int?
            let delivered: [Int]
        }
        struct Flow: Decodable {
            let id: String
            let steps: [Step]
            let want: Want
        }
        struct Want2: Decodable {
            let send, wait: String?
            let close: Bool?
            let stopAdvert: Bool?
        }
        struct Finish: Decodable {
            let id: String
            let keysRetried: Bool
            let http: Int?
            let body: String?
            let discoveryNearby: Bool
            let result: Want2
        }
        struct Vouch: Decodable {
            let requests: [Request]
            let results: [Result]
            let flows: [Flow]
            let finish: [Finish]
        }
        let vouch: Vouch
    }

    private let v = try! CorpusLocator.load(Matrix.self, "peer-matrix").vouch

    private func body(_ r: Matrix.Request) -> Data {
        if let h = r.bodyHex { return unhex(h) }
        if let p = r.bodyPad { return Data((p.prefix + String(repeating: p.fill, count: p.count) + p.suffix).utf8) }
        return Data((r.body ?? "").utf8)
    }

    // MARK: The corpus rows

    func testTheRowCountsArePinned() {
        XCTAssertEqual(v.requests.count, 78)
        XCTAssertEqual(v.results.count, 26)
        XCTAssertEqual(v.flows.count, 30)
        XCTAssertEqual(v.finish.count, 29)
        for ids in [v.requests.map(\.id), v.results.map(\.id), v.flows.map(\.id), v.finish.map(\.id)] {
            XCTAssertEqual(Set(ids).count, ids.count)
        }
    }

    func testRequests() {
        for r in v.requests {
            let b = body(r)
            if let n = r.length { XCTAssertEqual(b.count, n, r.id) }
            let got = PeerVouch.verifyRequest(
                slug: r.slug, h: unhex(r.hHex), hello: VouchHello(label: r.hello.label, platform: r.hello.platform),
                body: b)
            if r.verdict == "ok" {
                let want = r.result!
                XCTAssertEqual(got?.request, want.request, r.id)
                XCTAssertEqual(got?.deviceId, want.deviceId, r.id)
                XCTAssertEqual(got?.signKey, want.signKey, r.id)
                XCTAssertEqual(got?.agreeKey, want.agreeKey, r.id)
                XCTAssertEqual(got?.platform, want.platform, r.id)
                XCTAssertNotNil(got, r.id)
                XCTAssertEqual(
                    got?.label.map { Array($0.unicodeScalars) }, want.label.map { Array($0.unicodeScalars) }, r.id)
            } else {
                XCTAssertNil(got, r.id)
                XCTAssertEqual(r.close, "peer_bad_frame", r.id)
            }
        }
    }

    func testResults() {
        for r in v.results {
            let b = r.bodyHex.map(unhex) ?? Data((r.body ?? "").utf8)
            let got = PeerVouch.parseResult(b)
            if let refuse = r.refuse {
                XCTAssertEqual(got, .refuse(PeerCloseCode(rawValue: refuse)!), r.id)
            } else {
                XCTAssertEqual(got, .status(VouchStatus(rawValue: r.status!)!), r.id)
            }
        }
    }

    func testFinish() {
        for r in v.finish {
            let got = PeerVouch.finishMap(
                VouchApproveAnswer(
                    http: r.http, body: r.body, discoveryNearby: r.discoveryNearby, keysRetried: r.keysRetried))
            let want: VouchFinishAction
            if let s = r.result.send {
                want = .send(VouchStatus(rawValue: s)!)
            } else if let w = r.result.wait {
                want = w == "choice" ? .waitChoice : .waitKeys
            } else {
                want = .close(stopAdvert: r.result.stopAdvert ?? false)
            }
            XCTAssertEqual(got, want, r.id)
        }
    }

    /// One requester flow and one approver flow, the receiving end checking each record first, as the two
    /// ends of one session.
    private func run(_ steps: [Matrix.Step]) -> (close: String?, at: Int?, delivered: [Int]) {
        let d = VouchFlow<FlowRecord>(role: .requester)
        let m = VouchFlow<FlowRecord>(role: .approver)
        var delivered: [Int] = []
        for (i, s) in steps.enumerated() {
            func take(_ vd: VouchVerdict<FlowRecord>, onM: Bool = false) -> String? {
                switch vd {
                case .close(let c): return c.rawValue
                case .ok(let out):
                    for r in out {
                        delivered.append(r.at)
                        if onM && r.type == PeerRecordType.vouchReq { m.verified() }
                    }
                    return nil
                }
            }
            var code: String?
            switch s.ev {
            case "handshake"?:
                code = take(d.negotiate(local: s.capsD!, remote: s.capsM!))
                if code == nil { code = take(m.negotiate(local: s.capsM!, remote: s.capsD!)) }
            case "shown"?:
                d.codeShown()
                m.codeShown()
            case "picked"?: code = take(m.picked(), onM: true)
            case "wrong-pick"?, "none-match"?: code = take(m.abandon(s.ev == "wrong-pick" ? .wrongPick : .noneMatch))
            case "timeout"?: code = take(m.abandon(.timeout))
            case "confirmed"?: code = take(d.confirmAccount())
            case nil:
                let type = Int(s.type!, radix: 16)!
                let b =
                    type == PeerRecordType.vouchResult
                    ? PeerVouch.buildResult(VouchStatus(rawValue: s.status!)!) : Data(count: s.bytes ?? 0)
                let r = FlowRecord(type: type, body: b, at: i)
                let (from, to) = s.dir == "d2m" ? (d, m) : (m, d)
                code = take(to.receive(r), onM: to === m)
                // The sender's verdict only gates: what the receiver delivers is what counts.
                let sent = from.send(r)
                if code == nil, case .close(let c) = sent { code = c.rawValue }
            default: XCTFail("unknown event \(s.ev ?? "")")
            }
            if let code { return (code, i, delivered) }
        }
        return (nil, nil, delivered)
    }

    func testFlows() {
        for f in v.flows {
            let got = run(f.steps)
            XCTAssertEqual(got.close, f.want.close, f.id)
            XCTAssertEqual(got.at, f.want.at, f.id)
            XCTAssertEqual(got.delivered, f.want.delivered, f.id)
        }
    }

    // MARK: The unit rules

    func testBuildThenVerifyRoundTrip() async throws {
        let store = try DeviceKeyStore.inMemory()
        let h = Data((0..<32).map { UInt8($0) })
        let request = "nr_AAAAAAAAAAAAAAAAAAAAAA"
        let id = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
        let hello = VouchHello(label: "Ana's laptop", platform: "macos")
        let b = try await PeerVouch.buildRequest(
            port: store, slug: "djdl", h: h, request: request, deviceId: id, hello: hello)
        let ok = PeerVouch.verifyRequest(slug: "djdl", h: h, hello: hello, helloCleaned: true, body: b)
        let keys = try await store.ensure()
        XCTAssertEqual(ok?.request, request)
        XCTAssertEqual(ok?.deviceId, id)
        XCTAssertEqual(ok?.signKey, keys.signKey)
        XCTAssertEqual(ok?.agreeKey, keys.agreeKey)
        // The proof binds one session, one product and one hello.
        var other = h
        other[0] ^= 1
        XCTAssertNil(PeerVouch.verifyRequest(slug: "djdl", h: other, hello: hello, body: b))
        XCTAssertNil(PeerVouch.verifyRequest(slug: "other", h: h, hello: hello, body: b))
        XCTAssertNil(
            PeerVouch.verifyRequest(slug: "djdl", h: h, hello: VouchHello(label: "Bo", platform: "macos"), body: b))
        XCTAssertNil(
            PeerVouch.verifyRequest(
                slug: "djdl", h: h, hello: VouchHello(label: "Ana's laptop", platform: "ios"), body: b))
        // Bad inputs are refused before anything is signed.
        for (rq, did, hh) in [("nr_short", id, h), (request, "short", h), (request, id, Data(count: 31))] {
            do {
                _ = try await PeerVouch.buildRequest(
                    port: store, slug: "djdl", h: hh, request: rq, deviceId: did, hello: hello)
                XCTFail("built")
            } catch { XCTAssertEqual(error as? VouchError, .badInput) }
        }
    }

    func testSecretsAreNotPrinted() async throws {
        let store = try DeviceKeyStore.inMemory()
        let h = Data(repeating: 7, count: 32)
        let request = "nr_QWERTYUIOPASDFGHJKLZXC"
        let hello = VouchHello(platform: "macos")
        let b = try await PeerVouch.buildRequest(
            port: store, slug: "djdl", h: h, request: request, deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
            hello: hello)
        let ok = try XCTUnwrap(PeerVouch.verifyRequest(slug: "djdl", h: h, hello: hello, body: b))
        for text in [String(describing: ok), "\(ok)", String(reflecting: ok), dumped(ok)] {
            XCTAssertFalse(text.contains(request))
            XCTAssertFalse(text.contains(ok.signKey))
        }
    }

    private func dumped<T>(_ v: T) -> String {
        var s = ""
        dump(v, to: &s)
        return s
    }

    func testDecoysAreDistinctInRangeAndTheRealOneIsUniformlyPlaced() throws {
        var counts = [0, 0, 0]
        for n in 0..<3000 {
            let real = (n * 7919) % 1_000_000
            let d = try PeerVouch.decoyCodes(real: real)
            XCTAssertEqual(d.codes.count, 3)
            XCTAssertEqual(Set(d.codes).count, 3)
            XCTAssertTrue(d.codes.allSatisfy { (0..<1_000_000).contains($0) })
            XCTAssertEqual(d.codes[d.index], real)
            counts[d.index] += 1
        }
        // Each position about 1000 of 3000; far from a bias to one slot.
        for c in counts { XCTAssertTrue((800...1200).contains(c), "\(counts)") }
    }

    func testDecoysRejectBiasedDrawsAndGiveUpOnAStuckSource() throws {
        // 0xFFFFFFFF is above the largest multiple of 10^6 in 2^32: rejected, not wrapped.
        let calls = LockedValue(0)
        let src: PeerRandom = { n in
            calls.with { $0 += 1 }
            return Data(repeating: 0xFF, count: n)
        }
        XCTAssertThrowsError(try PeerVouch.decoyCodes(real: 5, random: src))
        XCTAssertTrue(calls.current >= 256)
        // A source that only repeats the real code never terminates the loop: it throws.
        let same: PeerRandom = { n in Data(repeating: 0, count: n) }
        XCTAssertThrowsError(try PeerVouch.decoyCodes(real: 0, random: same))
        XCTAssertThrowsError(try PeerVouch.decoyCodes(real: 1_000_000))
        XCTAssertThrowsError(try PeerVouch.decoyCodes(real: -1))
    }

    func testTheApproverInstanceIsP1AndTenRandomBytes() {
        let asked = LockedValue<[Int]>([])
        let name = PeerVouch.approverInstance { n in
            asked.with { $0.append(n) }
            return Data(repeating: 0xAB, count: n)
        }
        XCTAssertEqual(asked.current, [10])
        XCTAssertEqual(name, "p1-" + PeerAdvert.base32Lower(Data(repeating: 0xAB, count: 10)))
        XCTAssertTrue(PeerAdvert.isInstanceName(name))
        XCTAssertNotEqual(PeerVouch.approverInstance(), PeerVouch.approverInstance())
    }

    func testTheFailureBudgetStopsAtTheSecondFailureInTenMinutes() {
        let t = LockedValue<TimeInterval>(0)
        let b = VouchFailureBudget(mono: { t.current })
        XCTAssertFalse(b.fail())
        t.set(599)
        XCTAssertTrue(b.fail())
        XCTAssertTrue(b.stopped)
        b.reopen()
        XCTAssertFalse(b.stopped)
        XCTAssertFalse(b.fail())
        // The window slides: the first failure aged out before the second.
        t.set(599 + 601)
        XCTAssertFalse(b.fail())
        XCTAssertFalse(b.stopped)
    }

    func testTheCloseCodesAreTheRegistrysPeerKind() {
        let peer = ERROR_CODE_KINDS.filter { $0.value == "peer" }.map(\.key).sorted()
        XCTAssertEqual(PeerCloseCode.allCases.map(\.rawValue).sorted(), peer)
    }

    // MARK: The 16 KiB open chain (modes v and p)

    func testAnOpenMoreChainIsCappedAt16KiBInModesVAndPOnly() {
        func chain(_ mode: PeerRecordMode, parts: Int, size: Int) -> PeerAssembleResult? {
            var a = PeerRecordAssembler(mode: mode)
            var last: PeerAssembleResult?
            for i in 0..<parts {
                let more: UInt8 = i < parts - 1 ? 1 : 0
                last = a.push(PeerRecord(type: PeerRecordType.hello, flags: more, body: Data(count: size)))
            }
            return last
        }
        // HELLO is legal in every mode: 8 x 2048 = exactly 16 KiB passes, one byte more does not.
        XCTAssertEqual(chain(.v, parts: 8, size: 2048), .message(type: PeerRecordType.hello, body: Data(count: 16384)))
        XCTAssertEqual(chain(.p, parts: 8, size: 2048), .message(type: PeerRecordType.hello, body: Data(count: 16384)))
        XCTAssertEqual(chain(.v, parts: 2, size: 8193), .close(.peerBadFrame))
        XCTAssertEqual(chain(.p, parts: 2, size: 8193), .close(.peerBadFrame))
        XCTAssertEqual(chain(.a, parts: 2, size: 8193), .message(type: PeerRecordType.hello, body: Data(count: 16386)))
        // A record that is not chained is bounded by the Noise limit only.
        var single = PeerRecordAssembler(mode: .v)
        XCTAssertEqual(
            single.push(PeerRecord(type: PeerRecordType.hello, flags: 0, body: Data(count: 30000))),
            .message(type: PeerRecordType.hello, body: Data(count: 30000)))
    }
}
