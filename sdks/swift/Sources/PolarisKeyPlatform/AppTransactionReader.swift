// AppTransaction, for COMMERCE only (P6-01 verifies its JWS server-side). Outlet detection never
// calls it: it throws when the user is not signed in to the App Store, may need the network, and
// under StoreKit Testing reports `Xcode` (notes/S-06 §§1–2, S-09 §Results 2).
//
// Only fields in the iOS 18.5 SDK are read, so CI's Xcode 16.4 compiles this file:
// `storeType`, `AppTransaction.all` and `revocationDate` are iOS 27 SDK symbols; read them from
// the JWS on the server instead. TestFlight and the sandbox report `originalAppVersion` as `1.0`,
// and StoreKit Testing as `CFBundleVersion` (S-09), so do not use it there.

import Foundation

#if canImport(StoreKit)
import StoreKit
#endif

/// One AppTransaction, decoded.
public struct AppTransactionInfo: Sendable, Equatable {
    public var jws: String
    public var verified: Bool
    public var verificationError: String?
    public var environment: String
    public var originalAppVersion: String
    public var appVersion: String
    public var bundleID: String
    public var appTransactionID: String
    public var originalPurchaseDate: Double

    public init(
        jws: String, verified: Bool, verificationError: String? = nil, environment: String,
        originalAppVersion: String, appVersion: String, bundleID: String, appTransactionID: String,
        originalPurchaseDate: Double
    ) {
        self.jws = jws
        self.verified = verified
        self.verificationError = verificationError
        self.environment = environment
        self.originalAppVersion = originalAppVersion
        self.appVersion = appVersion
        self.bundleID = bundleID
        self.appTransactionID = appTransactionID
        self.originalPurchaseDate = originalPurchaseDate
    }

    var json: PlatformObject {
        [
            "jws": .string(jws), "verified": .bool(verified),
            "verificationError": verificationError.map(PlatformJSON.string) ?? .null,
            "environment": .string(environment), "originalAppVersion": .string(originalAppVersion),
            "appVersion": .string(appVersion), "bundleID": .string(bundleID),
            "appTransactionID": .string(appTransactionID),
            "originalPurchaseDate": .double(originalPurchaseDate),
        ]
    }
}

/// Where the AppTransaction comes from (a fake in tests).
public protocol AppTransactionSource: Sendable {
    func read(refresh: Bool) async throws -> AppTransactionInfo
}

#if canImport(StoreKit)
/// StoreKit's `AppTransaction.shared` / `refresh()`.
public struct SystemAppTransaction: AppTransactionSource {
    public init() {}

    public func read(refresh: Bool) async throws -> AppTransactionInfo {
        let r = refresh ? try await AppTransaction.refresh() : try await AppTransaction.shared
        let t: AppTransaction
        var info = AppTransactionInfo(
            jws: r.jwsRepresentation, verified: true, environment: "", originalAppVersion: "",
            appVersion: "", bundleID: "", appTransactionID: "", originalPurchaseDate: 0)
        switch r {
        case .verified(let v):
            t = v
        case .unverified(let v, let e):
            t = v
            info.verified = false
            info.verificationError = "\(e)"
        }
        info.environment = t.environment.rawValue
        info.originalAppVersion = t.originalAppVersion
        info.appVersion = t.appVersion
        info.bundleID = t.bundleID
        info.appTransactionID = t.appTransactionID  // back-deployed before iOS 18.4
        info.originalPurchaseDate = t.originalPurchaseDate.timeIntervalSince1970
        return info
    }
}
#endif

/// The `app_transaction` op: `{ok, ms, …AppTransactionInfo}` or `{ok:false, error, ms}`.
public func readAppTransaction(
    source: any AppTransactionSource, refresh: Bool = false, deadline: Double = 10
) async -> PlatformObject {
    let start = Date()
    do {
        let info = try await withPlatformDeadline(deadline) { try await source.read(refresh: refresh) }
        var out = info.json
        out["ok"] = true
        out["ms"] = .int(elapsedMs(since: start))
        return out
    } catch is PlatformTimeout {
        return ["ok": false, "error": "timeout", "ms": .int(elapsedMs(since: start))]
    } catch {
        return ["ok": false, "error": .string("\(error)"), "ms": .int(elapsedMs(since: start))]
    }
}
