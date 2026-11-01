// @pkey-feature identity.redirect.native
//
// The native redirect sign-in against the redirect-native-* and locker-redirect-native recordings
// (I-15b.4). The SDK pushes the request itself and the recording pins every byte it sends; the
// browser's half is the recording's. A loopback listener is the replay's own (the recorded port, no
// socket); a scheme delivery goes through `signIn.handleRedirect`.

import Foundation
import PolarisKey
import PolarisKeyCore

@testable import PolarisKeyIdentity

/// The loopback listener of a recorded conversation: the recorded port, no socket. The redirect is
/// handed to the session's own callback handler, as the listener would.
final class ReplayListener: NativeLoopbackListener, @unchecked Sendable {
    let port: Int
    private let lock = NSLock()
    private var accept: (@Sendable (String) -> NativeListenerReply)?
    private var isClosed = false

    init(port: Int) { self.port = port }

    func start(_ accept: @escaping @Sendable (String) -> NativeListenerReply) {
        lock.withLock { self.accept = accept }
    }
    func close() { lock.withLock { isClosed = true } }
    var closed: Bool { lock.withLock { isClosed } }

    func deliver(_ url: String) -> NativeListenerReply? {
        lock.withLock { accept }.map { $0(url) }
    }
}

enum NativeReplay {
    static let recordedVerifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    static let recordedState = "tidewater-state-0123456789"

    /// A native sign-in as the host would start it: the SDK pushes the request itself, the label
    /// and options being the recorded push's.
    static func start(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession
    ) async throws -> SignInSession {
        let body = ReplayServer.pushedForm(step)
        let redirectUri = body["redirect_uri"] ?? step.args["redirectUri"]?.stringValue ?? ""
        client.identity.redirectEntropy.set(
            (
                state: body["state"] ?? recordedState,
                codeVerifier: step.args["codeVerifier"]?.stringValue ?? recordedVerifier
            ))
        var native = NativeRedirectOptions(
            registeredSchemes: [], returnUri: body["return_uri"], openBrowser: false)
        switch NativeRedirect.classify(redirectUri) {
        case .loopback:
            let port = URLComponents(string: redirectUri)?.port ?? 0
            native.loopback = true
            client.identity.nativeListenerFactory.set {
                let listener = ReplayListener(port: port)
                session.nativeListener = listener
                return listener
            }
        case .scheme:
            native.loopback = false
            native.registeredSchemes = [redirectUri]
        case .claimed:
            native.loopback = false
            native.registeredClaimed = [redirectUri]
        case nil:
            throw ReplayError("the recorded push names no native redirect URI: \(redirectUri)")
        }
        let choice: LicenseChoiceMode? = body["license_choice"] == "app" ? .app : nil
        session.licenseChoice = choice
        let started = try await client.identity.signIn.start(
            SignInOptions(
                channel: .redirect, deviceName: body["device_name"],
                scope: body["scope"].map { $0.split(separator: " ").map(String.init) },
                loginHint: body["login_hint"], nameHint: body["name_hint"],
                purpose: body["purpose"].flatMap(SignInPurpose.init(rawValue:)),
                licenseChoice: choice, native: native))
        return started
    }

    /// Hand the recorded redirect to the sign-in waiting for it. A sign-in already settled is single
    /// use, so a replayed callback is played against a fresh one built on the same pending request
    /// (the recording pins the Worker's refusal of the code, which the SDK would not even ask).
    static func complete(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession, transcript: Transcript
    ) async throws -> SignInOutcome {
        let url = step.args["callbackUrl"]?.stringValue ?? ""
        if let live = client.identity.nativeActive.current, live.outcome == .pending, let flow = live.native {
            if flow.redirectClass == .loopback {
                guard let listener = session.nativeListener, let reply = listener.deliver(url) else {
                    throw ReplayError("the loopback listener was not started")
                }
                let handle = URLComponents(string: url)?.queryItems?.first { $0.name == "request" }?.value ?? ""
                if let location = reply.location, location != "\(transcript.baseUrl)/signin/return?request=\(handle)" {
                    throw ReplayError("the listener answered 303 to \(location)")
                }
                guard reply.final else { throw ReplayError("the listener kept waiting for the redirect") }
                return try await live.wait()
            }
            return try await client.identity.signIn.handleRedirect(url)
        }
        let base = "\(transcript.baseUrl)/\(transcript.product)/identity"
        let parts = URLComponents(string: url)
        let redirectUri = String(url.prefix(while: { $0 != "?" }))
        guard let cls = NativeRedirect.classify(redirectUri) else {
            throw ReplayError("the recorded callback is at no native redirect URI: \(redirectUri)")
        }
        let pending = NativePending(
            redirectClass: cls, redirectUri: redirectUri,
            state: step.args["state"]?.stringValue ?? recordedState,
            codeVerifier: step.args["codeVerifier"]?.stringValue ?? recordedVerifier,
            clientId: transcript.product,
            issuer: parts?.queryItems?.first { $0.name == "iss" }?.value ?? "\(base)",
            authorizeEndpoint: "\(base)/authorize", tokenEndpoint: "\(base)/token",
            choiceApp: session.licenseChoice == .app)
        let flow = NativeFlow(
            pending: pending, authorizeUrl: "\(base)/authorize", expiresAt: Int.max, expiresIn: 600,
            listener: nil, returnPage: nil)
        let fresh = SignInSession(client: client.identity, native: flow, deviceName: nil, browser: nil)
        return try await fresh.handleRedirect(url)
    }
}
