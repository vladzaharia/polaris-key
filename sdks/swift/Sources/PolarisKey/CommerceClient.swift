// `client.commerce` — store purchases become licence flags (P6-01, notes/SDK-PARITY-PASS.md §3.9).
//
// The store sells; the Worker verifies the purchase with the store and puts the mapped flag on
// the player's licence. The device only forwards what its store handed it.
//
//   binding()                       GET  /<p>/distribution/commerce/binding → the licence's opaque
//                                   purchase binding and the products on sale. Hand `bindingId`
//                                   to the store BEFORE buying (StoreKit's appAccountToken).
//   claim(store:payload:)           POST /<p>/distribution/commerce/claim. The primitive does not
//                                   sync (the commerce-claim transcript pins its traffic); call
//                                   client.sync() so the next licence document carries the flag.
//                                   The one-calls below sync for you.
//   claimAppStore / claimSteam /    the three store payloads, spelled out.
//     claimPlay
//   purchase(productID:)            the one call: binding → StoreKit purchase(appAccountToken:) →
//                                   claim → finish ONLY after the claim answered ok → sync.
//   restore()                       re-claim every current StoreKit entitlement, then sync.
//   startTransactionUpdates()       the Transaction.updates loop: renewals, Ask to Buy approvals
//                                   and purchases made on another device are claimed (and
//                                   finished after the claim) as they arrive.
//
// A refused or failed claim leaves the StoreKit transaction UNFINISHED, so StoreKit redelivers it
// and a later claim (the updates loop, or restore()) can retry. A claim refused with 403
// `attestation_required` attests once and retries once when this runtime can attest (§3.10).
// Refusals keep the server's code and `reason`: `not_entitled` + `no_license` (enrol first; the
// bridge never creates a licence), `forbidden` + `not_owned` / `binding_mismatch` /
// `bound_elsewhere` / `unbound`, `bad_request` + a store reason, `unavailable`, `not_found`.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

/// One store product the operator mapped to a licence flag.
public struct CommerceProduct: Sendable, Equatable, Codable {
    public let store: String
    public let productId: String
    public let flag: String
    public let deliverable: String?

    public init(store: String, productId: String, flag: String, deliverable: String? = nil) {
        self.store = store
        self.productId = productId
        self.flag = flag
        self.deliverable = deliverable
    }
}

/// `binding()`'s answer.
public struct CommerceBinding: Sendable, Equatable {
    /// The opaque purchase binding (a UUID): StoreKit's `appAccountToken`, Play's
    /// `obfuscatedAccountId`, the identity of a Steam web-API ticket.
    public let bindingId: String
    public let products: [CommerceProduct]
}

/// A granted claim.
public struct CommerceClaim: Sendable, Equatable {
    public let store: String
    public let productId: String
    public let flag: String
    public let deliverable: String?
    /// `active`, `revoked`, …
    public let state: String
    public let granted: Bool
    public let changed: Bool
}

/// How a claim ended (§3.9).
public enum ClaimResult: Sendable, Equatable {
    case ok(CommerceClaim)
    /// 403 `forbidden` with reason `not_owned`: the store does not report this account as the
    /// owner.
    case notOwned(code: String, reason: String)
    /// 403 `attestation_required`, after the one attest-and-retry (or where none can run).
    case attestationRequired
    /// Any other refusal: the server's code, status and `reason`.
    case refused(code: String, status: Int, reason: String?, message: String?)
    /// No usable answer: `network`, `server-error`, `invalid-response`, `local-only`, or a typed
    /// `service-unavailable` before any request.
    case error(code: String, message: String)

    public var isOK: Bool {
        if case .ok = self { return true }
        return false
    }

    /// The server's code (or the client's, for `.error`); `""` for `.ok`.
    public var code: String {
        switch self {
        case .ok: return ""
        case .notOwned(let code, _): return code
        case .attestationRequired: return ErrorCode.attestationRequired
        case .refused(let code, _, _, _), .error(let code, _): return code
        }
    }

    /// The refusal's `reason`, when the server gave one.
    public var reason: String? {
        switch self {
        case .notOwned(_, let reason): return reason
        case .refused(_, _, let reason, _): return reason
        default: return nil
        }
    }
}

/// How `purchase(productID:)` ended.
public enum CommercePurchaseResult: Sendable, Equatable {
    /// Bought, claimed, finished and synced: the licence now carries `claim.flag`.
    case claimed(CommerceClaim, transactionID: UInt64)
    /// The purchase waits on approval (Ask to Buy, SCA). The updates loop claims it later.
    case pending
    case userCancelled
    /// StoreKit sold it but the claim did not succeed; the transaction stays unfinished so it is
    /// redelivered and claimed later.
    case claimFailed(ClaimResult, transactionID: UInt64)
    /// The typed N/A: no StoreKit here (`runtime`), or the product does not run commerce
    /// (`product`).
    case unsupported(Unsupported)
    /// Nothing was bought: the binding failed, the product is not on sale, StoreKit threw, or the
    /// transaction failed StoreKit's verification.
    case failed(code: String, message: String)
}

public actor CommerceClient {
    public static let appStore = "app-store"
    public static let play = "play"
    public static let steam = "steam"

    private let core: CoreContext
    private let store: (any StoreClient)?
    private let onClaimed: @Sendable () async -> Void
    private var lastBinding: CommerceBinding?
    private var updatesTask: Task<Void, Never>?
    private var seenUpdates: Set<String> = []

    /// - Parameters:
    ///   - store: StoreKit behind its seam; nil where StoreKit is unavailable (purchase and
    ///     restore then answer the typed N/A, while binding and claim still work).
    ///   - onClaimed: the facade's forced sync after a granted claim.
    public init(
        core: CoreContext, store: (any StoreClient)?,
        onClaimed: @escaping @Sendable () async -> Void
    ) {
        self.core = core
        self.store = store is NoStoreKit ? nil : store
        self.onClaimed = onClaimed
    }

    /// The product list from the last successful `binding()` (empty until then).
    public var products: [CommerceProduct] { lastBinding?.products ?? [] }

    private func refusedByServices() async -> String? {
        for slug in [ServiceSlug.license, ServiceSlug.distribution] {
            do {
                try await core.requireService(slug, feature: Feature.commerceReceipt)
            } catch let e as PolarisError {
                return e.message
            } catch {
                return "\(error)"
            }
        }
        return nil
    }

    // ── The two routes ───────────────────────────────────────────────────────────────────
    /// `GET /<p>/distribution/commerce/binding`. Throws `PolarisError`: `service-unavailable`
    /// (no License or Distribution), `no-token`, the server's code, or `network`.
    public func binding() async throws -> CommerceBinding {
        try await core.requireService(.license, feature: Feature.commerceReceipt)
        try await core.requireService(.distribution, feature: Feature.commerceReceipt)
        guard let token = await core.token else {
            throw PolarisError(code: ErrorCode.noToken, message: "Activate or enrol before buying.")
        }
        let response: PolarisResponse
        do {
            response = try await core.request(
                core.endpoints.url("distribution/commerce/binding"),
                headers: ["authorization": "Bearer \(token)"])
        } catch let e as PolarisError where e.code == PolarisError.localOnly {
            throw e
        } catch {
            throw PolarisError(code: ErrorCode.network, message: "\(error)")
        }
        guard response.isOK else {
            let body = try? JSONDecoder().decode(ServerErrorBody.self, from: response.body)
            throw PolarisError(
                code: body?.code ?? ErrorCode.httpError,
                message: body?.message ?? "commerce binding failed with status \(response.status).",
                detail: body?.reason)
        }
        guard let b = try? JSONDecoder().decode(BindingBody.self, from: response.body),
            !b.bindingId.isEmpty
        else {
            throw PolarisError(
                code: ErrorCode.invalidResponse, message: "The binding answer has no bindingId.")
        }
        let binding = CommerceBinding(bindingId: b.bindingId, products: b.products ?? [])
        lastBinding = binding
        return binding
    }

    /// `POST /<p>/distribution/commerce/claim` with `{store, …payload}`. Never throws. Does not
    /// sync: call `client.sync()` afterwards (the one-calls do).
    public func claim(store: String, payload: [String: JSONValue]) async -> ClaimResult {
        if let why = await refusedByServices() {
            return .error(code: ErrorCode.serviceUnavailable, message: why)
        }
        var result = await postClaim(store: store, payload: payload)
        if case .attestationRequired = result, await core.attestForRetry() {
            result = await postClaim(store: store, payload: payload)
        }
        return result
    }

    /// Claim a StoreKit transaction by its signed JWS.
    public func claimAppStore(signedTransaction: String) async -> ClaimResult {
        await claim(store: Self.appStore, payload: ["signedTransaction": .string(signedTransaction)])
    }

    /// Claim a Steam DLC: the hex ticket from `GetAuthTicketForWebApi(bindingId)` and the DLC's
    /// app id. No Steamworks dependency: the host passes the ticket.
    public func claimSteam(ticketHex: String, dlcAppId: String) async -> ClaimResult {
        await claim(
            store: Self.steam,
            payload: ["ticket": .string(ticketHex), "dlcAppId": .string(dlcAppId)])
    }

    /// Claim a Google Play purchase (a JVM or bridged host).
    public func claimPlay(productId: String, purchaseToken: String) async -> ClaimResult {
        await claim(
            store: Self.play,
            payload: ["productId": .string(productId), "purchaseToken": .string(purchaseToken)])
    }

    private func postClaim(store: String, payload: [String: JSONValue]) async -> ClaimResult {
        guard let token = await core.token else {
            return .error(code: ErrorCode.noToken, message: "Activate or enrol before claiming.")
        }
        var body = payload
        body["store"] = .string(store)
        let data = (try? JSONEncoder().encode(JSONValue.object(body))) ?? Data("{}".utf8)
        let response: PolarisResponse
        do {
            response = try await core.request(
                core.endpoints.url("distribution/commerce/claim"), method: "POST",
                headers: ["authorization": "Bearer \(token)", "content-type": "application/json"],
                body: data)
        } catch let e as PolarisError where e.code == PolarisError.localOnly {
            return .error(code: e.code, message: e.message)
        } catch {
            return .error(code: ErrorCode.network, message: "\(error)")
        }
        return Self.mapClaim(response)
    }

    static func mapClaim(_ response: PolarisResponse) -> ClaimResult {
        if response.isOK {
            guard let b = try? JSONDecoder().decode(ClaimBody.self, from: response.body) else {
                return .error(
                    code: ErrorCode.invalidResponse, message: "The claim answer could not be read.")
            }
            return .ok(
                CommerceClaim(
                    store: b.store ?? "", productId: b.productId ?? "", flag: b.flag ?? "",
                    deliverable: b.deliverable, state: b.state ?? "active",
                    granted: b.granted ?? true, changed: b.changed ?? false))
        }
        let body = try? JSONDecoder().decode(ServerErrorBody.self, from: response.body)
        if response.status >= 500 {
            return .error(
                code: ErrorCode.serverError,
                message: body?.message ?? "the claim failed with status \(response.status).")
        }
        let code = body?.code ?? ErrorCode.httpError
        if code == ErrorCode.attestationRequired { return .attestationRequired }
        if code == ErrorCode.forbidden && body?.reason == "not_owned" {
            return .notOwned(code: code, reason: "not_owned")
        }
        return .refused(
            code: code, status: response.status, reason: body?.reason, message: body?.message)
    }

    // ── StoreKit one-calls ───────────────────────────────────────────────────────────────
    private func storeUnsupported() -> Unsupported {
        Unsupported(
            feature: Feature.commerceReceipt, reason: UnsupportedReason.runtime,
            detail: "StoreKit is not available here; claim purchases with claim(store:payload:).")
    }

    /// The App Store products on sale, as StoreKit shows them. Empty without StoreKit.
    public func storeProducts(_ ids: [String]? = nil) async -> [ProductInfo] {
        guard let store else { return [] }
        let wanted =
            ids
            ?? products.filter { $0.store == Self.appStore }.map(\.productId)
        guard !wanted.isEmpty else { return [] }
        return (try? await store.products(wanted)) ?? []
    }

    /// Buy `productID` on the App Store and turn it into a licence flag in one call.
    public func purchase(productID: String) async -> CommercePurchaseResult {
        guard let store else { return .unsupported(storeUnsupported()) }
        if let why = await refusedByServices() {
            return .unsupported(
                Unsupported(
                    feature: Feature.commerceReceipt, reason: UnsupportedReason.product,
                    detail: why))
        }
        let binding: CommerceBinding
        do {
            binding = try await self.binding()
        } catch let e as PolarisError {
            return .failed(code: e.code, message: e.message)
        } catch {
            return .failed(code: ErrorCode.network, message: "\(error)")
        }
        guard let token = UUID(uuidString: binding.bindingId) else {
            return .failed(
                code: ErrorCode.invalidResponse, message: "The binding is not a UUID.")
        }
        do {
            _ = try await store.products([productID])
            let outcome = try await store.purchase(productID: productID, appAccountToken: token)
            switch outcome {
            case .pending: return .pending
            case .userCancelled: return .userCancelled
            case .success(let t, _):
                seenUpdates.insert(Self.updateKey(t))
                guard t.verified else {
                    return .failed(
                        code: ErrorCode.platformError,
                        message: "StoreKit could not verify the transaction: \(t.verificationError ?? "unverified")")
                }
                let claimed = await claimAppStore(signedTransaction: t.jws)
                guard case .ok(let c) = claimed else {
                    return .claimFailed(claimed, transactionID: t.id)
                }
                // Finish ONLY after the server recorded the purchase (P5-05), then sync so the
                // licence document carries the flag.
                _ = await store.finish(transactionID: t.id)
                await onClaimed()
                return .claimed(c, transactionID: t.id)
            }
        } catch let e as ProductNotLoaded {
            return .failed(
                code: ErrorCode.notFound, message: "\(e.productID) is not on sale in this storefront.")
        } catch {
            return .failed(code: ErrorCode.platformError, message: "\(error)")
        }
    }

    /// Re-claim every current, verified StoreKit entitlement (a reinstall, a new device), then
    /// sync. The typed N/A without StoreKit.
    public func restore() async -> Result<[ClaimResult], UnsupportedError> {
        guard let store else { return .failure(UnsupportedError(storeUnsupported())) }
        var results: [ClaimResult] = []
        for t in await store.currentEntitlements(productID: nil) where t.verified && !t.revoked {
            let r = await claimAppStore(signedTransaction: t.jws)
            if r.isOK { _ = await store.finish(transactionID: t.id) }
            results.append(r)
        }
        if results.contains(where: \.isOK) { await onClaimed() }
        return .success(results)
    }

    /// Start the `Transaction.updates` loop (idempotent): each new verified, unrevoked transaction
    /// is claimed and finished after the claim; a revocation triggers a sync (the Worker learns of
    /// refunds from Apple's notifications). `onResult` sees every claim the loop makes.
    public func startTransactionUpdates(
        onResult: (@Sendable (TransactionInfo, ClaimResult) -> Void)? = nil
    ) {
        guard let store, updatesTask == nil else { return }
        let stream = store.updates()
        updatesTask = Task { [weak self] in
            for await t in stream {
                guard let self else { return }
                await self.handleUpdate(t, store: store, onResult: onResult)
            }
        }
    }

    public func stopTransactionUpdates() {
        updatesTask?.cancel()
        updatesTask = nil
    }

    public var listening: Bool { updatesTask != nil }

    private func handleUpdate(
        _ t: TransactionInfo, store: any StoreClient,
        onResult: (@Sendable (TransactionInfo, ClaimResult) -> Void)?
    ) async {
        guard seenUpdates.insert(Self.updateKey(t)).inserted else { return }
        if t.revoked {
            await onClaimed()
            return
        }
        guard t.verified else { return }
        let r = await claimAppStore(signedTransaction: t.jws)
        if r.isOK {
            _ = await store.finish(transactionID: t.id)
            await onClaimed()
        }
        onResult?(t, r)
    }

    private static func updateKey(_ t: TransactionInfo) -> String { "\(t.id):\(t.revoked)" }
}

private struct BindingBody: Decodable {
    let bindingId: String
    let products: [CommerceProduct]?
}

private struct ClaimBody: Decodable {
    let store: String?
    let productId: String?
    let flag: String?
    let deliverable: String?
    let state: String?
    let granted: Bool?
    let changed: Bool?
}

/// Pass as `PolarisKeyClientOptions.storeClient` to run commerce without StoreKit (a build sold
/// elsewhere, or a test): `purchase` and `restore` then answer the typed N/A.
public struct NoStoreKit: StoreClient {
    public init() {}
    public func products(_ ids: [String]) async throws -> [ProductInfo] { [] }
    @MainActor public func purchase(productID: String, appAccountToken: UUID?) async throws
        -> PurchaseOutcome
    { .pending }
    public func currentEntitlements(productID: String?) async -> [TransactionInfo] { [] }
    public func updates() -> AsyncStream<TransactionInfo> { AsyncStream { $0.finish() } }
    public func finish(transactionID: UInt64) async -> Bool { false }
}

/// The StoreKit client this build uses by default: StoreKit 2 where it is importable.
func defaultStoreClient() -> (any StoreClient)? {
    #if canImport(StoreKit)
        return SystemStoreClient()
    #else
        return nil
    #endif
}
