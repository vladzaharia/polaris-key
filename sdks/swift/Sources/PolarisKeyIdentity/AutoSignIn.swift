// `client.identity.autoSignIn()`: the automatic sign-in ladder (CC-01-auto-sign-in §1, I-44.2).
//
//   rung 1  a stored credential and a licence: `signedIn`, no network
//   rung 2  silent restore (I-49): skipped here
//   rung 3  the platform provider, silently, over a fresh Worker nonce, then `exchange`
//   rung 4  the provider's one OS sheet (`prompt: .optional`), then `exchange`
//   rung 5+ are the app's: the regular sign-in form is `needsSignIn` / `unavailable`
//
//   switch await client.identity.autoSignIn() {
//   case .signedIn(let ready):            ...   // the session is there
//   case .confirm(let pending):           ...   // show pending.consent, then choice.complete
//   case .choose(let pending):            ...   // the licence choice
//   case .needsSignIn(let handle, let why): ... // the regular form (`handle` feeds the link offer)
//   case .deviceLimit(let view):          ...   // every seat is taken; the choice view, when sent
//   case .unavailable(let code):          ...   // no exchange here: the regular form
//   }
//
// Sign-out rules:
//   - `signOut()` sets `explicitSignOut` (CoreContext, persisted beside the credential) and runs the
//     provider's `signOutCleanup()`. While it is set rungs 3 and 4 do not run: nothing silent
//     signs the person back in. The next explicit sign-in (a token stored from a sign-in) clears it.
//     A stored session (rung 1) is the person's own and is not touched by the flag.
//   - A provider that reports its credential revoked at launch (Sign in with Apple, scenario 11)
//     signs the device out through `signOut()`. If the Worker cannot be reached the flag stays
//     unset and the check repeats at the next launch.
//
// Nothing here logs, prints or keeps a token, a grant or a link handle; the result redacts them.
// `syncKey` is absent until U-39 (Q-8).

import Foundation
import PolarisKeyCore

/// What a platform provider hands the exchange: an identity token bound to the nonce. A secret.
public struct PlatformSubjectToken: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The identity token. A secret.
    public let token: String
    /// The server nonce that was bound into the request.
    public let nonce: String
    public init(token: String, nonce: String) {
        self.token = token
        self.nonce = nonce
    }
    public var description: String { "PlatformSubjectToken(<redacted>)" }
    public var debugDescription: String { description }
}

/// The platform's identity (Sign in with Apple; Google where a native one exists) behind the
/// ladder. The nonce is the Worker's, passed on as it is.
public protocol PlatformIdentityProvider: Sendable {
    /// Which `exchange` kind this provider's tokens are.
    var kind: ExchangeKind { get }
    /// An identity token with no UI. Throws when none is immediately available.
    func silent(nonce: String) async throws -> PlatformSubjectToken
    /// An identity token through the platform's one account sheet. Throws when dismissed.
    func sheet(nonce: String) async throws -> PlatformSubjectToken
    /// Forget the platform's session state (called by `identity.signOut()`).
    func signOutCleanup() async
    /// True when the platform says the person revoked this app's credential.
    func credentialRevoked() async -> Bool
}

/// Whether the ladder may show the provider's sheet (rung 4).
public enum AutoSignInPrompt: Sendable, Equatable {
    /// Rung 3 only.
    case never
    /// Rung 4 after rung 3 finds nothing: at most one OS sheet. The default.
    case optional
}

public struct AutoSignInOptions: Sendable {
    /// The provider to use; nil uses the one installed on the client (`installPlatformIdentity`).
    public var provider: (any PlatformIdentityProvider)?
    public var prompt: AutoSignInPrompt

    public init(provider: (any PlatformIdentityProvider)? = nil, prompt: AutoSignInPrompt = .optional) {
        self.provider = provider
        self.prompt = prompt
    }
}

/// Why `autoSignIn` found no session.
public enum AutoSignInReason: String, Sendable, Equatable {
    /// The platform account is not linked to a Polaris Locker account: sign in, then offer the link.
    case noLink = "no_link"
    /// The product's terms version is unaccepted; only the sign-in card takes acceptance.
    case terms
    /// The person signed out on this device; the next sign-in is theirs to start.
    case signedOut = "signed_out"
    /// The platform offered no credential (none, dismissed, or the sheet was not allowed).
    case noCredential = "no_credential"
}

/// What the ladder answered.
public enum AutoSignInResult: Sendable, Equatable {
    case signedIn(SignInReady)
    case confirm(PendingConsent)
    case choose(PendingSignIn)
    /// `linkHandle` is present for `noLink` after an exchange; used once, by the link offer.
    case needsSignIn(linkHandle: String?, reason: AutoSignInReason)
    /// Every seat is taken; `view` is the choice view (with the replace rows) when the Worker sent it.
    case deviceLimit(view: LicenseChoiceView?)
    /// No exchange here, or a refusal: `code` is the Worker's or `platform-identity-unavailable`.
    case unavailable(code: String)
}

extension AutoSignInResult: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        switch self {
        case .signedIn: return "AutoSignInResult.signedIn"
        case .confirm(let p): return "AutoSignInResult.confirm(\(p))"
        case .choose(let p): return "AutoSignInResult.choose(\(p))"
        case .needsSignIn(let h, let r):
            return "AutoSignInResult.needsSignIn(linkHandle: \(h == nil ? "nil" : redactedCredential), reason: \(r.rawValue))"
        case .deviceLimit: return "AutoSignInResult.deviceLimit"
        case .unavailable(let c): return "AutoSignInResult.unavailable(\(c))"
        }
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["result": description], displayStyle: .struct) }
}

extension IdentityClient {
    /// Install the platform provider `signOut()` cleans up after and `autoSignIn()` uses by default.
    public func installPlatformIdentity(_ provider: (any PlatformIdentityProvider)?) {
        platformProvider.set(provider)
    }

    /// Run the ladder. Never throws: a refusal is a result.
    public func autoSignIn(_ options: AutoSignInOptions = AutoSignInOptions()) async -> AutoSignInResult {
        let provider = options.provider ?? platformProvider.current
        if let provider, await provider.credentialRevoked() { await signOutAfterRevocation(provider) }

        // Rung 1: the stored session.
        if await core.token != nil, await core.cache().license != nil {
            let id = await core.cache().license?.doc.licenseId
            return .signedIn(SignInReady(subject: subjectValue.current, licenseId: id))
        }
        // Signed out on purpose: rungs 2-4 stay quiet.
        if await core.explicitSignOut() { return .needsSignIn(linkHandle: nil, reason: .signedOut) }
        guard let provider else { return .unavailable(code: ErrorCode.platformIdentityUnavailable) }

        // Rung 3: silent.
        switch await attempt(provider, silent: true) {
        case .done(let result): return result
        case .nothing: break
        }
        // Rung 4: the one sheet.
        if options.prompt == .optional {
            switch await attempt(provider, silent: false) {
            case .done(let result): return result
            case .nothing: break
            }
        }
        return .needsSignIn(linkHandle: nil, reason: .noCredential)
    }

    /// Called by `signOut()` once the Worker accepted it: no silent rung runs until the next
    /// explicit sign-in, and the platform forgets its session.
    func markSignedOut() async {
        await core.setExplicitSignOut(true)
        await platformProvider.current?.signOutCleanup()
    }

    private enum Attempt {
        case done(AutoSignInResult)
        /// The provider had no token; try the next rung.
        case nothing
    }

    private func attempt(_ provider: any PlatformIdentityProvider, silent: Bool) async -> Attempt {
        do {
            let answer = try await exchangeNonce(kind: provider.kind)
            guard case .nonce(let nonce) = answer else {
                if case .unavailable(let code) = answer { return .done(.unavailable(code: code)) }
                return .nothing
            }
            let subject: PlatformSubjectToken
            do {
                subject = try await silent ? provider.silent(nonce: nonce.value) : provider.sheet(nonce: nonce.value)
            } catch is CancellationError {
                return .done(.unavailable(code: "cancelled"))
            } catch {
                return .nothing
            }
            let outcome = try await exchange(kind: provider.kind, subjectToken: subject.token, nonce: nonce.value)
            return .done(Self.result(outcome))
        } catch let error as ExchangeError {
            if error.code == ErrorCode.deviceLimit { return .done(.deviceLimit(view: error.view)) }
            return .done(.unavailable(code: error.code))
        } catch let error as PolarisError {
            return .done(.unavailable(code: error.code))
        } catch {
            return .done(.unavailable(code: IdentityClient.networkError))
        }
    }

    private static func result(_ outcome: ExchangeOutcome) -> AutoSignInResult {
        switch outcome {
        case .signedIn(let ready): return .signedIn(ready)
        case .confirm(let pending): return .confirm(pending)
        case .choose(let pending): return .choose(pending)
        case .needsSignIn(let n):
            return .needsSignIn(linkHandle: n.linkHandle, reason: n.reason == .terms ? .terms : .noLink)
        case .unavailable(let code): return .unavailable(code: code)
        }
    }

    /// Scenario 11. With a session this is the regular `signOut()`; with none, only the local state.
    private func signOutAfterRevocation(_ provider: any PlatformIdentityProvider) async {
        if await core.token == nil {
            await core.setExplicitSignOut(true)
            await provider.signOutCleanup()
        } else {
            _ = try? await signOut()
        }
    }
}
