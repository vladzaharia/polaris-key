// `client.identity.exchange`: the platform ID-token exchange (WIRE-CONTRACT-V5 §12.11.2-.3, I-44.1).
// The app asks the platform (Sign in with Apple, Google) for an ID token over a nonce the Worker
// issued, and the Worker answers with the same device token a redirect sign-in mints. This file is
// the primitive; the ladder that calls the platform is I-44.2.
//
//   let nonce = try await client.identity.exchangeNonce()          // .nonce(ExchangeNonce)
//   let token = try await provider.idToken(nonce: nonce.value)     // the platform's, not ours
//   switch try await client.identity.exchange(kind: .google, subjectToken: token, nonce: nonce.value) {
//   case .signedIn(let ready):   ...                               // the device token is stored
//   case .confirm(let pending):  ...                               // show pending.consent, then
//       _ = try await client.identity.choice.complete(
//           grant: pending.grant, choice: nil, consent: ChoiceConsent(claims: [...]))
//   case .choose(let pending):   ...                               // the licence choice, as a redirect's
//   case .needsSignIn(let n):    ...                               // sign in the regular way, then link
//   case .unavailable(let code): ...                               // fall to the next rung
//   }
//
// Rules:
//   - The nonce route registers the device's two public keys; the proof of purpose `exchange`
//     binds the nonce, the signing key and the SHA-256 of the provider token (§12.11.1), and is
//     signed by the device key port, so no private key is handled here.
//   - A nonce is single use: this client asks for a fresh one per attempt, never caches or reuses
//     one, and holds none after the attempt, whatever the answer. The Worker spends it on the
//     first attempt that reaches it.
//   - The token, the grant and the link handle travel in a body, never a URL, and never print: a
//     description, a mirror, a log or an error shows `[redacted]` or omits them.
//   - Both routes come from discovery and must be on this product. A product that publishes no
//     `exchange` member, or not the requested kind, is `unavailable`, with no request sent.
//   - A refusal is a typed `ExchangeError` and changes nothing local. `404` (either route) is `unavailable(not_found)`.
//   - The sign-in card `url` of an interstitial must be https, or http on loopback.

import CryptoKit
import Foundation
import PolarisKeyCore

/// The platform providers an ID token can come from (§12.11.3).
public enum ExchangeKind: String, Sendable, Equatable, CaseIterable {
    case google
    case apple
}

/// A nonce the Worker issued for one exchange: 300 seconds, spent by the first attempt. Printing
/// it shows the value `[redacted]`.
public struct ExchangeNonce: Sendable, Equatable {
    /// What the platform signs into its ID token, unchanged (no hashing).
    public let value: String
    public let expiresIn: Int
    /// When it lapses on this client's clock (epoch seconds).
    public let expiresAt: Int
}

extension ExchangeNonce: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "ExchangeNonce(value: \(redactedCredential), expiresIn: \(expiresIn))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self, children: ["value": redactedCredential, "expiresIn": expiresIn],
            displayStyle: .struct)
    }
}

/// The answer to a nonce request.
public enum ExchangeNonceAnswer: Sendable, Equatable {
    case nonce(ExchangeNonce)
    /// This device cannot run the exchange here: the route is `404`, the product publishes no such
    /// kind, or the device keys are memory-only. `code` is `not_found` or
    /// `platform-identity-unavailable`.
    case unavailable(code: String)
}

/// `ExchangeConsentView` (§12.11.3 rule 1): what the consent screen shows. Display data.
public struct ExchangeConsent: Sendable, Equatable {
    public struct Client: Sendable, Equatable {
        public let appName: String
        public let developerName: String?
        public let iconUrl: String?
        public let nameVerified: Bool
    }
    public struct Account: Sendable, Equatable {
        public let provider: String
        /// The token's own address, or nil.
        public let email: String?
    }
    public let client: Client
    public let `as`: Account
    /// The consent items (§12.7.3), as the Worker sent them.
    public let items: [JSONValue]
    public let scopeHash: String
    public let firstTime: Bool
    public let changed: Bool

    static func read(_ value: JSONValue?) -> ExchangeConsent? {
        guard let o = value?.objectValue, let c = o["client"]?.objectValue,
            let appName = c["appName"]?.stringValue, let a = o["as"]?.objectValue,
            let provider = a["provider"]?.stringValue, case .array(let items)? = o["items"],
            let scopeHash = o["scopeHash"]?.stringValue, let firstTime = o["firstTime"]?.boolValue,
            let changed = o["changed"]?.boolValue
        else { return nil }
        return ExchangeConsent(
            client: Client(
                appName: appName, developerName: c["developerName"]?.stringValue,
                iconUrl: c["iconUrl"]?.stringValue,
                nameVerified: c["nameVerified"]?.boolValue ?? false),
            as: Account(provider: provider, email: a["email"]?.stringValue), items: items,
            scopeHash: scopeHash, firstTime: firstTime, changed: changed)
    }
}

/// The link exists but the person has not consented to this app, or what it asks changed
/// (`status: "confirm"`). Show `consent`, then `choice.complete(grant:choice:consent:)`. Printing
/// shows the grant `[redacted]`.
public struct PendingConsent: Sendable, Equatable {
    public let grant: String
    public let expiresIn: Int
    /// When the grant lapses on this client's clock (epoch seconds).
    public let expiresAt: Int
    public let consent: ExchangeConsent
}

extension PendingConsent: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "PendingConsent(grant: \(redactedCredential), expiresIn: \(expiresIn), "
            + "provider: \(consent.as.provider), firstTime: \(consent.firstTime))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "grant": redactedCredential, "expiresIn": expiresIn, "expiresAt": expiresAt,
                "consent": consent,
            ], displayStyle: .struct)
    }
}

/// Why the exchange found no account to sign in (`interstitial_required`).
public enum NeedsSignInReason: String, Sendable, Equatable {
    /// No link exists for this token: sign in the regular way, then offer the link.
    case noLink = "no_link"
    /// The product's terms version is unaccepted; only the card takes acceptance.
    case terms
}

/// `403 interstitial_required` (§12.11.3 rule 4). `linkHandle` is present for `noLink`: used once,
/// by the link offer, so the app does not ask the platform for a second token. Printing shows it
/// `[redacted]`.
public struct NeedsSignIn: Sendable, Equatable {
    public let reason: NeedsSignInReason
    /// The product's sign-in card.
    public let url: String
    public let linkHandle: String?
    /// Seconds the handle lives (600), when the Worker said.
    public let expiresIn: Int?
    /// When the handle lapses on this client's clock (epoch seconds).
    public let expiresAt: Int?
}

extension NeedsSignIn: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "NeedsSignIn(reason: \(reason.rawValue), url: \(url), "
            + "linkHandle: \(linkHandle == nil ? "nil" : redactedCredential))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "reason": reason.rawValue, "url": url,
                "linkHandle": linkHandle == nil ? "nil" : redactedCredential,
                "expiresIn": expiresIn as Any,
            ], displayStyle: .struct)
    }
}

/// What the exchange answered.
public enum ExchangeOutcome: Sendable, Equatable {
    /// The link and the consent exist and no choice is due: the device token is stored and the
    /// post-acquisition sync has run.
    case signedIn(SignInReady)
    case confirm(PendingConsent)
    /// A licence choice is due and consent stands: the same pending grant a redirect gives.
    case choose(PendingSignIn)
    case needsSignIn(NeedsSignIn)
    /// No exchange here (`not_found`, or `platform-identity-unavailable`): fall to the next rung.
    case unavailable(code: String)
}

/// A refusal of the nonce route or the grant: `invalid_grant` (every failed check says this and
/// nothing more), `unsupported_grant_type`, `not_entitled`, `device_limit` and
/// `license_choice_required` (with a fresh `view`), `rate_limited` (`retryAfterSeconds`), or the
/// Worker's own code. The text carries the code and status only.
public struct ExchangeError: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: String
    public let status: Int
    public let retryAfterSeconds: Int?
    public let view: LicenseChoiceView?
    /// Where the person manages their devices (`device_limit`), when the Worker sent an https one.
    public let manageUrl: String?

    public var description: String { "ExchangeError(\(code), status \(status))" }
}

/// A sign-out happened while the ladder was waiting on the platform or the Worker.
struct SignedOutDuringLadder: Error {}

extension IdentityClient {
    static let exchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange"
    static let idTokenType = "urn:ietf:params:oauth:token-type:id_token"

    /// Ask the Worker for a nonce for `kind`, registering this device's public keys with it. Send
    /// the value to the platform, then pass it to `exchange(kind:subjectToken:nonce:)`.
    public func exchangeNonce(kind: ExchangeKind) async throws -> ExchangeNonceAnswer {
        let routes = try await exchangeRoutes(kind)
        guard let routes else { return .unavailable(code: ErrorCode.platformIdentityUnavailable) }
        guard let port = try await exchangePort() else {
            return .unavailable(code: ErrorCode.platformIdentityUnavailable)
        }
        return try await fetchNonce(routes.nonce, port)
    }

    /// Exchange a platform ID token for a device token. `nonce` is the value the token was
    /// requested with (`exchangeNonce`): the platform signs it into the token, so the Worker can
    /// only match one asked for first. Any answer spends the nonce.
    public func exchange(kind: ExchangeKind, subjectToken: String, nonce: String) async throws
        -> ExchangeOutcome
    {
        try await exchange(kind: kind, subjectToken: subjectToken, optionalNonce: nonce, ladderGeneration: nil)
    }

    /// Conformance and tests only: nil takes a fresh nonce after the token exists, which the
    /// Worker refuses for a real platform token (the nonce is not inside it).
    ///
    /// `ladderGeneration` is set by `autoSignIn`: the token is stored only if no sign-out happened
    /// since (`SignedOutDuringLadder` otherwise), and storing it never ends the signed-out state.
    /// A direct call is the person's own sign-in and clears that state.
    func exchange(
        kind: ExchangeKind, subjectToken: String, optionalNonce nonce: String?,
        ladderGeneration: Int? = nil
    ) async throws -> ExchangeOutcome
    {
        guard !subjectToken.isEmpty else {
            throw PolarisError(code: ErrorCode.invalidArgument, message: "subjectToken is empty.")
        }
        guard let routes = try await exchangeRoutes(kind) else {
            return .unavailable(code: ErrorCode.platformIdentityUnavailable)
        }
        guard let port = try await exchangePort() else {
            return .unavailable(code: ErrorCode.platformIdentityUnavailable)
        }
        let value: String
        if let nonce {
            guard Self.nonceOK(nonce) else {
                throw PolarisError(code: ErrorCode.invalidArgument, message: "nonce is malformed.")
            }
            value = nonce
        } else {
            switch try await fetchNonce(routes.nonce, port) {
            case .unavailable(let code): return .unavailable(code: code)
            case .nonce(let n): value = n.value
            }
        }
        let keys = try await port.ensure()
        let proof = try await DeviceProofs.sign(
            port, purpose: .exchange, product: core.product, deviceId: await core.deviceId,
            value: "\(value).\(keys.signKey)",
            tokenHash: Base64URL.encode(Data(SHA256.hash(data: Data(subjectToken.utf8)))))
        let pairs: [(String, String)] = [
            ("grant_type", Self.exchangeGrantType), ("client_id", core.product),
            ("subject_token", subjectToken), ("subject_token_type", Self.idTokenType),
            ("nonce", value), ("device_key", keys.signKey), ("proof", proof.sig),
        ]
        let form = pairs.map { "\(ManageLink.formEncode($0.0))=\(ManageLink.formEncode($0.1))" }
            .joined(separator: "&")
        let response = try await exchangeSend(
            routes.token, contentType: IdentityRedirect.tokenContentType, body: Data(form.utf8))
        return try await exchangeOutcome(response, ladderGeneration: ladderGeneration)
    }

    // ── Routes and keys ──────────────────────────────────────────────────────────────────

    /// The two routes, or nil when the product does not accept `kind` (no request is sent).
    private func exchangeRoutes(_ kind: ExchangeKind) async throws -> (nonce: URL, token: URL)? {
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityExchange)
        guard let fragment = await core.discoveryDocument?.identity,
            let exchange = fragment.exchange, exchange.kinds.contains(kind.rawValue),
            let nonce = fragment.nonce, !nonce.isEmpty, let token = fragment.token, !token.isEmpty
        else { return nil }
        let root = core.endpoints.url("").absoluteString
        guard nonce.hasPrefix(root), token.hasPrefix(root), let nonceUrl = URL(string: nonce),
            let tokenUrl = URL(string: token)
        else {
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "an identity endpoint points outside this product.")
        }
        return (nonceUrl, tokenUrl)
    }

    /// The key port, or nil when its keys die with the process: registering them would bind the
    /// device to a key it cannot present again.
    private func exchangePort() async throws -> (any DeviceKeyPort)? {
        var held = deviceKeys.current
        if held == nil {
            let made = try DeviceKeyStore(productSlug: core.product, accessGroup: core.keychainAccessGroup)
            held = deviceKeys.with { slot -> any DeviceKeyPort in
                if let existing = slot { return existing }
                slot = made
                return made
            }
        }
        guard let port = held else { return nil }
        return try await port.persistence() == .memory ? nil : port
    }

    static func nonceOK(_ s: String) -> Bool {
        urlSafe(s, count: 43)
    }

    /// `count` characters of the base64url alphabet: a shape check, as the redirect grant's.
    private static func urlSafe(_ s: String, count: Int) -> Bool {
        s.utf8.count == count
            && s.utf8.allSatisfy {
                ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
                    || $0 == 0x2D || $0 == 0x5F
            }
    }

    private func fetchNonce(_ url: URL, _ port: any DeviceKeyPort) async throws -> ExchangeNonceAnswer {
        let keys = try await port.ensure()
        let body = try JSONEncoder().encode(
            JSONValue.object(["signKey": .string(keys.signKey), "agreeKey": .string(keys.agreeKey)]))
        let response = try await exchangeSend(url, contentType: "application/json", body: body)
        if response.status == 404 { return .unavailable(code: ErrorCode.notFound) }
        guard response.status == 200 else { throw exchangeRefusal(response) }
        let object = exchangeBody(response)?.objectValue
        guard let value = object?["nonce"]?.stringValue, Self.nonceOK(value),
            let expiresIn = wholeSeconds(object?["expiresIn"]?.doubleValue)
        else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the nonce route answered without a nonce.")
        }
        return .nonce(
            ExchangeNonce(value: value, expiresIn: expiresIn, expiresAt: await core.now() + expiresIn))
    }

    // ── Transport and answers ────────────────────────────────────────────────────────────

    /// No bearer: the proof and the nonce are the credentials, bound to this device.
    private func exchangeSend(_ url: URL, contentType: String, body: Data) async throws -> PolarisResponse
    {
        do {
            return try await core.request(
                url, method: "POST", headers: ["content-type": contentType], body: body)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "the exchange request failed.")
        }
    }

    private func exchangeBody(_ response: PolarisResponse) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: response.body)
    }

    private func exchangeOutcome(_ response: PolarisResponse, ladderGeneration: Int?) async throws
        -> ExchangeOutcome
    {
        let body = exchangeBody(response)
        let object = body?.objectValue ?? [:]
        if response.status == 403, object["error"]?.stringValue == ErrorCode.interstitialRequired {
            return try await needsSignIn(object)
        }
        if response.status == 404 { return .unavailable(code: ErrorCode.notFound) }
        guard response.status == 200 else { throw exchangeRefusal(response) }
        if object["status"]?.stringValue == "confirm" {
            guard let grant = object["grant"]?.stringValue, Self.grantOK(grant),
                let expiresIn = wholeSeconds(object["expiresIn"]?.doubleValue),
                let consent = ExchangeConsent.read(object["consent"])
            else { throw Self.badAnswer }
            return .confirm(
                PendingConsent(
                    grant: grant, expiresIn: expiresIn, expiresAt: await core.now() + expiresIn,
                    consent: consent))
        }
        switch IdentityRedirect.parseTokenAnswer(status: 200, body: body) {
        case .malformed, .refused:
            throw Self.badAnswer
        case .choose(let grant, let expiresIn, let choices):
            guard let view = LicenseChoiceView.read(.object(choices)) else { throw Self.badAnswer }
            let lifetime = wholeSeconds(expiresIn) ?? 0
            return .choose(
                PendingSignIn(
                    grant: grant, expiresIn: lifetime, expiresAt: await core.now() + lifetime, view: view))
        case .token(let accessToken, let scope, let subject, _, _, let license):
            let previous = holdSubjectFirst(subject)
            do {
                if let generation = ladderGeneration {
                    guard try await core.setTokenUnlessSignedOut(accessToken, generation: generation) else {
                        throw SignedOutDuringLadder()
                    }
                } else {
                    try await core.setToken(accessToken, source: .signin, person: true)
                }
            } catch {
                restoreSubject(previous, ifHeld: subject)
                throw error
            }
            if redirectAcquisitionSync.current { await onAcquired?() }
            announceSubject(subject, previous: previous)
            notifyIdentity(IdentityChange(kind: IdentityChange.signedIn, subject: subject))
            return .signedIn(
                SignInReady(
                    identity: nil, attached: nil, subject: subject, scope: scope,
                    licenseId: license?["id"]?.stringValue))
        }
    }

    private static var badAnswer: PolarisError {
        PolarisError(
            code: ErrorCode.badResponse, message: "the token endpoint answered without a complete exchange.")
    }

    private static func grantOK(_ s: String) -> Bool {
        s.hasPrefix("sg_") && urlSafe(String(s.dropFirst(3)), count: 43)
    }

    /// An unknown `reason` reads as `no_link` and carries no handle; a literal `no_link` without a usable handle carries none.
    private func needsSignIn(_ o: [String: JSONValue]) async throws -> ExchangeOutcome {
        guard let url = o["url"]?.stringValue, Self.cardUrlOK(url) else { throw Self.badAnswer }
        let raw = o["reason"]?.stringValue
        let reason = raw == NeedsSignInReason.terms.rawValue ? NeedsSignInReason.terms : .noLink
        let carriesHandle = raw == NeedsSignInReason.noLink.rawValue
        var handle: String?
        var expiresIn: Int?
        var expiresAt: Int?
        if carriesHandle, let h = o["linkHandle"]?.stringValue, h.hasPrefix("lh_"),
            Self.urlSafe(String(h.dropFirst(3)), count: 43),
            let seconds = wholeSeconds(o["expiresIn"]?.doubleValue)
        {
            handle = h
            expiresIn = seconds
            expiresAt = await core.now() + seconds
        }
        return .needsSignIn(
            NeedsSignIn(reason: reason, url: url, linkHandle: handle, expiresIn: expiresIn, expiresAt: expiresAt))
    }

    /// https, or http on loopback: the card is a page the person opens.
    static func cardUrlOK(_ raw: String) -> Bool {
        guard let u = URL(string: raw), let scheme = u.scheme?.lowercased(), let host = u.host?.lowercased()
        else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]")
    }

    /// A refusal: the flat OAuth `{"error": "code"}` or the nested `{"error": {"code"}}` body. A 5xx
    /// or a body with no code is `server_error`. Nothing of the request is echoed.
    private func exchangeRefusal(_ response: PolarisResponse) -> ExchangeError {
        let object = exchangeBody(response)?.objectValue ?? [:]
        let code = object["error"]?.stringValue ?? object["error"]?.objectValue?["code"]?.stringValue
        var retry = wholeSeconds(object["retryAfter"]?.doubleValue)
        if retry == nil, let header = response.headers.first(where: { $0.key.lowercased() == "retry-after" })?
            .value.trimmingCharacters(in: .whitespaces), let seconds = Int(header)
        {
            retry = seconds
        }
        let resolved =
            response.status >= 500
            ? IdentityClient.serverError
            : (code.flatMap { $0.isEmpty ? nil : $0 } ?? "http_\(response.status)")
        return ExchangeError(
            code: resolved, status: response.status, retryAfterSeconds: retry,
            view: LicenseChoiceView.read(object["view"]),
            manageUrl: object["manageUrl"]?.stringValue.flatMap { Self.cardUrlOK($0) ? $0 : nil })
    }
}
