import Foundation
import StoreKit
import StoreKitTest
import XCTest

import PKPlatform

/// Prints one tagged line per observation so the run log can be grepped: `S09 <label> <json>`.
func s09(_ label: String, _ o: JSONObject) {
    print("S09 \(label) \(encodeJSON(o))")
}

func fooID() -> String { "dev.polariskey.research.pack.foes" }

@MainActor
final class StoreKitProbeTests: XCTestCase {
    var session: SKTestSession!

    override func setUp() async throws {
        let url = try XCTUnwrap(Bundle(for: StoreKitProbeTests.self).url(forResource: "Products", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.disableDialogs = true
        session.clearTransactions()
        session.resetToDefaultState()
        session.disableDialogs = true
    }

    func test1_products() async throws {
        let o = try await StoreService.shared.load([fooID(), "dev.polariskey.research.gems100", "missing.id"])
        s09("products", o)
        guard case .array(let a)? = o["products"] else { return XCTFail("no products") }
        XCTAssertEqual(a.count, 2)
    }

    func test2_appTransaction() async throws {
        let o = await readAppTransaction()
        s09("app_transaction", o)
        let r = await readAppTransaction(refresh: true)
        s09("app_transaction_refresh", r)
    }

    func test3_purchaseRefund() async throws {
        _ = try await StoreService.shared.load([fooID()])
        await StoreService.shared.startListener()
        let token = UUID(uuidString: "6F2C3B1A-0000-4000-8000-00000000C0DE")!
        let t0 = Date()
        let p = await purchase(productID: fooID(), appAccountToken: token)
        s09("purchase", p.merging(["ms": .int(Int(Date().timeIntervalSince(t0) * 1000))]) { $1 })
        XCTAssertEqual(p["result"], "success")
        XCTAssertEqual(p["appAccountToken"], .string(token.uuidString))

        let e1 = await StoreService.shared.entitlements()
        s09("entitlements_after_purchase", e1)

        // Unfinished until the host finishes it (P6-01 finishes after the server records it).
        var unfinished = 0
        for await _ in Transaction.unfinished { unfinished += 1 }
        s09("unfinished_before_finish", ["count": .int(unfinished)])

        guard case .string(let idStr)? = p["id"], let id = UInt64(idStr) else { return XCTFail("id") }
        let finished = await StoreService.shared.finish(id)
        unfinished = 0
        for await _ in Transaction.unfinished { unfinished += 1 }
        s09("unfinished_after_finish", ["finished": .bool(finished), "count": .int(unfinished)])

        // Refund through the test session; Transaction.updates should deliver the revoked copy.
        _ = EventSink.shared.drainRecorded()
        try session.refundTransaction(identifier: UInt(id))
        let deadline = Date().addingTimeInterval(10)
        var events: [String] = []
        while Date() < deadline {
            events += EventSink.shared.drainRecorded()
            if events.contains(where: { $0.contains("\"revoked\":true") }) { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        for e in events { print("S09 refund_event \(e)") }
        let e2 = await StoreService.shared.entitlements()
        s09("entitlements_after_refund", e2)
        let latest = await Transaction.latest(for: fooID())
        if let latest { s09("latest_after_refund", describe(latest)) }
        s09("session_transactions", ["all": .array(session.allTransactions().map { .string("\($0.identifier) \($0.productIdentifier) state=\($0.state.rawValue)") })])
    }

    func test4_consumableAndCSurface() async throws {
        // Through the C surface, as a host would: products, purchase, then events.
        _ = EventSink.shared.drainRecorded()
        let r1 = pkp_roundtrip(#"{"op":"products","ids":["dev.polariskey.research.gems100"]}"#)
        let r2 = pkp_roundtrip(#"{"op":"ping"}"#)
        s09("c_products_ack", r1)
        s09("c_ping", r2)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let r3 = pkp_roundtrip(#"{"op":"purchase","product":"dev.polariskey.research.gems100","appAccountToken":"6F2C3B1A-0000-4000-8000-00000000C0DE"}"#)
        s09("c_purchase_ack", r3)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        for e in EventSink.shared.drainRecorded() { print("S09 c_event \(e)") }
    }

    func test5_distributor() async throws {
        let o = await readDistributor(deadline: 5)
        s09("distributor_in_test_host", o)
        let r = await readEligibilityRegion(deadline: 5)
        s09("eligibility_region_in_test_host", r)
    }

    func test6_keychain() async throws {
        let s = SecureStore.set(service: "pkey:probe", account: "token", value: "t1", accessible: "afterFirstUnlockThisDeviceOnly", group: nil)
        s09("kc_set_test_host", s)
        s09("kc_get_test_host", SecureStore.get(service: "pkey:probe", account: "token", group: nil))
        s09("kc_delete_test_host", SecureStore.delete(service: "pkey:probe", account: "token", group: nil))
    }
}

func pkp_roundtrip(_ s: String) -> JSONObject {
    let p = s.withCString { pkp_call($0) }
    defer { pkp_free(p) }
    return decodeJSON(String(cString: p)) ?? [:]
}

@MainActor
final class EntitlementTimingTests: XCTestCase {
    func testEntitlementsAfterPurchase() async throws {
        let url = try XCTUnwrap(Bundle(for: EntitlementTimingTests.self).url(forResource: "Products", withExtension: "storekit"))
        let session = try SKTestSession(contentsOf: url)
        session.disableDialogs = true
        session.clearTransactions()
        _ = try await StoreService.shared.load([fooID()])
        let p = await purchase(productID: fooID(), appAccountToken: nil)
        s09("t_purchase", ["result": p["result"] ?? .null, "id": p["id"] ?? .null])
        let t0 = Date()
        for i in 0..<20 {
            var ents = 0, unfinished = 0, all = 0
            for await _ in Transaction.currentEntitlements { ents += 1 }
            for await _ in Transaction.unfinished { unfinished += 1 }
            for await _ in Transaction.all { all += 1 }
            let cur = await Transaction.latest(for: fooID()) != nil
            s09("t_poll", ["i": .int(i), "ms": .int(Int(Date().timeIntervalSince(t0) * 1000)), "currentEntitlements": .int(ents), "unfinished": .int(unfinished), "all": .int(all), "latestFor": .bool(cur)])
            if ents > 0 { break }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
    }
}
