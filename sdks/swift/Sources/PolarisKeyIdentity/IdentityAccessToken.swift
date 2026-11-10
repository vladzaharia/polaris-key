// `identity.accessToken(refresh:)` (identity.accesstoken, D6, WIRE-CONTRACT-V5 §12.13.10): the app's own
// short-lived access token for its own backend, from its device token (RFC 8693 device exchange).
// Mirrors `@polaris-key/node`'s `identity/accessToken.ts` and Python's `identity/access_token.py`.
//
// WHAT IT PROVES: this device holds a sign-in (`sub` is the device's pairwise subject, `client_id` the
// product). It is NOT a licence check: no tier, no entitlement, and a signed-in device has one whether or
// not its licence is valid. A backend that sells a licensed feature also checks the licence (the server
// drop-ins).
//
// Discovery gates it: only a product whose identity fragment carries `accessToken: true` (its issuer is
// served) is asked; otherwise the call is the typed `service-unavailable` with no request. The token lives
// in memory only (never stored, never logged), is reused until 60 seconds before it expires (§12.13.10
// rule 4, not the 30 minute document margin), is asked for once at a time, is bound to the device token
// it was asked with (another token is a miss) and is dropped at sign-out. After a 429 nothing is asked
// until the wait has passed. The endpoint must be on the Worker's origin and is never followed through a
// redirect. The SDK never verifies the token: the backend does, against the issuer's key set.

import Foundation
import PolarisKeyCore

/// What `accessToken(refresh:)` answers.
public struct AccessToken: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The compact `at+jwt`, for `Authorization: Bearer …` on the app's own backend. Kept in memory
    /// only: never stored, never logged.
    public let accessToken: String
    public let tokenType: String
    /// Seconds left on the token when it was handed out. A fresh exchange answers 600.
    public let expiresIn: Int
    /// Epoch seconds, by the SDK's clock.
    public let expiresAt: Int

    public init(accessToken: String, tokenType: String = "Bearer", expiresIn: Int, expiresAt: Int) {
        self.accessToken = accessToken
        self.tokenType = tokenType
        self.expiresIn = expiresIn
        self.expiresAt = expiresAt
    }

    public var description: String { "AccessToken(expiresIn: \(expiresIn), expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
}

/// §12.13.10 rule 4: a cached token is reused until this many seconds before it expires.
let accessTokenReuseMarginSeconds = 60
/// The longest `access_token` accepted: a longer value is `bad_response`.
let maxAccessTokenCharacters = 8192

private let tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange"
private let deviceSubjectTokenType = "urn:polaris-key:token-type:device"
private let accessTokenType = "urn:ietf:params:oauth:token-type:access_token"

/// The one in-memory access token of a client. `get` returns the held token while it was asked for with
/// the same `key` (the device token) and more than 60 seconds remain, and otherwise runs `exchange` once:
/// callers with the same key that arrive while it runs share its answer, a caller with another key does
/// not. `refresh` skips the held token; it still joins an exchange in flight. A refused or failed exchange
/// is not cached. After `holdOff` no exchange starts until the time has passed. `clear` drops the token
/// and detaches any exchange in flight, so its answer is not kept after a sign-out.
actor AccessTokenCache {
    private struct Flight {
        let id: Int
        let key: String
        let task: Task<AccessToken, Error>
    }

    private var held: (key: String, token: AccessToken)?
    private var flight: Flight?
    private var generation = 0
    private var nextId = 0
    private var notBefore = 0

    /// No exchange starts before `time` (epoch seconds): a 429's wait. The limit is the device's, so a
    /// sign-out does not lift it.
    func holdOff(until time: Int) { notBefore = max(notBefore, time) }

    func get(
        key: String, refresh: Bool, now: @escaping @Sendable () async -> Int,
        exchange: @escaping @Sendable () async throws -> (token: String, expiresIn: Int)
    ) async throws -> AccessToken {
        let t = await now()
        if !refresh, let held, held.key == key, held.token.expiresAt - accessTokenReuseMarginSeconds > t {
            return AccessToken(
                accessToken: held.token.accessToken, expiresIn: held.token.expiresAt - t,
                expiresAt: held.token.expiresAt)
        }
        if let flight, flight.key == key { return try await flight.task.value }
        if notBefore > t {
            let wait = notBefore - t
            throw PolarisError(
                code: ErrorCode.rateLimited,
                message: "too many access token requests: try again in \(wait) seconds.",
                status: 429, retryAfterSeconds: wait)
        }
        nextId += 1
        let id = nextId
        let started = generation
        let task = Task<AccessToken, Error> {
            let grant = try await exchange()
            let at = await now()
            return AccessToken(
                accessToken: grant.token, expiresIn: grant.expiresIn, expiresAt: at + grant.expiresIn)
        }
        flight = Flight(id: id, key: key, task: task)
        do {
            let token = try await task.value
            // Kept only while this is still the client's exchange: a `clear()` (sign-out) or a call with
            // another device token while it ran means the answer is not ours to keep.
            if generation == started, flight?.id == id { held = (key, token) }
            if flight?.id == id { flight = nil }
            return token
        } catch {
            if flight?.id == id { flight = nil }
            throw error
        }
    }

    func clear() {
        generation += 1
        held = nil
        flight = nil
    }
}

extension IdentityClient {
    /// An access token (`at+jwt`, 600 seconds) for the app's own backend, from this device's own sign-in
    /// (RFC 8693 device exchange). `.accessToken` goes in `Authorization: Bearer …`.
    ///
    /// It proves that this device holds a sign-in. It is NOT a licence check: it carries no tier and no
    /// entitlement, and a signed-in device has one whether or not its licence is valid. A backend that
    /// sells a licensed feature also checks the licence (the server drop-ins).
    ///
    /// Only when discovery names `accessToken` (the product's sign-in issuer is served); otherwise this
    /// throws the typed `service-unavailable` before any request. A device with no sign-in is `no-token`
    /// (nothing sent). The token is held in memory only (never stored, never logged), reused until 60
    /// seconds before it expires, asked for once at a time and dropped at sign-out; `refresh: true` asks
    /// again (an app whose backend refused it). A refusal keeps its wire code (`invalid_grant`: not signed
    /// in; `rate_limited` with `retryAfterSeconds`) and is not cached. The SDK never verifies the token:
    /// the backend does, against the issuer's key set.
    public func accessToken(refresh: Bool = false) async throws -> AccessToken {
        if await core.discoveryDocument == nil { await core.discover() }
        try await core.requireService(.identity, feature: Feature.identityAccesstoken)
        guard let fragment = await core.discoveryDocument?.identity, fragment.accessToken,
            let raw = fragment.token
        else {
            throw accessTokenUnavailable(
                "this product's discovery names no access token exchange: its sign-in issuer is not served")
        }
        guard let endpoint = URL(string: raw), sameOrigin(endpoint, core.endpoints.url("")) else {
            throw accessTokenUnavailable("this product's access token endpoint is not on the Worker's origin")
        }
        // Read at the time of the call: a device that is not signed in has none, and nothing is sent.
        guard let deviceToken = await core.token else {
            throw PolarisError(
                code: ErrorCode.noToken, message: "Sign in before asking for an access token.")
        }
        let core = self.core
        do {
            return try await accessTokens.get(
                key: deviceToken, refresh: refresh, now: { await core.now() },
                exchange: { try await IdentityClient.exchangeAccessToken(core, endpoint, deviceToken) })
        } catch let error as PolarisError {
            if error.code == ErrorCode.invalidGrant {
                // The Worker's one refusal for a device that holds no sign-in: nothing held is good any more.
                await accessTokens.clear()
            } else if error.code == ErrorCode.rateLimited, let wait = error.retryAfterSeconds, wait > 0 {
                await accessTokens.holdOff(until: await core.now() + wait)
            }
            throw error
        }
    }

    /// Drop the held access token (sign-out, deactivation).
    package func clearAccessToken() async { await accessTokens.clear() }

    private func accessTokenUnavailable(_ detail: String) -> PolarisError {
        let unsupported = Unsupported(
            feature: Feature.identityAccesstoken, reason: UnsupportedReason.product, detail: detail)
        return PolarisError(
            code: PolarisError.serviceUnavailable, message: detail, detail: unsupported.detail,
            unsupported: unsupported)
    }

    /// The exchange form, member order fixed so every SDK sends the same bytes.
    static func accessTokenForm(clientId: String, deviceToken: String) -> String {
        [
            ("grant_type", tokenExchangeGrantType), ("client_id", clientId),
            ("subject_token", deviceToken), ("subject_token_type", deviceSubjectTokenType),
            ("requested_token_type", accessTokenType),
        ].map { "\(ManageLink.formEncode($0.0))=\(ManageLink.formEncode($0.1))" }.joined(separator: "&")
    }

    /// Read a `200` answer: exactly an `access_token` (a compact JWS of at most 8 KiB),
    /// `issued_token_type` the access-token type, `token_type` `Bearer` and a positive integer
    /// `expires_in`; anything else is `bad_response`. Nothing is verified.
    static func readAccessToken(_ body: Data) throws -> (token: String, expiresIn: Int) {
        let object = (try? JSONDecoder().decode(JSONValue.self, from: body))?.objectValue ?? [:]
        let parts = object["access_token"]?.stringValue?.split(
            separator: ".", omittingEmptySubsequences: false)
        if let token = object["access_token"]?.stringValue, let parts, parts.count == 3,
            token.count <= maxAccessTokenCharacters,
            parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(isBase64URL) }),
            object["issued_token_type"]?.stringValue == accessTokenType,
            object["token_type"]?.stringValue == "Bearer",
            let expires = object["expires_in"]?.intValue, expires > 0
        {
            return (token, expires)
        }
        throw PolarisError(
            code: ErrorCode.badResponse,
            message: "the access token exchange answered without a usable access token.")
    }

    private static func exchangeAccessToken(
        _ core: CoreContext, _ endpoint: URL, _ deviceToken: String
    ) async throws -> (token: String, expiresIn: Int) {
        let body = Data(accessTokenForm(clientId: core.product, deviceToken: deviceToken).utf8)
        let response: PolarisResponse
        do {
            response = try await core.transport.send(
                PolarisRequest(
                    url: endpoint, method: "POST",
                    headers: core.headers(["content-type": "application/x-www-form-urlencoded"]),
                    body: body, timeoutSeconds: core.requestTimeoutSeconds,
                    // The device token is in the body: never replay it at a redirect's address.
                    followRedirects: false))
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "\(error)")
        }
        if (300..<400).contains(response.status) {
            throw PolarisError(
                code: ErrorCode.badResponse,
                message: "the access token endpoint answered with a redirect.", status: response.status)
        }
        guard response.status == 200 else { throw accessTokenRefusal(response) }
        return try readAccessToken(response.body)
    }

    /// A refusal keeps the Worker's wire code; a 429's wait is the `Retry-After` header, else the body's
    /// `retryAfter` (the recording carries only that), rounded up.
    private static func accessTokenRefusal(_ response: PolarisResponse) -> PolarisError {
        let object = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue ?? [:]
        let code = object["error"]?.objectValue?["code"]?.stringValue ?? object["error"]?.stringValue
        if response.status >= 500 {
            return PolarisError(
                code: IdentityClient.serverError,
                message: object["message"]?.stringValue
                    ?? "the access token exchange failed with status \(response.status).",
                status: response.status)
        }
        var wait: Int?
        if let header = response.header("retry-after"), let n = Int(header.trimmingCharacters(in: .whitespaces)),
            n >= 0
        {
            wait = n
        } else if let seconds = object["retryAfter"]?.doubleValue, seconds.isFinite, seconds >= 0 {
            wait = Int(min(seconds.rounded(.up), Double(Int32.max)))
        }
        let fallback = response.status == 429 ? ErrorCode.rateLimited : "http_\(response.status)"
        return PolarisError(
            code: code ?? fallback,
            message: "the access token exchange was refused (status \(response.status)).",
            status: response.status, retryAfterSeconds: wait)
    }
}

private func isBase64URL(_ c: Character) -> Bool {
    c.isASCII && (c.isLetter || c.isNumber || c == "-" || c == "_")
}

/// Scheme, host and port of both, the port defaulted.
private func sameOrigin(_ a: URL, _ b: URL) -> Bool {
    func origin(_ u: URL) -> (String, String, Int)? {
        guard let scheme = u.scheme?.lowercased(), let host = u.host?.lowercased() else { return nil }
        return (scheme, host, u.port ?? (scheme == "https" ? 443 : 80))
    }
    guard let x = origin(a), let y = origin(b) else { return false }
    return x == y
}
