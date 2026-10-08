// @pkey-feature outlet.detect
// The Swift runner for `conformance/corpus/v2/outlet-matrix.json`'s detection rows
// (plans/P3-01.md §2.9, §4.7), read from the checkout through `CorpusLocator`, with the
// same row names as the Node runner (`conformance/runners/node/corpusV2.test.ts`), pytest and
// the Godot runner: the signal table and platform data equal the compiled `OUTLET_SIGNALS` and
// `OUTLET_PLATFORM_DATA`, and every row runs through `detectOutlet`.

import Foundation
import PolarisKeyCore
import XCTest

private struct DetectionFile: Decodable {
    let vocabulary: [String: [String]]
    let signals: [Signal]
    let platformData: [String: JSONValue]
    let rows: [Row]

    struct Signal: Decodable {
        let signal: String
        let confidence: String?
    }
    struct Stamp: Decodable {
        let outletKind: String
        let subkind: String?
        let outletIds: [String: String]
    }
    struct Row: Decodable {
        let name: String
        let stamp: Stamp?
        let signals: [String: JSONValue]
        let expect: Expect
    }
    struct Expect: Decodable {
        let kind: String
        let confidence: String?
        let source: String?
        let subkind: String?
    }
}

final class OutletMatrixTests: XCTestCase {
    private func file() throws -> DetectionFile {
        try CorpusLocator.load(DetectionFile.self, "outlet-matrix")
    }

    func testSignalTableEqualsTheMatrix() throws {
        let f = try file()
        XCTAssertEqual(OUTLET_SIGNALS.map(\.signal), f.vocabulary["signals"])
        XCTAssertEqual(f.signals.map { OutletSignalSpec($0.signal, $0.confidence) }, OUTLET_SIGNALS)
    }

    func testPlatformDataEqualsTheMatrix() throws {
        let d = try file().platformData
        let strings = { (k: String) in d[k]?.arrayValue?.compactMap(\.stringValue) }
        let p = OUTLET_PLATFORM_DATA
        XCTAssertEqual(strings("playStoreCertSha256s"), p.playStoreCertSha256s)
        XCTAssertEqual(strings("altStorePalMarketplaceIds"), p.altStorePalMarketplaceIds)
        XCTAssertEqual(strings("playPackages"), p.playPackages)
        XCTAssertEqual(strings("obtainiumPackages"), p.obtainiumPackages)
        XCTAssertEqual(strings("fdroidClientPackages"), p.fdroidClientPackages)
        XCTAssertEqual(strings("systemInstallerPackages"), p.systemInstallerPackages)
        XCTAssertEqual(d["macosStoreLeaves"]?.objectValue?.compactMapValues(\.stringValue), p.macosStoreLeaves)
        XCTAssertEqual(d["deadlineMs"]?.intValue, p.deadlineMs)
        XCTAssertEqual(
            Set(d.keys),
            [
                "listingUrlPrefixes", "playStoreCertSha256s", "altStorePalMarketplaceIds", "playPackages",
                "obtainiumPackages", "fdroidClientPackages", "systemInstallerPackages", "macosStoreLeaves",
                "deadlineMs",
            ])
    }

    func testEveryRow() throws {
        let rows = try file().rows
        XCTAssertEqual(rows.count, 48)
        for row in rows {
            let stamp = row.stamp.map {
                DetectionStamp(outletKind: $0.outletKind, subkind: $0.subkind, outletIds: $0.outletIds)
            }
            let got = detectOutlet(stamp: stamp, signals: row.signals)
            let want = DetectedOutlet(
                kind: row.expect.kind, confidence: row.expect.confidence, source: row.expect.source,
                subkind: row.expect.subkind)
            XCTAssertEqual(got, want, row.name)
        }
    }

    // ── Edges the rows do not reach ───────────────────────────────────────────────────────────

    func testDetectionStampReadsTheKindAsResolveUpdateOutletDoes() {
        XCTAssertEqual(
            detectionStamp(OutletStamp(outlet: "steam-beta", outletKind: "steam")),
            DetectionStamp(outletKind: "steam"))
        XCTAssertEqual(detectionStamp(OutletStamp(outlet: "itch"))?.outletKind, "itch")
        XCTAssertNil(detectionStamp(OutletStamp(outlet: "epic-store", outletKind: "epic")))
        XCTAssertNil(detectionStamp(OutletStamp(outlet: "itch-beta")))
        XCTAssertNil(detectionStamp(nil))
        XCTAssertEqual(
            detectionStamp(OutletStamp(outlet: "direct", outletSubkind: "flatpak", outletIds: ["flatpakId": "a"])),
            DetectionStamp(outletKind: "direct", subkind: "flatpak", outletIds: ["flatpakId": "a"]))
        XCTAssertNil(detectionStamp(OutletStamp(outlet: "direct", outletSubkind: "brew"))?.subkind)
    }

    func testMalformedValuesAndMissingIdentitiesAreNoEvidence() {
        let stamp = DetectionStamp(outletKind: "direct", outletIds: ["steamAppId": "3166810", "snapName": "diceroll"])
        let cases: [[String: JSONValue]] = [
            ["linux.snapEnv": .null],
            ["linux.snapEnv": .string("diceroll")],
            ["steam.appIdEnv": .array([.int(3_166_810)])],
            ["android.installSource": .null],
            ["android.installSource": .object(["installer": .int(5), "initiator": .int(5)])],
            ["linux.appImageEnv": .object(["appDir": .int(1), "exePath": .string("/x")])],
            ["node.packageManager": .object(["manager": .string("yarn"), "packageMatch": .bool(true)])],
            ["ios.appDistributor": .int(7)],
            ["unknown.signal": .bool(true)],
            ["windows.packageIdentity": .null, "windows.signatureKind": .string("Store")],
            ["steam.libraryManifest": .int(3_166_810)],
        ]
        for signals in cases {
            XCTAssertEqual(detectOutlet(stamp: stamp, signals: signals).kind, "direct", "\(signals)")
        }
        XCTAssertEqual(detectOutlet(stamp: nil, signals: [:]), UNKNOWN_DETECTION)
        XCTAssertEqual(detectOutlet(stamp: DetectionStamp(outletKind: "epic"), signals: [:]), UNKNOWN_DETECTION)
    }
}
