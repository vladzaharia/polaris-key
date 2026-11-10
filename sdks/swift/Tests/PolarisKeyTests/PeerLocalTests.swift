// @pkey-feature connect.local
// CC-29.11: local links in the core (WIRE-CONTRACT-V5 §15.12) against the `local` section of
// `conformance/corpus/v2/peer-matrix.json`, read in place: the code, the QR, the adverts, the TXT parsers, the
// LOCAL_LINK body, the link secret, the handshake payloads and negotiation, the pairing window, the joiner and its
// dial budget, the exchange guard, the pin, the trial order, the records, the gate and the listener's admission.
// The Direct Transfer rows of mode `l` run in `PeerXferTests`. Mirrors the Node runner's `localSuites.ts`.

import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private typealias Row = [String: JSONValue]

final class PeerLocalTests: XCTestCase {
    private let l: Row = {
        let v = try! CorpusLocator.load(JSONValue.self, "peer-matrix")
        return v.objectValue!["local"]!.objectValue!
    }()

    private func obj(_ key: String) -> Row { l[key]!.objectValue! }
    private func rows(_ key: String) -> [Row] { l[key]!.arrayValue!.map { $0.objectValue! } }
    private func rows(_ key: String, _ sub: String) -> [Row] {
        obj(key)[sub]!.arrayValue!.map { $0.objectValue! }
    }
    private func str(_ r: Row, _ k: String) -> String { r[k]!.stringValue! }
    private func id(_ r: Row) -> String { r["id"]!.stringValue! }
    private func strs(_ r: Row, _ k: String) -> [String] { r[k]!.arrayValue!.map { $0.stringValue! } }

    /// A stream of fixed bytes: `source(n)` answers nil, consuming nothing, when fewer than `n` are left.
    private final class Stream: @unchecked Sendable {
        let all: [UInt8]
        var at = 0
        init(_ h: String) { all = [UInt8](unhex(h)) }
        func take(_ n: Int) -> Data? {
            if at + n > all.count { return nil }
            defer { at += n }
            return Data(all[at..<(at + n)])
        }
    }

    // ── Constants ────────────────────────────────────────────────────────────────────

    func testConstantsMatch() {
        let c = obj("constants")
        XCTAssertEqual(c["pairSeconds"]?.intValue, localPairSeconds)
        XCTAssertEqual(c["codeDigits"]?.intValue, localCodeDigits)
        XCTAssertEqual(c["pairFailures"]?.intValue, localPairFailures)
        XCTAssertEqual(c["qrSecretBytes"]?.intValue, localQrSecretBytes)
        XCTAssertEqual(c["joinCandidates"]?.intValue, localJoinCandidates)
        XCTAssertEqual(c["joinBrowseSeconds"]?.intValue, localJoinBrowseSeconds)
        XCTAssertEqual(c["maxLinks"]?.intValue, maxLocalLinks)
        XCTAssertEqual(c["maxLiveAdverts"]?.intValue, maxLiveLocalAdverts)
        XCTAssertEqual(c["maxLinkSecrets"]?.intValue, maxLinkSecrets)
        XCTAssertEqual(c["maxContactSecrets"]?.intValue, maxContactSecrets)
        XCTAssertEqual(c["bodyMax"]?.intValue, localLinkBodyMax)
        XCTAssertEqual(c["maxCats"]?.intValue, maxContactCats)
        XCTAssertEqual(c["exchangeSeconds"]?.intValue, contactExchangeSeconds)
        XCTAssertEqual(c["admissionGroupPerMinute"]?.intValue, localGroupPerMinute)
        XCTAssertEqual(maxLinkSecrets, maxContactSecrets + maxLocalLinks)
        XCTAssertEqual(PeerLocal.trialTotal, 2 + maxLinkSecrets)
    }

    // ── Codes and the QR ─────────────────────────────────────────────────────────────

    func testNameplates() {
        for r in rows("codes", "nameplate") {
            let s = Stream(str(r, "stream"))
            let got = PeerLocal.drawNameplate({ s.take($0) }, inUse: strs(r, "inUse"))
            let want = r["want"]!.objectValue!
            XCTAssertEqual(got, want["nameplate"]?.stringValue, id(r))
            XCTAssertEqual(s.at, want["consumed"]!.intValue, id(r))
        }
    }

    func testPasswords() {
        for r in rows("codes", "password") {
            let s = Stream(str(r, "stream"))
            let want = r["want"]!.objectValue!
            XCTAssertEqual(PeerLocal.drawPassword({ s.take($0) }), want["password"]?.stringValue, id(r))
            XCTAssertEqual(s.at, want["consumed"]!.intValue, id(r))
        }
    }

    func testDisplayAndParse() {
        for r in rows("codes", "display") {
            XCTAssertEqual(
                PeerLocal.displayCode(nameplate: str(r, "nameplate"), password: str(r, "password")), str(r, "want"),
                id(r))
        }
        for r in rows("codes", "parse") {
            let want = r["want"]!.objectValue!
            let got = PeerLocal.parseCode(str(r, "text"))
            XCTAssertEqual(got != nil, want["ok"]!.boolValue, id(r))
            XCTAssertEqual(got?.nameplate, want["nameplate"]?.stringValue, id(r))
            XCTAssertEqual(got?.password, want["password"]?.stringValue, id(r))
        }
    }

    func testQrMakeAndParse() {
        for r in rows("qr", "make") {
            let instance = PeerLocal.pairingInstance(sid: unhex(str(r, "sid")))
            XCTAssertEqual(instance, str(r, "instance"), id(r))
            XCTAssertEqual(
                PeerLocal.makeQr(slug: str(r, "slug"), instance: str(r, "instance"), secret: unhex(str(r, "secret"))),
                str(r, "want"), id(r))
        }
        for r in rows("qr", "parse") {
            let want = r["want"]!.objectValue!
            switch PeerLocal.parseQr(str(r, "text"), own: str(r, "own")) {
            case .ok(let slug, let instance, let secret):
                XCTAssertEqual(want["result"]?.stringValue, "ok", id(r))
                XCTAssertEqual(slug, want["slug"]?.stringValue, id(r))
                XCTAssertEqual(instance, want["instance"]?.stringValue, id(r))
                XCTAssertEqual(PeerAdvert.base32Lower(secret), want["secret"]?.stringValue, id(r))
            case .otherApp: XCTAssertEqual(want["result"]?.stringValue, "other-app", id(r))
            case .invalid: XCTAssertEqual(want["result"]?.stringValue, "invalid", id(r))
            }
        }
        // The instance name turns back into the window's 10 bytes (the CPace `sid`).
        for r in rows("adverts", "pairing") {
            XCTAssertEqual(PeerLocal.sid(ofInstance: str(r, "instance")).map(hex), str(r, "sid"), id(r))
        }
    }

    // ── Adverts and TXT ──────────────────────────────────────────────────────────────

    func testAdverts() {
        let adverts = obj("adverts")
        XCTAssertEqual(adverts["epochSeconds"]?.intValue, peerAdvertEpochSeconds)
        for r in rows("adverts", "pairing") {
            XCTAssertEqual(PeerLocal.pairingInstance(sid: unhex(str(r, "sid"))), str(r, "instance"), id(r))
        }
        for r in rows("adverts", "names") {
            XCTAssertEqual(
                PeerLocal.localInstance(
                    secret: unhex(str(r, "secret")), advertiserLinkKey: unhex(str(r, "ownLinkKey")),
                    epoch: r["epoch"]!.intValue!), str(r, "instance"), id(r))
        }
        for r in rows("adverts", "browse") {
            let links = r["links"]!.arrayValue!.map { $0.objectValue! }.map {
                PeerLocal.LinkKey(secret: unhex(str($0, "secret")), peerKey: unhex(str($0, "peerKey")))
            }
            let got = PeerLocal.browseLocalInstance(str(r, "instance"), links: links, now: r["now"]!.intValue!)
            if let want = r["want"]?.objectValue {
                XCTAssertEqual(got?.link, want["link"]?.intValue, id(r))
                XCTAssertEqual(got?.epochBack, want["epochBack"]?.intValue, id(r))
            } else {
                XCTAssertNil(got, id(r))
            }
        }
    }

    func testTxtParsers() {
        for r in rows("txt") {
            let want = r["want"]!.objectValue!
            let entries = strs(r, "entries")
            if str(r, "parser") == "local" {
                let refused = PeerLocal.parseLocalTxt(entries)
                XCTAssertEqual(refused == nil, want["ok"]!.boolValue, id(r))
                if let refused { XCTAssertEqual(refused.rawValue, want["reason"]?.stringValue, id(r)) }
                continue
            }
            // The generic TXT parser: modes a, v and p; a pairing window's advert (`m=q`) also reads its nameplate.
            if entries.contains("m=q") {
                switch PeerLocal.parsePairingTxt(entries) {
                case .ok(let h, let n):
                    XCTAssertEqual(want["ok"]!.boolValue, true, id(r))
                    XCTAssertEqual(want["mode"]?.stringValue, "q", id(r))
                    XCTAssertEqual(h, want["h"]?.stringValue, id(r))
                    XCTAssertEqual(n, want["n"]?.stringValue, id(r))
                case .refused(let why):
                    XCTAssertEqual(want["ok"]!.boolValue, false, id(r))
                    XCTAssertEqual(why, want["reason"]?.stringValue, id(r))
                }
                continue
            }
            let got = PeerAdvert.parseTxt(entries)
            switch got {
            case .ok(let mode, let h):
                XCTAssertEqual(want["ok"]!.boolValue, true, id(r))
                XCTAssertEqual(mode.rawValue, want["mode"]?.stringValue, id(r))
                XCTAssertEqual(h, want["h"]?.stringValue, id(r))
            case .refused(let why):
                XCTAssertEqual(want["ok"]!.boolValue, false, id(r))
                XCTAssertEqual(why.rawValue, want["reason"]?.stringValue, id(r))
            }
        }
    }

    // ── The LOCAL_LINK body and the secret ───────────────────────────────────────────

    private func bodyBytes(_ r: Row) -> Data {
        if let h = r["bodyHex"]?.stringValue { return unhex(h) }
        if let p = r["bodyPad"]?.objectValue {
            return Data(
                (str(p, "prefix") + String(repeating: str(p, "fill"), count: p["count"]!.intValue!) + str(p, "suffix"))
                    .utf8)
        }
        return Data(str(r, "body").utf8)
    }

    func testLocalLinkBody() throws {
        for r in rows("body") {
            let b = bodyBytes(r)
            XCTAssertEqual(b.count, r["length"]!.intValue, id(r))
            let want = r["want"]!.objectValue!
            let got = PeerLocal.parseLocalLink(b)
            XCTAssertEqual(got != nil, want["ok"]!.boolValue, id(r))
            guard let got else { continue }
            XCTAssertEqual(got.label, want["label"]?.stringValue, id(r))
            XCTAssertEqual(got.cats, strs(want, "cats"), id(r))
            // What a side builds, the peer reads back.
            let again = PeerLocal.parseLocalLink(try PeerLocal.buildLocalLink(label: got.label, cats: got.cats))
            XCTAssertEqual(again, got, id(r))
        }
    }

    func testLinkSecret() throws {
        for r in rows("secrets") {
            XCTAssertEqual(
                hex(
                    try PeerLocal.linkSecret(
                        h: unhex(str(r, "h")), isk: unhex(str(r, "isk")), keyA: unhex(str(r, "keyA")),
                        keyB: unhex(str(r, "keyB")))), str(r, "secret"), id(r))
        }
        // The id and the tag are derived, one way, from public and secret inputs and carry neither.
        let id1 = PeerLocal.linkId(peerKey: Data(repeating: 1, count: 32))
        XCTAssertEqual(id1.count, 16)
        XCTAssertNotEqual(id1, PeerLocal.linkId(peerKey: Data(repeating: 2, count: 32)))
        XCTAssertEqual(PeerLocal.linkTag(secret: Data(repeating: 1, count: 32)).count, 16)
    }

    // ── Handshake payloads ───────────────────────────────────────────────────────────

    func testHandshakePayloadsAndNegotiation() {
        let hp = obj("handshakePayloads")
        for r in hp["payloads"]!.arrayValue!.map({ $0.objectValue! }) {
            let b = r["payloadHex"]?.stringValue.map(unhex) ?? Data(str(r, "payload").utf8)
            XCTAssertEqual(b.count, r["length"]!.intValue, id(r))
            let got = PeerPayload.parse(
                mode: PeerNoiseMode(rawValue: str(r, "mode"))!, message: r["message"]!.intValue!, b)
            let want = r["want"]!.objectValue!
            XCTAssertEqual(got.ok, want["ok"]!.boolValue, id(r))
            if got.ok, let caps = want["caps"]?.arrayValue {
                XCTAssertEqual(got.caps, caps.map { $0.stringValue! }, id(r))
            }
        }
        for r in hp["negotiate"]!.arrayValue!.map({ $0.objectValue! }) {
            let want = r["want"]!.objectValue!
            let got = PeerLocal.negotiateLocalCaps(
                mode: PeerNoiseMode(rawValue: str(r, "mode"))!, local: strs(r, "local"), remote: strs(r, "remote"))
            XCTAssertEqual(got.caps, strs(want, "caps"), id(r))
            XCTAssertEqual(got.close, want["close"]?.stringValue, id(r))
            XCTAssertEqual(PeerPayload.capsIntersection(strs(r, "local"), strs(r, "remote")), got.caps, id(r))
        }
    }

    // ── The pairing window ───────────────────────────────────────────────────────────

    private func windowJSON(_ out: LocalWindowOutcome, _ w: LocalPairingWindow) -> Row {
        var o: Row = [:]
        if let r = out.result { o["result"] = .string(r.rawValue) }
        if let i = out.id { o["id"] = .int(i) }
        let s = w.state
        o["open"] = .bool(s.open)
        o["holder"] = s.holder.map { .string($0.rawValue) } ?? .null
        o["failures"] = .int(s.failures)
        o["rotations"] = .int(s.rotations)
        o["closed"] = s.closed.map { .string($0.rawValue) } ?? .null
        if let h = out.host { o["host"] = .string(h) }
        return o
    }

    func testWindowRows() {
        let all = rows("window")
        XCTAssertGreaterThan(all.count, 0)
        for r in all {
            var w = LocalPairingWindow()
            var last = 0
            var got: [Row] = []
            for s in r["steps"]!.arrayValue!.map({ $0.objectValue! }) {
                let t = s["t"]?.doubleValue ?? 0
                let attempt = s["id"]?.intValue ?? last
                var out = LocalWindowOutcome.none
                switch str(s, "event") {
                case "open": out = w.open(t)
                case "c1":
                    out = w.c1(t, valid: s["valid"]!.boolValue!)
                    if let i = out.id { last = i }
                case "begin-guess":
                    out = LocalWindowOutcome(result: nil, rotate: false)
                    let ok = w.beginGuess(attempt, t)
                    var row = windowJSON(out, w)
                    row["result"] = .string(ok ? "permit" : "denied")
                    got.append(row)
                    continue
                case "msg1":
                    if let o = w.msg1(attempt, t, opens: s["opens"]!.boolValue!) {
                        out = o
                    } else {
                        var row = windowJSON(.none, w)
                        row["result"] = .string("denied")
                        got.append(row)
                        continue
                    }
                case "guess-opened": out = w.guessOpened(attempt, t)
                case "guess-failed": out = w.guessFailed(attempt, t)
                case "abandon": out = w.abandon(attempt, t)
                case "rotated": w.rotated(t)
                case "session-end": out = w.sessionEnd(t, stored: s["stored"]!.boolValue!)
                case "tick": w.tick(t)
                case "close": out = w.close(t)
                default: XCTFail("\(id(r)): event")
                }
                got.append(windowJSON(out, w))
            }
            let want = r["want"]!.arrayValue!.map { $0.objectValue! }
            XCTAssertEqual(got.count, want.count, id(r))
            for (i, (g, wnt)) in zip(got, want).enumerated() { XCTAssertEqual(g, wnt, "\(id(r)) step \(i)") }
        }
    }

    func testJoinBudgetRows() {
        for r in rows("joinBudget") {
            var budget = LocalDialBudget()
            var got: [Row] = []
            for j in r["joins"]!.arrayValue!.map({ $0.objectValue! }) {
                let input = j["input"]!.objectValue!
                if str(input, "kind") == "qr" {
                    got.append(["allowed": .bool(true), "used": .int(0)])
                    continue
                }
                let np = str(input, "nameplate")
                let t = j["t"]!.doubleValue!
                let v = budget.check(np, t)
                if v.allowed { budget.spend(np, t, dials: j["dials"]!.intValue!) }
                got.append(["allowed": .bool(v.allowed), "used": .int(v.used)])
            }
            XCTAssertEqual(got, r["want"]!.arrayValue!.map { $0.objectValue! }, id(r))
        }
    }

    func testJoinRows() {
        for r in rows("join") {
            let input = r["input"]!.objectValue!
            let kind: LocalJoinInput
            switch str(input, "kind") {
            case "code": kind = .code(nameplate: str(input, "nameplate"))
            case "qr": kind = .qr(instance: str(input, "instance"))
            default: kind = .invalid
            }
            var plan = LocalJoinPlan(kind)
            for a in r["adverts"]!.arrayValue!.map({ $0.objectValue! }) {
                let h = str(a, "h")
                let tagMatches = h == "current" || h == "previous"
                _ = plan.see(instance: str(a, "instance"), tagMatches: tagMatches, n: str(a, "n"))
            }
            var dialled: [String] = []
            for outcome in strs(r, "dials") {
                guard let next = plan.next() else { break }
                dialled.append(next)
                plan.ended(LocalDialOutcome(rawValue: outcome)!)
            }
            let want = r["want"]!.objectValue!
            XCTAssertEqual(plan.browses, want["browsed"]!.boolValue, id(r))
            XCTAssertEqual(plan.kept, strs(want, "kept"), id(r))
            XCTAssertEqual(dialled, strs(want, "dialled"), id(r))
            XCTAssertEqual(plan.result().rawValue, str(want, "result"), id(r))
        }
    }

    // ── The exchange guard, the pin and the trial order ──────────────────────────────

    func testExchangeRows() {
        for r in rows("exchange") {
            var x = LocalExchange(held: r["held"]!.intValue!, cats: strs(r, "cats"))
            var got: [Row] = []
            for s in r["steps"]!.arrayValue!.map({ $0.objectValue! }) {
                let e: LocalExchangeEvent
                switch str(s, "event") {
                case "own-confirm": e = .ownConfirm
                case "own-decline": e = .ownDecline
                case "peer-confirm": e = .peerConfirm
                case "peer-link": e = .peerLink(Data(str(s, "body").utf8))
                case "timeout-confirm": e = .timeoutConfirm
                default: e = .timeoutExchange
                }
                let out = x.step(e)
                var o: Row = ["sends": .array(out.sends.map { .string($0 == .confirm ? "CONFIRM" : "LOCAL_LINK") })]
                if let st = out.stored {
                    var sto: Row = ["cats": .array(st.cats.map { .string($0) })]
                    if let label = st.label { sto["label"] = .string(label) }
                    o["stored"] = .object(sto)
                }
                if let c = out.close { o["close"] = .string(c.rawValue) }
                got.append(o)
            }
            XCTAssertEqual(got, r["want"]!.arrayValue!.map { $0.objectValue! }, id(r))
        }
    }

    func testPinRows() {
        for r in rows("pin") {
            let want = r["want"]!.objectValue!
            let ok: Bool
            if str(r, "mode") == "l" {
                let held = strs(r, "held")[r["matched"]!.intValue!]
                ok = PeerLocal.pin(held: unhex(held), remoteStatic: unhex(str(r, "remoteStatic")))
            } else {
                ok = PeerLocal.pairingRemoteOk(own: unhex(str(r, "own")), remoteStatic: unhex(str(r, "remoteStatic")))
            }
            XCTAssertEqual(ok, want["ok"]!.boolValue, id(r))
            // The initiator asks after message 2, the responder after message 3.
            XCTAssertEqual(r["checkedAfter"]!.intValue, str(r, "role") == "initiator" ? 2 : 3, id(r))
        }
    }

    func testTrialOrderRows() {
        for r in rows("trialOrder") {
            let account: [Bool]? = r["account"]?.arrayValue.map { $0.map { $0 != .null } }
            let contacts = strs(r, "contacts").count
            let locals = strs(r, "locals").count
            let plan = PeerLocal.listenerTrialOrder(account: account, contacts: contacts, locals: locals)
            var tried: [String] = []
            var hit: String?
            var close: String?
            var limiterAsked = false
            let opens = r["opens"]?.objectValue
            for e in plan {
                if e.kind != "a" && !limiterAsked {
                    limiterAsked = true
                    if str(r, "limiter") == "refuse" {
                        close = "peer_busy"
                        break
                    }
                }
                let name = "\(e.kind):\(e.index)"
                tried.append(name)
                if let o = opens, str(o, "mode") == String(e.kind) {
                    let key = e.kind == "a" ? "key" : e.kind == "c" ? "contact" : "link"
                    if o[key]?.intValue == e.index {
                        hit = name
                        break
                    }
                }
            }
            if hit == nil && close == nil { close = "handshake_failed" }
            let padded = close == "handshake_failed" && contacts + locals > 0
            let dummy = padded ? PeerLocal.trialPadding(tried: tried.count) : 0
            let want = r["want"]!.objectValue!
            XCTAssertEqual(tried, strs(want, "tried"), id(r))
            XCTAssertEqual(hit, want["hit"]?.stringValue, id(r))
            XCTAssertEqual(hit != nil && hit!.first != "a", want["slot"]!.boolValue, id(r))
            XCTAssertEqual(close, want["close"]?.stringValue, id(r))
            XCTAssertEqual(dummy, want["dummy"]!.intValue, id(r))
        }
    }

    // ── Records and the gate ─────────────────────────────────────────────────────────

    func testRecordRows() {
        for r in rows("records") {
            let type = Int(str(r, "type"), radix: 16)!
            let body = Data(count: type == 0x0004 || type == 0x0005 ? 8 : 0)
            var asm = PeerRecordAssembler(mode: PeerRecordMode(rawValue: str(r, "mode"))!)
            let got = asm.push(PeerRecord(type: type, flags: 0, body: body))
            let want = r["want"]!.objectValue!
            if want["ignored"]?.boolValue == true {
                XCTAssertEqual(got, .ignored, id(r))
            } else if want["allowed"]?.boolValue == true {
                XCTAssertEqual(got, .message(type: type, body: body), id(r))
            } else {
                XCTAssertEqual(got, .close(PeerCloseCode(rawValue: str(want, "close"))!), id(r))
            }
        }
    }

    func testGateRows() {
        let gated = Set(["pair", "join", "advertise-q", "advertise-l", "browse-q", "browse-l", "dial-l", "answer-l"])
        for r in rows("gate") {
            var g = LocalPairingGate(LocalGateState(rawValue: str(r, "start"))!)
            var got: [Row] = []
            for s in r["steps"]!.arrayValue!.map({ $0.objectValue! }) {
                if let call = s["call"]?.stringValue {
                    got.append([
                        "cached": .string(g.state.rawValue),
                        "call": .string(gated.contains(call) && !g.allowed ? "local-pairing-off" : "ok"),
                    ])
                    continue
                }
                let effects: [LocalGateEffect]
                switch str(s, "read") {
                case "ok": effects = g.readOk(body: s["body"])
                case "not-found": effects = g.readNotFound()
                default: effects = g.readError()
                }
                var o: Row = ["cached": .string(g.state.rawValue)]
                if !effects.isEmpty { o["effects"] = .array(effects.map { .string($0.rawValue) }) }
                got.append(o)
            }
            XCTAssertEqual(got, r["want"]!.arrayValue!.map { $0.objectValue! }, id(r))
        }
    }

    // ── Admission (§15.10, "Admission") ──────────────────────────────────────────────

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var t = 0.0
        var now: Double {
            get { lock.withLock { t } }
            set { lock.withLock { t = newValue } }
        }
    }

    func testAdmissionRows() {
        let c = obj("constants")
        XCTAssertEqual(c["admissionGroupPerMinute"]?.intValue, localGroupPerMinute)
        for r in rows("admission") {
            let clock = Clock()
            let lim = HandshakeLimiter(
                maxPerMinute: c["admissionSharedPerMinute"]!.intValue!, maxPending: c["admissionWaiting"]!.intValue!,
                groupMax: c["admissionGroupPerMinute"]!.intValue!, mono: { clock.now })
            var holds: [Int: @Sendable () -> Void] = [:]
            var got: [Row] = []
            for (i, e) in r["events"]!.arrayValue!.map({ $0.objectValue! }).enumerated() {
                clock.now = e["t"]!.doubleValue!
                if let rel = e["release"]?.intValue {
                    holds[rel]?()
                    holds[rel] = nil
                    got.append(["result": .string("released")])
                    continue
                }
                switch lim.beginLocal(group: str(e, "group")) {
                case .refused(let by): got.append(["result": .string("refused"), "by": .string(by.rawValue)])
                case .admitted(let hit, let miss):
                    let opens = e["opens"]!.boolValue!
                    if opens { holds[i] = hit() } else { miss() }
                    got.append(["result": .string("tried"), "hit": .bool(opens)])
                }
            }
            // The state columns are the corpus's own bookkeeping; the limiter's answers are the rows'.
            let want = r["want"]!.arrayValue!.map { w -> Row in
                var o = w.objectValue!
                o["group"] = nil
                o["failed"] = nil
                o["waiting"] = nil
                return o
            }
            XCTAssertEqual(got, want, id(r))
        }
    }

    /// A refund finds its stamp even when another group's message 1 has been counted since (the limiter prunes
    /// and rewrites its per-group lists): a hit leaves the group's budget whole.
    func testAHitRefundsAfterOtherMessagesWereCounted() {
        let clock = Clock()
        let lim = HandshakeLimiter(maxPerMinute: 5, maxPending: 4, groupMax: 2, mono: { clock.now })
        guard case .admitted(let hitA, _) = lim.beginLocal(group: "a") else { return XCTFail("admitted") }
        clock.now = 1
        guard case .admitted(_, let missB) = lim.beginLocal(group: "b") else { return XCTFail("admitted") }
        missB()
        let release = hitA()
        for k in 0..<2 {
            clock.now = 2 + Double(k)
            guard case .admitted(_, let miss) = lim.beginLocal(group: "a") else {
                return XCTFail("a's budget is whole")
            }
            miss()
        }
        release()
    }
}
