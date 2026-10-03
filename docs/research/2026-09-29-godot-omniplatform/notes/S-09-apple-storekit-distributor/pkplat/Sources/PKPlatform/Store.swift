import Foundation
import StoreKit
#if canImport(UIKit)
    import UIKit
#endif

// MARK: - AppTransaction (commerce only; outlet detection never calls it)

public func readAppTransaction(refresh: Bool = false, deadline: Double = 10) async -> JSONObject {
    let t0 = Date()
    do {
        let r = try await withDeadline(deadline) {
            refresh ? try await AppTransaction.refresh() : try await AppTransaction.shared
        }
        var o: JSONObject = ["ok": true, "jws": .string(r.jwsRepresentation)]
        let t: AppTransaction
        switch r {
        case .verified(let v):
            t = v
            o["verified"] = true
        case .unverified(let v, let e):
            t = v
            o["verified"] = false
            o["verification_error"] = .string("\(e)")
        }
        o["environment"] = .string(t.environment.rawValue)
        o["originalAppVersion"] = .string(t.originalAppVersion)
        o["appVersion"] = .string(t.appVersion)
        o["bundleID"] = .string(t.bundleID)
        o["appTransactionID"] = .string(t.appTransactionID)  // back-deployed before 18.4
        o["originalPurchaseDate"] = .double(t.originalPurchaseDate.timeIntervalSince1970)
        o["ms"] = .int(Int(Date().timeIntervalSince(t0) * 1000))
        return o
    } catch {
        return ["ok": false, "error": .string("\(error)"), "ms": .int(Int(Date().timeIntervalSince(t0) * 1000))]
    }
}

// MARK: - StoreKit 2

public func describe(_ r: VerificationResult<Transaction>) -> JSONObject {
    var o: JSONObject = ["jws": .string(r.jwsRepresentation)]
    let t: Transaction
    switch r {
    case .verified(let v):
        t = v
        o["verified"] = true
    case .unverified(let v, let e):
        t = v
        o["verified"] = false
        o["verification_error"] = .string("\(e)")
    }
    o["id"] = .string(String(t.id))
    o["originalID"] = .string(String(t.originalID))
    o["productID"] = .string(t.productID)
    o["environment"] = .string(t.environment.rawValue)
    o["appAccountToken"] = t.appAccountToken.map { .string($0.uuidString) } ?? .null
    o["revoked"] = .bool(t.revocationDate != nil)
    o["revocationReason"] = t.revocationReason.map { .int($0.rawValue) } ?? .null
    o["ownershipType"] = .string(t.ownershipType.rawValue)
    return o
}

/// Products are cached in an actor; `Product` is Sendable.
public actor StoreService {
    public static let shared = StoreService()
    private var products: [String: Product] = [:]
    private var listener: Task<Void, Never>?
    /// Unfinished transactions by id, kept until the host says the server has recorded them.
    private var pending: [UInt64: Transaction] = [:]

    public func load(_ ids: [String]) async throws -> JSONObject {
        let ps = try await Product.products(for: ids)
        for p in ps { products[p.id] = p }
        return [
            "products": .array(
                ps.map {
                    .object([
                        "id": .string($0.id), "type": .string($0.type.rawValue),
                        "displayPrice": .string($0.displayPrice), "displayName": .string($0.displayName),
                    ])
                })
        ]
    }

    public func product(_ id: String) -> Product? { products[id] }

    func keep(_ r: VerificationResult<Transaction>) {
        if case .verified(let t) = r { pending[t.id] = t }
    }

    /// `finish()` only after the server has recorded the transaction (P5-05 design note).
    public func finish(_ id: UInt64) async -> Bool {
        if let t = pending.removeValue(forKey: id) {
            await t.finish()
            return true
        }
        for await r in Transaction.unfinished {
            if case .verified(let t) = r, t.id == id {
                await t.finish()
                return true
            }
        }
        return false
    }

    public func entitlements() async -> JSONObject {
        var a: [JSONValue] = []
        for await r in Transaction.currentEntitlements { a.append(.object(describe(r))) }
        return ["entitlements": .array(a)]
    }

    public func startListener() {
        guard listener == nil else { return }
        listener = Task.detached {
            for await r in Transaction.updates {
                await StoreService.shared.keep(r)
                var o = describe(r)
                o["ev"] = "transaction_updated"
                EventSink.shared.emit(o)
            }
        }
    }
}

/// Purchase is main-actor isolated in StoreKit (`Product.purchase(options:)` and
/// `purchase(confirmIn: some UIScene, ...)` are `@MainActor`), so the entry point is too.
@MainActor
public func purchase(productID: String, appAccountToken: UUID?) async -> JSONObject {
    guard let p = await StoreService.shared.product(productID) else {
        return ["ok": false, "error": "product not loaded"]
    }
    var opts: Set<Product.PurchaseOption> = []
    if let tok = appAccountToken { opts.insert(.appAccountToken(tok)) }
    do {
        let result: Product.PurchaseResult
        var confirmIn = "none"
        #if os(iOS)
            if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) {
                confirmIn = "scene"
                result = try await p.purchase(confirmIn: scene, options: opts)
            } else {
                result = try await p.purchase(options: opts)
            }
        #else
            result = try await p.purchase(options: opts)
        #endif
        switch result {
        case .success(let r):
            await StoreService.shared.keep(r)
            var o = describe(r)
            o["ok"] = true
            o["result"] = "success"
            o["confirm_in"] = .string(confirmIn)
            return o
        case .pending: return ["ok": true, "result": "pending"]
        case .userCancelled: return ["ok": true, "result": "userCancelled"]
        @unknown default: return ["ok": false, "result": "unknown"]
        }
    } catch {
        return ["ok": false, "error": .string("\(error)")]
    }
}
