import Foundation
import XCTest

@testable import PolarisKeyPlatform

final class StoreTests: XCTestCase {
    private let catalog = [
        ProductInfo(id: "pack.foes", type: "Non-Consumable", displayName: "Foes pack", displayPrice: "$4.99", price: "4.99"),
        ProductInfo(id: "gems100", type: "Consumable", displayName: "Gems", displayPrice: "$0.99", price: "0.99"),
    ]
    private let token = UUID(uuidString: "6F2C3B1A-0000-4000-8000-00000000C0DE")!

    func testProductsReportsOnlyKnownIDs() async {
        let sink = PlatformEventSink()
        let s = StoreService(client: FakeStoreClient(catalog: catalog), sink: sink)
        let r = await s.products(["pack.foes", "gems100", "missing.id"])
        guard case .array(let ps)? = r["products"] else { return XCTFail("no products") }
        XCTAssertEqual(ps.count, 2)
        XCTAssertEqual(ps.first, .object(["id": "pack.foes", "type": "Non-Consumable", "displayName": "Foes pack", "displayPrice": "$4.99", "price": "4.99"]))
    }

    func testPurchaseRunsOnTheMainActorAndCarriesTheJWS() async {
        let client = FakeStoreClient(catalog: catalog)
        let s = StoreService(client: client, sink: PlatformEventSink())
        _ = await s.products(["pack.foes"])
        client.willPurchase(.success(transaction(7), confirmIn: "scene"))
        let r = await s.purchase(productID: "pack.foes", appAccountToken: token)
        XCTAssertEqual(r["result"], "success")
        XCTAssertEqual(r["confirmIn"], "scene")
        guard case .object(let t)? = r["transaction"] else { return XCTFail("no transaction") }
        XCTAssertEqual(t["id"], "7", "ids are strings")
        XCTAssertEqual(t["jws"], "eyJhbGciOiJFUzI1NiJ9.7.sig")
        XCTAssertEqual(t["appAccountToken"], "6f2c3b1a-0000-4000-8000-00000000c0de")
        XCTAssertEqual(client.purchaseOnMainThread, true)
    }

    func testPurchaseOfAnUnloadedProductAndTheOtherOutcomes() async {
        let client = FakeStoreClient(catalog: catalog)
        let s = StoreService(client: client, sink: PlatformEventSink())
        let r = await s.purchase(productID: "pack.foes", appAccountToken: nil)
        XCTAssertEqual(r["ok"], false)
        XCTAssertEqual(r["error"], "product_not_loaded")
        _ = await s.products(["pack.foes"])
        client.willPurchase(.pending)
        let pending = await s.purchase(productID: "pack.foes", appAccountToken: nil)
        XCTAssertEqual(pending["result"], "pending")
        client.willPurchase(.userCancelled)
        let cancelled = await s.purchase(productID: "pack.foes", appAccountToken: nil)
        XCTAssertEqual(cancelled["result"], "userCancelled")
    }

    func testUpdatesAreDeduplicatedByTransactionAndRevocation() async {
        let sink = PlatformEventSink()
        let log = EventLog(sink)
        let client = FakeStoreClient(catalog: catalog)
        let s = StoreService(client: client, sink: sink)
        await s.startListener()
        await s.startListener()  // idempotent
        _ = await s.products(["pack.foes"])
        client.willPurchase(.success(transaction(7), confirmIn: "default"))
        _ = await s.purchase(productID: "pack.foes", appAccountToken: token)

        // Transaction.updates re-delivers the purchase (S-09): not reported again.
        client.deliver(transaction(7))
        // A purchase made elsewhere (another device, Ask to Buy): reported once.
        client.deliver(transaction(8))
        client.deliver(transaction(8))
        // The refund's revoked copy of 7: reported once.
        client.deliver(transaction(7, revoked: true))
        client.deliver(transaction(7, revoked: true))

        let events = await log.wait { $0.filter { $0["ev"] == "transaction_updated" }.count >= 2 }
        try? await Task.sleep(nanoseconds: 100_000_000)
        let updates = log.named("transaction_updated")
        XCTAssertEqual(updates.count, 2, "\(events)")
        XCTAssertEqual(updates.map { $0["id"] }, ["8", "7"])
        XCTAssertEqual(updates.map { $0["revoked"] }, [false, true])
        XCTAssertEqual(updates.last?["jws"], "eyJhbGciOiJFUzI1NiJ9.7.revoked")
    }

    func testFinishIsOnlyWhatTheHostAsksFor() async {
        let client = FakeStoreClient(catalog: catalog)
        let s = StoreService(client: client, sink: PlatformEventSink())
        _ = await s.products(["pack.foes"])
        client.willPurchase(.success(transaction(7), confirmIn: "default"))
        _ = await s.purchase(productID: "pack.foes", appAccountToken: token)
        XCTAssertEqual(client.finished, [], "a purchase is never finished before the server records it")
        let r = await s.finish(transactionID: 7)
        XCTAssertEqual(r["finished"], true)
        let again = await s.finish(transactionID: 7)
        XCTAssertEqual(again["finished"], false)
        XCTAssertEqual(client.finished, [7])
    }

    func testEntitlementsFilterByProduct() async {
        let client = FakeStoreClient(catalog: catalog)
        client.setEntitlements([transaction(1, product: "pack.foes"), transaction(2, product: "pack.bosses")])
        let s = StoreService(client: client, sink: PlatformEventSink())
        let all = await s.entitlements(productID: nil)
        guard case .array(let a)? = all["entitlements"] else { return XCTFail() }
        XCTAssertEqual(a.count, 2)
        let one = await s.entitlements(productID: "pack.bosses")
        guard case .array(let b)? = one["entitlements"], case .object(let t)? = b.first else { return XCTFail() }
        XCTAssertEqual(b.count, 1)
        XCTAssertEqual(t["id"], "2")
    }
}
