// @pkey-feature update.decide
// The Swift runner for `conformance/corpus/v2/update-matrix.json` (plans/P3-01.md §4.6), read
// from the checkout through `CorpusLocator`. Every section, with the same names as the
// Node runner (`conformance/runners/node/corpusV2.test.ts`) and the Python and Godot runners:
//
//   vocabulary       the version and §2.8's lists         → the generated constants
//   versionCases     25 comparisons                       → compareVersions
//   capabilityCases  10 narrowings                        → effectiveCapabilities
//   outletCases      12 resolutions                       → resolveUpdateOutlet
//   bucketVectors    6 vectors                            → rolloutBucket
//   rows             65 decisions and their boot values   → decideUpdate, bootDecision
//
// plus the compiled tables against `outlet-matrix.json#/kinds`, `#/platformNarrowing`,
// `#/subkinds` and `#/platformData/listingUrlPrefixes`.
//
// Like GateMatrixTests, this is a deliberately independent port: a shared helper would prove
// only that two runners share one, not that two implementations agree.

import Foundation
import PolarisKeyCore
import XCTest

private struct MatrixFile: Decodable {
    let updateMatrixVersion: Int
    let vocabulary: [String: [String]]
    let versionCases: [VersionCase]
    let capabilityCases: [CapabilityCase]
    let outletCases: [OutletCase]
    let bucketVectors: [BucketVector]
    let rows: [Row]

    struct VersionCase: Decodable {
        let name: String
        let scheme: String
        let a: String
        let b: String
        let expect: Int?
    }
    struct CapabilityCase: Decodable {
        let name: String
        let kind: String
        let platform: String
        let subkind: String?
        let server: [String: JSONValue]?
        let expect: JSONValue
    }
    struct OutletCase: Decodable {
        let name: String
        let host: JSONValue?
        let stamp: JSONValue?
        let detected: JSONValue?
        let expect: JSONValue
    }
    struct BucketVector: Decodable {
        let name: String
        let salt: String
        let installId: String
        let sha256: String
        let first4: String
        let u32: Int
        let bucket: Int
    }
    struct Row: Decodable {
        struct Expect: Decodable {
            let decision: JSONValue
            let boot: String
        }
        let name: String
        let input: JSONValue
        let expect: Expect
    }
}

private struct OutletMatrixFile: Decodable {
    let outletMatrixVersion: Int
    let kinds: JSONValue
    let platformNarrowing: JSONValue
    let subkinds: JSONValue
    let vocabulary: [String: [String]]
    let platformData: PlatformData

    struct PlatformData: Decodable {
        let listingUrlPrefixes: [String: [String]]
    }
}

// ── JSON → the SDK's inputs (the matrices spell the wire's JSON) ───────────────────────────────

private func str(_ v: JSONValue?) -> String? { v?.stringValue }

private func hostOutlet(_ v: JSONValue?) -> HostOutlet? {
    switch v {
    case .string(let kind)?: return .kind(kind)
    case .object(let o)?:
        return .outlet(id: o["id"]?.stringValue ?? "", kind: o["kind"]?.stringValue ?? "", subkind: o["subkind"]?.stringValue)
    default: return nil
    }
}

private func stamp(_ v: JSONValue?) -> OutletStamp? {
    guard let o = v?.objectValue else { return nil }
    return OutletStamp(
        outlet: str(o["outlet"]), outletKind: str(o["outletKind"]), outletSubkind: str(o["outletSubkind"]))
}

private func detected(_ v: JSONValue?) -> DetectedOutlet? {
    guard let o = v?.objectValue, let kind = str(o["kind"]) else { return nil }
    return DetectedOutlet(
        kind: kind, confidence: str(o["confidence"]), source: str(o["source"]), subkind: str(o["subkind"]))
}

private func resolvedJSON(_ r: ResolvedOutlet?) -> JSONValue {
    guard let r else { return .null }
    return .object([
        "id": r.id.map(JSONValue.string) ?? .null, "kind": .string(r.kind),
        "subkind": r.subkind.map(JSONValue.string) ?? .null,
    ])
}

/// A row's `input` as an `UpdateDecisionInput`. Every member the matrix carries is read; a
/// missing one fails the row rather than defaulting.
func decisionInput(_ json: JSONValue) throws -> UpdateDecisionInput {
    let o = try XCTUnwrap(json.objectValue)
    let feed = try XCTUnwrap(ChannelFeedDoc(json: try XCTUnwrap(o["feed"])), "the row's feed")
    var record: ReleaseRecordDoc?
    if let r = o["record"], r != .null {
        record = try XCTUnwrap(ReleaseRecordDoc(json: r), "the row's record")
    }
    let i = try XCTUnwrap(o["installed"]?.objectValue)
    let installed = InstalledBuild(
        version: try XCTUnwrap(str(i["version"])), binaryVersion: str(i["binaryVersion"]),
        buildNumber: str(i["buildNumber"]), platform: try XCTUnwrap(str(i["platform"])),
        arch: try XCTUnwrap(str(i["arch"])), format: str(i["format"]), engine: str(i["engine"]))
    let outlet = try XCTUnwrap(o["outlet"]?.objectValue)
    var staged: StagedUpdate?
    if let s = o["staged"]?.objectValue {
        staged = StagedUpdate(version: try XCTUnwrap(str(s["version"])), channel: try XCTUnwrap(str(s["channel"])))
    }
    var content: UpdateContentInput?
    if let c = o["content"] {
        content = try XCTUnwrap(UpdateContentInput(json: c), "the row's content")
    }
    return UpdateDecisionInput(
        now: try XCTUnwrap(o["now"]?.exactIntForTests), feed: feed, record: record,
        installed: installed,
        outlet: UpdateOutlet(id: str(outlet["id"]), kind: try XCTUnwrap(str(outlet["kind"]))),
        subkind: str(o["subkind"]), staged: staged, skipVersion: str(o["skipVersion"]),
        bucket: o["bucket"]?.exactIntForTests,
        methods: try XCTUnwrap(o["methods"]?.arrayValue).compactMap(\.stringValue), content: content)
}

extension JSONValue {
    var exactIntForTests: Int? {
        if case .int(let i) = self { return i }
        return nil
    }
}

final class UpdateMatrixTests: XCTestCase {
    private func matrix() throws -> MatrixFile {
        try CorpusLocator.load(MatrixFile.self, "update-matrix")
    }

    func testVersionAndVocabulary() throws {
        let m = try matrix()
        XCTAssertEqual(m.updateMatrixVersion, UPDATE_MATRIX_VERSION)
        XCTAssertEqual(m.vocabulary["actions"], UPDATE_ACTION_VALUES)
        XCTAssertEqual(m.vocabulary["noneReasons"], UPDATE_NONE_REASON_VALUES)
        XCTAssertEqual(m.vocabulary["blockedReasons"], UPDATE_BLOCKED_REASON_VALUES)
        XCTAssertEqual(m.vocabulary["methods"], BINARY_METHOD_VALUES)
        XCTAssertEqual(m.vocabulary["boot"], BootEvent.Decision.allCases.map(\.rawValue))
        XCTAssertEqual(m.vocabulary["schemes"], FEED_VERSION_SCHEMES)
        XCTAssertEqual(Set(m.vocabulary.keys), ["actions", "noneReasons", "blockedReasons", "methods", "boot", "schemes"])
    }

    func testCompiledTablesEqualTheOutletMatrix() throws {
        let o = try CorpusLocator.load(OutletMatrixFile.self, "outlet-matrix")
        XCTAssertEqual(o.outletMatrixVersion, OUTLET_MATRIX_VERSION)
        var kinds: [String: JSONValue] = [:]
        for (kind, caps) in OUTLET_CAPABILITY_DEFAULTS {
            guard case .object(var fields) = caps.json else { return XCTFail() }
            fields["platforms"] = .array((OUTLET_PLATFORMS[kind] ?? []).map(JSONValue.string))
            kinds[kind] = .object(fields)
        }
        XCTAssertEqual(o.kinds, .object(kinds))
        XCTAssertEqual(o.platformNarrowing, .object(PLATFORM_NARROWING.mapValues { .object($0.mapValues { .object($0) }) }))
        XCTAssertEqual(o.subkinds, .object(SUBKIND_NARROWING.mapValues { .object($0) }))
        XCTAssertEqual(o.platformData.listingUrlPrefixes, LISTING_URL_PREFIXES)
        XCTAssertEqual(o.vocabulary["kinds"], OUTLET_KIND_VALUES)
        XCTAssertEqual(o.vocabulary["subkinds"], OUTLET_SUBKIND_VALUES)
        XCTAssertEqual(o.vocabulary["confidence"], OUTLET_CONFIDENCE_VALUES)
    }

    func testEverySectionHasItsCases() throws {
        let m = try matrix()
        XCTAssertEqual(m.versionCases.count, 25)
        XCTAssertEqual(m.capabilityCases.count, 10)
        XCTAssertEqual(m.outletCases.count, 12)
        XCTAssertEqual(m.bucketVectors.count, 6)
        XCTAssertEqual(m.rows.count, 65)
    }

    func testVersionCases() throws {
        for c in try matrix().versionCases {
            XCTAssertEqual(compareVersions(c.scheme, c.a, c.b), c.expect, "version \(c.name)")
        }
    }

    func testCapabilityCases() throws {
        for c in try matrix().capabilityCases {
            let got = effectiveCapabilities(c.kind, platform: c.platform, subkind: c.subkind, server: c.server)
            XCTAssertEqual(got.json, c.expect, "capability \(c.name)")
        }
    }

    func testOutletCases() throws {
        for c in try matrix().outletCases {
            let got = resolveUpdateOutlet(host: hostOutlet(c.host), stamp: stamp(c.stamp), detected: detected(c.detected))
            XCTAssertEqual(resolvedJSON(got), c.expect, "outlet \(c.name)")
        }
    }

    /// A host outlet outside the vocabularies is refused (the SDK raises `invalid-options`).
    func testInvalidHostOutletsAreRefused() {
        for host: HostOutlet in [
            .kind("epic"), .kind(OUTLET_UNKNOWN), .outlet(id: "Direct Build", kind: "direct"),
            .outlet(id: "direct", kind: "epic"), .outlet(id: "direct", kind: "direct", subkind: "brew"),
            .outlet(id: "direct\n", kind: "direct"),
        ] {
            XCTAssertNil(resolveUpdateOutlet(host: host), "\(host)")
            XCTAssertFalse(isValidHostOutlet(host), "\(host)")
        }
    }

    func testBucketVectors() throws {
        for v in try matrix().bucketVectors {
            XCTAssertEqual(rolloutBucket(salt: v.salt, installId: v.installId), v.bucket, "bucket \(v.name)")
            XCTAssertEqual(v.u32 % ROLLOUT_BUCKETS, v.bucket)
            XCTAssertEqual(UInt32(v.first4, radix: 16).map(Int.init), v.u32, v.name)
        }
    }

    func testRows() throws {
        for row in try matrix().rows {
            let input = try decisionInput(row.input)
            // Every row's feed passes the feed claims (plans/P3-01.md §4.9).
            XCTAssertNil(
                feedClaims(try XCTUnwrap(row.input.objectValue?["feed"]), expectedAud: "djdl",
                           channel: input.feed.channel, platform: input.installed.platform),
                "row \(row.name): its feed passes the claims")
            let decision = decideUpdate(input)
            XCTAssertEqual(decision.json, row.expect.decision, "row \(row.name)")
            XCTAssertEqual(bootDecision(decision).rawValue, row.expect.boot, "row \(row.name) boot")
        }
    }

    /// No P3-01 row stops play: every boot value is `none` or `optional`, and every mandatory or
    /// blocked answer is a prompt the player cannot dismiss. (Only a CI-signed revocation of a
    /// required pack can give `required`: `contentRows`, `ContentConformanceV2Tests`.)
    func testNoRowStopsPlay() throws {
        for row in try matrix().rows {
            XCTAssertTrue(["none", "optional"].contains(row.expect.boot), row.name)
            let decision = decideUpdate(try decisionInput(row.input))
            if case .blocked = decision { XCTAssertTrue(isUndismissable(decision), row.name) }
            if isUndismissable(decision) { XCTAssertEqual(bootDecision(decision), .optional, row.name) }
        }
    }
}
