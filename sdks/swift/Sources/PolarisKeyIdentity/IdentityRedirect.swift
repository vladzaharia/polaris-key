// The authorization-code redirect core (WIRE-CONTRACT-V4 §12.4, §12.5; I-10b.11): everything the
// SDK does around the browser hop, with no I/O of its own. A port of client-core's
// `identityRedirect.ts`; the vectors in `IdentityRedirectTests` are that file's.
//
//   1. `IdentityRedirect.start`           S256 PKCE, the `state`, and the authorize URL the host opens.
//   2. `IdentityRedirect.checkCallback`   the redirect back to the app: the redirect URI, then no
//                                         repeats, `state`, `iss` (RFC 9207), `error`, `code`. A
//                                         refusal here never reaches the token endpoint.
//   3. `IdentityRedirect.tokenForm`       the form body of `POST /<p>/identity/token`.
//   4. `IdentityRedirect.parseTokenAnswer` the answer: a token response, `choose` (by its `status`
//                                         member alone), or a refusal carrying the Worker's OAuth
//                                         `error`.
//
// Safety rules the session layer relies on:
//   - S256 only. There is no `plain` path and no option to send one.
//   - `state` and the verifier are 32 random bytes each unless a test injects them. The session
//     keeps the pending request for ONE `checkCallback` and token request, then drops it.
//   - The verifier, the code and the token are never put in a URL or a log here; the authorize URL
//     carries only the challenge.

import CryptoKit
import Foundation
import PolarisKeyCore

/// Random bytes. Default `SystemRandomNumberGenerator`; a test injects a fixed source.
public typealias RandomBytes = @Sendable (Int) -> [UInt8]

/// Why a callback was refused before any token request. The raw values are the shared vector
/// vocabulary; every SDK reports the same one for the same URL.
public enum CallbackFailure: String, Sendable, Equatable {
    /// Not an absolute URL, or a repeated parameter.
    case malformed
    /// The callback is not at the redirect URI the request named.
    case redirectMismatch = "redirect-mismatch"
    /// `state` absent or not this request's.
    case stateMismatch = "state-mismatch"
    /// `iss` absent or not the discovery issuer (RFC 9207).
    case issuerMismatch = "issuer-mismatch"
    /// An `error` other than `access_denied`.
    case authorizationError = "authorization-error"
    case missingCode = "missing-code"
}

public enum CallbackResult: Sendable, Equatable {
    /// The code to redeem.
    case code(String)
    /// The person pressed Cancel on the card (`error=access_denied`).
    case cancelled
    /// Anything else (`sign-in-failed`); `error` is the callback's own `error` value when it
    /// carried one.
    case failed(reason: CallbackFailure, error: String?)
}

public enum TokenAnswer: Sendable, Equatable {
    /// `200` with an `access_token`: the activation response under its OAuth names.
    case token(
        accessToken: String, scope: String, subject: String, schemaVersion: Int,
        device: [String: JSONValue], license: [String: JSONValue]?)
    /// `200` with `status: "choose"` (I-08b): the app shows the licence choice, then calls
    /// `choice/complete` with `grant`.
    case choose(grant: String, expiresIn: Double, choices: [String: JSONValue])
    /// The Worker refused: `error` is its flat OAuth / Polaris code (`invalid_grant`,
    /// `rate_limited`, ...), `retryAfterSeconds` when it named one. A 5xx or a body with no
    /// `error` is `server_error`.
    case refused(error: String, status: Int, retryAfterSeconds: Int?)
    /// A `200` that is neither of the above, or lacks a member the call needs.
    case malformed
}

/// One pending redirect sign-in. The session holds it between the navigation and the callback,
/// uses it for ONE `checkCallback` (and one token request), then drops it. `codeVerifier` is a
/// secret: never log it, never put it in a URL.
public struct RedirectPending: Sendable, Equatable {
    /// The URL to open in the browser. Carries the challenge, never the verifier.
    public let authorizeUrl: String
    public let state: String
    let codeVerifier: String
    /// For tests: the verifier a fresh request generated.
    var codeVerifierForTests: String { codeVerifier }
    public let redirectUri: String
    public let clientId: String
    public let issuer: String
    public let tokenEndpoint: String
    /// The authorize URL carries `license_choice=app`: the token endpoint may answer `choose`.
    public let choiceApp: Bool
}

extension RedirectPending: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        "RedirectPending(authorizeUrl: \(authorizeUrl), codeVerifier: \(redactedCredential))"
    }
    public var debugDescription: String { description }
}

public enum IdentityRedirect {
    /// RFC 7636 §4.1: the verifier is 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`.
    public static let verifierMin = 43
    public static let verifierMax = 128
    /// WIRE-CONTRACT-V4 §12.4: `state` is 16 to 512 printable ASCII characters.
    public static let stateMin = 16
    public static let stateMax = 512
    /// The scope a sign-in asks for when the host names none (a subset of `profile email
    /// cloudSync`; `openid` is `invalid_scope` until I-21).
    public static let defaultScope = "profile email"
    /// The `Content-Type` of the token request.
    public static let tokenContentType = "application/x-www-form-urlencoded"

    private static let grantPattern = #"sg_[A-Za-z0-9_-]{43}"#

    // ── PKCE ─────────────────────────────────────────────────────────────────────────────

    private static func systemRandom(_ length: Int) -> [UInt8] {
        var generator = SystemRandomNumberGenerator()
        return (0..<length).map { _ in UInt8.random(in: 0...255, using: &generator) }
    }

    /// A fresh PKCE verifier: 32 random bytes, 43 base64url characters.
    public static func generateCodeVerifier(random: RandomBytes? = nil) -> String {
        Base64URL.encode(Data((random ?? systemRandom)(32)))
    }

    /// A fresh `state`: 32 random bytes, 43 base64url characters.
    public static func generateState(random: RandomBytes? = nil) -> String {
        Base64URL.encode(Data((random ?? systemRandom)(32)))
    }

    /// The S256 challenge: `base64url(SHA-256(ASCII(verifier)))`, unpadded (RFC 7636 §4.2).
    public static func pkceChallenge(_ verifier: String) -> String {
        Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    // ── The authorize request ────────────────────────────────────────────────────────────

    /// The shared rule for a host-supplied redirect URI: absolute `https:`, no userinfo, no
    /// fragment, no whitespace or control characters. (Loopback, scheme and claimed-HTTPS URIs
    /// are I-15's.)
    public static func isRedirectUri(_ raw: String?) -> Bool {
        guard let raw, !raw.isEmpty, raw.utf16.count <= 2048 else { return false }
        if raw.unicodeScalars.contains(where: {
            $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F || $0 == "\\"
        }) { return false }
        guard raw.hasPrefix("https://"), !raw.contains("#") else { return false }
        let rest = raw.dropFirst("https://".count)
        let authority = rest.prefix(while: { $0 != "/" && $0 != "?" })
        return !authority.isEmpty && !authority.contains("@")
    }

    private static func isAbsoluteHttp(_ s: String) -> Bool {
        let rest: Substring
        if s.hasPrefix("https://") {
            rest = s.dropFirst(8)
        } else if s.hasPrefix("http://") {
            rest = s.dropFirst(7)
        } else {
            return false
        }
        return !rest.isEmpty && !rest.unicodeScalars.contains(where: { $0.properties.isWhitespace })
    }

    private static func isPrintable(_ s: String) -> Bool {
        !s.isEmpty && s.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7E }
    }

    private static func scopeString(_ scope: [String]?) throws -> String {
        guard let scope else { return defaultScope }
        let parts = scope.joined(separator: " ").split(separator: " ", omittingEmptySubsequences: true)
            .map(String.init)
        guard !parts.isEmpty, parts.allSatisfy(isPrintable) else {
            throw invalid("scope must be a space-delimited list of printable scopes.")
        }
        return parts.joined(separator: " ")
    }

    private static func invalid(_ message: String) -> PolarisError {
        PolarisError(code: ErrorCode.invalidArgument, message: message)
    }

    private static func formBody(_ pairs: [(String, String)]) -> String {
        pairs.map { "\(ManageLink.formEncode($0.0))=\(ManageLink.formEncode($0.1))" }
            .joined(separator: "&")
    }

    /// Build the authorize request. Query order is fixed so every SDK emits the same bytes:
    /// `response_type client_id redirect_uri state code_challenge code_challenge_method scope
    /// [login_hint] [name_hint] [purpose] [license_choice]`, each value form-encoded (space as
    /// `+`). A hint that is empty is not sent; a hint is sent verbatim (the Worker normalises,
    /// and drops a login hint that is not an email). `licenseChoice` `"app"` is sent only when
    /// `choiceAvailable` (discovery has the `choice*` endpoints).
    public static func start(
        authorizeEndpoint: String, tokenEndpoint: String, issuer: String, clientId: String,
        redirectUri: String, scope: [String]? = nil, loginHint: String? = nil,
        nameHint: String? = nil, purpose: String? = nil, licenseChoice: String? = nil,
        choiceAvailable: Bool = false, random: RandomBytes? = nil, state: String? = nil,
        codeVerifier: String? = nil
    ) throws -> RedirectPending {
        guard isRedirectUri(redirectUri) else {
            throw invalid("redirectUri must be an absolute https URL with no fragment.")
        }
        for (name, value) in [("authorize", authorizeEndpoint), ("token", tokenEndpoint)]
        where !isAbsoluteHttp(value) {
            throw invalid("the \(name) endpoint is not an absolute URL.")
        }
        guard !issuer.isEmpty else { throw invalid("discovery names no issuer.") }
        guard !clientId.isEmpty else { throw invalid("clientId is empty.") }
        let state = state ?? generateState(random: random)
        guard (stateMin...stateMax).contains(state.utf16.count), isPrintable(state) else {
            throw invalid("state must be 16 to 512 printable characters.")
        }
        let verifier = codeVerifier ?? generateCodeVerifier(random: random)
        guard (verifierMin...verifierMax).contains(verifier.utf16.count),
            verifier.unicodeScalars.allSatisfy({
                switch $0.value {
                case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F, 0x7E: return true
                default: return false
                }
            })
        else { throw invalid("the PKCE verifier must be 43 to 128 unreserved characters.") }

        var pairs: [(String, String)] = [
            ("response_type", "code"), ("client_id", clientId), ("redirect_uri", redirectUri),
            ("state", state), ("code_challenge", pkceChallenge(verifier)),
            ("code_challenge_method", "S256"), ("scope", try scopeString(scope)),
        ]
        if let loginHint, !loginHint.isEmpty { pairs.append(("login_hint", loginHint)) }
        if let nameHint, !nameHint.isEmpty { pairs.append(("name_hint", nameHint)) }
        if let purpose, !purpose.isEmpty { pairs.append(("purpose", purpose)) }
        if licenseChoice == "app", choiceAvailable { pairs.append(("license_choice", "app")) }
        let joiner = authorizeEndpoint.contains("?") ? "&" : "?"
        return RedirectPending(
            authorizeUrl: "\(authorizeEndpoint)\(joiner)\(formBody(pairs))", state: state,
            codeVerifier: verifier, redirectUri: redirectUri, clientId: clientId, issuer: issuer,
            tokenEndpoint: tokenEndpoint, choiceApp: licenseChoice == "app" && choiceAvailable)
    }

    // ── The callback ─────────────────────────────────────────────────────────────────────

    /// The query pairs of `url` (before any `#`); nil when a name repeats or an escape is bad.
    /// A `+` is a space.
    private static func query(of url: String) -> [String: String]? {
        guard let q = url.firstIndex(of: "?") else { return [:] }
        let after = url.index(after: q)
        var end = url.endIndex
        if let hash = url.firstIndex(of: "#") { end = hash }
        // A fragment that starts before the `?` leaves no query.
        guard after <= end else { return [:] }
        func decode(_ s: Substring) -> String? {
            s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
        }
        var out: [String: String] = [:]
        for part in url[after..<end].split(separator: "&", omittingEmptySubsequences: true) {
            let eq = part.firstIndex(of: "=")
            guard let name = decode(eq.map { part[..<$0] } ?? part),
                let value = decode(eq.map { part[part.index(after: $0)...] } ?? ""),
                out[name] == nil
            else { return nil }
            out[name] = value
        }
        return out
    }

    /// `scheme://authority/path`, lower-cased scheme and host, no query or fragment.
    private static func originPath(_ url: String) -> String? {
        guard let sep = url.range(of: "://") else { return nil }
        let scheme = url[..<sep.lowerBound]
        func isAlpha(_ c: Unicode.Scalar) -> Bool {
            (0x41...0x5A).contains(c.value) || (0x61...0x7A).contains(c.value)
        }
        guard let first = scheme.unicodeScalars.first, isAlpha(first),
            scheme.unicodeScalars.allSatisfy({
                isAlpha($0) || (0x30...0x39).contains($0.value) || [0x2B, 0x2E, 0x2D].contains($0.value)
            })
        else { return nil }
        let rest = url[sep.upperBound...]
        let authority = rest.prefix(while: { $0 != "/" && $0 != "?" && $0 != "#" })
        let path = rest.dropFirst(authority.count).prefix(while: { $0 != "?" && $0 != "#" })
        return "\(scheme.lowercased())://\(authority.lowercased())\(path)"
    }

    /// Check the redirect back to the app. The order is fixed and the first failure wins: the
    /// callback is at the redirect URI; no parameter repeats; `state` is this request's; `iss` is
    /// the discovery issuer (a callback with no `iss` is refused: the Worker always sends it);
    /// then `error` (`access_denied` is `cancelled`, any other is `failed`); then `code`.
    ///
    /// Pure: the caller drops the pending request after the first call, whatever the result.
    public static func checkCallback(
        state: String, redirectUri: String, issuer: String, callbackUrl: String
    ) -> CallbackResult {
        func fail(_ reason: CallbackFailure, _ error: String? = nil) -> CallbackResult {
            .failed(reason: reason, error: error)
        }
        guard let got = originPath(callbackUrl), let want = originPath(redirectUri) else {
            return fail(.malformed)
        }
        guard got == want else { return fail(.redirectMismatch) }
        guard let q = query(of: callbackUrl) else { return fail(.malformed) }
        guard q["state"] == state else { return fail(.stateMismatch) }
        guard q["iss"] == issuer else { return fail(.issuerMismatch) }
        if let error = q["error"] {
            return error == "access_denied" ? .cancelled : fail(.authorizationError, error)
        }
        guard let code = q["code"], !code.isEmpty else { return fail(.missingCode) }
        return .code(code)
    }

    static func checkCallback(_ pending: RedirectPending, _ callbackUrl: String) -> CallbackResult {
        checkCallback(
            state: pending.state, redirectUri: pending.redirectUri, issuer: pending.issuer,
            callbackUrl: callbackUrl)
    }

    // ── The token request ────────────────────────────────────────────────────────────────

    /// The form body of `POST /<p>/identity/token` (§12.5). Member order is fixed:
    /// `grant_type client_id code code_verifier redirect_uri [device_name]`.
    public static func tokenForm(
        clientId: String, codeVerifier: String, redirectUri: String, code: String,
        deviceName: String? = nil
    ) -> String {
        var pairs: [(String, String)] = [
            ("grant_type", "authorization_code"), ("client_id", clientId), ("code", code),
            ("code_verifier", codeVerifier), ("redirect_uri", redirectUri),
        ]
        if let deviceName, !deviceName.isEmpty { pairs.append(("device_name", deviceName)) }
        return formBody(pairs)
    }

    /// Read the token endpoint's answer. `choose` is decided by the `status` member alone, never
    /// by the absence of `access_token`.
    public static func parseTokenAnswer(status: Int, body: JSONValue?) -> TokenAnswer {
        let object = body?.objectValue
        if status != 200 {
            let error = object?["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "server_error"
            var retry: Int?
            if let seconds = object?["retryAfter"]?.doubleValue, seconds.isFinite, seconds > 0 {
                retry = Int(min(seconds.rounded(.up), Double(Int32.max)))
            }
            return .refused(error: error, status: status, retryAfterSeconds: retry)
        }
        guard let object else { return .malformed }
        if object["status"]?.stringValue == "choose" {
            guard let grant = object["grant"]?.stringValue, wholeMatches(grantPattern, grant) != nil,
                let expiresIn = object["expiresIn"]?.doubleValue,
                let choices = object["choices"]?.objectValue
            else { return .malformed }
            return .choose(grant: grant, expiresIn: expiresIn, choices: choices)
        }
        guard let token = object["access_token"]?.stringValue, !token.isEmpty,
            let scope = object["scope"]?.stringValue,
            let subject = object["subject"]?.stringValue, !subject.isEmpty,
            let device = object["device"]?.objectValue, let licenseMember = object["license"]
        else { return .malformed }
        let license: [String: JSONValue]?
        switch licenseMember {
        case .null: license = nil
        case .object(let o): license = o
        default: return .malformed
        }
        return .token(
            accessToken: token, scope: scope, subject: subject,
            schemaVersion: object["schemaVersion"]?.intValue ?? 1, device: device, license: license)
    }
}

// ── The redirect channel of `signIn.start` (WIRE-CONTRACT-V4 §12.4, §12.5) ───────────────────

extension IdentityClient {
    /// Begin a redirect sign-in. Refuses before any sign-in request when the product does not run
    /// Identity (`service-unavailable`) or its discovery serves no `authorize`, `token` or
    /// `issuer` (`sign-in-unavailable`): an endpoint is used only when discovery names it, never
    /// built. The token endpoint must be on this product: the device's headers go nowhere else.
    func startRedirect(_ options: SignInOptions) async throws -> RedirectPending {
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityRedirectWeb)
        guard let redirectUri = options.redirectUri else {
            throw PolarisError(
                code: ErrorCode.invalidArgument,
                message: "redirectUri must be an absolute https URL with no fragment.")
        }
        let fragment = await core.discoveryDocument?.identity
        guard let authorize = fragment?.authorize, !authorize.isEmpty,
            let token = fragment?.token, !token.isEmpty,
            let issuer = fragment?.issuer, !issuer.isEmpty
        else {
            throw PolarisError(
                code: ErrorCode.signInUnavailable,
                message: "this product's discovery serves no redirect sign-in.")
        }
        guard token.hasPrefix(core.endpoints.url("").absoluteString) else {
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "the token endpoint points outside this product.")
        }
        let entropy = redirectEntropy.current
        // `license_choice=app` only when asked and all four grant routes are published (§12.6).
        let choiceAvailable = fragment?.choiceAvailable == true
        return try IdentityRedirect.start(
            authorizeEndpoint: authorize, tokenEndpoint: token, issuer: issuer,
            clientId: core.product, redirectUri: redirectUri, scope: options.scope,
            loginHint: options.loginHint, nameHint: options.nameHint,
            purpose: options.purpose?.rawValue, licenseChoice: options.licenseChoice?.rawValue,
            choiceAvailable: choiceAvailable, state: entropy?.state,
            codeVerifier: entropy?.codeVerifier)
    }

    /// Redeem the code at the token endpoint and, on a token, store it and run the acquisition
    /// sync as after a device-code `ready`. A refusal is a `SignInError` under the Worker's code.
    func redeemRedirect(_ pending: RedirectPending, code: String, deviceName: String?)
        async throws -> RedirectRedeemed
    {
        guard let url = URL(string: pending.tokenEndpoint) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the token endpoint is not a URL.")
        }
        let label = await core.deviceLabel(deviceName)
        let form = IdentityRedirect.tokenForm(
            clientId: pending.clientId, codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri, code: code, deviceName: label)
        let response: PolarisResponse
        do {
            response = try await core.request(
                url, method: "POST", headers: ["content-type": IdentityRedirect.tokenContentType],
                body: Data(form.utf8))
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "\(error)")
        }
        let body = try? JSONDecoder().decode(JSONValue.self, from: response.body)
        switch IdentityRedirect.parseTokenAnswer(status: response.status, body: body) {
        case .malformed:
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "the token endpoint answered without a complete sign-in.")
        case .refused(let error, let status, let retryAfter):
            var retry = retryAfter
            if retry == nil, let header = response.headers.first(where: { $0.key.lowercased() == "retry-after" })?
                .value.trimmingCharacters(in: .whitespaces), let seconds = Int(header)
            {
                retry = seconds
            }
            throw SignInError(
                code: status >= 500 ? IdentityClient.serverError : error,
                message: "the token endpoint refused the sign-in (\(error)).",
                retryAfterSeconds: retry)
        case .choose(let grant, let expiresIn, let choices):
            // Only `license_choice=app` makes the Worker answer this; a card sign-in never sees it.
            guard pending.choiceApp, let view = LicenseChoiceView.read(.object(choices)) else {
                throw PolarisError(
                    code: ErrorCode.badResponse,
                    message: "the token endpoint asked for a licence choice this sign-in did not request.")
            }
            let lifetime = wholeSeconds(expiresIn) ?? 0
            return .choose(
                PendingSignIn(
                    grant: grant, expiresIn: lifetime, expiresAt: await core.now() + lifetime,
                    view: view))
        case .token(let accessToken, let scope, let subject, _, _, let license):
            let previous = holdSubjectFirst(subject)
            do { try await core.setToken(accessToken, source: .signin, person: true) } catch {
                restoreSubject(previous, ifHeld: subject)
                throw error
            }
            if redirectAcquisitionSync.current { await onAcquired?() }
            announceSubject(subject, previous: previous)
            notifyIdentity(IdentityChange(kind: IdentityChange.signedIn, subject: subject))
            return .ready(
                SignInReady(
                    identity: nil, attached: nil, subject: subject, scope: scope,
                    licenseId: license?["id"]?.stringValue))
        }
    }
}

/// What redeeming a redirect code gave: a signed-in device, or (`license_choice=app`) a pending
/// sign-in grant the app chooses a licence with.
enum RedirectRedeemed: Sendable, Equatable {
    case ready(SignInReady)
    case choose(PendingSignIn)
}
