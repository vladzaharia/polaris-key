// The AddToAccount driver over `client.identity` (UK-43.4): the three calls the model
// (AddToAccountModel.swift) runs on, over the SDK's primitives.
//
//   signIn(_:)      `identity.signIn.start` with channel `.redirect` and NO redirect URI (the SDK picks
//                   the platform's: ASWebAuthenticationSession on iOS, the loopback listener on macOS),
//                   the hints, purpose `.attach` and `licenseChoice: .app`. Only where the SDK answers
//                   `redirect-unavailable` (no native class applies) it asks for a device code instead
//                   (nothing was sent). Any other failure is thrown: a sign-in that could not start.
//   complete(grant:) `identity.choice.complete(.keep)`: keep this device's license in the account.
//   attach(confirm:) `identity.attach`; false previews, nothing is written.
//
// The email of the account that signed in rides the `signedIn` answer (`SignInReady.identity`), so the
// model can tell an account other than the one typed. The SDK names it on the device-code channel;
// a redirect sign-in carries none, and the model then has nothing to compare.

import Foundation
import PolarisKeyCore
import PolarisKeyIdentity

public struct IdentityAddToAccountDriver: AddToAccountDriver {
    private let identity: IdentityClient
    private let native: NativeRedirectOptions

    /// `native` is the host's native redirect setup (its registered schemes, its opener); the default
    /// leaves the SDK's.
    public init(identity: IdentityClient, native: NativeRedirectOptions = NativeRedirectOptions()) {
        self.identity = identity
        self.native = native
    }

    public func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle {
        func options(_ channel: SignInChannel) -> SignInOptions {
            SignInOptions(
                channel: channel, loginHint: hints.loginHint, nameHint: hints.nameHint,
                purpose: SignInPurpose(rawValue: hints.purpose), licenseChoice: .app,
                native: channel == .redirect ? native : NativeRedirectOptions())
        }
        do {
            return Handle(try await identity.signIn.start(options(.redirect)))
        } catch let error as PolarisError where error.code == ErrorCode.redirectUnavailable {
            // Headless, or no class applies: the person confirms a code instead (hints stay).
            return Handle(try await identity.signIn.start(options(.deviceCode)))
        }
    }

    public func complete(grant: String) async throws -> Bool {
        _ = try await identity.choice.complete(grant: grant, choice: .keep)
        return true
    }

    public func attach(confirm: Bool) async throws -> AddToAccountAttach {
        switch try await identity.attach(confirm: confirm) {
        case .confirm, .ok: return .ok
        case .refused(let code, _): return .refused(code: code)
        }
    }

    /// A running `SignInSession` as the model sees it.
    private final class Handle: AddToAccountHandle {
        private let session: SignInSession
        let userCode: String?

        init(_ session: SignInSession) {
            self.session = session
            // A redirect session has no code to show.
            self.userCode = session.userCode.isEmpty ? nil : session.userCode
        }

        func wait() async throws -> AddToAccountWait {
            switch try await session.wait() {
            case .signedIn(let ready):
                let email = ready.identity?.email
                return .signedIn(email: (email?.isEmpty ?? true) ? nil : email)
            case .chooseLicense(let pending): return .choose(grant: pending.grant)
            case .cancelled: return .cancelled
            case .pending: return .pending
            // Expired, an identity to confirm, a key return: a failed attempt.
            case .expired, .choose, .activated: return .expired
            }
        }

        func reopen() async -> Bool { await session.reopen() }
        func cancel() { session.cancel() }
    }
}
