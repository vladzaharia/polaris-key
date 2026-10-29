// @pkey-feature connect.protocol connect.lan
// CC-11.6: the codecs of `pkey-peer/1` (WIRE-CONTRACT-V5 §15.4, §15.5) against the `adverts`,
// `sas` and `handshakePayloads` rows of `conformance/corpus/v2/peer-matrix.json`, read in place:
// the advert epoch, instance names, product tags, TXT and browse; the SAS commit, reveal, code and
// display; the handshake payloads and the capability intersection; and, for the LAN adapter
// (CC-IPV6.6, §15.4.1), every `lanAddresses` row through `lanVerdict` and `lanGroupKey`.

import Foundation
import PolarisKeyPlatform
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

final class PeerCodecTests: XCTestCase {
    private let m: [String: JSONValue] = {
        let v = try! CorpusLocator.load(JSONValue.self, "peer-matrix")
        return v.objectValue!
    }()

    private func rows(_ section: String, _ key: String) -> [[String: JSONValue]] {
        m[section]!.objectValue![key]!.arrayValue!.map { $0.objectValue! }
    }

    // ── Adverts ──────────────────────────────────────────────────────────────────────

    func testEpochs() {
        XCTAssertEqual(m["adverts"]!.objectValue!["epochSeconds"]?.intValue, 900)
        for r in rows("adverts", "epochs") {
            XCTAssertEqual(peerAdvertEpoch(r["now"]!.intValue!), r["epoch"]!.intValue, "\(r["now"]!)")
        }
        XCTAssertEqual(peerAdvertEpoch(-1), -1)
    }

    func testNamesTagsAndInstanceShapes() throws {
        for r in rows("adverts", "names") {
            let got = try PeerAdvert.accountInstance(
                discoveryKey: unhex(r["kDisc"]!.stringValue!), epoch: r["epoch"]!.intValue!,
                deviceId: r["deviceId"]!.stringValue!)
            XCTAssertEqual(got, r["instance"]!.stringValue, r["id"]!.stringValue!)
        }
        for r in rows("adverts", "tags") {
            XCTAssertEqual(
                try PeerAdvert.productTag(slug: r["slug"]!.stringValue!, epoch: r["epoch"]!.intValue!),
                r["h"]!.stringValue)
        }
        for r in rows("adverts", "instances") {
            XCTAssertEqual(
                PeerAdvert.isInstanceName(r["name"]!.stringValue!), r["want"]!.boolValue, r["name"]!.stringValue!)
        }
        XCTAssertFalse(PeerAdvert.isInstanceName("p1-abcdefghijklmnop\n"))
        XCTAssertThrowsError(try PeerAdvert.deviceIdBytes("short"))
        XCTAssertThrowsError(
            try PeerAdvert.accountInstance(
                discoveryKey: Data(count: 32), epoch: -1, deviceId: String(repeating: "A", count: 32)))
    }

    func testBase32() {
        XCTAssertEqual(PeerAdvert.base32Lower(Data("foobar".utf8)), "mzxw6ytboi")
        XCTAssertEqual(PeerAdvert.base32Lower(Data("f".utf8)), "my")
    }

    func testTxt() {
        for r in rows("adverts", "txt") {
            let want = r["want"]!.objectValue!
            let got = PeerAdvert.parseTxt(r["entries"]!.arrayValue!.map { $0.stringValue! })
            let id = r["id"]!.stringValue!
            if want["ok"]!.boolValue! {
                guard case .ok(let mode, let h) = got else { return XCTFail(id) }
                XCTAssertEqual(mode.rawValue, want["mode"]!.stringValue, id)
                XCTAssertEqual(h, want["h"]?.stringValue, id)
            } else {
                XCTAssertEqual(got, .refused(PeerAdvert.TxtRefusal(rawValue: want["reason"]!.stringValue!)!), id)
            }
        }
    }

    func testBrowse() throws {
        for r in rows("adverts", "browse") {
            let got = try PeerAdvert.browseAccountInstance(
                r["instance"]!.stringValue!, discoveryKeys: r["kDiscs"]!.arrayValue!.map { unhex($0.stringValue!) },
                now: r["now"]!.intValue!, roster: r["roster"]!.arrayValue!.map { $0.stringValue! })
            let id = r["id"]!.stringValue!
            if let want = r["want"]!.objectValue {
                XCTAssertEqual(got?.deviceId, want["deviceId"]!.stringValue, id)
                XCTAssertEqual(got?.epochBack, want["epochBack"]!.intValue, id)
                XCTAssertEqual(got?.keyIndex, want["keyIndex"]!.intValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    // ── SAS ──────────────────────────────────────────────────────────────────────────

    func testSasCommitsAndBodies() throws {
        for r in rows("sas", "commits") {
            let nD = unhex(r["nD"]!.stringValue!)
            let c = unhex(r["c"]!.stringValue!)
            XCTAssertEqual(hex(PeerSAS.commit(nD)), r["c"]!.stringValue)
            XCTAssertEqual(String(decoding: try PeerSAS.body(.c, c), as: UTF8.self), r["commitBody"]!.stringValue)
            XCTAssertEqual(String(decoding: try PeerSAS.body(.nD, nD), as: UTF8.self), r["revealBody"]!.stringValue)
            XCTAssertEqual(
                PeerSAS.parseBody(.c, Data(r["commitBody"]!.stringValue!.utf8)).map(hex), r["c"]!.stringValue)
            XCTAssertEqual(
                PeerSAS.parseBody(.nD, Data(r["revealBody"]!.stringValue!.utf8)).map(hex), r["nD"]!.stringValue)
        }
        // Not the canonical one-member object.
        let good = try PeerSAS.body(.c, Data(count: 32))
        XCTAssertNil(PeerSAS.parseBody(.nD, good))
        XCTAssertNil(PeerSAS.parseBody(.c, good + [0x20]))
        XCTAssertNil(PeerSAS.parseBody(.c, Data([0xff, 0xfe])))
        XCTAssertNil(PeerSAS.parseBody(.c, Data(#"{"c":""}"#.utf8)))
        XCTAssertThrowsError(try PeerSAS.encodeValue(Data(count: 31)))
    }

    func testSasCodesRevealsAndNonces() {
        for r in rows("sas", "codes") {
            let code = PeerSAS.value(
                handshakeHash: unhex(r["h"]!.stringValue!), nD: unhex(r["nD"]!.stringValue!),
                nM: unhex(r["nM"]!.stringValue!), mode: PeerNoiseMode(rawValue: r["mode"]!.stringValue!)!)
            let id = r["id"]!.stringValue!
            XCTAssertEqual(code, r["code"]!.intValue, id)
            XCTAssertEqual(PeerSAS.display(code), r["display"]!.stringValue, id)
        }
        for r in rows("sas", "reveals") {
            XCTAssertEqual(
                PeerSAS.revealOK(commit: r["c"]!.stringValue!, nD: r["nD"]!.stringValue!), r["want"]!.boolValue,
                r["id"]!.stringValue!)
        }
        for r in rows("sas", "nonces") {
            let id = r["id"]!.stringValue!
            XCTAssertEqual(PeerSAS.decodeValue(r["text"]!.stringValue!).map(hex), r["want"]?.stringValue, id)
        }
        XCTAssertEqual(PeerSAS.display(5), "000 005")
    }

    // ── Handshake payloads ───────────────────────────────────────────────────────────

    func testPayloads() {
        let section = m["handshakePayloads"]!.objectValue!
        XCTAssertEqual(section["maxPayload"]?.intValue, peerMaxHandshakePayload)
        for r in rows("handshakePayloads", "payloads") {
            let id = r["id"]!.stringValue!
            let bytes: Data
            if let h = r["payloadHex"]?.stringValue {
                bytes = unhex(h)
            } else if let pad = r["payloadPad"]?.objectValue {
                bytes = Data(
                    (pad["prefix"]!.stringValue!
                        + String(repeating: pad["fill"]!.stringValue!, count: pad["count"]!.intValue!)
                        + pad["suffix"]!.stringValue!).utf8)
            } else {
                bytes = Data(r["payload"]!.stringValue!.utf8)
            }
            XCTAssertEqual(bytes.count, r["length"]!.intValue, id)
            let v = PeerPayload.parse(
                mode: PeerNoiseMode(rawValue: r["mode"]!.stringValue!)!, message: r["message"]!.intValue!, bytes)
            let want = r["want"]!.objectValue!
            XCTAssertEqual(v.ok, want["ok"]!.boolValue, id)
            if want["ok"]!.boolValue!, let caps = want["caps"]?.arrayValue {
                XCTAssertEqual(v.caps, caps.map { $0.stringValue! }, id)
            }
            if want["cert"] != nil {
                XCTAssertEqual(v.cert, want["cert"]!.stringValue, id)
                XCTAssertEqual(v.ring, want["ring"]!.intValue, id)
            }
        }
    }

    func testIntersection() {
        for r in rows("handshakePayloads", "intersection") {
            XCTAssertEqual(
                PeerPayload.capsIntersection(
                    r["local"]!.arrayValue!.map { $0.stringValue! }, r["remote"]!.arrayValue!.map { $0.stringValue! }),
                r["want"]!.arrayValue!.map { $0.stringValue! }, r["id"]!.stringValue!)
        }
    }

    func testBuildersRoundTripThroughTheParser() throws {
        XCTAssertEqual(String(decoding: PeerPayload.payload1(), as: UTF8.self), #"{"v":1}"#)
        XCTAssertTrue(PeerPayload.parse(mode: .a, message: 1, PeerPayload.payload1()).ok)
        let caps = ["app/1", "ring/1"]
        let v = try PeerPayload.payload23(mode: .v, caps: caps)
        XCTAssertEqual(String(decoding: v, as: UTF8.self), #"{"v":1,"caps":["app/1","ring/1"]}"#)
        XCTAssertEqual(PeerPayload.parse(mode: .v, message: 2, v).caps, caps)
        let a = try PeerPayload.payload23(mode: .a, caps: caps, account: (cert: "e30.e30.c2ln", ring: 7))
        XCTAssertEqual(
            String(decoding: a, as: UTF8.self), #"{"v":1,"cert":"e30.e30.c2ln","ring":7,"caps":["app/1","ring/1"]}"#)
        let got = PeerPayload.parse(mode: .a, message: 3, a)
        XCTAssertEqual([got.ring, got.cert.map { _ in 1 }], [7, 1])
        XCTAssertThrowsError(try PeerPayload.payload23(mode: .a, caps: caps))
        XCTAssertThrowsError(
            try PeerPayload.payload23(
                mode: .v, caps: Array(repeating: String(repeating: "a", count: 40) + "/1", count: 300)))
    }

    // ── LAN addresses (§15.4.1) ──────────────────────────────────────────────────────

    /// Every `lanAddresses` row: the verdict, the per-address key and the per-/64 key. The
    /// `candidates` rows under it (§15.6, CANDIDATES) are not run: the Swift peer session reads no
    /// CANDIDATES entry, so it dials only what the Bonjour browse returns.
    func testLanAddressRows() {
        let rows = rows("lanAddresses", "rows")
        XCTAssertEqual(rows.count, 133, "a row added or dropped is a deliberate corpus change")
        XCTAssertEqual(Set(rows.map { $0["id"]!.stringValue! }).count, rows.count)
        for r in rows {
            let id = r["id"]!.stringValue!
            let key = r["key"]?.stringValue
            let v = lanVerdict(
                r["remote"]!.stringValue!, local: r["local"]?.stringValue,
                allowLoopback: r["allowLoopback"]!.boolValue!)
            XCTAssertEqual(v, LanVerdict(dial: r["dial"]!.boolValue!, key: key), id)
            XCTAssertEqual(lanGroupKey(v.key), r["group"]?.stringValue, id)
        }
    }

    /// `mdnsAnswers` is the mDNS answer-learning rule; the OS resolver owns it on Apple platforms
    /// (Network.framework hands the app resolved endpoints), so Swift skips it by name.
    func testMdnsAnswersIsSkippedByName() {
        let skipped: Set<String> = ["mdnsAnswers"]
        XCTAssertTrue(skipped.isSubset(of: Set(m.keys)))
        XCTAssertNotNil(m["mdnsAnswers"]!.objectValue!["rows"], "the section still exists in the corpus")
    }

    func testLanVerdictEdgesBeyondTheCorpus() {
        // A refusal carries no key, and an absent local address refuses a global one.
        XCTAssertEqual(lanVerdict("8.8.8.8", local: nil, allowLoopback: true), LanVerdict(dial: false, key: nil))
        XCTAssertFalse(lanVerdict("2001:db8:1:2::5", local: nil, allowLoopback: false).dial)
        XCTAssertTrue(lanVerdict("2001:db8:1:2::5", local: "2001:db8:1:2::9", allowLoopback: false).dial)
        XCTAssertNil(lanGroupKey(nil))
        XCTAssertNil(lanGroupKey("10.0.0.1"))
        XCTAssertEqual(lanGroupKey("fe80::1%en0"), "fe80::/64%en0")
    }
}
