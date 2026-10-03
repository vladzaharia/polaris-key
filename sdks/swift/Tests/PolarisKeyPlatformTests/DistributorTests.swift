import Foundation
import XCTest

@testable import PolarisKeyPlatform

final class DistributorTests: XCTestCase {
    private let evidence = BundleEvidence(provisioned: false, altBundleIdentifier: nil, bundleIdentifier: "gg.vlad.diceroll")

    func testEachCaseIsReportedRaw() async {
        let cases: [(DistributorCase, String)] = [
            (.appStore, "appStore"), (.testFlight, "testFlight"), (.marketplace("com.example.market"), "marketplace:com.example.market"),
            (.web, "web"), (.other, "other"),
        ]
        for (d, want) in cases {
            let r = await readDistributor(source: FakeDistributor(.answer(d)), evidence: evidence, availability: .iOS26_3)
            XCTAssertEqual(r["signal"], .string(want), "\(d)")
            XCTAssertNil(r["reason"], "\(d)")
            XCTAssertEqual(r["ok"], true)
        }
    }

    func testUnavailableBelowIOS17_4AndTheSourceIsNeverCalled() async {
        let source = FakeDistributor(.answer(.appStore))
        let r = await readDistributor(source: source, evidence: evidence, availability: .iOS17_0)
        XCTAssertEqual(r["signal"], "unavailable")
        XCTAssertNotNil(r["reason"])
        XCTAssertEqual(source.calls.withLock { $0 }, 0)
    }

    func testNoWebBelowIOS17_5() async {
        let r = await readDistributor(source: FakeDistributor(.answer(.web)), evidence: evidence, availability: .iOS17_4)
        XCTAssertEqual(r["signal"], "other")
        XCTAssertEqual(signal(for: .web, availability: .iOS17_4), "other")
        XCTAssertEqual(signal(for: .web, availability: .iOS26_3), "web")
    }

    func testANeverResolvingSourceIsUnavailableAtTheDeadline() async {
        let start = Date()
        let r = await readDistributor(source: FakeDistributor(.hang), evidence: evidence, availability: .iOS26_4, deadline: 0.2)
        let took = Date().timeIntervalSince(start)
        XCTAssertEqual(r["signal"], "unavailable")
        XCTAssertEqual(r["reason"], "timeout")
        XCTAssertEqual(r["deadline"], .double(0.2))
        XCTAssertLessThan(took, 2, "the hung call must not be awaited past the deadline")
        XCTAssertGreaterThanOrEqual(took, 0.15)
    }

    func testTheDefaultDeadlineIsTwoSeconds() {
        XCTAssertEqual(defaultDistributorDeadline, 2.0)
    }

    func testAnErrorIsUnavailableNotOther() async {
        let r = await readDistributor(source: FakeDistributor(.fail("boom")), evidence: evidence, availability: .iOS26_4)
        XCTAssertEqual(r["signal"], "unavailable")
        XCTAssertTrue(r["reason"]?.stringValue?.hasPrefix("error: ") ?? false)
        let u = await readDistributor(source: FakeDistributor(.unavailable), evidence: evidence, availability: .iOS26_4)
        XCTAssertEqual(u["reason"], "version")
    }

    func testStaticEvidenceIsAlwaysReturnedAndNeverSelects() async {
        let alt = BundleEvidence(provisioned: true, altBundleIdentifier: "gg.vlad.diceroll", bundleIdentifier: "gg.vlad.diceroll.ABCDE12345")
        // Even with a timed-out distributor, the evidence rides along.
        let r = await readDistributor(source: FakeDistributor(.hang), evidence: alt, availability: .iOS26_4, deadline: 0.05)
        XCTAssertEqual(r["signal"], "unavailable")
        XCTAssertEqual(r["provisioned"], true)
        XCTAssertEqual(r["altBundleIdentifier"], "gg.vlad.diceroll")
        XCTAssertEqual(r["bundleIdentifier"], "gg.vlad.diceroll.ABCDE12345")
        // Below 17.4 too.
        let low = await readDistributor(source: FakeDistributor(.answer(.appStore)), evidence: alt, availability: .iOS17_0)
        XCTAssertEqual(low["provisioned"], true)
        let none = await readDistributor(source: FakeDistributor(.answer(.appStore)), evidence: evidence, availability: .iOS26_4)
        XCTAssertEqual(none["altBundleIdentifier"], .null)
        XCTAssertEqual(none["signal"], "appStore", "a provisioning profile or a rewrite never changes the signal")
    }

    func testReadAtEveryCallNeverCached() async {
        let source = FakeDistributor(.answer(.testFlight))
        _ = await readDistributor(source: source, evidence: evidence, availability: .iOS26_4)
        _ = await readDistributor(source: source, evidence: evidence, availability: .iOS26_4)
        XCTAssertEqual(source.calls.withLock { $0 }, 2)
    }

    func testTheSystemDistributorOffIOSIsUnavailable() async {
        #if !os(iOS)
        let r = await readDistributor(source: SystemDistributor(), evidence: evidence, availability: .current)
        XCTAssertEqual(r["signal"], "unavailable")
        XCTAssertEqual(r["reason"], "runtime")
        XCTAssertFalse(PlatformAvailability.current.appDistributor)
        #endif
    }

    func testDeadlineReturnsTheValueWhenItWins() async throws {
        let v = try await withPlatformDeadline(1) { 42 }
        XCTAssertEqual(v, 42)
        do {
            _ = try await withPlatformDeadline(0.05) { () async throws -> Int in
                try await Task.sleep(nanoseconds: 2_000_000_000)
                return 1
            }
            XCTFail("expected a timeout")
        } catch let t as PlatformTimeout {
            XCTAssertEqual(t.seconds, 0.05)
        }
    }
}

final class AppTransactionTests: XCTestCase {
    private let info = AppTransactionInfo(
        jws: "a.b.c", verified: true, environment: "Xcode", originalAppVersion: "14", appVersion: "1.4",
        bundleID: "gg.vlad.diceroll", appTransactionID: "0", originalPurchaseDate: 0)

    func testFieldsAndJWS() async {
        let r = await readAppTransaction(source: FakeAppTransaction(info: info))
        XCTAssertEqual(r["ok"], true)
        XCTAssertEqual(r["jws"], "a.b.c")
        XCTAssertEqual(r["environment"], "Xcode")
        XCTAssertEqual(r["appTransactionID"], "0")
        XCTAssertEqual(r["originalAppVersion"], "14")
        XCTAssertEqual(r["verified"], true)
        XCTAssertNotNil(r["ms"])
        let refreshed = await readAppTransaction(source: FakeAppTransaction(info: info), refresh: true)
        XCTAssertEqual(refreshed["appVersion"], "1.4-refreshed")
    }

    func testErrorAndTimeout() async {
        let e = await readAppTransaction(source: FakeAppTransaction(info: nil))
        XCTAssertEqual(e["ok"], false)
        XCTAssertNotNil(e["error"])
        let t = await readAppTransaction(source: FakeAppTransaction(info: info, hang: true), deadline: 0.05)
        XCTAssertEqual(t["error"], "timeout")
    }
}
