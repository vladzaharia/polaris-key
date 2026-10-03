// StoreKit 2: products, purchase, entitlements, the Transaction.updates listener and finish().
// Every transaction result carries its signed JWS for P6-01's server-side verification.
//
// The rules (notes/S-09 §Recommendation 4):
//
//   - `purchase` is main-actor isolated, as StoreKit's `Product.purchase(options:)` and
//     `purchase(confirmIn: some UIScene, options:)` are. The C entry point is synchronous and
//     nonisolated, so it reaches the main actor through `await` from a detached task; it never
//     calls `MainActor.assumeIsolated` (which traps on any thread but the main one).
//   - `finish()` is called only on the host's `finish` op, after the server has recorded the
//     purchase. The verified `Transaction` from `purchase()` is kept until then.
//   - The `Transaction.updates` listener starts at launch and is DEDUPLICATED by transaction id
//     and revocation state: updates re-deliver the purchase `purchase()` already returned, then
//     deliver a revoked copy after a refund.
//   - A purchase is confirmed by its own result, never by re-reading `currentEntitlements`: right
//     after `.success` it stays empty for about a second (S-09 §Results 1c).
//   - `Transaction.currentEntitlements(for:)` is iOS 18.4 / macOS 15.4 (and the Xcode 16.3 SDK);
//     below that the full list is filtered.
//   - The `appAccountToken` is the value P6-01 issues. The JWS spells it in lower case and
//     `UUID.uuidString` in upper case; results carry the lower-case form, and P6-01 compares
//     UUIDs, not strings.

import Foundation

#if canImport(StoreKit)
import StoreKit
#endif
#if os(iOS) && canImport(UIKit)
import UIKit
#endif

/// A product, as the host shows it.
public struct ProductInfo: Sendable, Equatable {
    public var id: String
    public var type: String
    public var displayName: String
    public var displayPrice: String
    /// The price as a decimal string (`4.99`), never a binary float.
    public var price: String

    public init(id: String, type: String, displayName: String, displayPrice: String, price: String) {
        self.id = id
        self.type = type
        self.displayName = displayName
        self.displayPrice = displayPrice
        self.price = price
    }

    var json: PlatformJSON {
        .object([
            "id": .string(id), "type": .string(type), "displayName": .string(displayName),
            "displayPrice": .string(displayPrice), "price": .string(price),
        ])
    }
}

/// A transaction, decoded, with its signed JWS.
public struct TransactionInfo: Sendable, Equatable {
    public var id: UInt64
    public var originalID: UInt64
    public var productID: String
    public var environment: String
    public var appAccountToken: String?
    public var revoked: Bool
    public var revocationReason: Int?
    public var ownershipType: String
    public var purchaseDate: Double
    public var verified: Bool
    public var verificationError: String?
    public var jws: String

    public init(
        id: UInt64, originalID: UInt64, productID: String, environment: String, appAccountToken: String? = nil,
        revoked: Bool = false, revocationReason: Int? = nil, ownershipType: String = "PURCHASED",
        purchaseDate: Double = 0, verified: Bool = true, verificationError: String? = nil, jws: String
    ) {
        self.id = id
        self.originalID = originalID
        self.productID = productID
        self.environment = environment
        self.appAccountToken = appAccountToken
        self.revoked = revoked
        self.revocationReason = revocationReason
        self.ownershipType = ownershipType
        self.purchaseDate = purchaseDate
        self.verified = verified
        self.verificationError = verificationError
        self.jws = jws
    }

    /// Ids are strings: a UInt64 does not survive a JSON number in every host (Godot parses JSON
    /// numbers as doubles).
    var json: PlatformObject {
        [
            "id": .string(String(id)), "originalID": .string(String(originalID)),
            "productID": .string(productID), "environment": .string(environment),
            "appAccountToken": appAccountToken.map(PlatformJSON.string) ?? .null,
            "revoked": .bool(revoked), "revocationReason": revocationReason.map(PlatformJSON.int) ?? .null,
            "ownershipType": .string(ownershipType), "purchaseDate": .double(purchaseDate),
            "verified": .bool(verified),
            "verificationError": verificationError.map(PlatformJSON.string) ?? .null,
            "jws": .string(jws),
        ]
    }

    /// The deduplication key of the updates listener.
    var updateKey: String { "\(id):\(revoked)" }
}

/// What a purchase ended as.
public enum PurchaseOutcome: Sendable, Equatable {
    /// `confirmIn` says how the sheet was presented: `scene` (iOS, the foreground-active window
    /// scene) or `default`.
    case success(TransactionInfo, confirmIn: String)
    case pending
    case userCancelled
}

/// StoreKit behind a seam (a fake in `swift test`, where StoreKit Testing loads no products).
public protocol StoreClient: Sendable {
    func products(_ ids: [String]) async throws -> [ProductInfo]
    /// Main-actor isolated, as StoreKit's purchase is.
    @MainActor func purchase(productID: String, appAccountToken: UUID?) async throws -> PurchaseOutcome
    func currentEntitlements(productID: String?) async -> [TransactionInfo]
    /// `Transaction.updates`, from now until the stream is dropped.
    func updates() -> AsyncStream<TransactionInfo>
    /// Finish the transaction; false when it is not known or already finished.
    func finish(transactionID: UInt64) async -> Bool
}

/// Thrown by `StoreClient.purchase` for a product `products(_:)` has not loaded.
public struct ProductNotLoaded: Error, Sendable, Equatable {
    public let productID: String
}

/// The store module: the client, the listener and its deduplication.
public actor StoreService {
    private let client: any StoreClient
    private let sink: PlatformEventSink
    private var seen: Set<String> = []
    private var listener: Task<Void, Never>?

    public init(client: any StoreClient, sink: PlatformEventSink) {
        self.client = client
        self.sink = sink
    }

    /// Start the `Transaction.updates` listener (idempotent). Each NEW transaction state is
    /// emitted once as `{"ev":"transaction_updated", …TransactionInfo}`.
    public func startListener() {
        guard listener == nil else { return }
        let stream = client.updates()
        listener = Task { [weak self] in
            for await t in stream {
                guard let self else { return }
                await self.deliver(t)
            }
        }
    }

    public var listening: Bool { listener != nil }

    private func deliver(_ t: TransactionInfo) {
        guard seen.insert(t.updateKey).inserted else { return }
        var event = t.json
        event["ev"] = "transaction_updated"
        sink.emit(event)
    }

    public func products(_ ids: [String]) async -> PlatformObject {
        do {
            let found = try await client.products(ids)
            return ["ok": true, "products": .array(found.map(\.json))]
        } catch {
            return ["ok": false, "error": .string("\(error)")]
        }
    }

    public func purchase(productID: String, appAccountToken: UUID?) async -> PlatformObject {
        do {
            switch try await client.purchase(productID: productID, appAccountToken: appAccountToken) {
            case .success(let t, let confirmIn):
                // The listener will see this purchase again; it is already reported here.
                seen.insert(t.updateKey)
                return ["ok": true, "result": "success", "confirmIn": .string(confirmIn), "transaction": .object(t.json)]
            case .pending:
                return ["ok": true, "result": "pending"]
            case .userCancelled:
                return ["ok": true, "result": "userCancelled"]
            }
        } catch let e as ProductNotLoaded {
            return ["ok": false, "error": "product_not_loaded", "product": .string(e.productID)]
        } catch {
            return ["ok": false, "error": .string("\(error)")]
        }
    }

    public func entitlements(productID: String?) async -> PlatformObject {
        let list = await client.currentEntitlements(productID: productID)
        return ["ok": true, "entitlements": .array(list.map { .object($0.json) })]
    }

    public func finish(transactionID: UInt64) async -> PlatformObject {
        ["ok": true, "finished": .bool(await client.finish(transactionID: transactionID))]
    }
}

#if canImport(StoreKit)
/// Loaded products and the verified, unfinished transactions kept for `finish`.
private actor StoreKitState {
    var products: [String: Product] = [:]
    var pending: [UInt64: Transaction] = [:]

    func add(_ ps: [Product]) { for p in ps { products[p.id] = p } }
    func product(_ id: String) -> Product? { products[id] }
    func keep(_ t: Transaction) { pending[t.id] = t }
    func take(_ id: UInt64) -> Transaction? { pending.removeValue(forKey: id) }
}

/// StoreKit 2.
public struct SystemStoreClient: StoreClient {
    private let state = StoreKitState()
    private let availability: PlatformAvailability

    public init(availability: PlatformAvailability = .current) { self.availability = availability }

    public func products(_ ids: [String]) async throws -> [ProductInfo] {
        let found = try await Product.products(for: ids)
        await state.add(found)
        return found.map {
            ProductInfo(
                id: $0.id, type: $0.type.rawValue, displayName: $0.displayName, displayPrice: $0.displayPrice,
                price: "\($0.price)")
        }
    }

    @MainActor
    public func purchase(productID: String, appAccountToken: UUID?) async throws -> PurchaseOutcome {
        guard let product = await state.product(productID) else { throw ProductNotLoaded(productID: productID) }
        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken { options.insert(.appAccountToken(token)) }
        let result: Product.PurchaseResult
        var confirmIn = "default"
        #if os(iOS) && canImport(UIKit)
        if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) {
            confirmIn = "scene"
            result = try await product.purchase(confirmIn: scene, options: options)
        } else {
            result = try await product.purchase(options: options)
        }
        #else
        result = try await product.purchase(options: options)
        #endif
        switch result {
        case .success(let r):
            if case .verified(let t) = r { await state.keep(t) }
            return .success(Self.describe(r), confirmIn: confirmIn)
        case .pending:
            return .pending
        case .userCancelled:
            return .userCancelled
        @unknown default:
            return .pending
        }
    }

    public func currentEntitlements(productID: String?) async -> [TransactionInfo] {
        var out: [TransactionInfo] = []
        #if compiler(>=6.1)
        if let productID, availability.entitlementsForID, #available(iOS 18.4, macOS 15.4, *) {
            for await r in Transaction.currentEntitlements(for: productID) { out.append(Self.describe(r)) }
            return out
        }
        #endif
        for await r in Transaction.currentEntitlements {
            let t = Self.describe(r)
            if productID == nil || t.productID == productID { out.append(t) }
        }
        return out
    }

    public func updates() -> AsyncStream<TransactionInfo> {
        let state = self.state
        return AsyncStream { continuation in
            let task = Task.detached {
                for await r in Transaction.updates {
                    if case .verified(let t) = r, t.revocationDate == nil { await state.keep(t) }
                    continuation.yield(Self.describe(r))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func finish(transactionID: UInt64) async -> Bool {
        if let t = await state.take(transactionID) {
            await t.finish()
            return true
        }
        for await r in Transaction.unfinished {
            if case .verified(let t) = r, t.id == transactionID {
                await t.finish()
                return true
            }
        }
        return false
    }

    static func describe(_ r: VerificationResult<Transaction>) -> TransactionInfo {
        let t: Transaction
        var verified = true
        var verificationError: String?
        switch r {
        case .verified(let v):
            t = v
        case .unverified(let v, let e):
            t = v
            verified = false
            verificationError = "\(e)"
        }
        return TransactionInfo(
            id: t.id, originalID: t.originalID, productID: t.productID, environment: t.environment.rawValue,
            appAccountToken: t.appAccountToken?.uuidString.lowercased(), revoked: t.revocationDate != nil,
            revocationReason: t.revocationReason?.rawValue, ownershipType: t.ownershipType.rawValue,
            purchaseDate: t.purchaseDate.timeIntervalSince1970, verified: verified,
            verificationError: verificationError, jws: r.jwsRepresentation)
    }
}
#endif
