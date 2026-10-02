// @pkey-feature outlet.detect
// The Apple runtimes' outlet readers over faked installs (plans/P3-01.md §2.9). The mapping is
// `detectOutlet`, run row for row in `OutletMatrixTests`; these prove the readers for every
// outlet an Apple runtime can see, AppDistributor's deadline, and that a hung AppDistributor is
// no evidence.

import Foundation
import PolarisKeyCore
import PolarisKeyUpdate
import XCTest

let OUTLET_TEST_IDS: [String: String] = [
    "steamAppId": "3166810", "itchGameId": "1001", "flatpakId": "gg.vlad.Diceroll", "snapName": "diceroll",
    "caskToken": "diceroll", "homebrewFormula": "diceroll", "msixFamilyName": "Diceroll_abc123",
    "bundleId": "gg.vlad.diceroll",
]

/// A faked macOS install: files, symlinks, and a signing leaf.
func fakeMac(
    files: [String: Data] = [:], links: [String: String] = [:], leaf: String? = "Developer ID Application",
    bundle: String = "/Applications/Diceroll.app"
) -> OutletReaderEnvironment {
    let paths = Array(files.keys) + Array(links.keys)
    return OutletReaderEnvironment(
        platform: "macos", bundlePath: bundle,
        fileExists: { files[$0] != nil || links[$0] != nil },
        readFile: { files[$0] },
        listDirectory: { dir in
            Array(Set(paths.filter { $0.hasPrefix(dir + "/") }.map {
                String($0.dropFirst(dir.count + 1).split(separator: "/").first ?? "")
            }))
        },
        symlinkDestination: { links[$0] },
        signingLeaf: { _ in leaf })
}

final class OutletReaderTests: XCTestCase {
    private let receipt = "/Applications/Diceroll.app/Contents/_MASReceipt/receipt"
    private let direct = DetectionStamp(outletKind: "direct", outletIds: OUTLET_TEST_IDS)

    private func detect(_ env: OutletReaderEnvironment, _ stamp: DetectionStamp?) async -> DetectedOutlet {
        detectOutlet(stamp: stamp, signals: await readOutletSignals(env, outletIds: stamp?.outletIds ?? [:]))
    }

    // ── macOS ────────────────────────────────────────────────────────────────────────────────

    func testAnAppStoreReceiptAndStoreLeafNameAppStore() async {
        let env = fakeMac(files: [receipt: Data("r".utf8)], leaf: "Apple Mac OS Application Signing")
        let signals = await readOutletSignals(env, outletIds: OUTLET_TEST_IDS)
        XCTAssertEqual(signals["macos.masReceipt"], .bool(true))
        XCTAssertEqual(signals["macos.receiptSandbox"], .bool(false))
        XCTAssertEqual(signals["macos.signingLeaf"], .string("Apple Mac OS Application Signing"))
        let got = await detect(env, direct)
        XCTAssertEqual(got, DetectedOutlet(kind: "app-store", confidence: "attested", source: "macos.masReceipt"))
    }

    func testATestFlightReceiptAndLeafNameTestFlight() async {
        let env = fakeMac(
            files: [receipt: Data("..ProductionSandbox..".utf8)], leaf: "TestFlight Beta Distribution")
        let got = await detect(env, nil)
        XCTAssertEqual(got.kind, "testflight")
    }

    func testANonStoreLeafVetoesAnAppStoreStampAndLeavesDirect() async {
        let appStore = DetectionStamp(outletKind: "app-store", outletIds: OUTLET_TEST_IDS)
        let devID = fakeMac(leaf: "Developer ID Application: Vlad (ABCDE12345)")
        let signals = await readOutletSignals(devID)
        // The team name is never carried.
        XCTAssertEqual(signals["macos.signingLeaf"], .string("Developer ID Application"))
        XCTAssertEqual(signals["macos.masReceipt"], .bool(false))
        let vetoed = await detect(devID, appStore)
        XCTAssertEqual(vetoed, UNKNOWN_DETECTION)
        let unsigned = await detect(fakeMac(leaf: "none"), appStore)
        XCTAssertEqual(unsigned, UNKNOWN_DETECTION)
        let kept = await detect(devID, direct)
        XCTAssertEqual(kept, DetectedOutlet(kind: "direct", confidence: "stamp", source: "stamp"))
    }

    func testTheProductsCaskroomLinkRestrictsToHomebrew() async {
        let env = fakeMac(links: ["/opt/homebrew/Caskroom/diceroll/1.4.0/Diceroll.app": "/Applications/Diceroll.app"])
        let signals = await readOutletSignals(env, outletIds: OUTLET_TEST_IDS)
        XCTAssertEqual(signals["macos.homebrewCask"], .string("diceroll"))
        let got = await detect(env, direct)
        XCTAssertEqual(
            got, DetectedOutlet(kind: "direct", confidence: "heuristic", source: "macos.homebrewCask", subkind: "homebrew"))
        // Another token's Caskroom is never read.
        let other = await readOutletSignals(env, outletIds: ["caskToken": "other"])
        XCTAssertNil(other["macos.homebrewCask"])
    }

    func testABareToolHasNoReceiptButItsLeafIsRead() async {
        let signals = await readOutletSignals(fakeMac(bundle: "/usr/local/bin/diceroll"))
        XCTAssertNil(signals["macos.masReceipt"])
        XCTAssertEqual(signals["macos.signingLeaf"], .string("Developer ID Application"))
    }

    // ── iOS ──────────────────────────────────────────────────────────────────────────────────

    private func ios(
        distributor: (@Sendable () async -> String?)?, deadline: Duration = .seconds(2), alt: String? = nil,
        profile: Bool = false
    ) -> OutletReaderEnvironment {
        OutletReaderEnvironment(
            platform: "ios", bundlePath: "/var/containers/Bundle/Application/X/Diceroll.app",
            bundleIdentifier: alt.map { "\($0).ABCDE12345" } ?? "gg.vlad.diceroll", altBundleIdentifier: alt,
            hasProvisioningProfile: profile, appDistributor: distributor, deadline: deadline)
    }

    func testAppDistributorValuesNameTheirOutlets() async {
        let cases: [(String, String)] = [
            ("appStore", "app-store"), ("testFlight", "testflight"), ("web", "direct"),
            ("marketplace:com.example", "unknown"), ("other", "direct"),
        ]
        for (value, kind) in cases {
            let env = ios(distributor: { value })
            let signals = await readOutletSignals(env)
            XCTAssertEqual(signals["ios.appDistributor"], .string(value))
            let got = await detect(env, direct)
            // `other` is no evidence: the direct stamp stands. A marketplace other than AltStore PAL
            // vetoes only app-store and testflight, so it too leaves direct.
            XCTAssertEqual(got.kind, value.hasPrefix("marketplace") ? "direct" : kind, value)
        }
    }

    func testANeverResolvingAppDistributorTimesOutAndIsNoEvidence() async {
        let hung = ios(
            distributor: {
                try? await Task.sleep(for: .seconds(3600))
                return "appStore"
            }, deadline: .milliseconds(50))
        let started = ContinuousClock.now
        let signals = await readOutletSignals(hung)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
        XCTAssertEqual(signals["ios.appDistributor"], .string("timeout"))
        let appStore = DetectionStamp(outletKind: "app-store", outletIds: OUTLET_TEST_IDS)
        let got = await detect(hung, appStore)
        XCTAssertEqual(got, DetectedOutlet(kind: "app-store", confidence: "stamp", source: "stamp"))
    }

    func testWithoutMarketplaceKitThereIsNoAppDistributorSignal() async {
        let signals = await readOutletSignals(ios(distributor: nil))
        XCTAssertNil(signals["ios.appDistributor"])
        XCTAssertEqual(signals["ios.provisioningProfile"], .bool(false))
    }

    func testAnAltStoreRewriteMovesAnAppStoreStampToAltstore() async {
        let env = ios(distributor: nil, alt: "gg.vlad.diceroll")
        let signals = await readOutletSignals(env)
        XCTAssertEqual(
            signals["ios.bundleIdRewrite"],
            .object([
                "runtimeBundleId": .string("gg.vlad.diceroll.ABCDE12345"),
                "altBundleIdentifier": .string("gg.vlad.diceroll"),
            ]))
        let got = await detect(env, DetectionStamp(outletKind: "app-store", outletIds: OUTLET_TEST_IDS))
        XCTAssertEqual(got, DetectedOutlet(kind: "altstore", confidence: "declared", source: "ios.bundleIdRewrite"))
    }

    func testAProvisioningProfileVetoesAnAppStoreStamp() async {
        let got = await detect(
            ios(distributor: nil, profile: true), DetectionStamp(outletKind: "app-store", outletIds: OUTLET_TEST_IDS))
        XCTAssertEqual(got, UNKNOWN_DETECTION)
    }

    func testTheRealProcessReadsWithoutCrashing() async {
        _ = await readOutletSignals(.process())
    }
}
