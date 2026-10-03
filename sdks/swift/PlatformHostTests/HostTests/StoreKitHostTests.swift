// PolarisKeyPlatform against REAL StoreKit (StoreKit Testing in Xcode, environment `Xcode`), the
// real Keychain and the real AppDistributor, in a unit-test bundle hosted by an app with
// get-task-allow (see project.yml for why nothing less works).
//
// Each StoreKit test asserts the product count first: a misconfigured session loads nothing and
// fails silently otherwise (S-09). Xcode-environment JWS are signed by a per-session self-signed
// certificate (`kid Apple_Xcode_Key`, one `x5c` entry): fit for P6-01's parsing, not its chain
// validation.

import Foundation
import PolarisKeyPlatform
import StoreKit
import StoreKitTest
import XCTest

private let foes = "dev.polariskey.platformhost.pack.foes"
private let gems = "dev.polariskey.platformhost.gems100"
private let token = UUID(uuidString: "6F2C3B1A-0000-4000-8000-00000000C0DE")!

/// Collects a sink's events.
private final class Events: Sendable {
    private let lock = PlatformLock<[PlatformObject]>([])

    init(_ sink: PlatformEventSink) { sink.setObserver { [lock] e in lock.withLock { $0.append(e) } } }

    var all: [PlatformObject] { lock.withLock { $0 } }

    func wait(_ timeout: Double = 15, until predicate: @escaping ([PlatformObject]) -> Bool) async -> [PlatformObject] {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if predicate(all) { return all }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return all
    }

    func result(_ req: PlatformJSON?) async -> PlatformObject {
        await wait { $0.contains { $0["req"] == req } }.first { $0["req"] == req } ?? [:]
    }
}

final class StoreKitHostTests: XCTestCase {
    private var session: SKTestSession?

    /// `Transaction.unfinished`'s count, polled for up to 5 s until it equals `want`.
    private func unfinishedCount(becomes want: Int) async -> Int {
        var count = -1
        for _ in 0..<50 {
            count = 0
            for await _ in Transaction.unfinished { count += 1 }
            if count == want { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return count
    }

    override func setUpWithError() throws {
        let url = try XCTUnwrap(Bundle(for: StoreKitHostTests.self).url(forResource: "Products", withExtension: "storekit"))
        let s = try SKTestSession(contentsOf: url)
        s.disableDialogs = true
        s.clearTransactions()
        s.resetToDefaultState()
        s.disableDialogs = true
        session = s
    }

    private func loadedProducts(_ store: StoreService) async throws -> [PlatformJSON] {
        let r = await store.products([foes, gems, "missing.id"])
        guard case .array(let ps)? = r["products"] else {
            XCTFail("products failed: \(r)")
            return []
        }
        XCTAssertEqual(ps.count, 2, "StoreKit Testing loaded \(ps.count) products: is the host app missing get-task-allow?")
        return ps
    }

    func testProductsLoad() async throws {
        let store = StoreService(client: SystemStoreClient(), sink: PlatformEventSink())
        let ps = try await loadedProducts(store)
        let ids = ps.compactMap { p -> String? in if case .object(let o) = p { return o["id"]?.stringValue }; return nil }
        XCTAssertEqual(Set(ids), [foes, gems])
    }

    func testPurchaseFinishRefundAndDeduplication() async throws {
        let sink = PlatformEventSink()
        let events = Events(sink)
        let store = StoreService(client: SystemStoreClient(), sink: sink)
        await store.startListener()
        _ = try await loadedProducts(store)

        let bought = await store.purchase(productID: foes, appAccountToken: token)
        XCTAssertEqual(bought["result"], "success", "\(bought)")
        guard case .object(let t)? = bought["transaction"], let idText = t["id"]?.stringValue, let id = UInt64(idText) else {
            return XCTFail("no transaction: \(bought)")
        }
        XCTAssertEqual(t["environment"], "Xcode")
        XCTAssertEqual(t["verified"], true)
        XCTAssertEqual(t["appAccountToken"], .string(token.uuidString.lowercased()))
        XCTAssertEqual(t["jws"]?.stringValue?.split(separator: ".").count, 3)

        // Not finished until the host says the server has recorded it. `Transaction.unfinished`
        // lags a purchase by about a second (S-09 §Results 1c), so it is polled.
        let before = await unfinishedCount(becomes: 1)
        XCTAssertEqual(before, 1)
        let finished = await store.finish(transactionID: id)
        XCTAssertEqual(finished["finished"], true)
        let after = await unfinishedCount(becomes: 0)
        XCTAssertEqual(after, 0)

        // A refund: Transaction.updates re-delivers the purchase, then the revoked copy. Only
        // the revoked copy is reported.
        try XCTUnwrap(session).refundTransaction(identifier: UInt(id))
        let seen = await events.wait { $0.contains { $0["ev"] == "transaction_updated" && $0["revoked"] == true } }
        try? await Task.sleep(nanoseconds: 500_000_000)
        let updates = events.all.filter { $0["ev"] == "transaction_updated" && $0["id"] == .string(idText) }
        XCTAssertEqual(updates.map { $0["revoked"] }, [true], "\(seen)")
    }

    func testConsumableThroughTheJSONRouter() async throws {
        let host = PlatformHost(services: .system())
        let events = Events(host.sink)
        let ack = decodePlatformJSON(host.call(#"{"op":"products","ids":["\#(gems)"]}"#)) ?? [:]
        let products = await events.result(ack["req"])
        guard case .array(let ps)? = products["products"] else { return XCTFail("\(products)") }
        XCTAssertEqual(ps.count, 1)
        let buy = decodePlatformJSON(host.call(#"{"op":"purchase","product":"\#(gems)","appAccountToken":"\#(token.uuidString)"}"#)) ?? [:]
        let bought = await events.result(buy["req"])
        XCTAssertEqual(bought["result"], "success", "\(bought)")
        XCTAssertEqual(bought["ev"], "purchase")
    }

    func testAppTransaction() async throws {
        let r = await readAppTransaction(source: SystemAppTransaction())
        XCTAssertEqual(r["ok"], true, "\(r)")
        XCTAssertEqual(r["environment"], "Xcode")
        XCTAssertEqual(r["verified"], true)
        XCTAssertEqual(r["originalAppVersion"], "14", "StoreKit Testing reports CFBundleVersion, not 1.0")
    }
}

final class KeychainHostTests: XCTestCase {
    func testRoundTripInTheDataProtectionKeychain() {
        let store = SecureStore(product: "platformhost-test")
        _ = store.delete(account: "device")
        XCTAssertEqual(store.get(account: "device"), ["ok": true, "value": .null])
        XCTAssertEqual(store.set(account: "device", value: "d-1"), ["ok": true, "op": "add"])
        XCTAssertEqual(store.set(account: "device", value: "d-2"), ["ok": true, "op": "update"])
        XCTAssertEqual(store.get(account: "device"), ["ok": true, "value": "d-2"])

        // The stored item's class is AfterFirstUnlockThisDeviceOnly, in no shared access group.
        var item: CFTypeRef?
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "pkey:platformhost-test",
            kSecAttrAccount as String: "device", kSecUseDataProtectionKeychain as String: true,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        XCTAssertEqual(SecItemCopyMatching(q as CFDictionary, &item), errSecSuccess)
        let attrs = item as? [String: Any]
        XCTAssertEqual(attrs?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(store.delete(account: "device"), ["ok": true])
    }
}

final class DistributorHostTests: XCTestCase {
    func testTheSimulatorNeverAnswersSoTheDeadlineDoes() async {
        // AppDistributor.current never resolves on the simulator (S-06, S-09): the read must still
        // come back at the deadline, as `unavailable`.
        let start = Date()
        let r = await readDistributor(deadline: 1)
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
        XCTAssertNotNil(r["signal"])
        if r["signal"] == "unavailable" { XCTAssertNotNil(r["reason"]) }
        XCTAssertEqual(r["provisioned"], false, "simulator builds carry no embedded.mobileprovision")
        XCTAssertEqual(r["bundleIdentifier"], "dev.polariskey.platformhost")
    }
}
