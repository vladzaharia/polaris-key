// The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete a
// browser redirect: a CLI, a daemon, a TV app, a kiosk.
//
//   beginSignIn(deviceName:)  POST /<p>/identity/auth/device/start → the code the player types
//                             and the two verification URIs (the complete one, with the code in
//                             it, is the QR payload). The device code — the POLL credential —
//                             stays inside the prompt.
//   pollSignIn(_:)            POST /<p>/identity/auth/device/poll, exactly once. The caller paces.
//   waitForSignIn(_:)         the paced loop: at least `interval` between polls, longer after a
//                             `slow_down`, never faster because a poll failed, and stopped by
//                             expiry or by cancelling the task (it then throws
//                             `CancellationError`).
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

    public init(
        deviceCode: String, userCode: String, verificationUri: String,
        verificationUriComplete: String, expiresIn: Int, interval: Int, expiresAt: Int
    ) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.verificationUriComplete = verificationUriComplete
        self.expiresIn = expiresIn
        self.interval = interval
        self.expiresAt = expiresAt
    }
}

extension SignInPrompt: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "SignInPrompt(deviceCode: \(redactedCredential), userCode: \(userCode), "
            + "verificationUri: \(verificationUri), "
            + "verificationUriComplete: \(verificationUriComplete), expiresIn: \(expiresIn), "
            + "interval: \(interval), expiresAt: \(expiresAt))"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "deviceCode": redactedCredential, "userCode": userCode,
                "verificationUri": verificationUri,
                "verificationUriComplete": verificationUriComplete, "expiresIn": expiresIn,
                "interval": interval, "expiresAt": expiresAt,
            ], displayStyle: .struct)
    }
}

/// What a redacted credential prints as.
let redactedCredential = "[redacted]"

/// One poll's answer.
public enum SignInPoll: Sendable, Equatable {
    /// The player has not finished yet.
    case pending
    /// Polled too fast: wait `interval` seconds before the next poll (RFC 8628 §3.5).
    case slowDown(interval: Int)
    /// Signed in: the device token is stored and the post-acquisition sync has run.
    case ready
    /// The code expired (or the server no longer knows it). Begin again.
    case expired
    /// The sign-in failed or was refused. Begin again.
    case error(message: String)
}

/// How `waitForSignIn` ended. Cancellation throws `CancellationError` instead.
public enum SignInResult: Sendable, Equatable {
    case ready
    case expired
    case error(message: String)
}

/// Raised after a sign-in mints a credential; the facade syncs.
public typealias SignInAcquiredListener = @Sendable () async -> Void

/// RFC 8628 §3.5: a `slow_down` without an interval adds five seconds to the CURRENT interval, so
/// repeated interval-less answers keep lengthening it.
public let SLOW_DOWN_STEP_SECONDS = 5

/// The seconds `waitForSignIn` actually sleeps: never under one second (a zero or negative interval
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

    private let core: CoreContext
    private let onAcquired: SignInAcquiredListener?
    private let sleep: @Sendable (Double) async throws -> Void

    /// - Parameter sleep: how `waitForSignIn` waits between polls. Defaults to `Task.sleep`, which
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

    /// `seconds` as `Task.sleep`'s nanoseconds, clamped first: `UInt64(seconds * 1e9)` traps on a
    /// negative, non-finite or huge value.
    static func sleepNanoseconds(_ seconds: Double) -> UInt64 {
        let bounded = seconds.isFinite ? min(max(seconds, 0), maxSeconds) : 0
        return UInt64(bounded * 1_000_000_000)
    }

    /// Begin a device-code sign-in. Throws `PolarisError(service-unavailable)` before any request
    /// when this product does not run Identity (D-21).
    ///
    /// No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
    /// credential, and the server binds the flow to this device by its id.
    public func beginSignIn(deviceName: String? = nil) async throws -> SignInPrompt {
        try await core.requireService(.identity)
        var body: [String: String] = ["deviceId": await core.deviceId]
        if let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            body["deviceName"] = name
        }
        let response = try await post("identity/auth/device/start", body)
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
            interval: interval, expiresAt: await core.now() + expiresIn)
    }

    /// Poll once. On `.ready` the token is stored and the post-acquisition sync has completed
    /// before this returns.
    ///
    /// Throws `PolarisError(network-error)` when the request never got an answer and
    /// `PolarisError(server-error)` on a 5xx — neither says anything about the sign-in, so neither
    /// is folded into a status. `waitForSignIn` rides both out.
    public func pollSignIn(_ prompt: SignInPrompt) async throws -> SignInPoll {
        try await poll(prompt, current: prompt.interval)
    }

    /// One poll, where an interval-less `slow_down` lengthens `current` — the interval the caller
    /// is pacing at — rather than the prompt's original one.
    private func poll(_ prompt: SignInPrompt, current: Int) async throws -> SignInPoll {
        try await core.requireService(.identity)
        let response = try await post(
            "identity/auth/device/poll",
            ["deviceCode": prompt.deviceCode, "deviceId": await core.deviceId])
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
        case "ready":
            guard let token = body?.token, !token.isEmpty else {
                return .error(message: "ready without a token.")
            }
            try await core.setToken(token)
            await onAcquired?()
            return .ready
        default:
            return .error(message: "device sign-in failed.")
        }
    }

    /// Poll until the sign-in settles. The first poll waits one `interval` after the prompt was
    /// issued; a `slow_down` lengthens the interval for every later poll and never shortens it; a
    /// transient failure is retried at the SAME interval. Returns `.expired` once the prompt's
    /// `expiresAt` has passed, without asking the server. Cancelling the task stops polling and
    /// throws `CancellationError`.
    public func waitForSignIn(_ prompt: SignInPrompt) async throws -> SignInResult {
        try await core.requireService(.identity)
        var interval = prompt.interval
        while true {
            try Task.checkCancellation()
            if await core.now() >= prompt.expiresAt { return .expired }
            try await sleep(Double(pollDelay(interval: interval, expiresIn: prompt.expiresIn)))
            try Task.checkCancellation()
            if await core.now() >= prompt.expiresAt { return .expired }
            let poll: SignInPoll
            do {
                poll = try await self.poll(prompt, current: interval)
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
            case .ready:
                return .ready
            case .expired:
                return .expired
            case .error(let message):
                return .error(message: message)
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────
    private func post(_ path: String, _ body: [String: String]) async throws -> PolarisResponse {
        let data = try JSONEncoder().encode(body)
        do {
            return try await core.request(
                core.endpoints.url(path), method: "POST",
                headers: ["content-type": "application/json"], body: data)
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
}

private struct PollBody: Decodable {
    let status: String?
    let interval: Double?
    let token: String?
}

private struct FlatError: Decodable { let error: String }
private struct NestedError: Decodable {
    struct Inner: Decodable { let code: String }
    let error: Inner
}
