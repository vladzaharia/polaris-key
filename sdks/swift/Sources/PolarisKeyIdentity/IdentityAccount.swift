// The account on this device (WIRE-CONTRACT-V4 §12.3, §12.6): `subject()`, `signOut()`,
// `openAccount()` and `attach(confirm:)`. Mirrors `@polaris-key/node`'s `identity/account.ts`.
//
// Every call reads the endpoint it needs from discovery's Identity fragment
// (`ProductDiscoveryDocument.identity`, loaded on first use) and never builds a URL. A product
// whose fragment names no such endpoint answers the typed unsupported result
// (`UnsupportedError`, reason `product`); a product that does not run Identity answers
// `service-unavailable`. An endpoint on another origin or product is refused rather than
// followed: the device token goes only to the Worker that issued it.
//
// A refusal of `attach` is a typed result, never a thrown auth failure, and it keeps the token,
// the cache and the identity.

import Foundation
import PolarisKeyCore

#if os(macOS)
    import AppKit
#elseif canImport(UIKit) && !os(watchOS)
    import UIKit
#endif

/// The licence an `attach(confirm: false)` preview names.
public struct AttachLicense: Sendable, Equatable {
    public let id: String
    public let tierId: String?
    public let name: String?

    public init(id: String, tierId: String? = nil, name: String? = nil) {
        self.id = id
        self.tierId = tierId
        self.name = name
    }
}

/// What `attach(confirm:)` answered.
public enum AttachResult: Sendable, Equatable {
    /// `confirm: false`: the device's own licence, written nowhere.
    case confirm(license: AttachLicense)
    /// `confirm: true`: the licence is in the signed-in account, the token rotated and stored.
    /// `attached` is `claimed` when this call put it there, nil when it already was. The caller
    /// syncs, as after `activate`.
    case ok(subject: String?, attached: String?)
    /// The Worker refused (`account_required`, `license_owned`, `license_email_bound`,
    /// `unauthorized`, `not_found`, …). Nothing local changed.
    case refused(code: String, status: Int)
}

/// What `signOut()` answered. `released` is true when the sign-in had bound this device to a
/// licence of the account: the device is deauthorized and the local credential is gone. When
/// false the device keeps its token (it is still activated by key); only the subject is
/// forgotten.
public struct SignOutResult: Sendable, Equatable {
    public let released: Bool

    public init(released: Bool) { self.released = released }
}

/// How `openAccount()` opens a URL. Defaults to the system (`NSWorkspace` / `UIApplication`).
public typealias AccountURLOpener = @Sendable (URL) async -> Bool

private let defaultAccountOpener: AccountURLOpener = { url in
    await MainActor.run {
        #if os(macOS)
            return NSWorkspace.shared.open(url)
        #elseif canImport(UIKit) && !os(watchOS)
            UIApplication.shared.open(url)
            return true
        #else
            return false
        #endif
    }
}

extension IdentityClient {
    /// `GET identity/subject`: the account this device's licence is in, or nil (a key-only
    /// device). The answer is held for `account`.
    public func subject() async throws -> String? {
        let url = try await accountEndpoint("subject") { $0.subject }
        let response = try await withBearer(url, method: "GET")
        guard response.status == 200 else { throw refusal(response) }
        let value = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?
            .objectValue?["subject"]?.stringValue
        subjectValue.set(value)
        return value
    }

    /// The subject held from the last `subject()` or `attach`; nil for a device with no account.
    public var account: String? { subjectValue.current }

    /// Sign out of the account: the pre-sign-out hooks (`onBeforeSignOut`), then
    /// `POST identity/signout`. On `released: true` the local credential is wiped as after a
    /// deactivation and the `license` event follows; on `released: false` the device keeps its
    /// token and only the subject is forgotten.
    @discardableResult
    public func signOut() async throws -> SignOutResult {
        let url = try await accountEndpoint("signout") { $0.signout }
        for hook in beforeSignOut.current.map(\.hook) { try await hook() }
        let response = try await withBearer(url, method: "POST")
        guard response.status == 200 else { throw refusal(response) }
        guard
            let released = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?
                .objectValue?["released"]?.boolValue
        else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "sign-out answered without `released`.")
        }
        subjectValue.set(nil)
        if released {
            if let wipe = signOutHook.current { try await wipe() } else { try await core.clearAll() }
        }
        return SignOutResult(released: released)
    }

    /// Register a function `signOut()` awaits first (Cloud Sync's flush). A hook that throws
    /// stops the sign-out. Returns the remover.
    @discardableResult
    public func onBeforeSignOut(_ hook: @escaping @Sendable () async throws -> Void)
        -> @Sendable () -> Void
    {
        let id = beforeSignOut.with { hooks -> Int in
            let id = (hooks.last?.id ?? 0) + 1
            hooks.append(SignOutHook(id: id, hook: hook))
            return id
        }
        return { [beforeSignOut] in beforeSignOut.with { $0.removeAll { $0.id == id } } }
    }

    /// Open the product's page in the customer portal (discovery's `accountPortal`). Throws the
    /// typed unsupported result when the product names none or the platform cannot open a URL.
    public func openAccount(opener: AccountURLOpener? = nil) async throws {
        let url = try await accountEndpoint("accountPortal", scoped: false) { $0.accountPortal }
        guard url.scheme == "https" || url.scheme == "http" else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the account portal is not a web URL.")
        }
        guard await (opener ?? defaultAccountOpener)(url) else {
            throw UnsupportedError(
                Unsupported(
                    feature: Feature.identityAccount, reason: UnsupportedReason.runtime,
                    detail: "this platform cannot open the account portal."))
        }
    }

    /// `POST identity/attach`. `confirm: false` previews the device's licence and writes
    /// nothing; `confirm: true` puts it in the signed-in account, rotates and stores the token.
    /// A refusal is a typed result that keeps every piece of state.
    public func attach(confirm: Bool) async throws -> AttachResult {
        let url = try await accountEndpoint("attach") { $0.attach }
        let body = try JSONEncoder().encode(JSONValue.object(["confirm": .bool(confirm)]))
        let response = try await withBearer(
            url, method: "POST", headers: ["content-type": "application/json"], body: body)
        let json = try? JSONDecoder().decode(JSONValue.self, from: response.body)
        guard response.status == 200 else {
            return .refused(
                code: refusalCode(response) ?? "http_\(response.status)", status: response.status)
        }
        let object = json?.objectValue ?? [:]
        if object["status"]?.stringValue == "confirm" {
            let l = object["license"]?.objectValue ?? [:]
            return .confirm(
                license: AttachLicense(
                    id: l["id"]?.stringValue ?? "", tierId: l["tierId"]?.stringValue,
                    name: l["name"]?.stringValue))
        }
        guard let token = object["token"]?.stringValue, !token.isEmpty else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "attach answered without a token.")
        }
        try await core.setToken(token, source: .activate)
        let subject = object["subject"]?.stringValue
        subjectValue.set(subject)
        return .ok(subject: subject, attached: object["attached"]?.stringValue == "claimed" ? "claimed" : nil)
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    /// One endpoint of the Identity fragment, as an absolute URL on this product.
    private func accountEndpoint(
        _ name: String, scoped: Bool = true, _ pick: (IdentityDiscovery) -> String?
    ) async throws -> URL {
        // Discovery is the authority for Identity: load it once, then gate on what it says.
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityAccount)
        guard let raw = await core.discoveryDocument?.identity.flatMap(pick) else {
            throw UnsupportedError(
                Unsupported(
                    feature: Feature.identityAccount, reason: UnsupportedReason.product,
                    detail: "the product's discovery names no identity \(name) endpoint."))
        }
        let prefix = core.endpoints.url("").absoluteString
        // The portal is a page the person opens, not a call that carries the token.
        guard let url = URL(string: raw), !scoped || raw.hasPrefix(prefix) else {
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "an identity endpoint points outside this product.")
        }
        return url
    }

    private func withBearer(
        _ url: URL, method: String, headers: [String: String] = [:], body: Data? = nil
    ) async throws -> PolarisResponse {
        guard let token = await core.token else {
            throw PolarisError(
                code: ErrorCode.noToken, message: "Activate or sign in before using the account.")
        }
        var all = headers
        all["authorization"] = "Bearer \(token)"
        do {
            return try await core.request(url, method: method, headers: all, body: body)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "\(error)")
        }
    }

    private func refusalCode(_ response: PolarisResponse) -> String? {
        guard let object = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue
        else { return nil }
        return object["error"]?.objectValue?["code"]?.stringValue ?? object["error"]?.stringValue
    }

    private func refusal(_ response: PolarisResponse) -> PolarisError {
        PolarisError(
            code: refusalCode(response) ?? "http_\(response.status)",
            message: "the account call was refused (status \(response.status)).")
    }
}

struct SignOutHook: Sendable {
    let id: Int
    let hook: @Sendable () async throws -> Void
}
