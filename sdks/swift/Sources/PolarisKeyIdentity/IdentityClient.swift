// The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete a
// browser redirect: a CLI, a daemon, a TV app, a kiosk.
//
//   signIn.start(_:)          SignInSession.swift: `POST /<p>/identity/auth/device/start` → a
//                             `SignInSession` with the code the player types and the two
//                             verification URIs (the complete one, with the code in it, is the
//                             QR payload). The device code — the POLL credential — stays inside
//                             the session. `session.wait()` is the paced loop: at least
//                             `interval` between polls, longer after a `slow_down`, never faster
//                             because a poll failed, stopped by expiry or `cancel()`.
//
// This file holds the two requests the session drives (`startDeviceCode`, `pollDeviceCode`) and
// the loop (`waitDeviceCode`); they are internal, and the tests reach them through the session.
//
// A `ready` poll stores the device token through Core and raises the acquisition event, so the
// facade's forced sync runs exactly as it does after activation.
//
// A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else. The
// Worker's callback merges nothing (P1-06): a device on an anonymous enrolled licence is not
// attached to the account by signing in, and nothing here offers or implies that it is.
//
// Its own target, depending on Core only, so a host that wants just the sign-in flow can link
// `PolarisKeyIdentity` alone. The umbrella `PolarisKey` target depends on it and re-exports it
// (the facade exposes `client.identity`), so a one-import adopter gets these types too — unlike
// Update, which stays out of the umbrella. Mirrors `@polaris-key/node`'s `identity/client.ts`.

import Foundation
import PolarisKeyCore

/// What the host shows the player, plus the poll credential the SDK keeps using. Printing it
/// (`print`, `String(describing:)`, `debugPrint`, `dump`) shows `deviceCode` as `[redacted]`.
public struct SignInPrompt: Sendable, Equatable {
    /// The poll credential. Never show it, never put it in a URL.
    public let deviceCode: String
    /// What the player types on the verification page, e.g. `WDJB-MJHT`.
    public let userCode: String
    /// The page the player opens and types the code into.
    public let verificationUri: String
    /// The same page with the code pre-filled — the payload for a QR code or a link.
    public let verificationUriComplete: String
    /// Seconds the code lives for, as the server advertised it.
    public let expiresIn: Int
    /// The minimum seconds between polls, as the server advertised it.
    public let interval: Int
    /// When the code expires on THIS client's clock (epoch seconds).
    public let expiresAt: Int
    /// The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo, else (an
    /// older Worker) the label sent; `nil` when there is none.
    public let deviceName: String?

    public init(
        deviceCode: String, userCode: String, verificationUri: String,
        verificationUriComplete: String, expiresIn: Int, interval: Int, expiresAt: Int,
        deviceName: String? = nil
    ) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.verificationUriComplete = verificationUriComplete
        self.expiresIn = expiresIn
        self.interval = interval
        self.expiresAt = expiresAt
        self.deviceName = deviceName
    }
}

extension SignInPrompt: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "SignInPrompt(deviceCode: \(redactedCredential), userCode: \(userCode), "
            + "verificationUri: \(verificationUri), "
            + "verificationUriComplete: \(verificationUriComplete), expiresIn: \(expiresIn), "
            + "interval: \(interval), expiresAt: \(expiresAt), "
            + "deviceName: \(deviceName ?? "nil"))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "deviceCode": redactedCredential, "userCode": userCode,
                "verificationUri": verificationUri,
                "verificationUriComplete": verificationUriComplete, "expiresIn": expiresIn,
                "interval": interval, "expiresAt": expiresAt, "deviceName": deviceName as Any,
            ], displayStyle: .struct)
    }
}

/// What a redacted credential prints as.
let redactedCredential = "[redacted]"

/// The signed-in identity the Worker shows the device: a name and a verified e-mail, never the
/// subject or other claims.
public struct SignInIdentity: Sendable, Equatable, Decodable {
    public let name: String?
    public let email: String?

    public init(name: String? = nil, email: String? = nil) {
        self.name = name
        self.email = email
    }
}

/// What a completed sign-in carries (P1-06's residual, P1-07).
public struct SignInReady: Sendable, Equatable {
    /// Who the device is now signed in as, when the Worker said (device-code flows).
    public let identity: SignInIdentity?
    /// `claimed` or `migrated` when the device's anonymous enrolled licence was attached to the
    /// account on the player's opt-in; nil when nothing was attached.
    public let attached: String?
    /// The account's subject, when the Worker said (held for `identity.account`).
    public let subject: String?
    /// Redirect channel: the granted scope, space-delimited.
    public let scope: String?
    /// Redirect channel: the licence the device runs on; nil on a device with none.
    public let licenseId: String?

    public init(
        identity: SignInIdentity? = nil, attached: String? = nil, subject: String? = nil,
        scope: String? = nil, licenseId: String? = nil
    ) {
        self.identity = identity
        self.attached = attached
        self.subject = subject
        self.scope = scope
        self.licenseId = licenseId
    }
}

/// One poll's answer.
public enum SignInPoll: Sendable, Equatable {
    /// The player has not finished yet.
    case pending
    /// Polled too fast: wait `interval` seconds before the next poll (RFC 8628 §3.5).
    case slowDown(interval: Int)
    /// Only with `confirmIdentity`: the flow is held at the signed-in identity so the device can
    /// show it ("Is this you?") and the player can accept it. `attachable` is
    /// true when this device holds an anonymous enrolled licence the account could take over.
    case confirm(identity: SignInIdentity, attachable: Bool)
    /// Signed in: the device token is stored and the post-acquisition sync has run.
    case ready(SignInReady)
    /// The code expired (or the server no longer knows it). Start again.
    case expired
    /// The sign-in failed or was refused. Start again. `code` is `ErrorCode.signInDenied` when the
    /// Worker answered its generic `error` (the provider failed, or the person pressed Deny; the
    /// server never says which).
    case error(message: String, code: String? = nil)
}

/// How the wait loop ended. Cancellation throws `CancellationError` instead. The session turns it
/// into a `SignInOutcome` or a `SignInError`.
enum SignInResult: Sendable, Equatable {
    case ready(SignInReady)
    /// Only with `confirmIdentity`: the flow is held at the signed-in identity.
    case confirm(identity: SignInIdentity, attachable: Bool)
    case expired
    case error(message: String, code: String? = nil)

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

/// One identity change the facade turns into the `identity` event.
public struct IdentityChange: Sendable, Equatable {
    public static let signedIn = "signedIn"
    public static let signedOut = "signedOut"
    public static let subjectChanged = "subjectChanged"

    public let kind: String
    public let subject: String?
    public let previous: String?

    public init(kind: String, subject: String? = nil, previous: String? = nil) {
        self.kind = kind
        self.subject = subject
        self.previous = previous
    }
}

/// Raised after a sign-in mints a credential; the facade syncs.
public typealias SignInAcquiredListener = @Sendable () async -> Void

/// RFC 8628 §3.5: a `slow_down` without an interval adds five seconds to the CURRENT interval, so
/// repeated interval-less answers keep lengthening it.
public let SLOW_DOWN_STEP_SECONDS = 5

/// The seconds the wait loop actually sleeps: never under one second (a zero or negative interval
/// would spin) and never past the code's own lifetime.
func pollDelay(interval: Int, expiresIn: Int) -> Int {
    min(max(interval, 1), max(expiresIn, 1))
}

/// A server's seconds rounded UP (a 0.5 is one second, not zero) and capped, so no conversion or
/// later `now + seconds` can trap. `nil` for anything that is not a positive, finite number.
func wholeSeconds(_ value: Double?) -> Int? {
    guard let value, value.isFinite, value > 0 else { return nil }
    return Int(min(value.rounded(.up), maxSeconds))
}

/// The longest wait or lifetime this client represents: about 68 years.
private let maxSeconds = Double(Int32.max)

public final class IdentityClient: Sendable {
    /// Client-side codes this module throws, beside the Worker's own.
    public static let networkError = "network-error"
    public static let serverError = "server-error"

    let core: CoreContext
    let onAcquired: SignInAcquiredListener?
    /// Conformance replay only: the exact `state` and verifier of a recorded redirect conversation.
    /// Conformance replay only: false skips the sync after a redirect token (the recordings of
    /// `redirect-web-*` hold the token exchange, not the sync that follows it).
    let redirectAcquisitionSync = LockedValue<Bool>(true)
    let redirectEntropy = LockedValue<(state: String?, codeVerifier: String?)?>(nil)
    /// The facade's local wipe after a released sign-out (`installSignOut`): the credential goes
    /// and the `license` event follows.
    let signOutHook = LockedValue<(@Sendable () async throws -> Void)?>(nil)
    /// The subject held from the last `subject()` or `attach`.
    let subjectValue = LockedValue<String?>(nil)
    /// `onBeforeSignOut` hooks, in registration order.
    let beforeSignOut = LockedValue<[SignOutHook]>([])
    /// Where the facade hears of a sign-in, a sign-out and a changed subject (`installIdentityEvents`).
    let identityEvents = LockedValue<(@Sendable (IdentityChange) -> Void)?>(nil)
    /// The device key port the platform exchange signs with (`installDeviceKeys`); nil until one
    /// is handed over, and then a `DeviceKeyStore` for the product, made on first use.
    let deviceKeys = LockedValue<(any DeviceKeyPort)?>(nil)
    /// The platform identity `autoSignIn()` uses and `signOut()` cleans up after.
    let platformProvider = LockedValue<(any PlatformIdentityProvider)?>(nil)
    /// Platform sessions waiting on `choice.complete`, by grant (see `platformSession`).
    let pendingPlatformSessions = LockedValue<[String: PendingPlatformSession]>([:])
    private let sleep: @Sendable (Double) async throws -> Void

    /// - Parameter sleep: how the wait loop waits between polls. Defaults to `Task.sleep`, which
    ///   throws `CancellationError` when the task is cancelled; tests inject a clock-driven one.
    public init(
        core: CoreContext,
        onAcquired: SignInAcquiredListener? = nil,
        sleep: (@Sendable (Double) async throws -> Void)? = nil
    ) {
        self.core = core
        self.onAcquired = onAcquired
        self.sleep =
            sleep ?? { seconds in
                try await Task.sleep(nanoseconds: IdentityClient.sleepNanoseconds(seconds))
            }
    }

    /// Hand over the device key port the platform exchange signs with (the same keys Connect
    /// uses). Nil keeps the product's `DeviceKeyStore`, made on first use.
    public func installDeviceKeys(_ port: (any DeviceKeyPort)?) { deviceKeys.set(port) }

    func notifyIdentity(_ change: IdentityChange) { identityEvents.current?(change) }

    /// Hold `subject` and say so when it differs from the one held before.
    func updateSubject(_ subject: String?) {
        let previous = subjectValue.with { held -> String? in
            let old = held
            held = subject
            return old
        }
        if previous != subject {
            notifyIdentity(
                IdentityChange(
                    kind: IdentityChange.subjectChanged, subject: subject, previous: previous))
        }
    }

    /// Hold the incoming person's subject BEFORE their token is installed, so a Cloud Sync request bound
    /// to the previous person is dropped by the host's person check instead of going out under the new
    /// token (HOST-BIND). Quiet: the change is announced by `announceSubject` once the token is in.
    /// Returns the subject held before.
    func holdSubjectFirst(_ subject: String?) -> String? {
        subjectValue.with { held -> String? in
            let old = held
            if let subject { held = subject }
            return old
        }
    }

    /// The token could not be installed: the previous subject is back, and nothing was announced.
    func restoreSubject(_ previous: String?, ifHeld subject: String?) {
        guard subject != nil else { return }
        subjectValue.with { held in if held == subject { held = previous } }
    }

    /// Say the subject changed (the sign-in is complete) when it differs from the one held before.
    func announceSubject(_ subject: String?, previous: String?) {
        if previous != subject {
            notifyIdentity(
                IdentityChange(kind: IdentityChange.subjectChanged, subject: subject, previous: previous))
        }
    }

    /// `seconds` as `Task.sleep`'s nanoseconds, clamped first: `UInt64(seconds * 1e9)` traps on a
    /// negative, non-finite or huge value.
    static func sleepNanoseconds(_ seconds: Double) -> UInt64 {
        let bounded = seconds.isFinite ? min(max(seconds, 0), maxSeconds) : 0
        return UInt64(bounded * 1_000_000_000)
    }

    /// Ask for a device code (`signIn.start`). Throws `PolarisError(service-unavailable)` before any request
    /// when this product does not run Identity (D-21).
    ///
    /// No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
    /// credential, and the server binds the flow to this device by its id.
    func startDeviceCode(deviceName: String? = nil) async throws -> SignInPrompt {
        try await core.requireService(.identity, feature: Feature.identityDevicecode)
        var body: [String: String] = ["deviceId": await core.deviceId]
        // §12.7.1: the per-call name, else `CoreOptions.deviceName`, else the platform default,
        // normalised exactly as the Worker will store it. `""` sends none.
        let label = await core.deviceLabel(deviceName)
        if let label { body["deviceName"] = label }
        let response = try await post("identity/auth/device/start", body)
        // Identity switched off since discovery: the route does not exist (§12.8).
        if response.status == 404 {
            throw PolarisError(
                code: ErrorCode.serviceUnavailable,
                message: "The Identity service is off for this product.")
        }
        guard response.status == 200 else {
            throw PolarisError(
                code: errorCode(response) ?? "sign-in-unavailable",
                message: "device sign-in could not start (status \(response.status)).")
        }
        guard let b = try? JSONDecoder().decode(StartBody.self, from: response.body),
            !b.deviceCode.isEmpty, !b.userCode.isEmpty, !b.verificationUri.isEmpty,
            !b.verificationUriComplete.isEmpty, let expiresIn = wholeSeconds(b.expiresIn),
            let interval = wholeSeconds(b.interval)
        else {
            throw PolarisError(
                code: "bad_response",
                message: "device sign-in start answered without a complete prompt.")
        }
        return SignInPrompt(
            deviceCode: b.deviceCode, userCode: b.userCode, verificationUri: b.verificationUri,
            verificationUriComplete: b.verificationUriComplete, expiresIn: expiresIn,
            interval: interval, expiresAt: await core.now() + expiresIn,
            // The echo is what the page shows; an older Worker sends none, so show what was sent.
            deviceName: b.echoed ? b.deviceName : label)
    }

    /// Poll once. On `.ready` the token is stored and the post-acquisition sync has completed
    /// before this returns.
    ///
    /// Throws `PolarisError(network-error)` when the request never got an answer and
    /// `PolarisError(server-error)` on a 5xx — neither says anything about the sign-in, so neither
    /// is folded into a status. The wait loop rides both out.
    ///
    /// P1-07's opt-in: with `confirmIdentity` the Worker holds the flow at the signed-in identity
    /// (`.confirm`) instead of completing it; the decision is then sent as `attachLicense` (with
    /// the device's bearer, which names the anonymous enrolled licence to attach). Without either,
    /// the poll completes exactly as before: the identity's own licence, nothing attached.
    func pollDeviceCode(
        _ prompt: SignInPrompt, confirmIdentity: Bool = false, attachLicense: Bool? = nil
    ) async throws -> SignInPoll {
        try await poll(
            prompt, current: prompt.interval, confirmIdentity: confirmIdentity,
            attachLicense: attachLicense)
    }

    /// One poll, where an interval-less `slow_down` lengthens `current` — the interval the caller
    /// is pacing at — rather than the prompt's original one.
    private func poll(
        _ prompt: SignInPrompt, current: Int, confirmIdentity: Bool = false,
        attachLicense: Bool? = nil
    ) async throws -> SignInPoll {
        try await core.requireService(.identity, feature: Feature.identityDevicecode)
        var ask: [String: JSONValue] = [
            "deviceCode": .string(prompt.deviceCode), "deviceId": .string(await core.deviceId),
        ]
        var bearer: String?
        if confirmIdentity || attachLicense != nil { ask["confirmIdentity"] = .bool(true) }
        if let attachLicense {
            ask["attachLicense"] = .bool(attachLicense)
            if attachLicense { bearer = await core.token }
        }
        let response = try await post("identity/auth/device/poll", ask, bearer: bearer)
        if response.status >= 500 {
            throw PolarisError(
                code: IdentityClient.serverError,
                message: "device sign-in poll failed with status \(response.status).")
        }
        let body = try? JSONDecoder().decode(PollBody.self, from: response.body)
        if response.status == 429 {
            // The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
            // answer 429 without one, which RFC 8628 §3.5 treats the same way.
            if let given = wholeSeconds(body?.interval) { return .slowDown(interval: given) }
            let (stepped, overflow) = current.addingReportingOverflow(SLOW_DOWN_STEP_SECONDS)
            return .slowDown(interval: overflow ? Int.max : stepped)
        }
        guard response.status == 200 else {
            return .error(message: "device sign-in poll refused (status \(response.status)).")
        }
        switch body?.status {
        case "pending":
            return .pending
        case "timeout":
            return .expired
        case "confirm":
            return .confirm(
                identity: body?.identity ?? SignInIdentity(), attachable: body?.attachable ?? false)
        case "ready":
            guard let token = body?.token, !token.isEmpty else {
                return .error(message: "ready without a token.")
            }
            let subject = body?.subject.flatMap { $0.isEmpty ? nil : $0 }
            let previous = holdSubjectFirst(subject)
            do { try await core.setToken(token, source: .signin, person: true) } catch {
                restoreSubject(previous, ifHeld: subject)
                throw error
            }
            await onAcquired?()
            notifyIdentity(IdentityChange(kind: IdentityChange.signedIn, subject: subject))
            return .ready(
                SignInReady(identity: body?.identity, attached: body?.attached, subject: subject))
        case "error":
            // A Deny names itself (`reason: access_denied`); a bare `error` failed after approval.
            return .error(
                message: "device sign-in failed.",
                code: body?.reason == "access_denied" ? ErrorCode.signInDenied : ErrorCode.signInFailed)
        default:
            return .error(message: "device sign-in failed.")
        }
    }

    /// Poll until the sign-in settles. The first poll waits one `interval` after the prompt was
    /// issued; a `slow_down` lengthens the interval for every later poll and never shortens it; a
    /// transient failure is retried at the SAME interval. Returns `.expired` once the prompt's
    /// `expiresAt` has passed, without asking the server. Cancelling the task stops polling and
    /// throws `CancellationError`.
    func waitDeviceCode(_ prompt: SignInPrompt, confirmIdentity: Bool = false) async throws
        -> SignInResult
    {
        try await wait(prompt, confirmIdentity: confirmIdentity, attachLicense: nil)
    }

    private func wait(_ prompt: SignInPrompt, confirmIdentity: Bool, attachLicense: Bool?)
        async throws -> SignInResult
    {
        try await core.requireService(.identity, feature: Feature.identityDevicecode)
        var interval = prompt.interval
        while true {
            try Task.checkCancellation()
            if await core.now() >= prompt.expiresAt { return .expired }
            try await sleep(Double(pollDelay(interval: interval, expiresIn: prompt.expiresIn)))
            try Task.checkCancellation()
            if await core.now() >= prompt.expiresAt { return .expired }
            let poll: SignInPoll
            do {
                poll = try await self.poll(
                    prompt, current: interval, confirmIdentity: confirmIdentity,
                    attachLicense: attachLicense)
            } catch let error as PolarisError
                where error.code == IdentityClient.networkError
                || error.code == IdentityClient.serverError
            {
                continue
            }
            switch poll {
            case .pending:
                continue
            case .slowDown(let next):
                interval = max(interval, next)
            case .ready(let ready):
                return .ready(ready)
            case .confirm(let identity, let attachable):
                return .confirm(identity: identity, attachable: attachable)
            case .expired:
                return .expired
            case .error(let message, let code):
                return .error(message: message, code: code)
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────
    private func post(_ path: String, _ body: [String: String]) async throws -> PolarisResponse {
        try await post(path, body.mapValues(JSONValue.string), bearer: nil)
    }

    private func post(_ path: String, _ body: [String: JSONValue], bearer: String?) async throws
        -> PolarisResponse
    {
        let data = try JSONEncoder().encode(JSONValue.object(body))
        var headers = ["content-type": "application/json"]
        if let bearer { headers["authorization"] = "Bearer \(bearer)" }
        do {
            return try await core.request(
                core.endpoints.url(path), method: "POST", headers: headers, body: data)
        } catch let error as PolarisError where error.code == PolarisError.localOnly {
            throw error
        } catch {
            throw PolarisError(code: IdentityClient.networkError, message: "\(error)")
        }
    }

    private func errorCode(_ response: PolarisResponse) -> String? {
        if let flat = try? JSONDecoder().decode(FlatError.self, from: response.body) {
            return flat.error
        }
        return (try? JSONDecoder().decode(NestedError.self, from: response.body))?.error.code
    }
}

private struct StartBody: Decodable {
    let deviceCode: String
    let userCode: String
    let verificationUri: String
    let verificationUriComplete: String
    /// Doubles, so a fractional answer rounds up instead of failing to decode.
    let expiresIn: Double
    let interval: Double
    /// PX-W13: the stored label; `echoed` is false when the member is absent (an older Worker).
    let deviceName: String?
    let echoed: Bool

    enum CodingKeys: String, CodingKey {
        case deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval
        case deviceName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceCode = try c.decode(String.self, forKey: .deviceCode)
        userCode = try c.decode(String.self, forKey: .userCode)
        verificationUri = try c.decode(String.self, forKey: .verificationUri)
        verificationUriComplete = try c.decode(String.self, forKey: .verificationUriComplete)
        expiresIn = try c.decode(Double.self, forKey: .expiresIn)
        interval = try c.decode(Double.self, forKey: .interval)
        echoed = c.contains(.deviceName)
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
    }
}

private struct PollBody: Decodable {
    let status: String?
    let reason: String?
    let interval: Double?
    let token: String?
    let identity: SignInIdentity?
    let attached: String?
    let attachable: Bool?
    let subject: String?
}

private struct FlatError: Decodable { let error: String }
private struct NestedError: Decodable {
    struct Inner: Decodable { let code: String }
    let error: Inner
}
