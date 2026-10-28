// Sign in with Apple (I-44.4): the AuthenticationServices edge for automatic sign-in, standalone so
// the Godot natives (I-48) reuse it.
//
//   silent   there is none: Apple's API shows a sheet whenever a credential exists, so `silent`
//            answers `unavailable` at once and never reaches the authorizer (SEC-LADDER 1).
//   sheet    the request with performRequests(options: .preferImmediatelyAvailableCredentials):
//            the ladder's one OS sheet (rung 4, `prompt: .optional`). It fails at once for a
//            person who has not used Apple sign-in with this app. `preferImmediate: false` is the
//            plain account sheet for the sign-in form's Apple button. tvOS has only the plain call.
//   state    getCredentialState(forUserID:) for the launch check (revoked → the caller signs out).
//
// Nonce (D-A4): the SERVER nonce goes into `request.nonce` as it is. Apple copies it into the
// identity token's `nonce` claim; the device-key proof binds the same value, so the Worker compares
// the claim with the nonce it issued. Hashing it first would add nothing and would break that
// comparison.
//
// Secrets: the identity token and the authorization code are bearer material. Neither reaches a log,
// `description` or `debugDescription`; only the Apple user id (not a secret) is kept, to feed the
// launch check.

import Foundation

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(tvOS) || os(visionOS))
    import AuthenticationServices
#endif

/// What Apple granted. The identity token (a JWT) and the code are secrets.
public struct AppleSignInGrant: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// Apple's stable user id for this team: not a secret.
    public let userID: String
    /// The identity token (compact JWT), UTF-8 decoded. A secret.
    public let identityToken: String
    /// The authorization code. A secret.
    public let authorizationCode: String?
    /// The email Apple shared (first authorisation only; may be a relay address).
    public let email: String?

    public init(userID: String, identityToken: String, authorizationCode: String?, email: String?) {
        self.userID = userID
        self.identityToken = identityToken
        self.authorizationCode = authorizationCode
        self.email = email
    }

    public var description: String { "AppleSignInGrant(userID: \(userID), token: <redacted>)" }
    public var debugDescription: String { description }
    /// A mirror (`dump`, a debugger) shows the secrets as redacted.
    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "userID": userID, "identityToken": "[redacted]",
                "authorizationCode": authorizationCode == nil ? "nil" : "[redacted]",
                "email": email as Any,
            ], displayStyle: .struct)
    }
}

/// Apple's `ASAuthorizationAppleIDProvider.CredentialState`, as plain values.
public enum AppleCredentialState: String, Sendable, Equatable {
    case authorized
    case revoked
    case notFound
    case transferred
}

/// A Sign in with Apple failure, typed. Everything else Apple reports collapses to these two.
public enum AppleSignInFailure: Error, Sendable, Equatable {
    /// The person dismissed the sheet, or (silent mode) no credential is immediately available.
    case cancelled
    /// Sign in with Apple cannot run: no Apple Account on the device, a missing capability, an
    /// unsupported OS, or any other system failure.
    case unavailable(String)
}

/// `ASAuthorizationController` behind a seam (a fake in tests: `swift test` has no Apple Account).
public protocol AppleIDAuthorizing: Sendable {
    /// Request an Apple ID authorisation with `nonce` (set as given) and the `.email` scope.
    /// `immediate` is the silent mode: `.preferImmediatelyAvailableCredentials`.
    func authorize(nonce: String, immediate: Bool) async throws -> AppleSignInGrant
    func credentialState(forUserID userID: String) async -> AppleCredentialState
}

/// Where the Apple user id is kept between launches. Not a secret.
public protocol AppleUserIDStoring: Sendable {
    func load() -> String?
    func save(_ userID: String)
    func clear()
}

/// UserDefaults-backed; one key per suite.
public final class DefaultsAppleUserIDStore: AppleUserIDStoring, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "pkey.apple.userID") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> String? { defaults.string(forKey: key) }
    public func save(_ userID: String) { defaults.set(userID, forKey: key) }
    public func clear() { defaults.removeObject(forKey: key) }
}

/// The Sign in with Apple facade the umbrella adapter and the native hosts call.
public struct AppleSignIn: Sendable {
    private let authorizer: any AppleIDAuthorizing
    private let userIDs: any AppleUserIDStoring

    public init(
        authorizer: any AppleIDAuthorizing = SystemAppleIDAuthorizer(),
        userIDs: any AppleUserIDStoring = DefaultsAppleUserIDStore()
    ) {
        self.authorizer = authorizer
        self.userIDs = userIDs
    }

    /// Apple has no silent rung: this throws `.unavailable` and never reaches the authorizer.
    public func silent(nonce: String) async throws -> AppleSignInGrant {
        throw AppleSignInFailure.unavailable("Sign in with Apple has no silent rung.")
    }

    /// Rung 4: the one OS sheet. `preferImmediate` (the default) asks only for a credential this
    /// app already has; pass false for the plain account sheet. The user id is NOT kept here:
    /// call `remember(userID:)` once the Worker accepted the token.
    public func sheet(nonce: String, preferImmediate: Bool = true) async throws -> AppleSignInGrant {
        guard !nonce.isEmpty else { throw AppleSignInFailure.unavailable("empty nonce") }
        return try await authorizer.authorize(nonce: nonce, immediate: preferImmediate)
    }

    /// Keep the Apple user id for the launch check, after a successful exchange.
    public func remember(userID: String) { userIDs.save(userID) }

    /// The stored user id's state, or nil when this app never signed in with Apple.
    public func credentialState() async -> AppleCredentialState? {
        guard let id = userIDs.load() else { return nil }
        return await authorizer.credentialState(forUserID: id)
    }

    /// True only when Apple says the stored credential is `.revoked` (the caller signs out).
    /// Not found, transferred and a failed lookup are not revocation.
    public func credentialRevoked() async -> Bool {
        await credentialState() == .revoked
    }

    /// Sign-out cleanup: forget the Apple user id.
    public func signOutCleanup() { userIDs.clear() }
}

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(tvOS) || os(visionOS))

    /// The real thing: `ASAuthorizationController`, driven on the main actor.
    public struct SystemAppleIDAuthorizer: AppleIDAuthorizing {
        public init() {}

        public func authorize(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
            try await AppleAuthorizationRun.perform(nonce: nonce, immediate: immediate)
        }

        public func credentialState(forUserID userID: String) async -> AppleCredentialState {
            await withCheckedContinuation { cont in
                ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID) { state, _ in
                    switch state {
                    case .authorized: cont.resume(returning: .authorized)
                    case .revoked: cont.resume(returning: .revoked)
                    case .transferred: cont.resume(returning: .transferred)
                    // `.notFound` and any state added later: the caller treats both as "no credential".
                    default: cont.resume(returning: .notFound)
                    }
                }
            }
        }

        /// ASAuthorizationError → cancelled | unavailable.
        static func typed(_ error: Error) -> AppleSignInFailure {
            if let failure = error as? AppleSignInFailure { return failure }
            let ns = error as NSError
            if ns.domain == ASAuthorizationError.errorDomain,
                let code = ASAuthorizationError.Code(rawValue: ns.code)
            {
                switch code {
                case .canceled, .notInteractive: return .cancelled
                default: return .unavailable("ASAuthorizationError \(ns.code)")
                }
            }
            return .unavailable("\(ns.domain) \(ns.code)")
        }
    }

    @MainActor
    private final class AppleAuthorizationRun: NSObject, ASAuthorizationControllerDelegate {
        private var continuation: CheckedContinuation<AppleSignInGrant, Error>?
        private var controller: ASAuthorizationController?

        static func perform(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
            let run = AppleAuthorizationRun()
            return try await run.start(nonce: nonce, immediate: immediate)
        }

        private func start(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<AppleSignInGrant, Error>) in
                self.continuation = cont
                let request = ASAuthorizationAppleIDProvider().createRequest()
                request.nonce = nonce
                request.requestedScopes = [.email]
                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                self.controller = controller
                #if os(tvOS)
                    // tvOS has no `performRequests(options:)`: both modes use the plain call (the TV sheet).
                    controller.performRequests()
                #else
                    if immediate {
                        controller.performRequests(options: .preferImmediatelyAvailableCredentials)
                    } else {
                        controller.performRequests()
                    }
                #endif
            }
        }

        private func finish(_ result: Result<AppleSignInGrant, Error>) {
            let cont = continuation
            continuation = nil
            controller = nil
            cont?.resume(with: result)
        }

        nonisolated func authorizationController(
            controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
        ) {
            let result: Result<AppleSignInGrant, Error>
            if let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8)
            {
                let code = cred.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
                result = .success(
                    AppleSignInGrant(
                        userID: cred.user, identityToken: token, authorizationCode: code, email: cred.email))
            } else {
                result = .failure(AppleSignInFailure.unavailable("no identity token"))
            }
            Task { @MainActor in self.finish(result) }
        }

        nonisolated func authorizationController(
            controller: ASAuthorizationController, didCompleteWithError error: Error
        ) {
            let typed = SystemAppleIDAuthorizer.typed(error)
            Task { @MainActor in self.finish(.failure(typed)) }
        }
    }

#else

    /// No AuthenticationServices on this platform.
    public struct SystemAppleIDAuthorizer: AppleIDAuthorizing {
        public init() {}

        public func authorize(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
            throw AppleSignInFailure.unavailable("Sign in with Apple is not available on this platform.")
        }

        public func credentialState(forUserID userID: String) async -> AppleCredentialState { .notFound }
    }

#endif
