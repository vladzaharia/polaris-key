// @pkey-feature connect.local
// CC-29.11: CPace for account-free local pairing (WIRE-CONTRACT-V5 §15.12, "The mode-q handshake") against the
// `cpace` section of `conformance/corpus/v2/noise-vectors.json`, read in place: the draft's string functions and
// its B.1.1 to B.1.5 vectors, Elligator 2, the generators, the share check, both frames, whole attempts (shares,
// frames, K, ISK, PSK), the low-order aborts, the two Noise handshakes byte for byte and the fourteen failure
// rows. Mirrors the Node runner's `cpaceSuites.ts`. The field arithmetic is `Fe25519`, so a row that fails here
// fails in the field, not in a hash.

import Foundation
import XCTest

@testable import PolarisKeyCore
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private func sha512(_ d: Data) -> Data { Data(SHA512.hash(data: d)) }

final class PeerCPaceTests: XCTestCase {
    private let c: [String: JSONValue] = {
        let v = try! CorpusLocator.load(JSONValue.self, "noise-vectors")
        return v.objectValue!["cpace"]!.objectValue!
    }()

    private func list(_ key: String) -> [[String: JSONValue]] { c[key]!.arrayValue!.map { $0.objectValue! } }
    private func str(_ r: [String: JSONValue], _ k: String) -> String { r[k]!.stringValue! }

    private func prs(_ kind: String, _ secret: String) throws -> Data {
        kind == "code" ? try PeerCPace.prsCode(secret) : try PeerCPace.prsQr(unhex(secret))
    }

    // ── The suite and the string functions ───────────────────────────────────────────

    func testSuiteIsPinned() {
        XCTAssertEqual(str(c, "suite"), "CPACE-X25519-SHA512")
        XCTAssertEqual(PeerCPace.dsi, str(c, "dsi"))
        XCTAssertEqual(PeerCPace.dsiIsk, str(c, "dsiIsk"))
        XCTAssertEqual(PeerCPace.sInBytes, c["sInBytes"]!.intValue)
    }

    func testAppendixAStringFunctions() {
        let vectors = c["anchors"]!.objectValue!["vectors"]!.arrayValue!.map { $0.objectValue! }
        var seen = 0
        for a in vectors {
            let v = a["vector"]!.objectValue!
            guard let fn = v["fn"]?.stringValue, let cases = v["cases"]?.arrayValue else { continue }
            for k in cases.map({ $0.objectValue! }) {
                let want = str(k, "out")
                switch fn {
                case "prepend_len":
                    XCTAssertEqual(hex(PeerCPace.prependLen(unhex(str(k, "in")))), want, str(a, "id"))
                    seen += 1
                case "lv_cat":
                    XCTAssertEqual(
                        hex(PeerCPace.lvCat(k["in"]!.arrayValue!.map { unhex($0.stringValue!) })), want, str(a, "id"))
                    seen += 1
                case "transcript_ir":
                    let p = k["in"]!.arrayValue!.map { unhex($0.stringValue!) }
                    XCTAssertEqual(
                        hex(PeerCPace.transcriptIr(ya: p[0], ada: p[1], yb: p[2], adb: p[3])), want, str(a, "id"))
                    seen += 1
                default: break
                }
            }
        }
        XCTAssertGreaterThan(seen, 0)
    }

    func testTheDraftsB11GeneratorAndB12ToB15IskVectors() throws {
        let vectors = c["anchors"]!.objectValue!["vectors"]!.arrayValue!.map { $0.objectValue! }
        func vec(_ id: String) -> [String: JSONValue] {
            vectors.first { $0["id"]!.stringValue == id }!["vector"]!.objectValue!
        }
        let b11 = vec("B.1.1")
        let gs = PeerCPace.generatorString(
            dsi: unhex(str(b11, "DSI")), prs: unhex(str(b11, "PRS")), ci: unhex(str(b11, "CI")),
            sid: unhex(str(b11, "sid")), sInBytes: PeerCPace.sInBytes)
        XCTAssertEqual(hex(gs), str(b11, "generatorString"))
        let hash = sha512(gs).prefix(32)
        XCTAssertEqual(hex(Data(hash)), str(b11, "hashGeneratorString"))
        XCTAssertEqual(hex(try XCTUnwrap(PeerCPace.elligator2(Data(hash))).u), str(b11, "g"))
        XCTAssertEqual(
            hex(
                PeerCPace.generator(
                    prs: unhex(str(b11, "PRS")), ci: unhex(str(b11, "CI")), sid: unhex(str(b11, "sid")))),
            str(b11, "g"))
        let b12 = vec("B.1.2-B.1.5")
        let ir = PeerCPace.transcriptIr(
            ya: unhex(str(b12, "Ya")), ada: unhex(str(b12, "ADa")), yb: unhex(str(b12, "Yb")),
            adb: unhex(str(b12, "ADb")))
        XCTAssertEqual(hex(ir), str(b12, "transcriptIr"))
        let input = PeerCPace.lvCat([unhex(str(b12, "dsiIsk")), unhex(str(b11, "sid")), unhex(str(b12, "K"))]) + ir
        XCTAssertEqual(hex(input), str(b12, "iskInput"))
        XCTAssertEqual(hex(sha512(input)), str(b12, "isk"))
        // The draft's own scalar and generator give its Ya and K through the platform X25519.
        XCTAssertEqual(
            hex(try XCTUnwrap(PeerCPace.share(scalar: unhex(str(b12, "ya")), generator: unhex(str(b11, "g"))))),
            str(b12, "Ya"))
    }

    // ── Elligator 2 and the generators ───────────────────────────────────────────────

    func testElligator2Rows() throws {
        let rows = list("elligator")
        XCTAssertGreaterThan(rows.count, 0)
        for r in rows {
            let out = try XCTUnwrap(PeerCPace.elligator2(unhex(str(r, "input"))), str(r, "id"))
            XCTAssertEqual(hex(out.r), str(r, "r"), str(r, "id"))
            XCTAssertEqual(out.onCurve, r["onCurve"]!.boolValue, str(r, "id"))
            XCTAssertEqual(hex(out.u), str(r, "u"), str(r, "id"))
        }
        XCTAssertNil(PeerCPace.elligator2(Data(count: 31)))
    }

    func testGeneratorRows() throws {
        for r in list("generators") {
            let id = str(r, "id")
            let p = try prs(str(r, "kind"), str(r, "secret"))
            XCTAssertEqual(hex(p), str(r, "prs"), id)
            XCTAssertEqual(hex(peerPrologue(slug: str(r, "slug"), mode: .q)), str(r, "ci"), id)
            let gs = PeerCPace.generatorString(
                dsi: Data(PeerCPace.dsi.utf8), prs: p, ci: unhex(str(r, "ci")), sid: unhex(str(r, "sid")),
                sInBytes: PeerCPace.sInBytes)
            XCTAssertEqual(hex(gs), str(r, "generatorString"), id)
            XCTAssertEqual(hex(sha512(gs).prefix(32)), str(r, "hash"), id)
            XCTAssertEqual(
                hex(PeerCPace.generator(prs: p, ci: unhex(str(r, "ci")), sid: unhex(str(r, "sid")))), str(r, "g"), id)
        }
    }

    func testPasswordAndSecretShapes() {
        XCTAssertThrowsError(try PeerCPace.prsCode("12345"))
        XCTAssertThrowsError(try PeerCPace.prsCode("12345a"))
        XCTAssertThrowsError(try PeerCPace.prsQr(Data(count: 15)))
        XCTAssertNoThrow(try PeerCPace.prsQr(Data(count: 16)))
    }

    /// The field is exercised on inputs the corpus rows do not reach: a value at or above p, the largest
    /// input and the smallest, against a second computation through the plain definition of the map.
    func testElligator2OnBoundaryInputs() throws {
        // 2^255 - 1 with the top bit set: decodeUCoordinate clears bit 255, so r = 2^255 - 1 = 18 (mod p).
        var top = Data(repeating: 0xff, count: 32)
        let a = try XCTUnwrap(PeerCPace.elligator2(top))
        top[31] = 0x7f
        let b = try XCTUnwrap(PeerCPace.elligator2(top))
        XCTAssertEqual(a, b)
        XCTAssertEqual(hex(a.r), "12" + String(repeating: "00", count: 31))
        // p itself reads as 0 and gives the zero row's answer.
        var p = Data(repeating: 0xff, count: 32)
        p[0] = 0xed
        p[31] = 0x7f
        let zero = try XCTUnwrap(PeerCPace.elligator2(Data(count: 32)))
        XCTAssertEqual(try XCTUnwrap(PeerCPace.elligator2(p)), zero)
    }

    // ── Shares and frames ────────────────────────────────────────────────────────────

    private func reason(_ v: PeerCPace.ShareVerdict) -> String? {
        switch v {
        case .ok: return nil
        case .length: return "length"
        case .nonCanonical: return "non-canonical"
        case .lowOrder: return "low-order"
        }
    }

    func testShareCheck() {
        for r in list("shares") {
            let want = r["want"]!.objectValue!
            let v = PeerCPace.checkShare(unhex(str(r, "share")))
            XCTAssertEqual(v == .ok, want["ok"]!.boolValue, str(r, "id"))
            if v != .ok { XCTAssertEqual(reason(v), want["reason"]!.stringValue, str(r, "id")) }
        }
    }

    private func verdictJSON(_ v: PeerCPace.FrameVerdict) -> [String: JSONValue] {
        switch v {
        case .refused(let why): return ["ok": .bool(false), "reason": .string(why.rawValue)]
        case .ok(let kind, let share):
            var o: [String: JSONValue] = ["ok": .bool(true), "share": .string(hex(share))]
            if let kind { o["kind"] = .string(kind == .code ? "code" : "qr") }
            return o
        }
    }

    func testFrames() {
        let frames = c["frames"]!.objectValue!
        for r in frames["c1"]!.arrayValue!.map({ $0.objectValue! }) {
            XCTAssertEqual(
                verdictJSON(PeerCPace.parseC1(unhex(str(r, "frame")))), r["want"]!.objectValue!, str(r, "id"))
        }
        for r in frames["c2"]!.arrayValue!.map({ $0.objectValue! }) {
            XCTAssertEqual(
                verdictJSON(PeerCPace.parseC2(unhex(str(r, "frame")))), r["want"]!.objectValue!, str(r, "id"))
        }
        XCTAssertEqual(PeerCPace.c1Length, 34)
        XCTAssertEqual(PeerCPace.c2Length, 33)
    }

    // ── Whole attempts ───────────────────────────────────────────────────────────────

    private struct Side {
        let slug: String
        let sid: Data
        let g: Data
    }

    private func side(_ a: [String: JSONValue], _ which: String) throws -> Side {
        let slug = str(a, "\(which)Slug")
        let sid = unhex(str(a, "\(which)Sid"))
        let g = PeerCPace.generator(
            prs: try prs(str(a, "kind"), str(a, "\(which)Secret")), ci: peerPrologue(slug: slug, mode: .q), sid: sid)
        return Side(slug: slug, sid: sid, g: g)
    }

    func testWholeAttempts() throws {
        let attempts = list("attempts")
        XCTAssertGreaterThan(attempts.count, 0)
        for a in attempts {
            let id = str(a, "id")
            let kind: PeerCPace.Kind = str(a, "kind") == "code" ? .code : .qr
            let j = try side(a, "joiner")
            let s = try side(a, "shower")
            XCTAssertEqual(hex(j.g), str(a, "joinerG"), id)
            XCTAssertEqual(hex(s.g), str(a, "showerG"), id)
            let ya = try XCTUnwrap(PeerCPace.share(scalar: unhex(str(a, "ya")), generator: j.g), id)
            let yb =
                a["reflect"]?.boolValue == true
                ? ya : try XCTUnwrap(PeerCPace.share(scalar: unhex(str(a, "yb")), generator: s.g), id)
            XCTAssertEqual(hex(ya), str(a, "Ya"), id)
            XCTAssertEqual(hex(yb), str(a, "Yb"), id)
            XCTAssertEqual(hex(PeerCPace.encodeC1(kind, ya: ya)), str(a, "c1"), id)
            XCTAssertEqual(hex(PeerCPace.encodeC2(yb: yb)), str(a, "c2"), id)
            let iskJ = try XCTUnwrap(
                PeerCPace.isk(sid: j.sid, scalar: unhex(str(a, "ya")), ya: ya, yb: yb, role: .initiator), id)
            let iskS = try XCTUnwrap(
                PeerCPace.isk(sid: s.sid, scalar: unhex(str(a, "yb")), ya: ya, yb: yb, role: .responder), id)
            XCTAssertEqual(hex(iskJ), str(a, "joinerIsk"), id)
            XCTAssertEqual(hex(iskS), str(a, "showerIsk"), id)
            XCTAssertEqual(hex(PeerCPace.psk(isk: iskJ, slug: j.slug)), str(a, "joinerPsk"), id)
            XCTAssertEqual(hex(PeerCPace.psk(isk: iskS, slug: s.slug)), str(a, "showerPsk"), id)
            XCTAssertEqual(iskJ == iskS, a["agree"]!.boolValue, id)
        }
    }

    func testLowOrderAbort() throws {
        let abort = c["abort"]!.objectValue!
        let scalar = unhex(str(abort, "scalar"))
        for r in abort["rows"]!.arrayValue!.map({ $0.objectValue! }) {
            let id = str(r, "id")
            let u = unhex(str(r, "u"))
            XCTAssertEqual(PeerCPace.checkShare(u) != .ok, r["shareRefused"]!.boolValue, id)
            let k = PeerCPace.share(scalar: scalar, generator: u)
            if r["kAllZero"]!.boolValue! {
                XCTAssertNil(k, id)
            } else {
                XCTAssertEqual(k.map(hex), str(r, "k"), id)
            }
            let isk = PeerCPace.isk(
                sid: Data(count: 10), scalar: scalar, ya: Data(count: 32), yb: u, role: .initiator)
            XCTAssertEqual(isk == nil, r["kAllZero"]!.boolValue!, id)
        }
    }

    // ── The Noise handshakes and the failures ────────────────────────────────────────

    private func handshake(
        _ role: PeerNoiseRole, protocol name: String, prologue: Data, psk: Data, staticKey: Data, ephemeral: Data,
        override: Data? = nil
    ) throws -> PeerNoiseHandshake {
        try PeerNoiseHandshake(
            role: role, protocol: name, prologue: prologue, staticKey: PeerNoiseRawStaticKey(privateKey: staticKey),
            psk: psk, ephemeralKey: ephemeral, ephemeralPublicOverride: override)
    }

    func testTheModeQAndModeLHandshakesByteForByte() async throws {
        let rows = list("handshakes")
        XCTAssertEqual(rows.map { str($0, "mode") }.sorted(), ["l", "q"])
        for h in rows {
            let id = str(h, "id")
            let mode = try XCTUnwrap(PeerNoiseMode(rawValue: str(h, "mode")))
            XCTAssertEqual(peerNoiseProtocol(mode), str(h, "protocol"), id)
            XCTAssertEqual(hex(peerPrologue(slug: str(h, "slug"), mode: mode)), str(h, "prologue"), id)
            if let attempt = h["attempt"]?.stringValue {
                let a = list("attempts").first { str($0, "id") == attempt }!
                XCTAssertEqual(str(a, "joinerPsk"), str(h, "psk"), id)
                XCTAssertEqual(str(a, "joinerIsk"), str(h, "isk"), id)
            }
            let i = try handshake(
                .initiator, protocol: str(h, "protocol"), prologue: unhex(str(h, "prologue")),
                psk: unhex(str(h, "psk")), staticKey: unhex(str(h, "initStatic")),
                ephemeral: unhex(str(h, "initEphemeral")))
            let r = try handshake(
                .responder, protocol: str(h, "protocol"), prologue: unhex(str(h, "prologue")),
                psk: unhex(str(h, "psk")), staticKey: unhex(str(h, "respStatic")),
                ephemeral: unhex(str(h, "respEphemeral")))
            let messages = h["messages"]!.arrayValue!.map { $0.objectValue! }
            let hs = messages.filter { str($0, "kind") == "handshake" }
            var (from, to) = (i, r)
            for (k, m) in hs.enumerated() {
                let wire = try await from.writeMessage(unhex(str(m, "payload")))
                XCTAssertEqual(hex(wire), str(m, "ciphertext"), "\(id) message \(k)")
                let read = try await to.readMessage(wire)
                XCTAssertEqual(hex(read), str(m, "payload"), id)
                (from, to) = (to, from)
            }
            let ih = try await i.handshakeHash
            let rh = try await r.handshakeHash
            XCTAssertEqual(hex(ih), str(h, "handshakeHash"), id)
            XCTAssertEqual(hex(rh), str(h, "handshakeHash"), id)
            let ti = try await i.transport()
            let tr = try await r.transport()
            if let m = messages.first(where: { str($0, "kind") == "transport" }) {
                let ct = try ti.send.encrypt(ad: Data(), unhex(str(m, "payload")))
                XCTAssertEqual(hex(ct), str(m, "ciphertext"), "\(id) record")
                XCTAssertEqual(hex(try tr.receive.decrypt(ad: Data(), ct)), str(m, "payload"), id)
            }
        }
    }

    func testTheFailureRows() async throws {
        let rows = list("failures")
        XCTAssertEqual(rows.count, 14)
        for f in rows {
            let id = str(f, "id")
            let i = try handshake(
                .initiator, protocol: str(f, "protocol"), prologue: unhex(str(f, "prologue")),
                psk: unhex(str(f, "psk")), staticKey: unhex(str(f, "initStatic")),
                ephemeral: unhex(str(f, "initEphemeral")),
                override: f["initEphemeralPublic"]?.stringValue.map(unhex))
            let r = try handshake(
                .responder, protocol: str(f, "protocol"),
                prologue: unhex(f["responderPrologue"]?.stringValue ?? str(f, "prologue")),
                psk: unhex(f["responderPsk"]?.stringValue ?? str(f, "psk")),
                staticKey: unhex(str(f, "respStatic")), ephemeral: unhex(str(f, "respEphemeral")))
            var failure: (at: Int, reason: String)?
            for (idx, p) in f["payloads"]!.arrayValue!.enumerated() {
                let (w, d) = idx % 2 == 0 ? (i, r) : (r, i)
                do {
                    let msg = try await w.writeMessage(unhex(p.stringValue!))
                    let got = try await d.readMessage(msg)
                    XCTAssertEqual(hex(got), p.stringValue, id)
                } catch let e as PeerNoiseError {
                    failure = (idx, e.code)
                    break
                }
            }
            XCTAssertEqual(failure?.at, f["failedAt"]!.intValue, id)
            XCTAssertEqual(failure?.reason, str(f, "reason"), id)
        }
    }
}
