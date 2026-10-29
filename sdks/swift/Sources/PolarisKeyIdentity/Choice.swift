// `client.identity.choice`: the licence choice in the app, over a pending sign-in grant
// (WIRE-CONTRACT-V4 §12.4.1, §12.5.1; plans/I-04.md §G). Mirrors the other SDKs' `identity.choice`.
//
//   let session = try await client.identity.signIn.start(
//       SignInOptions(channel: .redirect, redirectUri: "https://app.example/cb", licenseChoice: .app))
//   // ... the browser lands on the callback ...
//   guard case .chooseLicense(let pending) = try await session.complete(callbackUrl: url) else { ... }
//   let view = try await client.identity.choice.licenses(grant: pending.grant)
//   let devices = try await client.identity.choice.devices(grant: pending.grant, licenseId: id)
//   let done = try await client.identity.choice.complete(
//       grant: pending.grant, choice: .license(id: id, replaceDeviceId: devices.devices.first?.id))
//
// Each call reads its endpoint from discovery's Identity fragment and never builds one. A product
// that publishes no `choice*` routes answers the typed unsupported result (reason `product`; a
// sign-in then runs in card mode). The grant is a credential: it travels in a body, never a URL,
// and prints as `[redacted]`. `complete` stores the device token like any sign-in. A refusal is a
// typed `ChoiceError` and changes nothing local; the grant stays open unless the Worker says it
// is gone (`invalid_grant`).

import Foundation
import PolarisKeyCore

/// Who shows the licence choice (§12.4): the hosted card, or the app over `identity.choice`.
public enum LicenseChoiceMode: String, Sendable, Equatable {
    case card
    case app
}

/// A device count against a limit; `limit` is nil when the licence has none.
public struct ChoiceSeats: Sendable, Equatable, Codable {
    public let used: Int
    public let limit: Int?
}

/// Whether Replace is offered on a full licence, and when to retry after a recent one.
public struct ChoiceReplaceAllowance: Sendable, Equatable, Codable {
    public let allowed: Bool
    public let retryAfter: Int?
}

/// One licence row of the choice view. Display data: it authorises nothing.
public struct LicenseChoice: Sendable, Equatable, Codable, Identifiable {
    public let id: String
    public let tierName: String
    public let name: String?
    /// `purchase`, `store`, `key`, `free`, `developer` or `signin`.
    public let origin: String
    /// `seats` or `account`.
    public let access: String
    public let seats: ChoiceSeats
    /// The licence this device runs on.
    public let current: Bool
    public let expiresAt: Int?
    /// `free`, `full` or `blocked`.
    public let state: String
    public let blockedReason: String?
    /// On a full row: whether Replace is offered. Nil on a row that is not full.
    public let replace: ChoiceReplaceAllowance?
    public let freeDeviceUrl: String?
}

/// The explicit "create a new licence" row.
public struct LicenseCreateOffer: Sendable, Equatable, Codable {
    public let tierName: String
    public let access: String
}

/// The no-licence state: where to add a key or get one.
public struct GetLicenseOffer: Sendable, Equatable, Codable {
    public let activateUrl: String?
    public let purchaseUrl: String?
    public let keyEntry: Bool
}

/// `POST choice/licenses`, and `choices` of the `choose` token answer.
public struct LicenseChoiceView: Sendable, Equatable, Codable {
    /// `choose`, `autoIssue` or `none`.
    public let state: String
    public let choices: [LicenseChoice]
    /// True only when the device runs on a usable licence that is not in `choices`.
    public let keep: Bool
    /// A licence id, `keep`, `create`, or nil.
    public let preselected: String?
    public let create: LicenseCreateOffer?
    public let getLicense: GetLicenseOffer?

    static func read(_ value: JSONValue?) -> LicenseChoiceView? {
        guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(LicenseChoiceView.self, from: data)
    }
}

/// One device using a licence, as Replace lists it.
public struct ReplaceDevice: Sendable, Equatable, Codable, Identifiable {
    public let id: String
    public let label: String?
    public let platform: String?
    public let deviceType: String?
    public let lastSeen: Int
    public let leastRecent: Bool
    public let activeNow: Bool
    public let thisBrowser: Bool
}

/// `POST choice/devices`: the devices a full licence's seats are used by.
public struct ReplaceView: Sendable, Equatable, Codable {
    public let licenseId: String
    public let seats: ChoiceSeats
    public let devices: [ReplaceDevice]
    public let replace: ChoiceReplaceAllowance
}

/// What the person chose (`choice/complete`). `key` is the no-licence state's "Use a license key
/// instead": it counts as a key entry and then binds.
public enum LicenseChoiceInput: Sendable, Equatable {
    case license(id: String, replaceDeviceId: String? = nil)
    case keep
    case create
    case key(String)

    var wire: JSONValue {
        switch self {
        case .license(let id, let replace):
            var o: [String: JSONValue] = ["kind": .string("license"), "licenseId": .string(id)]
            if let replace { o["replaceDeviceId"] = .string(replace) }
            return .object(o)
        case .keep: return .object(["kind": .string("keep")])
        case .create: return .object(["kind": .string("create")])
        case .key(let key): return .object(["kind": .string("key"), "key": .string(key)])
        }
    }
}

/// What the person consented to on the exchange's consent screen (`consent` of `choice/complete`,
/// WIRE-CONTRACT-V5 §12.11.3 rule 2): the claims they agreed to share. Required on a grant that
/// was issued with `confirm`; the Worker refuses its absence with `bad_request` and leaves the
/// grant open.
public struct ChoiceConsent: Sendable, Equatable {
    public let claims: [String]

    public init(claims: [String]) { self.claims = claims }

    var wire: JSONValue { .object(["claims": .array(claims.map(JSONValue.string))]) }
}

/// A redeemed redirect code that needs a licence choice (`license_choice=app`, §12.5.1): the
/// grant (300 s, bound to this device) and the first view. Printing shows the grant `[redacted]`.
public struct PendingSignIn: Sendable, Equatable {
    public let grant: String
    /// Seconds the grant lives, as the Worker advertised.
    public let expiresIn: Int
    /// When the grant lapses on this client's clock (epoch seconds).
    public let expiresAt: Int
    public let view: LicenseChoiceView
}

extension PendingSignIn: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        "PendingSignIn(grant: \(redactedCredential), expiresIn: \(expiresIn), view: \(view.state))"
    }
    public var debugDescription: String { description }
}

/// What `choice.complete` answered: the device is signed in on the chosen licence.
public struct ChoiceCompletion: Sendable, Equatable {
    public let ready: SignInReady
    /// The licence's key-entry count after a key was entered.
    public let keyEntries: KeyEntries?
    /// After `keep`: this device holds an anonymous licence the account could take over.
    public let attachable: Bool?
}

/// A grant route the Worker refused: `invalid_grant` (unknown, expired, consumed, other device),
/// `license_choice_required` and `device_limit` (both with a fresh `view`), `not_found`,
/// `rate_limited` (`retryAfterSeconds`), `license_owned` (`signInUrl`), `key_entry_limit`
/// (`keyEntries`, `manageUrl`), or the Worker's own code.
public struct ChoiceError: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: String
    public let status: Int
    public let message: String
    public let retryAfterSeconds: Int?
    /// The choice to draw again, on `device_limit` and `license_choice_required`.
    public let view: LicenseChoiceView?
    public let manageUrl: String?
    public let signInUrl: String?
    public let keyEntries: KeyEntries?

    public var description: String { "ChoiceError(\(code)): \(message)" }
}

/// `client.identity.choice`.
public struct ChoiceNamespace: Sendable {
    let client: IdentityClient

    /// Read the licences the grant's view offers, fresh (30 reads per grant).
    public func licenses(grant: String) async throws -> LicenseChoiceView {
        let (url, _) = try await client.choiceUrl("choiceLicenses") { $0.choiceLicenses }
        let response = try await client.choicePost(url, ["grant": .string(try Self.checked(grant))])
        guard response.status == 200 else { throw client.choiceRefusal(response) }
        guard let view = LicenseChoiceView.read(client.choiceBody(response)) else {
            throw Self.badResponse("choice/licenses answered without a licence view.")
        }
        return view
    }

    /// The devices using one licence of the grant's view, for Replace. A licence outside the view
    /// is one `not_found`, whatever the id is.
    public func devices(grant: String, licenseId: String) async throws -> ReplaceView {
        let (url, _) = try await client.choiceUrl("choiceDevices") { $0.choiceDevices }
        let response = try await client.choicePost(
            url, ["grant": .string(try Self.checked(grant)), "licenseId": .string(licenseId)])
        guard response.status == 200 else { throw client.choiceRefusal(response) }
        guard let body = client.choiceBody(response),
            let data = try? JSONEncoder().encode(body),
            let view = try? JSONDecoder().decode(ReplaceView.self, from: data)
        else { throw Self.badResponse("choice/devices answered without a device list.") }
        return view
    }

    /// Finish the sign-in with the person's choice. On success the device token is stored and the
    /// post-acquisition sync has run, exactly as after a sign-in; the grant is consumed. A nil
    /// `choice` sends none, which the Worker refuses with `license_choice_required` (fresh `view`).
    public func complete(grant: String, choice: LicenseChoiceInput?) async throws -> ChoiceCompletion {
        try await complete(grant: grant, choice: choice, consent: nil)
    }

    /// As above, with the person's `consent` to an exchange `confirm` (`PendingConsent`).
    public func complete(
        grant: String, choice: LicenseChoiceInput?, consent: ChoiceConsent?
    ) async throws -> ChoiceCompletion {
        let (url, _) = try await client.choiceUrl("choiceComplete") { $0.choiceComplete }
        var request: [String: JSONValue] = ["grant": .string(try Self.checked(grant))]
        if let choice { request["choice"] = choice.wire }
        if let consent { request["consent"] = consent.wire }
        // `keep` is proven by the device's own token (the Worker reads it as held); every other
        // choice is made on the grant alone.
        var held: String?
        if choice == .keep { held = await client.core.token }
        let response = try await client.choicePost(url, request, bearer: held)
        guard response.status == 200 else { throw client.choiceRefusal(response) }
        let body = client.choiceBody(response)
        guard
            case .token(let accessToken, let scope, let subject, _, _, let license) =
                IdentityRedirect.parseTokenAnswer(status: 200, body: body)
        else { throw Self.badResponse("choice/complete answered without a sign-in.") }
        let previous = client.holdSubjectFirst(subject)
        do { try await client.core.setToken(accessToken, source: .signin, person: true) } catch {
            client.restoreSubject(previous, ifHeld: subject)
            throw error
        }
        await client.platformSessionCompleted(grant: grant)
        if client.redirectAcquisitionSync.current { await client.onAcquired?() }
        client.announceSubject(subject, previous: previous)
        client.notifyIdentity(IdentityChange(kind: IdentityChange.signedIn, subject: subject))
        let object = body?.objectValue ?? [:]
        let wire = (try? JSONEncoder().encode(object["keyEntries"] ?? .null))
            .flatMap { try? JSONDecoder().decode(KeyEntries.Wire.self, from: $0) }
        return ChoiceCompletion(
            ready: SignInReady(
                identity: nil, attached: nil, subject: subject, scope: scope,
                licenseId: license?["id"]?.stringValue),
            keyEntries: KeyEntries.read(wire), attachable: object["attachable"]?.boolValue)
    }

    /// Abandon the grant: nothing is bound. A lapsed grant is the same `invalid_grant`.
    public func cancel(grant: String) async throws {
        let (url, _) = try await client.choiceUrl("choiceCancel") { $0.choiceCancel }
        let response = try await client.choicePost(url, ["grant": .string(try Self.checked(grant))])
        client.platformSessionDropped(grant: grant)
        guard response.status == 204 || response.status == 200 else {
            throw client.choiceRefusal(response)
        }
    }

    private static func checked(_ grant: String) throws -> String {
        guard !grant.isEmpty else {
            throw PolarisError(code: ErrorCode.invalidArgument, message: "grant is empty.")
        }
        return grant
    }

    private static func badResponse(_ message: String) -> PolarisError {
        PolarisError(code: ErrorCode.badResponse, message: message)
    }
}

extension IdentityClient {
    /// `client.identity.choice`.
    public var choice: ChoiceNamespace { ChoiceNamespace(client: self) }

    /// One grant route from discovery, as an absolute URL on this product.
    fileprivate func choiceUrl(_ name: String, _ pick: (IdentityDiscovery) -> String?) async throws
        -> (URL, String)
    {
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityChoice)
        guard let raw = await core.discoveryDocument?.identity.flatMap(pick), !raw.isEmpty else {
            throw UnsupportedError(
                Unsupported(
                    feature: Feature.identityChoice, reason: UnsupportedReason.product,
                    detail: "the product's discovery names no identity \(name) route."))
        }
        guard let url = URL(string: raw), raw.hasPrefix(core.endpoints.url("").absoluteString)
        else {
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "an identity endpoint points outside this product.")
        }
        return (url, raw)
    }

    /// The grant routes carry no bearer but for `keep`: the grant is the credential, bound to this device.
    fileprivate func choicePost(_ url: URL, _ body: [String: JSONValue], bearer: String? = nil)
        async throws -> PolarisResponse
    {
        var headers = ["content-type": "application/json"]
        if let bearer, !bearer.isEmpty { headers["authorization"] = "Bearer \(bearer)" }
        let data = try JSONEncoder().encode(JSONValue.object(body))
        do {
            return try await core.request(
                url, method: "POST", headers: headers, body: data)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "\(error)")
        }
    }

    fileprivate func choiceBody(_ response: PolarisResponse) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: response.body)
    }

    /// A refusal: the nested `{"error": {"code"}}` body, its retry data beside it. A 5xx or a body
    /// with no code is `server_error`.
    fileprivate func choiceRefusal(_ response: PolarisResponse) -> ChoiceError {
        let object = choiceBody(response)?.objectValue ?? [:]
        let code =
            object["error"]?.objectValue?["code"]?.stringValue
            ?? object["error"]?.stringValue
        var retry = wholeSeconds(object["retryAfter"]?.doubleValue)
        if retry == nil,
            let header = response.headers.first(where: {
                $0.key.lowercased() == "retry-after"
            })?.value.trimmingCharacters(in: .whitespaces), let seconds = Int(header)
        {
            retry = seconds
        }
        let entries = (try? JSONEncoder().encode(object["keyEntries"] ?? .null))
            .flatMap { try? JSONDecoder().decode(KeyEntries.Wire.self, from: $0) }
        let resolved =
            (code.flatMap { $0.isEmpty ? nil : $0 })
            ?? (response.status >= 500 ? IdentityClient.serverError : "http_\(response.status)")
        return ChoiceError(
            code: resolved, status: response.status,
            message: "the licence choice was refused (\(resolved)).", retryAfterSeconds: retry,
            view: LicenseChoiceView.read(object["view"]), manageUrl: object["manageUrl"]?.stringValue,
            signInUrl: object["signInUrl"]?.stringValue, keyEntries: KeyEntries.read(entries))
    }
}
