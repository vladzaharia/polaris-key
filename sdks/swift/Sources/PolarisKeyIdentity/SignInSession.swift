// `identity.signIn.start(_:)` and the `SignInSession` it returns (SDK identity v2, I-10b.10).
//
//   let session = try await client.identity.signIn.start(SignInOptions(deviceName: "Deck"))
//   show(session.userCode, session.verificationUriComplete)   // the code, the page, the QR
//   switch try await session.wait() { ... }                   // the paced poll, until it settles
//
// `start` is one request (`POST /<p>/identity/auth/device/start`); `wait()` is the paced device-code
// poll. A refusal of the sign-in (the player pressed Deny, the provider failed) is a typed
// `SignInError`; an expired code, a cancelled session and a signed-in device are outcomes.
// A product that does not run Identity answers `PolarisError(service-unavailable)` before any
// request. A device-code sign-in yields the signed-in identity's OWN licence and nothing else.

import Foundation
import PolarisKeyCore

/// How the player signs in. Only the device code today; the redirect channel is I-10b.11.
public enum SignInChannel: Sendable, Equatable {
    case deviceCode
}

/// What `signIn.start` takes.
public struct SignInOptions: Sendable {
    public var channel: SignInChannel
    /// The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1); nil sends the default.
    public var deviceName: String?
    /// Show the verification page here as soon as the session starts (an in-app browser sheet on
    /// Apple platforms). Nil shows nothing: the host draws the code, or calls `reopen()`.
    public var browser: (any SignInBrowser)?

    public init(
        channel: SignInChannel = .deviceCode, deviceName: String? = nil,
        browser: (any SignInBrowser)? = nil
    ) {
        self.channel = channel
        self.deviceName = deviceName
        self.browser = browser
    }
}

/// Where a session stands. `wait()` returns the settled ones; `session.outcome` reads `.pending`
/// until then.
public enum SignInOutcome: Sendable, Equatable {
    case pending
    /// The flow is held at the signed-in identity (`attachable`: this device holds an anonymous
    /// enrolled licence the account could take over).
    case choose(identity: SignInIdentity, attachable: Bool)
    /// Signed in: the device token is stored and the post-acquisition sync has run.
    case signedIn(SignInReady)
    case cancelled
    case expired

    /// `pending`, `choose`, `signedIn`, `cancelled` or `expired`.
    public var kind: String {
        switch self {
        case .pending: return "pending"
        case .choose: return "choose"
        case .signedIn: return "signedIn"
        case .cancelled: return "cancelled"
        case .expired: return "expired"
        }
    }
}

/// A sign-in the Worker refused or that failed: `sign-in-denied` (the player pressed Deny),
/// `sign-in-failed` (it failed after approval) or the Worker's own code.
public struct SignInError: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "SignInError(\(code)): \(message)" }
}

/// `client.identity.signIn`.
public struct SignInNamespace: Sendable {
    let client: IdentityClient

    /// Ask for a device code and return its session. Throws `PolarisError` (`service-unavailable`
    /// when the product runs no Identity, `sign-in-unavailable`, `network-error`, ...). With
    /// `options.browser` the page is shown before this returns.
    public func start(_ options: SignInOptions = SignInOptions()) async throws -> SignInSession {
        let prompt = try await client.startDeviceCode(deviceName: options.deviceName)
        let session = SignInSession(client: client, prompt: prompt, browser: options.browser)
        if options.browser != nil { try await session.show() }
        return session
    }
}

extension IdentityClient {
    /// `signIn.start(_:)`.
    public var signIn: SignInNamespace { SignInNamespace(client: self) }
}

/// One device-code sign-in: the code to show, and the wait that settles it.
public final class SignInSession: Sendable {
    private struct State {
        var browser: (any SignInBrowser)?
        var task: Task<SignInResult, Error>?
        var cancelled = false
        var settled: Result<SignInOutcome, SignInError>?
    }

    private let client: IdentityClient
    private let prompt: SignInPrompt
    private let state: LockedValue<State>

    init(client: IdentityClient, prompt: SignInPrompt, browser: (any SignInBrowser)?) {
        self.client = client
        self.prompt = prompt
        self.state = LockedValue(State(browser: browser))
    }

    /// What the player types on the verification page, e.g. `WDJB-MJHT`.
    public var userCode: String { prompt.userCode }
    /// The page the player opens and types the code into.
    public var verificationUri: String { prompt.verificationUri }
    /// The same page with the code pre-filled: the payload for a QR code or a link.
    public var verificationUriComplete: String { prompt.verificationUriComplete }
    /// Seconds the code lives for, as the server advertised it.
    public var expiresIn: Int { prompt.expiresIn }
    /// The minimum seconds between polls, as the server advertised it.
    public var interval: Int { prompt.interval }
    /// When the code expires on this client's clock (epoch seconds).
    public var expiresAt: Int { prompt.expiresAt }
    /// The label the sign-in page shows: the Worker's echo, else the label sent.
    public var deviceName: String? { prompt.deviceName }

    /// `.pending` until the session settles.
    public var outcome: SignInOutcome {
        state.with { st in
            if let settled = st.settled, case .success(let outcome) = settled { return outcome }
            return st.cancelled ? .cancelled : .pending
        }
    }

    /// Show the verification page again, in the browser given to `start` or the platform's sheet.
    /// False when no browser could open it.
    @discardableResult
    public func reopen() async -> Bool {
        do {
            try await show()
            return true
        } catch {
            return false
        }
    }

    /// Stop the sign-in: the paced poll ends, `wait()` returns `.cancelled`, nothing binds.
    public func cancel() {
        let (task, browser) = state.with { st -> (Task<SignInResult, Error>?, (any SignInBrowser)?) in
            guard st.settled == nil, !st.cancelled else { return (nil, nil) }
            st.cancelled = true
            return (st.task, st.browser)
        }
        task?.cancel()
        Self.close(browser)
    }

    /// Poll until the sign-in settles. Throws `SignInError` when it was refused or failed, and
    /// `CancellationError` when the calling task is cancelled (the session keeps going; call
    /// `cancel()` to end it). A settled session answers the same outcome again.
    public func wait() async throws -> SignInOutcome {
        let task: Task<SignInResult, Error>
        let begun = state.with { st -> Result<SignInOutcome, SignInError>? in
            if let settled = st.settled { return settled }
            return st.cancelled ? .success(.cancelled) : nil
        }
        if let begun { return try begun.get() }
        task = state.with { st in
            if let running = st.task { return running }
            let client = self.client, prompt = self.prompt
            let created = Task { try await client.waitDeviceCode(prompt) }
            st.task = created
            return created
        }
        let result: SignInResult
        do {
            result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch is CancellationError {
            let ended = state.with { st -> Bool in
                if !st.cancelled { st.task = nil }
                return st.cancelled
            }
            guard ended else { throw CancellationError() }
            return try settle(.success(.cancelled))
        }
        switch result {
        case .ready(let ready): return try settle(.success(.signedIn(ready)))
        case .confirm(let identity, let attachable):
            return try settle(.success(.choose(identity: identity, attachable: attachable)))
        case .expired: return try settle(.success(.expired))
        case .error(let message, let code):
            let error = SignInError(code: code ?? ErrorCode.signInFailed, message: message)
            return try settle(.failure(error))
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    /// One poll, unpaced, for the transcript replayer: the session's own request.
    func pollOnce() async throws -> SignInPoll {
        try await client.pollDeviceCode(prompt)
    }

    func show() async throws {
        guard let url = URL(string: prompt.verificationUriComplete) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the verification URL is not a URL.")
        }
        var opener = state.current.browser
        if opener == nil { opener = await defaultSignInBrowser() }
        guard let opener else {
            throw UnsupportedError(
                Unsupported(
                    feature: Feature.identityDevicecode, reason: UnsupportedReason.runtime,
                    detail: "this platform has no browser sheet; show the code instead."))
        }
        state.with { $0.browser = opener }
        try await opener.open(url)
    }

    @discardableResult
    private func settle(_ result: Result<SignInOutcome, SignInError>) throws -> SignInOutcome {
        let browser = state.with { st -> (any SignInBrowser)? in
            if st.settled == nil { st.settled = result }
            return st.browser
        }
        Self.close(browser)
        return try result.get()
    }

    private static func close(_ browser: (any SignInBrowser)?) {
        guard let browser else { return }
        Task { @MainActor in browser.close() }
    }
}
