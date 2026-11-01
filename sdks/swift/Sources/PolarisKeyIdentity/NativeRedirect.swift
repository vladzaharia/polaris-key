// The native redirect helpers (WIRE-CONTRACT-V5 §12.12; I-15b.4): everything the SDK does around a
// pushed authorization request, with no I/O of its own. A port of client-core's `redirect.ts`;
// the vectors in `NativeRedirectTests` are that file's and the redirect-native-* recordings'.
//
//   1. `chooseClass`      loopback, then scheme, then claimed HTTPS, else the fallback.
//   2. `classify`         the class of a redirect URI; `loopbackUri` / `schemeUri` build one.
//   3. `pushRequest`      the form body of `POST /<p>/identity/request`, PKCE and state.
//   4. `parsePushedAnswer` the `201` answer, or the flat refusal.
//   5. `authorizeUrl`     `client_id` and `request_uri`, nothing else.
//   6. `parseCallback`    the redirect back: iss, state, code (and `request=` on loopback); any
//                         other parameter is refused.
//   7. `tokenForm`        the token request's body (the caller adds `X-PKey-Device`).
//
// Safety rules the session layer relies on (the same as `IdentityRedirect`): S256 only; the
// verifier and the code are never put in a URL or a log here; a pending request is used for ONE
// callback check and one token request, then dropped.

import Foundation
import PolarisKeyCore

/// How a native redirect URI reaches the app. A web redirect is never one of these.
enum NativeRedirectClass: String, Sendable, Equatable {
    case loopback
    case scheme
    case claimed
}

/// Why no native class applies. The raw values are the shared vector vocabulary.
enum RedirectUnavailableReason: String, Sendable, Equatable {
    case requestNotServed = "request-not-served"
    case noClass = "no-class"
}

enum NativeRedirectChoice: Sendable, Equatable {
    case loopback
    case scheme(String)
    case claimed(String)
    /// `redirect-unavailable`: nothing was sent; the caller offers a code (device code).
    case unavailable(RedirectUnavailableReason)
}

/// One pending native sign-in. A secret holder: `codeVerifier` is never logged or put in a URL.
struct NativePending: Sendable, Equatable {
    let redirectClass: NativeRedirectClass
    let redirectUri: String
    let state: String
    let codeVerifier: String
    let clientId: String
    let issuer: String
    let authorizeEndpoint: String
    let tokenEndpoint: String
    /// The push carried `license_choice=app`: the token endpoint may answer `choose`.
    let choiceApp: Bool
}

extension NativePending: CustomStringConvertible, CustomDebugStringConvertible {
    var description: String {
        "NativePending(redirectClass: \(redirectClass.rawValue), redirectUri: \(redirectUri), state: \(redactedCredential), codeVerifier: \(redactedCredential))"
    }
    var debugDescription: String { description }
}

struct PushedRequest: Sendable, Equatable {
    /// `POST` here; the caller adds `X-PKey-Device` and the SDK headers.
    let url: String
    let contentType: String
    let body: String
    let pending: NativePending
}

enum PushedAnswer: Sendable, Equatable {
    case pushed(requestUri: String, expiresIn: Int)
    /// The Worker refused: its flat `error` (a 5xx or a body with no `error` is `server_error`).
    case refused(error: String, status: Int, retryAfterSeconds: Int?)
    case malformed
}

/// Why a native callback was refused. The raw values are the shared vector vocabulary.
enum NativeCallbackFailure: String, Sendable, Equatable {
    case malformed
    case redirectMismatch = "redirect-mismatch"
    case stateMismatch = "state-mismatch"
    case issuerMismatch = "issuer-mismatch"
    case authorizationError = "authorization-error"
    case missingCode = "missing-code"
    /// A parameter beyond `code state iss request` (or `error error_description state iss request`).
    case unexpectedParameter = "unexpected-parameter"
    /// The `request=` handle is absent on loopback, or not an `rq_` handle.
    case requestInvalid = "request-invalid"
    /// The system browser session ended with an error (not a dismissal).
    case browserFailed = "browser-failed"

    /// A delivery that is not this sign-in's (another URL, a wrong `state`, an unreadable query)
    /// cannot be allowed to end it: the sign-in keeps waiting.
    var leavesSessionWaiting: Bool {
        self == .malformed || self == .redirectMismatch || self == .stateMismatch
    }
}

enum NativeCallbackResult: Sendable, Equatable {
    /// `request` is the `rq_` handle, present on a loopback delivery.
    case code(String, request: String?)
    case cancelled(request: String?)
    case failed(NativeCallbackFailure, error: String?)

    var request: String? {
        switch self {
        case .code(_, let request), .cancelled(let request): return request
        case .failed: return nil
        }
    }
}

extension NativeCallbackResult: CustomStringConvertible, CustomDebugStringConvertible {
    var description: String {
        switch self {
        case .code(_, let request):
            return "NativeCallbackResult.code(\(redactedCredential), request: \(request ?? "nil"))"
        case .cancelled(let request): return "NativeCallbackResult.cancelled(request: \(request ?? "nil"))"
        case .failed(let reason, let error):
            return "NativeCallbackResult.failed(\(reason.rawValue), error: \(error ?? "nil"))"
        }
    }
    var debugDescription: String { description }
}

enum NativeRedirect {
    /// §12.12: the one path of the loopback and scheme redirect URIs (RFC 8252 §7).
    static let path = "/pkey/callback"
    /// §12.12: how long a pushed request lives (RFC 9126 `expires_in`), and the listener with it.
    static let pushedRequestTtlSeconds = 600
    static let requestUriPattern = #"urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}"#
    static let requestHandlePattern = #"rq_[A-Za-z0-9_-]{22}"#

    /// A URL scheme a native redirect never uses: the web's own.
    private static let reservedSchemes: Set<String> = ["http", "https", "javascript", "data", "file"]
    private static let successParams: Set<String> = ["code", "state", "iss", "request"]
    private static let errorParams: Set<String> = ["error", "error_description", "state", "iss", "request"]

    // ── 1. The class ─────────────────────────────────────────────────────────────────────

    /// The order is fixed: loopback (desktop), the registered scheme, claimed HTTPS, else the
    /// fallback. A class is used only when discovery lists it AND the host has it; discovery with
    /// no `request` or no `nativeRedirect` is `request-not-served`.
    static func chooseClass(
        requestEndpoint: String?, discovery: NativeRedirectDiscovery?, canListen: Bool,
        registeredSchemes: [String] = [], registeredClaimed: [String] = []
    ) -> NativeRedirectChoice {
        guard let requestEndpoint, !requestEndpoint.isEmpty, let discovery else {
            return .unavailable(.requestNotServed)
        }
        if canListen && discovery.loopback { return .loopback }
        if let scheme = registeredSchemes.first(where: { discovery.schemes.contains($0) }) {
            return .scheme(scheme)
        }
        if let claimed = registeredClaimed.first(where: { discovery.claimedHttps.contains($0) }) {
            return .claimed(claimed)
        }
        return .unavailable(.noClass)
    }

    // ── 2. The redirect URI ──────────────────────────────────────────────────────────────

    private static func isDigits(_ s: Substring) -> Bool {
        !s.isEmpty && s.utf8.allSatisfy { (0x30...0x39).contains($0) }
    }

    private static func isSchemeName(_ s: Substring) -> Bool {
        guard let first = s.utf8.first, (0x61...0x7A).contains(first) else { return false }
        return s.utf8.allSatisfy {
            (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2B || $0 == 0x2E || $0 == 0x2D
        }
    }

    /// The class of a native redirect URI, or nil when it is none (§12.12: `localhost`, another
    /// path, a query, a fragment, userinfo, port 80 or no port are all refused).
    static func classify(_ uri: String?) -> NativeRedirectClass? {
        guard let uri, !uri.isEmpty, uri.utf16.count <= 2048 else { return nil }
        if uri.unicodeScalars.contains(where: {
            $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F || $0 == "\\"
        }) {
            return nil
        }
        if uri.hasPrefix("http://") {
            let rest = uri.dropFirst("http://".count)
            let host: Substring
            if rest.hasPrefix("127.0.0.1:") {
                host = rest.dropFirst("127.0.0.1:".count)
            } else if rest.hasPrefix("[::1]:") {
                host = rest.dropFirst("[::1]:".count)
            } else {
                return nil
            }
            let digits = host.prefix(while: { $0 != "/" })
            let tail = host.dropFirst(digits.count)
            guard isDigits(digits), digits.count <= 5, let port = Int(digits), (1...65535).contains(port),
                port != 80, tail == path[...], !(digits.count > 1 && digits.hasPrefix("0"))
            else { return nil }
            return .loopback
        }
        if uri.hasPrefix("https://") {
            let rest = uri.dropFirst("https://".count)
            let authority = rest.prefix(while: { !"/?#@".contains($0) })
            let tail = rest.dropFirst(authority.count)
            guard !authority.isEmpty, tail.hasPrefix("/"), !tail.contains("?"), !tail.contains("#") else {
                return nil
            }
            return tail == "/" ? nil : .claimed
        }
        guard let colon = uri.firstIndex(of: ":") else { return nil }
        let scheme = uri[..<colon]
        let tail = uri[uri.index(after: colon)...]
        guard isSchemeName(scheme), tail.hasPrefix("/"), !tail.contains("?"), !tail.contains("#") else {
            return nil
        }
        return !reservedSchemes.contains(String(scheme)) && tail == path[...] ? .scheme : nil
    }

    /// The loopback redirect URI for a listener's OS-assigned port.
    static func loopbackUri(port: Int) throws -> String {
        guard (1...65535).contains(port), port != 80 else {
            throw IdentityRedirect.invalid("the loopback port must be an explicit port other than 80.")
        }
        let uri = "http://127.0.0.1:\(port)\(path)"
        guard classify(uri) == .loopback else { throw IdentityRedirect.invalid("not a native redirect URI.") }
        return uri
    }

    /// The redirect URI of a registered scheme: `<scheme>:/pkey/callback`.
    static func schemeUri(_ scheme: String) throws -> String {
        guard isSchemeName(scheme[...]), !reservedSchemes.contains(scheme) else {
            throw IdentityRedirect.invalid("the scheme is not a registrable URL scheme.")
        }
        let uri = "\(scheme):\(path)"
        guard classify(uri) == .scheme else { throw IdentityRedirect.invalid("not a native redirect URI.") }
        return uri
    }

    // ── 3. The pushed request ────────────────────────────────────────────────────────────

    /// Build the pushed request (§12.12). Nothing here touches the network. Member order:
    /// `response_type client_id redirect_uri state code_challenge code_challenge_method [scope]
    /// [nonce] [login_hint] [name_hint] [purpose] [license_choice] [device_name] [return_uri]`.
    /// `scope` is left out when not given (the Worker defaults it); `license_choice=app` is sent
    /// only when `choiceAvailable` (I-08b).
    static func pushRequest(
        requestEndpoint: String, authorizeEndpoint: String, tokenEndpoint: String, issuer: String,
        clientId: String, redirectUri: String, deviceName: String? = nil, returnUri: String? = nil,
        scope: [String]? = nil, nonce: String? = nil, loginHint: String? = nil,
        nameHint: String? = nil, purpose: String? = nil, licenseChoice: String? = nil,
        choiceAvailable: Bool = false, random: RandomBytes? = nil, state: String? = nil,
        codeVerifier: String? = nil
    ) throws -> PushedRequest {
        guard let redirectClass = classify(redirectUri) else {
            throw IdentityRedirect.invalid("redirectUri is not a native redirect URI.")
        }
        if let returnUri, classify(returnUri) != .scheme {
            throw IdentityRedirect.invalid("returnUri must be a registered scheme's redirect URI.")
        }
        for (name, value) in [
            ("request", requestEndpoint), ("authorize", authorizeEndpoint), ("token", tokenEndpoint),
        ] where !IdentityRedirect.isAbsoluteHttp(value) {
            throw IdentityRedirect.invalid("the \(name) endpoint is not an absolute URL.")
        }
        guard !issuer.isEmpty else { throw IdentityRedirect.invalid("discovery names no issuer.") }
        guard !clientId.isEmpty else { throw IdentityRedirect.invalid("clientId is empty.") }
        let state = state ?? IdentityRedirect.generateState(random: random)
        guard (IdentityRedirect.stateMin...IdentityRedirect.stateMax).contains(state.utf16.count),
            IdentityRedirect.isPrintable(state)
        else { throw IdentityRedirect.invalid("state must be 16 to 512 printable characters.") }
        let verifier = codeVerifier ?? IdentityRedirect.generateCodeVerifier(random: random)
        guard (IdentityRedirect.verifierMin...IdentityRedirect.verifierMax).contains(verifier.utf16.count),
            verifier.unicodeScalars.allSatisfy({
                switch $0.value {
                case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F, 0x7E: return true
                default: return false
                }
            })
        else { throw IdentityRedirect.invalid("the PKCE verifier must be 43 to 128 unreserved characters.") }
        if let nonce, !IdentityRedirect.isPrintable(nonce) {
            throw IdentityRedirect.invalid("nonce must be printable characters.")
        }

        var pairs: [(String, String)] = [
            ("response_type", "code"), ("client_id", clientId), ("redirect_uri", redirectUri),
            ("state", state), ("code_challenge", IdentityRedirect.pkceChallenge(verifier)),
            ("code_challenge_method", "S256"),
        ]
        if let scope { pairs.append(("scope", try IdentityRedirect.scopeString(scope))) }
        if let nonce, !nonce.isEmpty { pairs.append(("nonce", nonce)) }
        if let loginHint, !loginHint.isEmpty { pairs.append(("login_hint", loginHint)) }
        if let nameHint, !nameHint.isEmpty { pairs.append(("name_hint", nameHint)) }
        if let purpose, !purpose.isEmpty { pairs.append(("purpose", purpose)) }
        let sentChoice = licenseChoice == "app" && choiceAvailable
        if sentChoice { pairs.append(("license_choice", "app")) }
        if let deviceName, !deviceName.isEmpty { pairs.append(("device_name", deviceName)) }
        if let returnUri, !returnUri.isEmpty { pairs.append(("return_uri", returnUri)) }
        return PushedRequest(
            url: requestEndpoint, contentType: IdentityRedirect.tokenContentType,
            body: IdentityRedirect.formBody(pairs),
            pending: NativePending(
                redirectClass: redirectClass, redirectUri: redirectUri, state: state,
                codeVerifier: verifier, clientId: clientId, issuer: issuer,
                authorizeEndpoint: authorizeEndpoint, tokenEndpoint: tokenEndpoint,
                choiceApp: sentChoice))
    }

    /// Read the answer of `POST /<p>/identity/request`: `201 {request_uri, expires_in}`.
    static func parsePushedAnswer(status: Int, body: JSONValue?) -> PushedAnswer {
        let object = body?.objectValue
        if status != 201 {
            let error = object?["error"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "server_error"
            var retry: Int?
            if let seconds = object?["retryAfter"]?.doubleValue, seconds.isFinite, seconds > 0 {
                retry = Int(min(seconds.rounded(.up), 3600))
            }
            return .refused(error: error, status: status, retryAfterSeconds: retry)
        }
        guard let object, let uri = object["request_uri"]?.stringValue,
            wholeMatches(requestUriPattern, uri) != nil,
            case .int(let expiresIn)? = object["expires_in"], expiresIn >= 1,
            expiresIn <= pushedRequestTtlSeconds
        else { return .malformed }
        return .pushed(requestUri: uri, expiresIn: expiresIn)
    }

    // ── 5. The authorize URL ─────────────────────────────────────────────────────────────

    /// `authorize?client_id=<id>&request_uri=<uri>`: the only parameters a pushed request takes.
    static func authorizeUrl(endpoint: String, clientId: String, requestUri: String) throws -> String {
        guard wholeMatches(requestUriPattern, requestUri) != nil else {
            throw IdentityRedirect.invalid("not a pushed request URI.")
        }
        return "\(endpoint)\(endpoint.contains("?") ? "&" : "?")client_id=\(ManageLink.formEncode(clientId))"
            + "&request_uri=\(ManageLink.formEncode(requestUri))"
    }

    // ── 6. The redirect back ─────────────────────────────────────────────────────────────

    /// Constant-time string equality (no early exit on the first differing byte).
    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8)
        let y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<max(x.count, y.count) {
            diff |= Int((i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0))
        }
        return diff == 0
    }

    /// `scheme:` + authority lower-cased, path as given. Nil for anything not an absolute URL.
    private static func baseOf(_ url: String) -> String? {
        guard let colon = url.firstIndex(of: ":") else { return nil }
        let scheme = url[..<colon]
        guard let first = scheme.utf8.first, (0x41...0x5A).contains(first) || (0x61...0x7A).contains(first),
            scheme.utf8.allSatisfy({
                (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0)
                    || $0 == 0x2B || $0 == 0x2E || $0 == 0x2D
            })
        else { return nil }
        var rest = url[url.index(after: colon)...]
        var authority = ""
        if rest.hasPrefix("//") {
            let host = rest.dropFirst(2).prefix(while: { $0 != "/" && $0 != "?" && $0 != "#" })
            authority = "//" + host
            rest = rest.dropFirst(2 + host.count)
        }
        let urlPath = rest.prefix(while: { $0 != "?" && $0 != "#" })
        return "\(scheme.lowercased()):\(authority.lowercased())\(urlPath)"
    }

    /// Check the redirect back to the app. The first failure wins, in this order: an absolute URL
    /// with no fragment; at the redirect URI the request named; no repeated parameter; `state`
    /// (constant time); `iss` (RFC 9207: a callback with no `iss` is refused); `error`
    /// (`access_denied` is `cancelled`); `code`; no parameter beyond `code state iss request` (or
    /// `error error_description state iss request`); on loopback, `request=` an `rq_` handle (a
    /// scheme or claimed delivery has none, and one that carries it must still hold a valid one).
    static func parseCallback(
        state: String, issuer: String, redirectUri: String, redirectClass: NativeRedirectClass? = nil,
        callbackUrl: String
    ) -> NativeCallbackResult {
        func fail(_ reason: NativeCallbackFailure, _ error: String? = nil) -> NativeCallbackResult {
            .failed(reason, error: error)
        }
        guard !callbackUrl.contains("#") else { return fail(.malformed) }
        guard let got = baseOf(callbackUrl), let want = baseOf(redirectUri) else { return fail(.malformed) }
        guard got == want else { return fail(.redirectMismatch) }
        guard let q = IdentityRedirect.query(of: callbackUrl) else { return fail(.malformed) }
        guard let sentState = q["state"], constantTimeEqual(sentState, state) else {
            return fail(.stateMismatch)
        }
        guard let iss = q["iss"], constantTimeEqual(iss, issuer) else { return fail(.issuerMismatch) }
        let error = q["error"]
        let code = q["code"]
        if error == nil && (code == nil || code == "") { return fail(.missingCode) }
        let allowed = error != nil ? errorParams : successParams
        if q.keys.contains(where: { !allowed.contains($0) }) { return fail(.unexpectedParameter) }
        let request = q["request"]
        let loopback = (redirectClass ?? classify(redirectUri)) == .loopback
        if let request {
            if wholeMatches(requestHandlePattern, request) == nil { return fail(.requestInvalid) }
        } else if loopback && error == nil {
            return fail(.requestInvalid)
        }
        if let error {
            return error == "access_denied" ? .cancelled(request: request) : fail(.authorizationError, error)
        }
        return .code(code ?? "", request: request)
    }

    static func parseCallback(_ pending: NativePending, _ callbackUrl: String) -> NativeCallbackResult {
        parseCallback(
            state: pending.state, issuer: pending.issuer, redirectUri: pending.redirectUri,
            redirectClass: pending.redirectClass, callbackUrl: callbackUrl)
    }

    // ── 7. The token request ─────────────────────────────────────────────────────────────

    /// The form body of `POST /<p>/identity/token` for a code from a pushed request (§12.5): the
    /// same form as the web redirect, redeemed from the pushing device (`X-PKey-Device`, which the
    /// request sender adds; a different device is `invalid_grant`). The label went with the push
    /// and is not repeated.
    static func tokenForm(_ pending: NativePending, code: String) -> String {
        IdentityRedirect.tokenForm(
            clientId: pending.clientId, codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri, code: code)
    }
}
