// @pkey-feature update.content packs.revoke
// The Swift runner for P4-13's corpus sections (plans/P4-13.md §4; P4-23), read from the
// generator-owned mirror in `Resources/v2/`, with the same ids as the Node runner
// (`conformance/runners/node/suites.ts`) and the Python runner:
//
//   feedContentCases  §2.2's content members, every case             → verifyFeed, feedContent
//   revocationCases   §2.3's steps 12–16, superseding                 → verifyRevocation,
//                                                                       verifyReleaseRecord,
//                                                                       newerRevocation
//   contentRows       update-matrix.json, §2.6's content decision     → decideUpdate, bootDecision,
//                                                                       packSetId
//
// The stamp cases' `expect.holds` (`holdsOf`) run in `ContentConformanceTests.testStampCases`.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

final class ContentDecisionConformanceTests: XCTestCase {
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
            seq: try XCTUnwrap(e["seq"]?.exactIntForTests))
    }

    // ── feedContentCases ─────────────────────────────────────────────────────────────────────

    func testAllFeedContentCases() throws {
        let list = try XCTUnwrap(cases()["feedContentCases"]?.arrayValue)
        XCTAssertEqual(list.count, 48)
        for raw in list {
            let c = try XCTUnwrap(raw.objectValue)
            let id = c["id"]!.stringValue!
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
            let want = try XCTUnwrap(c["expect"]?.objectValue?["content"])
            XCTAssertEqual(feed.content.json, want, "\(id): \(c["description"]!)")
            XCTAssertEqual(feedContent(feed.json, nonWire: feed.nonWireIntegers), feed.content, id)
        }
    }

    /// `withFeedContent` keeps exactly the parsed members, so a decision over the copy reads the
    /// same content as over the verified payload.
    func testWithFeedContentRoundTrips() throws {
        for raw in try XCTUnwrap(cases()["feedContentCases"]?.arrayValue) {
            let c = try XCTUnwrap(raw.objectValue)
            let r = verifyFeed(
                c["jws"]!.stringValue!,
                options: VerifyFeedOptions(
                    trust: try trust(c["trust"]), expectedAud: c["expectedAud"]!.stringValue!,
                    channel: c["channel"]!.stringValue!, platform: c["platform"]?.stringValue,
                    now: c["now"]?.exactIntForTests, checkFreshness: c["checkFreshness"]?.boolValue ?? true))
            let feed = try XCTUnwrap(r.feed)
            let copy = withFeedContent(feed, feed.content)
            XCTAssertEqual(feedContent(copy.json), feed.content, c["id"]!.stringValue!)
        }
    }

    // ── revocationCases ──────────────────────────────────────────────────────────────────────

    func testAllRevocationCases() throws {
        let list = try XCTUnwrap(cases()["revocationCases"]?.arrayValue)
        XCTAssertEqual(list.count, 27)
        var byId: [String: [String: JSONValue]] = [:]
        for raw in list { if let o = raw.objectValue, let id = o["id"]?.stringValue { byId[id] = o } }
        func verify(_ c: [String: JSONValue]) throws -> VerifyRevocationResult {
            verifyRevocation(
                c["jws"]!.stringValue!,
                options: VerifyRevocationOptions(
                    releaseKeys: try trust(c["releaseKeys"]), productTrust: try trust(c["productTrust"]),
                    expectedAud: c["expectedAud"]!.stringValue!, entry: try entry(c["entry"])))
        }
        for raw in list {
            let c = try XCTUnwrap(raw.objectValue)
            let id = c["id"]!.stringValue!
            let expect = try XCTUnwrap(c["expect"]?.objectValue)
            let ok = expect["verify"] == .string("ok")
            if c["mode"] == .string("replacement") {
                let pin = try XCTUnwrap(c["pin"]?.objectValue)
                let r = verifyReleaseRecord(
                    c["jws"]!.stringValue!,
                    options: VerifyReleaseRecordOptions(
                        releaseKeys: try trust(c["releaseKeys"]), productTrust: try trust(c["productTrust"]),
                        expectedAud: c["expectedAud"]!.stringValue!,
                        expectedHash: try XCTUnwrap(c["expectedHash"]?.stringValue),
                        pin: ReleaseRecordPin(
                            kind: pin["kind"]?.stringValue ?? "app", deliverable: pin["deliverable"]!.stringValue!,
                            version: pin["version"]!.stringValue!, seq: pin["seq"]!.exactIntForTests!)))
                if ok {
                    XCTAssertEqual(r.record?.kind, expect["kind"]?.stringValue, id)
                } else {
                    XCTAssertEqual(r.step?.rawValue, expect["step"]?.stringValue, id)
                }
                continue
            }
            let r = try verify(c)
            guard ok else {
                XCTAssertEqual(r.step?.rawValue, expect["step"]?.stringValue, "\(id): \(c["description"]!)")
                continue
            }
            guard let rev = r.revocation else {
                XCTFail("\(id) → ok, got \(String(describing: r.step))")
                continue
            }
            XCTAssertEqual(rev.body.json, expect["revocation"], id)
            if let supersedes = expect["supersedes"]?.stringValue {
                let other = try XCTUnwrap(try verify(try XCTUnwrap(byId[supersedes])).revocation, supersedes)
                let win = newerRevocation(rev, other)
                XCTAssertEqual(win, newerRevocation(other, rev), id)
                let winner = try XCTUnwrap(expect["winner"]?.stringValue)
                XCTAssertEqual(win.record, try entry(byId[winner]?["entry"]).record, id)
            }
        }
    }

    /// `revocationOf` reads the body alone; the token rule applies at `/replacement/seq`.
    func testRevocationOfTokenRule() throws {
        let doc: JSONValue = .object([
            "kind": .string("revocation"), "deliverable": .string("djdl.levels"),
            "revokes": .string(String(repeating: "a", count: 64)), "issuedAt": .int(1),
            "replacement": .object([
                "sha256": .string(String(repeating: "b", count: 64)), "seq": .int(1), "version": .string("1.0.0"),
            ]),
            "reason": .string("r"),
        ])
        XCTAssertNotNil(revocationOf(doc))
        XCTAssertNil(revocationOf(doc, nonWire: ["/replacement/seq"]))
    }

    // ── contentRows ──────────────────────────────────────────────────────────────────────────

    private func contentRows() throws -> [JSONValue] {
        let m = try XCTUnwrap(CorpusBundleLoader.load(JSONValue.self, "update-matrix").objectValue)
        return try XCTUnwrap(m["contentRows"]?.arrayValue)
    }

    func testAllContentRows() throws {
        let rows = try contentRows()
        XCTAssertEqual(rows.count, 44)
        for raw in rows {
            let row = try XCTUnwrap(raw.objectValue)
            let name = row["name"]!.stringValue!
            let expect = try XCTUnwrap(row["expect"]?.objectValue)
            let input = try decisionInput(try XCTUnwrap(row["input"]))
            XCTAssertNotNil(input.content, name)
            let decision = decideUpdate(input)
            XCTAssertEqual(decision.json, expect["decision"], "content row \(name)")
            XCTAssertEqual(bootDecision(decision).rawValue, expect["boot"]?.stringValue, "content row \(name) boot")
            if let want = expect["packSetId"]?.stringValue {
                guard case .packs(_, _, let set, _) = decision else {
                    XCTFail("content row \(name): expected packs")
                    continue
                }
                XCTAssertEqual(
                    packSetId(set.map { PackSetEntry(packId: $0.pack, releaseSha256: $0.sha256) }), want, name)
            }
        }
    }

    /// Decision 4: `required` exactly on the rows whose decision is `revoked-content` (as the
    /// blocked reason or as `contentBlock`).
    func testRequiredExactlyOnRevokedContentRows() throws {
        for raw in try contentRows() {
            let row = try XCTUnwrap(raw.objectValue)
            let d = try XCTUnwrap(row["expect"]?.objectValue?["decision"]?.objectValue)
            let revoked =
                d["reason"] == .string(UpdateBlockedReason.revokedContent)
                || d["contentBlock"] == .string(UpdateBlockedReason.revokedContent)
            XCTAssertEqual(row["expect"]?.objectValue?["boot"] == .string(BootEvent.Decision.required.rawValue), revoked)
        }
    }

    /// Every content row's feed has a usable `packFloors` member through `feedContent`.
    func testFeedContentOverEveryRowFeed() throws {
        for raw in try contentRows() {
            let feed = try XCTUnwrap(raw.objectValue?["input"]?.objectValue?["feed"])
            XCTAssertNotNil(feedContent(feed).packFloors)
        }
    }

    /// Without `content` every content row is P3-01's answer: a product with no packs is unchanged.
    func testNoContentIsP301() throws {
        for raw in try contentRows() {
            var input = try decisionInput(try XCTUnwrap(raw.objectValue?["input"]))
            input.content = nil
            let d = decideUpdate(input)
            XCTAssertNil(d.contentBlock)
            if case .packs = d { XCTFail("packs without content") }
            XCTAssertNotEqual(bootDecision(d), .required)
        }
    }
}
