// @pkey-feature commerce.receipt
//
// `client.commerce` (P6-01, notes/SDK-PARITY-PASS.md §3.9) against a fake StoreKit and a stub
// Worker: binding → purchase(appAccountToken: bindingId) → claim → finish only after the claim →
// sync; a refused claim leaves the transaction unfinished; restore re-claims; the updates loop
// claims new transactions once; the typed N/A without StoreKit.

import Foundation
@testable import PolarisKey
import PolarisKeyCore
import PolarisKeyPlatform
import XCTest

final class FakeStore: StoreClient, @unchecked Sendable {
    private let lock = NSLock()
    var outcome: PurchaseOutcome
    var entitlements: [TransactionInfo] = []
    private(set) var finished: [UInt64] = []
    private(set) var tokens: [UUID?] = []
    private var continuation: AsyncStream<TransactionInfo>.Continuation?
    private var stream: AsyncStream<TransactionInfo>!

    init(outcome: PurchaseOutcome) {
        self.outcome = outcome
        self.stream = AsyncStream { self.continuation = $0 }
    }

    func products(_ ids: [String]) async throws -> [ProductInfo] {
        ids.map { ProductInfo(id: $0, type: "nonConsumable", displayName: $0, displayPrice: "$1", price: "1") }
    }
    @MainActor func purchase(productID: String, appAccountToken: UUID?) async throws -> PurchaseOutcome {
        lock.withLock { tokens.append(appAccountToken) }
        return outcome
    }
    func currentEntitlements(productID: String?) async -> [TransactionInfo] { entitlements }
    func updates() -> AsyncStream<TransactionInfo> { stream }
    func finish(transactionID: UInt64) async -> Bool {
        lock.withLock { finished.append(transactionID) }
        return true
    }
    func deliver(_ t: TransactionInfo) { continuation?.yield(t) }
}

private let bindingId = "f8606ae6-c6af-419a-a7ca-125107444036"

private func tx(_ id: UInt64, revoked: Bool = false) -> TransactionInfo {
    TransactionInfo(
        id: id, originalID: id, productID: "pro", environment: "Sandbox",
        appAccountToken: bindingId, revoked: revoked, jws: "jws-\(id)")
}

final class CommerceTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client(store: FakeStore?, claimStatus: Int = 200) async throws -> PolarisKeyClient {
        await server.reply(
            "/djdl/distribution/commerce/binding",
            body: #"{"bindingId":"\#(bindingId)","products":[{"store":"app-store","productId":"pro","flag":"extras.pro","deliverable":"app"}]}"#)
        await server.reply(
            "/djdl/distribution/commerce/claim", status: claimStatus,
            body: claimStatus == 200
                ? #"{"ok":true,"store":"app-store","productId":"pro","flag":"extras.pro","deliverable":"app","state":"active","granted":true,"changed":true}"#
                : #"{"error":{"code":"forbidden"},"reason":"binding_mismatch"}"#)
        let s = InMemoryStore(deviceId: "dev")
        await s.setToken("pkeyt_dev")
        var options = PolarisKeyClientOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            pinnedKeys: [:], trustRefresh: false, store: s, transport: server.transport,
            expectedServices: [.license, .distribution], fingerprint: false,
            storeClient: store)
        if store == nil {
            options = PolarisKeyClientOptions(
                core: options.core, license: options.license, config: options.config,
                storeClient: NoStoreKit())
        }
        return try await PolarisKeyClient.create(options: options)
    }

    func testPurchaseClaimsThenFinishesThenSyncs() async throws {
        let store = FakeStore(outcome: .success(tx(7), confirmIn: "default"))
        let c = try await client(store: store)
        let r = await c.commerce.purchase(productID: "pro")
        guard case .claimed(let claim, let id) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(claim.flag, "extras.pro")
        XCTAssertEqual(id, 7)
        XCTAssertEqual(store.tokens, [UUID(uuidString: bindingId)])
        XCTAssertEqual(store.finished, [7])
        let claimBody = await server.requests(forPath: "/djdl/distribution/commerce/claim").first?.body
        let json = try JSONDecoder().decode([String: String].self, from: claimBody ?? Data())
        XCTAssertEqual(json, ["store": "app-store", "signedTransaction": "jws-7"])
        // The forced sync after the claim fetched the licence document.
        let docs = await server.requests(forPath: "/djdl/license/document")
        XCTAssertFalse(docs.isEmpty)
    }

    func testARefusedClaimLeavesTheTransactionUnfinished() async throws {
        let store = FakeStore(outcome: .success(tx(8), confirmIn: "default"))
        let c = try await client(store: store, claimStatus: 403)
        let r = await c.commerce.purchase(productID: "pro")
        guard case .claimFailed(let claim, let id) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(claim.code, "forbidden")
        XCTAssertEqual(claim.reason, "binding_mismatch")
        XCTAssertEqual(id, 8)
        XCTAssertTrue(store.finished.isEmpty)
    }

    func testPendingAndCancelled() async throws {
        let c = try await client(store: FakeStore(outcome: .pending))
        let pending = await c.commerce.purchase(productID: "pro")
        XCTAssertEqual(pending, .pending)
        let c2 = try await client(store: FakeStore(outcome: .userCancelled))
        let cancelled = await c2.commerce.purchase(productID: "pro")
        XCTAssertEqual(cancelled, .userCancelled)
    }

    func testRestoreReclaimsCurrentEntitlements() async throws {
        let store = FakeStore(outcome: .pending)
        store.entitlements = [tx(1), tx(2, revoked: true)]
        let c = try await client(store: store)
        let results = try await c.commerce.restore().get()
        XCTAssertEqual(results.count, 1)
        XCTAssertTrue(results[0].isOK)
        XCTAssertEqual(store.finished, [1])
    }

    func testTheUpdatesLoopClaimsEachTransactionOnce() async throws {
        let store = FakeStore(outcome: .pending)
        let c = try await client(store: store)
        let seen = LockedValue<[UInt64]>([])
        let done = expectation(description: "claimed")
        await c.commerce.startTransactionUpdates { t, r in
            XCTAssertTrue(r.isOK)
            seen.with { $0.append(t.id) }
            done.fulfill()
        }
        store.deliver(tx(9))
        store.deliver(tx(9))
        await fulfillment(of: [done], timeout: 5)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(seen.current, [9])
        XCTAssertEqual(store.finished, [9])
        await c.commerce.stopTransactionUpdates()
    }

    func testWithoutStoreKitPurchaseIsTypedUnsupported() async throws {
        let c = try await client(store: nil)
        guard case .unsupported(let u) = await c.commerce.purchase(productID: "pro") else {
            return XCTFail("expected unsupported")
        }
        XCTAssertEqual(u.feature, Feature.commerceReceipt)
        XCTAssertEqual(u.reason, UnsupportedReason.runtime)
        // Binding and claim still work: they are plain HTTP.
        let binding = try await c.commerce.binding()
        XCTAssertEqual(binding.bindingId, bindingId)
        let steam = await c.commerce.claimSteam(ticketHex: "ab", dlcAppId: "1")
        XCTAssertTrue(steam.isOK)
    }

    func testClaimMapping() {
        func map(_ status: Int, _ body: String) -> ClaimResult {
            CommerceClient.mapClaim(PolarisResponse(status: status, body: Data(body.utf8)))
        }
        XCTAssertEqual(
            map(403, #"{"error":{"code":"forbidden"},"reason":"not_owned"}"#),
            .notOwned(code: "forbidden", reason: "not_owned"))
        XCTAssertEqual(map(403, #"{"error":"attestation_required"}"#), .attestationRequired)
        XCTAssertEqual(
            map(403, #"{"error":"not_entitled","reason":"no_license"}"#),
            .refused(code: "not_entitled", status: 403, reason: "no_license", message: nil))
        XCTAssertEqual(map(503, "").code, ErrorCode.serverError)
    }
}

