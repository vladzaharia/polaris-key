// The nearby approval routes for the new device D (WIRE-CONTRACT-V5 §12.11.5): `nearby/start` and
// `nearby/poll`. The LAN half (adverts, the code, `VOUCH_REQ`) is the Connect code's, and the session that
// joins the two is `NearbySignInSession` (NearbySession.swift). Mirrors sdk-node's `identity/nearby.ts`.
//
// What this file keeps:
//  - an endpoint is used only when discovery names it and it lies inside the product; a product whose
//    discovery names none answers the typed `service-unavailable` N/A before any request;
//  - every route carries a `pkey-proof/1` proof (§12.11.1) signed through the device key port, so a private key
//    never leaves it. `start`: value `<signKey>.<agreeKey>`; `poll`: the request handle. Line 6 is `-`;
//  - D's `poll` is signed by the key D sent on `start`: the handle remembers that `signKey`, and a poll after the
//    device's keys changed is refused locally rather than sent;
//  - `start` sends D's bearer when D holds a credential, and never invents one; `poll` sends none;
//  - `poll` answers the token once. It is held UNCONFIRMED (CoreContext.setUnconfirmedToken): no sign-in, no
//    stored subject and no `signedIn` event until the person confirms the account;
//  - a 404 of `poll` is the same bytes whether the request is unknown or the routes went away (N11): it reads as
//    `unavailable` only after a fresh discovery read no longer names nearby approval;
//  - the request handle, the proofs and the token are in no description, mirror or error message.

import Foundation
import PolarisKeyCore

/// `nearby/start`'s answer. `request` is a secret: it prints as nothing.
struct NearbyStarted: Sendable, CustomStringConvertible, CustomReflectable {
    /// The request handle (`nr_…`): give it to the LAN request and nothing else.
    let request: String
    /// Seconds the request lives (300).
    let expiresIn: Int
    /// Seconds between polls (3).
    let interval: Int
    /// The signing key D sent: `poll` is signed by it, or not sent.
    let signKey: String

    var description: String { "NearbyStarted(expiresIn: \(expiresIn), interval: \(interval))" }
    var customMirror: Mirror {
        Mirror(self, children: ["expiresIn": expiresIn, "interval": interval], displayStyle: .struct)
    }
}

/// What a ready poll carried, other than the token (which stays in Core).
struct NearbyReady: Sendable, Equatable {
    /// The access token the poll stored, so the session can tell its own sign-in from a later one.
    let token: String
    let subject: String
    let scope: String
    let licenseId: String?
    let identity: SignInIdentity?
}

extension NearbyReady: CustomStringConvertible, CustomReflectable {
    var description: String { "NearbyReady(token: \(redactedCredential), scope: \(scope))" }
    var customMirror: Mirror { Mirror(self, children: ["scope": scope], displayStyle: .struct) }
}

/// One `nearby/poll` answer. A denial and a lapse are outcomes, not errors.
enum NearbyPoll: Sendable, Equatable {
    case pending
    case slowDown(interval: Int)
    case timeout
    case denied
    /// The routes went away (a 404 after a fresh discovery lost `nearby`).
    case unavailable
    case ready(NearbyReady)
}

/// A poll that said nothing about the sign-in (no answer, a 5xx): the loop rides it out, at the Worker's
/// `Retry-After` when it named one.
struct NearbyTransient: Error, Sendable, Equatable {
    var retryAfterSeconds: Int?
}

private let requestPattern = "^nr_[A-Za-z0-9_-]{22}$"

private let longestRetry = 60

extension IdentityClient {
    private func nearbyUnavailable(_ detail: String) -> PolarisError {
        let u = Unsupported(feature: Feature.identityNearby, reason: UnsupportedReason.product, detail: detail)
        return PolarisError(
            code: PolarisError.serviceUnavailable, message: "Nearby sign-in is not available here.",
            detail: detail, unsupported: u)
    }

    /// The endpoint discovery names, else the typed N/A. Nothing is sent before this answers.
    private func nearbyEndpoint(_ name: String, fresh: Bool = false) async throws -> URL {
        if fresh {
            _ = await core.discover()
        } else if await core.discoveryDocument == nil {
            await core.discover()
        }
        try await core.requireService(.identity, feature: Feature.identityNearby)
        let fragment = await core.discoveryDocument?.identity
        guard let fragment, fragment.nearby, let raw = fragment.endpoints[name], !raw.isEmpty else {
            throw nearbyUnavailable("this product's discovery does not name nearby approval")
        }
        // The device's headers and proof go nowhere but this product.
        let prefix = core.endpoints.url("").absoluteString
        guard let url = URL(string: raw), raw.hasPrefix(prefix) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "an identity endpoint points outside this product.")
        }
        return url
    }

    private func nearbyPost(_ url: URL, _ body: [String: JSONValue]) async throws -> PolarisResponse {
        let data = try JSONEncoder().encode(JSONValue.object(body))
        do {
            return try await core.request(
                url, method: "POST", headers: ["content-type": "application/json"], body: data)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "nearby sign-in could not reach the Worker.")
        }
    }

    private func nearbyProof(
        _ port: any DeviceKeyPort, _ purpose: DeviceProofPurpose, deviceId: String, value: String
    ) async throws -> String {
        // Conformance replay only: a proof by another key or over another value.
        if let sign = nearbyProofSigner.current {
            return try await sign(
                port,
                DeviceProofFields(purpose: purpose.rawValue, product: core.product, deviceId: deviceId, value: value))
        }
        do {
            return try await DeviceProofs.sign(
                port, purpose: purpose, product: core.product, deviceId: deviceId, value: value
            ).sig
        } catch {
            throw PolarisError(
                code: ErrorCode.signInFailed, message: "this device could not sign the nearby sign-in proof.")
        }
    }

    /// The Worker's error code of a refusal: the nested `{error:{code}}` or a flat `{error}`, else the
    /// registry code of the status.
    private func nearbyRefusalCode(_ response: PolarisResponse) -> String {
        let object = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue
        if let code = object?["error"]?.objectValue?["code"]?.stringValue, !code.isEmpty { return code }
        if let code = object?["error"]?.stringValue, !code.isEmpty { return code }
        switch response.status {
        case 429: return ErrorCode.rateLimited
        case 500...: return IdentityClient.serverError
        case 404: return ErrorCode.notFound
        case 403: return ErrorCode.forbidden
        case 401: return ErrorCode.unauthorized
        case 400: return ErrorCode.badRequest
        default: return ErrorCode.httpError
        }
    }

    /// `POST nearby/start`: D asks to be approved, sending its two public keys. Throws the typed N/A when
    /// discovery names no nearby approval or the route is off (`404`), and a `PolarisError` carrying the
    /// Worker's code and status for a refusal (`invalid_grant`, `device_keys_invalid`, `rate_limited`, ...).
    func nearbyStart(deviceName: String?) async throws -> NearbyStarted {
        let url = try await nearbyEndpoint("nearbyStart")
        _ = try await nearbyEndpoint("nearbyPoll")
        guard let binding = nearbyBinding.current else {
            throw PolarisError(
                code: PolarisError.serviceUnavailable, message: "nearby sign-in is not set up on this client.")
        }
        let (port, deviceId) = try await binding.signer()
        let keys = try await port.ensure()
        var body: [String: JSONValue] = [
            "signKey": .string(keys.signKey), "agreeKey": .string(keys.agreeKey),
        ]
        // §12.7.1: the per-call name, else the client's, else the platform default; "" sends none.
        if let label = await core.deviceLabel(deviceName) { body["deviceName"] = .string(label) }
        body["proof"] = .string(
            try await nearbyProof(port, .nearbyStart, deviceId: deviceId, value: "\(keys.signKey).\(keys.agreeKey)"))
        // A device id that already holds a credential proves it by that bearer; none is ever invented.
        var headers = ["content-type": "application/json"]
        if let bearer = await core.token { headers["authorization"] = "Bearer \(bearer)" }
        let response: PolarisResponse
        do {
            response = try await core.request(
                url, method: "POST", headers: headers, body: try JSONEncoder().encode(JSONValue.object(body)))
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "nearby sign-in could not reach the Worker.")
        }
        // The gate is off (the Worker rolled back after our discovery): start has no other 404.
        if response.status == 404 { throw nearbyUnavailable("this product does not serve nearby approval") }
        guard response.status == 201 else {
            throw PolarisError(
                code: nearbyRefusalCode(response), message: "nearby sign-in could not start.", status: response.status)
        }
        let object = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue
        guard let request = object?["request"]?.stringValue, wholeMatches(requestPattern, request) != nil,
            let expiresIn = wholeSeconds(object?["expiresIn"]?.doubleValue),
            let interval = wholeSeconds(object?["interval"]?.doubleValue)
        else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "nearby start answered without a complete request.")
        }
        return NearbyStarted(request: request, expiresIn: expiresIn, interval: interval, signKey: keys.signKey)
    }

    /// `POST nearby/poll`: one poll of D's request, signed by the key D started it with. A token is held
    /// unconfirmed and answered once as `ready`. A `429` is `slowDown`; a 5xx or a lost connection throws
    /// `NearbyTransient` and keeps the request. Pacing is the caller's.
    func nearbyPoll(_ started: NearbyStarted) async throws -> NearbyPoll {
        let url = try await nearbyEndpoint("nearbyPoll")
        guard let binding = nearbyBinding.current else {
            throw PolarisError(
                code: PolarisError.serviceUnavailable, message: "nearby sign-in is not set up on this client.")
        }
        let (port, deviceId) = try await binding.signer()
        guard let keys = try await port.publicKeys(), keys.signKey == started.signKey else {
            throw PolarisError(
                code: ErrorCode.signInFailed, message: "this device's keys changed since nearby sign-in started.")
        }
        let proof = try await nearbyProof(port, .nearbyPoll, deviceId: deviceId, value: started.request)
        let response: PolarisResponse
        do {
            response = try await nearbyPost(url, ["request": .string(started.request), "proof": .string(proof)])
        } catch let error as PolarisError where error.code == IdentityClient.networkError {
            throw NearbyTransient()
        }
        if response.status == 404 {
            // N11: the same bytes whether the request is unknown or the routes went away.
            do { _ = try await nearbyEndpoint("nearbyPoll", fresh: true) } catch let error as PolarisError
                where error.code == PolarisError.serviceUnavailable
            { return .unavailable }
            throw PolarisError(code: ErrorCode.notFound, message: "nearby sign-in was not found.", status: 404)
        }
        if response.status >= 500 {
            let retry = response.header("retry-after").flatMap {
                Int($0.trimmingCharacters(in: .whitespaces))
            }
            throw NearbyTransient(retryAfterSeconds: retry.map { min(max($0, 0), longestRetry) })
        }
        let answer = (try? JSONDecoder().decode(JSONValue.self, from: response.body))?.objectValue
        if response.status == 429 {
            return .slowDown(interval: wholeSeconds(answer?["interval"]?.doubleValue) ?? started.interval + 5)
        }
        guard response.status == 200 else {
            throw PolarisError(
                code: nearbyRefusalCode(response), message: "nearby sign-in was refused.", status: response.status)
        }
        guard let answer else {
            throw PolarisError(code: ErrorCode.badResponse, message: "nearby poll answered without a body.")
        }
        switch answer["status"]?.stringValue {
        case "pending": return .pending
        case "timeout": return .timeout
        case "error":
            if answer["reason"]?.stringValue == "access_denied" { return .denied }
            throw PolarisError(code: ErrorCode.signInFailed, message: "nearby sign-in failed.")
        case nil: break
        default: throw PolarisError(code: ErrorCode.signInFailed, message: "nearby sign-in failed.")
        }
        guard
            case .token(let accessToken, let scope, let subject, _, _, let license) = IdentityRedirect.parseTokenAnswer(
                status: 200, body: .object(answer)),
            wholeMatches(PAIRWISE_SUBJECT_PATTERN, subject) != nil
        else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "nearby poll answered without a complete sign-in.")
        }
        // Held unconfirmed (V5 §15.6.1 rule 12): not a sign-in, no stored subject and no `signedIn` event
        // until the person confirms the account, so Cloud Sync and Connect do not start for an account nobody
        // accepted. A mark that cannot be written fails the poll and stores nothing.
        do { try await core.setUnconfirmedToken(accessToken) } catch {
            throw PolarisError(
                code: ErrorCode.signInFailed, message: "nearby sign-in could not store the sign-in.")
        }
        if redirectAcquisitionSync.current { await onAcquired?() }
        func text(_ key: String) -> String? {
            license?[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        }
        let name = text("name")
        let email = text("email")
        let cachedLicense = await core.cache().license?.doc.licenseId
        return .ready(
            NearbyReady(
                token: accessToken, subject: subject, scope: scope,
                licenseId: text("id") ?? cachedLicense,
                identity: name == nil && email == nil ? nil : SignInIdentity(name: name, email: email)))
    }
}
