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
//   - `signOut()` bumps the sign-out generation, then (once the Worker accepted it) sets
//     `explicitSignOut` (CoreContext, persisted beside the credential, fails closed) and runs the
//     provider's `signOutCleanup()`. While the flag is set rungs 3 and 4 do not run. Only a sign-in
//     the person started (redirect, device code, `choice.complete`, `exchange` called from the
//     sign-in form) clears it; the ladder's own exchange never does.
//   - The ladder captures the generation when it starts; a sign-out during the platform prompt or
//     the exchange makes it store nothing and answer `needsSignIn(.signedOut)`.
//   - Rung 1 counts only a token the device holds as a sign-in (`TokenProvenance.signin`). A
//     key-activated device, an enrolment, or a device an account sign-out left activated is not.
//   - A provider that reports its credential revoked at launch (Sign in with Apple, scenario 11)
//     signs the device out through `signOut()`. If the Worker cannot be reached the flag stays
//     unset and the check repeats at the next launch.
//   - Device keys are the device's identity, not account state: sign-out keeps them.
//   - Cancelling the task rethrows `CancellationError`; nothing else throws.
//
// Nothing here logs, prints or keeps a token, a grant or a link handle; the result redacts them.
// `syncKey` is absent until U-39 (Q-8).

import Foundation
import PolarisKeyCore

/// What a platform provider hands the exchange: an identity token bound to the nonce. A secret.
public struct PlatformSubjectToken: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// The identity token. A secret.
    public let token: String
    /// The server nonce that was bound into the request.
    public let nonce: String
    /// The platform's stable user id, when it gave one. Not a secret.
    public let userID: String?
    public init(token: String, nonce: String, userID: String? = nil) {
        self.token = token
        self.nonce = nonce
        self.userID = userID
    }
    public var description: String { "PlatformSubjectToken(<redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(
            self, children: ["token": redactedCredential, "nonce": redactedCredential, "userID": userID as Any],
            displayStyle: .struct)
    }
}

/// A platform token exchanged for a grant that still needs the person's consent or choice.
struct PendingPlatformSession: Sendable {
    let provider: any PlatformIdentityProvider
    let subject: PlatformSubjectToken
}

/// The platform's identity (Sign in with Apple; Google where a native one exists) behind the
/// ladder. The nonce is the Worker's, passed on as it is.
public protocol PlatformIdentityProvider: Sendable {
    /// Which `exchange` kind this provider's tokens are.
    var kind: ExchangeKind { get }
    /// False when the platform has no silent mode (Sign in with Apple): rung 3 is skipped with no
    /// request. Default: true.
    var hasSilentRung: Bool { get }
    /// An identity token with no UI. Throws when none is immediately available.
    func silent(nonce: String) async throws -> PlatformSubjectToken
    /// An identity token through the platform's one account sheet. Throws when dismissed.
    func sheet(nonce: String) async throws -> PlatformSubjectToken
    /// Called once the Worker accepted a platform token (`signedIn`, `confirm` or `choose`), so the
    /// provider can keep what its launch check needs. Default: nothing.
    func sessionStarted(_ token: PlatformSubjectToken) async
    /// Forget the platform's session state (called by `identity.signOut()`).
    func signOutCleanup() async
    /// True when the platform says the person revoked this app's credential.
    func credentialRevoked() async -> Bool
}

extension PlatformIdentityProvider {
    public var hasSilentRung: Bool { true }
    public func sessionStarted(_ token: PlatformSubjectToken) async {}
}

/// Whether the ladder may show the provider's sheet (rung 4).
public enum AutoSignInPrompt: Sendable, Equatable {
    /// Rung 3 only (silent). The default.
    case never
    /// Rung 4 after rung 3 finds nothing: at most one OS sheet. The developer opts in.
    case optional
}

public struct AutoSignInOptions: Sendable {
    /// The provider to use; nil uses the one installed on the client (`installPlatformIdentity`).
    public var provider: (any PlatformIdentityProvider)?
    public var prompt: AutoSignInPrompt

    public init(provider: (any PlatformIdentityProvider)? = nil, prompt: AutoSignInPrompt = .never) {
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
    /// Every seat is taken. `manageUrl` is where to manage devices and `view` the choice view
    /// (with the replace rows), when the Worker sent them.
    case deviceLimit(manageUrl: String?, view: LicenseChoiceView?)
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
            return
                "AutoSignInResult.needsSignIn(linkHandle: \(h == nil ? "nil" : redactedCredential), reason: \(r.rawValue))"
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

    /// Run the ladder. A refusal is a result; only cancelling the task throws.
    public func autoSignIn(_ options: AutoSignInOptions = AutoSignInOptions()) async throws -> AutoSignInResult {
        let provider = options.provider ?? platformProvider.current
        if let provider, await provider.credentialRevoked() { await signOutAfterRevocation(provider) }
        let generation = await core.signOutGeneration

        // Rung 1: a token the device holds as a sign-in, with a licence.
        if await core.token != nil, await core.tokenProvenance() == .signin,
            await core.cache().license != nil
        {
            let id = await core.cache().license?.doc.licenseId
            return .signedIn(SignInReady(subject: subjectValue.current, licenseId: id))
        }
        // Signed out on purpose: rungs 2-4 stay quiet.
        if await core.explicitSignOut() { return .needsSignIn(linkHandle: nil, reason: .signedOut) }
        // No platform identity here (no provider installed): the regular form is next.
        guard let provider else { return .needsSignIn(linkHandle: nil, reason: .noCredential) }

        // Rung 3: silent.
        if provider.hasSilentRung {
            switch try await attempt(provider, silent: true, generation: generation) {
            case .done(let result): return result
            case .nothing: break
            }
        }
        // Rung 4: the one sheet.
        if options.prompt == .optional {
            switch try await attempt(provider, silent: false, generation: generation) {
            case .done(let result): return result
            case .nothing: break
            }
        }
        return .needsSignIn(linkHandle: nil, reason: .noCredential)
    }

    /// Called by `signOut()` once the Worker accepted it: no silent rung runs until the next
    /// person-started sign-in, and the platform forgets its session.
    func markSignedOut(_ provider: (any PlatformIdentityProvider)? = nil) async {
        await core.bumpSignOutGeneration()
        await core.setExplicitSignOut(true)
        await (provider ?? platformProvider.current)?.signOutCleanup()
    }

    private enum Attempt {
        case done(AutoSignInResult)
        /// The provider had no token; try the next rung.
        case nothing
    }

    private func attempt(
        _ provider: any PlatformIdentityProvider, silent: Bool, generation: Int
    ) async throws -> Attempt {
        let signedOut = Attempt.done(.needsSignIn(linkHandle: nil, reason: .signedOut))
        do {
            let answer = try await exchangeNonce(kind: provider.kind)
            guard case .nonce(let nonce) = answer else {
                if case .unavailable(let code) = answer { return .done(.unavailable(code: code)) }
                return .nothing
            }
            let subject: PlatformSubjectToken
            do {
                subject = try await silent ? provider.silent(nonce: nonce.value) : provider.sheet(nonce: nonce.value)
            } catch {
                try Task.checkCancellation()
                return .nothing
            }
            // A sign-out while the platform was prompting wins.
            if await core.signOutGeneration != generation { return signedOut }
            let outcome = try await exchange(
                kind: provider.kind, subjectToken: subject.token, optionalNonce: nonce.value,
                ladderGeneration: generation)
            await platformSession(outcome, provider: provider, subject: subject)
            return .done(Self.result(outcome))
        } catch is SignedOutDuringLadder {
            return signedOut
        } catch let error as CancellationError {
            throw error
        } catch let error as ExchangeError {
            try Task.checkCancellation()
            if error.code == ErrorCode.deviceLimit {
                return .done(.deviceLimit(manageUrl: error.manageUrl, view: error.view))
            }
            return .done(.unavailable(code: error.code))
        } catch let error as PolarisError {
            try Task.checkCancellation()
            return .done(.unavailable(code: error.code))
        } catch {
            try Task.checkCancellation()
            return .done(.unavailable(code: IdentityClient.networkError))
        }
    }

    /// Hand the provider its session once one exists: now for `.signedIn`; for a `confirm` or a
    /// `choose`, when `choice.complete` finishes that grant. Nothing is kept for any other way
    /// of signing in, so a later non-Apple session never inherits an Apple user id.
    public func platformSession(
        _ outcome: ExchangeOutcome, provider: any PlatformIdentityProvider,
        subject: PlatformSubjectToken
    ) async {
        let held = PendingPlatformSession(provider: provider, subject: subject)
        switch outcome {
        case .signedIn: await provider.sessionStarted(subject)
        case .confirm(let p): pendingPlatformSessions.with { $0[p.grant] = held }
        case .choose(let p): pendingPlatformSessions.with { $0[p.grant] = held }
        default: break
        }
    }

    /// `choice.complete` made a session from `grant`.
    func platformSessionCompleted(grant: String) async {
        let held = pendingPlatformSessions.with { $0.removeValue(forKey: grant) }
        if let held { await held.provider.sessionStarted(held.subject) }
    }

    func platformSessionDropped(grant: String) {
        pendingPlatformSessions.with { _ = $0.removeValue(forKey: grant) }
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

    /// Scenario 11, with the provider the ladder is using. With a session this is the regular
    /// `signOut()`; with none, only the local state.
    private func signOutAfterRevocation(_ provider: any PlatformIdentityProvider) async {
        if await core.token == nil {
            await markSignedOut(provider)
        } else {
            _ = try? await signOut(cleaningUp: provider)
        }
    }
}
