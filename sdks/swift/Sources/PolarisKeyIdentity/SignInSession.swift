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

/// How the player signs in: the device code (a code typed on another screen), or the OAuth
/// authorization-code redirect (the host opens `session.authorizeUrl` and hands the callback URL
/// back to `session.complete(callbackUrl:)`).
public enum SignInChannel: Sendable, Equatable {
    case deviceCode
    case redirect
}

/// The authorize request's `purpose` extension (§12.4): the card's copy.
public enum SignInPurpose: String, Sendable, Equatable {
    case signin
    case attach
}

/// What `signIn.start` takes.
public struct SignInOptions: Sendable {
    public var channel: SignInChannel
    /// The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1); nil sends the default.
    public var deviceName: String?
    /// Show the verification page here as soon as the session starts (an in-app browser sheet on
    /// Apple platforms). Nil shows nothing: the host draws the code, or calls `reopen()`.
    public var browser: (any SignInBrowser)?
    /// Redirect channel: the `https:` URI the product registered; the browser lands there with the
    /// code. Required for `.redirect`.
    public var redirectUri: String?
    /// Redirect channel: the scopes asked for; nil asks `profile email`.
    public var scope: [String]?
    /// Redirect channel: prefills the card (§12.4). Verifies nothing.
    public var loginHint: String?
    public var nameHint: String?
    public var purpose: SignInPurpose?
    /// Redirect channel: who shows the licence choice. `.app` asks for `license_choice=app` (sent
    /// only when discovery publishes the four `choice*` routes; else the card chooses); a due
    /// choice then settles the session as `.chooseLicense` and the app runs `identity.choice`.
    public var licenseChoice: LicenseChoiceMode?

    public init(
        channel: SignInChannel = .deviceCode, deviceName: String? = nil,
        browser: (any SignInBrowser)? = nil, redirectUri: String? = nil, scope: [String]? = nil,
        loginHint: String? = nil, nameHint: String? = nil, purpose: SignInPurpose? = nil,
        licenseChoice: LicenseChoiceMode? = nil
    ) {
        self.channel = channel
        self.deviceName = deviceName
        self.browser = browser
        self.redirectUri = redirectUri
        self.scope = scope
        self.loginHint = loginHint
        self.nameHint = nameHint
        self.purpose = purpose
        self.licenseChoice = licenseChoice
    }
}

/// Where a session stands. `wait()` returns the settled ones; `session.outcome` reads `.pending`
/// until then.
public enum SignInOutcome: Sendable, Equatable {
    case pending
    /// The flow is held at the signed-in identity (`attachable`: this device holds an anonymous
    /// enrolled licence the account could take over).
    case choose(identity: SignInIdentity, attachable: Bool)
    /// Redirect channel with `licenseChoice: .app`: the code was redeemed for a pending sign-in
    /// grant. Nothing is bound yet; run `client.identity.choice` with `grant`.
    case chooseLicense(PendingSignIn)
    /// Signed in: the device token is stored and the post-acquisition sync has run.
    case signedIn(SignInReady)
    case cancelled
    case expired

    /// `pending`, `choose`, `signedIn`, `cancelled` or `expired`.
    public var kind: String {
        switch self {
        case .pending: return "pending"
        case .choose: return "choose"
        case .chooseLicense: return "chooseLicense"
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
    /// Seconds to wait before retrying, when the Worker named them (`rate_limited`).
    public let retryAfterSeconds: Int?

    public init(code: String, message: String, retryAfterSeconds: Int? = nil) {
        self.code = code
        self.message = message
        self.retryAfterSeconds = retryAfterSeconds
    }

    public var description: String { "SignInError(\(code)): \(message)" }
}

/// `client.identity.signIn`.
public struct SignInNamespace: Sendable {
    let client: IdentityClient

    /// Ask for a device code (or, on the redirect channel, build the authorize URL) and return the
    /// session. Throws `PolarisError` (`service-unavailable` when the product runs no Identity,
    /// `sign-in-unavailable`, `invalid-argument`, `network-error`, ...). With `options.browser`
    /// the page is shown before this returns.
    public func start(_ options: SignInOptions = SignInOptions()) async throws -> SignInSession {
        if options.channel == .redirect {
            let pending = try await client.startRedirect(options)
            let session = SignInSession(
                client: client, redirect: pending, deviceName: options.deviceName,
                browser: options.browser)
            if options.browser != nil { try await session.show() }
            return session
        }
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
        /// The redirect request, until `complete` or `cancel` takes it (single use).
        var pending: RedirectPending?
    }

    private let client: IdentityClient
    private let prompt: SignInPrompt
    private let state: LockedValue<State>
    private let redirectDeviceName: String?

    /// The channel this session runs on.
    public let channel: SignInChannel

    init(client: IdentityClient, prompt: SignInPrompt, browser: (any SignInBrowser)?) {
        self.client = client
        self.prompt = prompt
        self.channel = .deviceCode
        self.redirectDeviceName = nil
        self.authorizeUrl = nil
        self.state = LockedValue(State(browser: browser))
    }

    /// A redirect session: the code fields are empty, `authorizeUrl` is the page to open.
    init(
        client: IdentityClient, redirect: RedirectPending, deviceName: String?,
        browser: (any SignInBrowser)?
    ) {
        self.client = client
        self.prompt = SignInPrompt(
            deviceCode: "", userCode: "", verificationUri: "", verificationUriComplete: "",
            expiresIn: 0, interval: 0, expiresAt: 0, deviceName: deviceName)
        self.channel = .redirect
        self.redirectDeviceName = deviceName
        self.state = LockedValue(State(browser: browser, pending: redirect))
        self.authorizeUrl = redirect.authorizeUrl
    }

    /// Redirect channel: the URL to open in the browser. It carries the challenge and `state`,
    /// never the verifier. Nil on the device-code channel.
    public let authorizeUrl: String?

    /// What the player types on the verification page, e.g. `WDJB-MJHT`. Empty on the redirect
    /// channel, as are the other code fields.
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
            st.pending = nil
            return (st.task, st.browser)
        }
        task?.cancel()
        Self.close(browser)
    }

    /// Poll until the sign-in settles. Throws `SignInError` when it was refused or failed, and
    /// `CancellationError` when the calling task is cancelled (the session keeps going; call
    /// `cancel()` to end it). A settled session answers the same outcome again.
    public func wait() async throws -> SignInOutcome {
        if channel == .redirect {
            let begun = state.current
            if let settled = begun.settled { return try settled.get() }
            if begun.cancelled { return .cancelled }
            throw PolarisError(
                code: ErrorCode.invalidArgument,
                message: "a redirect sign-in settles through complete(callbackUrl:), not wait().")
        }
        let task: Task<SignInResult, Error>
        let begun = state.with { st -> Result<SignInOutcome, SignInError>? in
            if let settled = st.settled { return settled }
            return st.cancelled ? .success(.cancelled) : nil
        }
        if let begun { return try begun.get() }
        task = state.with { st in
            if let running = st.task { return running }
            let client = self.client
            let prompt = self.prompt
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

    /// Redirect channel: redeem the callback the browser was sent to. Checks the redirect URI,
    /// `state` and `iss` first (a mismatch is `sign-in-failed`, nothing sent), then POSTs the form
    /// body to discovery's `token` endpoint. `error=access_denied` settles `.cancelled`; any other
    /// callback error is `sign-in-failed`. The Worker's refusal is thrown as a `SignInError` under
    /// its own code (`invalid_grant`, `invalid_client`, `rate_limited` with `retryAfterSeconds`).
    ///
    /// The session is single use: the PKCE verifier is dropped before the first request, so a
    /// second call (a replayed callback) is refused locally without one. A refusal never wipes the
    /// device token or the cache; only `.signedIn` changes state.
    @discardableResult
    public func complete(callbackUrl: String) async throws -> SignInOutcome {
        guard channel == .redirect else {
            throw PolarisError(
                code: ErrorCode.invalidArgument,
                message: "complete(callbackUrl:) belongs to a redirect sign-in; use wait().")
        }
        let pending = state.with { st -> RedirectPending? in
            let taken = st.pending
            st.pending = nil
            return taken
        }
        guard let pending else {
            throw SignInError(
                code: ErrorCode.signInFailed,
                message: "this sign-in is already finished or was cancelled; start a new one.")
        }
        switch IdentityRedirect.checkCallback(pending, callbackUrl) {
        case .cancelled:
            return try settle(.success(.cancelled))
        case .failed(let reason, _):
            return try settle(
                .failure(
                    SignInError(
                        code: ErrorCode.signInFailed,
                        message: "the sign-in redirect was refused (\(reason.rawValue)).")))
        case .code(let code):
            do {
                switch try await client.redeemRedirect(
                    pending, code: code, deviceName: redirectDeviceName)
                {
                case .ready(let ready): return try settle(.success(.signedIn(ready)))
                case .choose(let grant): return try settle(.success(.chooseLicense(grant)))
                }
            } catch let error as SignInError {
                return try settle(.failure(error))
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    /// One poll, unpaced, for the transcript replayer: the session's own request.
    func pollOnce() async throws -> SignInPoll {
        try await client.pollDeviceCode(prompt)
    }

    func show() async throws {
        guard let url = URL(string: authorizeUrl ?? prompt.verificationUriComplete) else {
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
