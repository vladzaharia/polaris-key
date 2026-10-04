// @pkey-feature packs.delegation
// The Swift runner for P4-19's corpus sections (plans/P4-19.md §4.2, §4.3; P4-25), with the same
// ids as the Node runner (`conformance/runners/node/suites.ts`) and the Python runner:
//
//   delegationCases  §2.3's delegated steps 12–16, recordRevoked,   → verifyReleaseRecord,
//                    delegation revocations, the feed entry `kind`     verifyRevocation,
//                                                                      recordRevoked, verifyFeed
//   dataOnlyCases    §2.5's data-only rule and Amendment A1          → dataOnlyRefusal
//                    (`content/cases.json`, read from the checkout)

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

final class DelegationConformanceTests: XCTestCase {
    private func cases() throws -> [String: JSONValue] {
        try XCTUnwrap(CorpusBundleLoader.load(JSONValue.self, "cases").objectValue)
    }

    private func trust(_ v: JSONValue?) throws -> TrustSet {
        try XCTUnwrap(v?.objectValue).compactMapValues(\.stringValue)
    }

    private func entry(_ v: JSONValue?) throws -> FeedRevocation {
        let e = try XCTUnwrap(v?.objectValue)
        return FeedRevocation(
            record: try XCTUnwrap(e["record"]?.stringValue), pack: try XCTUnwrap(e["pack"]?.stringValue),
            target: try XCTUnwrap(e["target"]?.stringValue), version: try XCTUnwrap(e["version"]?.stringValue),
            seq: try XCTUnwrap(e["seq"]?.exactIntForTests), kind: e["kind"]?.stringValue)
    }

    func testAllDelegationCases() throws {
        let list = try XCTUnwrap(cases()["delegationCases"]?.arrayValue)
        XCTAssertEqual(list.count, 46)
        for raw in list {
            let c = try XCTUnwrap(raw.objectValue)
            let id = c["id"]!.stringValue!
            let mode = c["mode"]!.stringValue!
            let expect = try XCTUnwrap(c["expect"]?.objectValue)
            let ok = expect["verify"] == .string("ok")
            let desc = "\(id): \(c["description"]?.stringValue ?? "")"
            switch mode {
            case "feed":
                let r = verifyFeed(
                    try XCTUnwrap(c["jws"]?.stringValue),
                    options: VerifyFeedOptions(
                        trust: try trust(c["trust"]), expectedAud: try XCTUnwrap(c["expectedAud"]?.stringValue),
                        channel: try XCTUnwrap(c["channel"]?.stringValue), platform: c["platform"]?.stringValue,
                        now: c["now"]?.exactIntForTests, checkFreshness: c["checkFreshness"]?.boolValue ?? true))
                guard let feed = r.feed else {
                    XCTFail("\(id) → ok, got \(String(describing: r.refusal))")
                    continue
                }
                XCTAssertEqual(feed.content.json, expect["content"], desc)
                // plans/P4-29.md §4.2: these feeds carry no delta menu.
                XCTAssertNil(feed.content.deltas, desc)
            case "revocation":
                let r = verifyRevocation(
                    c["jws"]!.stringValue!,
                    options: VerifyRevocationOptions(
                        releaseKeys: try trust(c["releaseKeys"]), productTrust: try trust(c["productTrust"]),
                        expectedAud: c["expectedAud"]!.stringValue!, entry: try entry(c["entry"])))
                if ok {
                    XCTAssertEqual(r.revocation?.body.json, expect["revocation"], desc)
                } else {
                    XCTAssertEqual(r.step?.rawValue, expect["step"]?.stringValue, desc)
                }
            default:
                var pin: ReleaseRecordPin?
                if let p = c["pin"]?.objectValue {
                    pin = ReleaseRecordPin(
                        kind: p["kind"]?.stringValue ?? "app", deliverable: p["deliverable"]!.stringValue!,
                        version: p["version"]!.stringValue!, seq: p["seq"]!.exactIntForTests!)
                }
                let delegation = mode == "record" ? c["delegation"]?.stringValue : nil
                let r = verifyReleaseRecord(
                    c["jws"]!.stringValue!,
                    options: VerifyReleaseRecordOptions(
                        releaseKeys: try trust(c["releaseKeys"]), productTrust: try trust(c["productTrust"]),
                        expectedAud: c["expectedAud"]!.stringValue!,
                        expectedHash: try XCTUnwrap(c["expectedHash"]?.stringValue), pin: pin,
                        delegation: delegation))
                guard ok else {
                    XCTAssertEqual(r.step?.rawValue, expect["step"]?.stringValue, desc)
                    continue
                }
                guard let record = r.record else {
                    XCTFail("\(id) → ok, got \(String(describing: r.step))")
                    continue
                }
                XCTAssertEqual(record.kind, expect["kind"]?.stringValue, desc)
                XCTAssertEqual(r.delegation?.json ?? .null, expect["delegation"] ?? .null, desc)
                if let revoked = c["revoked"]?.arrayValue {
                    let got = recordRevoked(
                        c["expectedHash"]!.stringValue!, r.delegation?.sha256,
                        Set(revoked.compactMap(\.stringValue)))
                    XCTAssertEqual(got.map { JSONValue.string($0.rawValue) } ?? .null, expect["revoked"] ?? .null, desc)
                }
            }
        }
    }

    func testAllDataOnlyCases() throws {
        let content = try ContentCorpus.load()
        let list = try XCTUnwrap(content["dataOnlyCases"]?.arrayValue)
        XCTAssertEqual(list.count, 76)
        func b64(_ s: String?) throws -> [UInt8] {
            [UInt8](try XCTUnwrap(Data(base64Encoded: s ?? "")))
        }
        for raw in list {
            let c = try XCTUnwrap(raw.objectValue)
            let id = c["id"]!.stringValue!
            var file: [UInt8]
            if let whole = c["content"]?.stringValue {
                file = try b64(whole)
            } else {
                file = try b64(c["head"]?.stringValue)
                if let fill = c["tailFill"]?.objectValue {
                    file += [UInt8](
                        repeating: UInt8(fill["byte"]!.exactIntForTests!), count: fill["length"]!.exactIntForTests!)
                } else {
                    file += try b64(c["tail"]?.stringValue)
                }
            }
            let rule = dataOnlyRefusal(
                c["path"]!.stringValue!, head: Array(file.prefix(DATA_ONLY_HEAD_BYTES)),
                tail: Array(file.suffix(DATA_ONLY_TAIL_BYTES)), full: file)
            let got: JSONValue =
                rule.map { .object(["ok": .bool(false), "rule": .string($0.rawValue)]) } ?? .object(["ok": .bool(true)])
            XCTAssertEqual(got, c["expect"], "\(id): \(c["description"]?.stringValue ?? "")")
        }
    }
}
