// The AddToAccount model (UK-43.4): the state machine behind the AddToAccount screen, a port of
// @polaris-key/ui-core's `addToAccountModel.ts` (and the Python, Kotlin and Godot ports). A license a
// key activated is floating; this adds it to an account. The person types a name and an email (they
// live only here, never in the views' inputs), the browser confirms the email, and the license is
// attached:
//
//     form -> busy -> added | owned | email-bound | other-account | failed   (invalid: a field is wrong)
//
// The model runs over `AddToAccountDriver`, three calls the gates implement over the SDK
// (`IdentityAddToAccountDriver`): sign in with the hints, keep this device's license, attach. A
// sign-in that ends signed in goes to attach after a preview that writes nothing. The hints only
// prefill the page: nothing here sends a code, and `attach` carries no address. An attempt that ends
// bumps the epoch, so the late answer of a cancelled one is dropped.
//
//   let model = AddToAccountModel(driver: driver, base: inputs, deviceKind: "Mac")
//   model.setField(.name, "Ada"); model.setField(.email, "ada@example.com")
//   await model.submit()           // blocks while the browser is open; run it from a Task
//   model.step                     // .added
//
// `cancel()` may be called while `submit()` is suspended: the sign-in is let go and the form comes back
// with the fields kept.

import Foundation
import Observation

/// The hints the sign-in carries: the typed email and name, and the purpose.
public struct AddToAccountHints: Sendable, Equatable {
    public let loginHint: String
    public let nameHint: String
    public let purpose: String

    public init(loginHint: String, nameHint: String, purpose: String = "attach") {
        self.loginHint = loginHint
        self.nameHint = nameHint
        self.purpose = purpose
    }
}

/// One answer of a sign-in's wait.
public enum AddToAccountWait: Sendable, Equatable {
    case pending
    /// Signed in; `email` is the account's address when the sign-in named it.
    case signedIn(email: String?)
    /// A license choice is due; the driver completes `grant` with Keep.
    case choose(grant: String)
    case cancelled
    case expired
}

/// The preview's and the attach's answer.
public enum AddToAccountAttach: Sendable, Equatable {
    case ok
    /// `code` is the Worker's wire code.
    case refused(code: String)
}

/// A running sign-in as the model sees it.
public protocol AddToAccountHandle: AnyObject, Sendable {
    /// The code the person checks against the one Polaris Locker shows, when the sign-in has one.
    var userCode: String? { get }
    func wait() async throws -> AddToAccountWait
    /// The page the person goes to when the sign-in is a code (`polaris.locker/device`); nil for a redirect.
    var verificationUri: String? { get }
    /// The same page with the code filled in: what the QR carries.
    var verificationUriComplete: String? { get }
    /// Bring the browser tab back; false when nothing could open.
    func reopen() async -> Bool
    func cancel()
}

extension AddToAccountHandle {
    public var verificationUri: String? { nil }
    public var verificationUriComplete: String? { nil }
}

/// The narrow interface both gates implement.
public protocol AddToAccountDriver: Sendable {
    func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle
    /// Keep this device's license in the signed-in account; false when the choice did not complete.
    func complete(grant: String) async throws -> Bool
    /// `confirm: false` previews (nothing is written); `true` writes.
    func attach(confirm: Bool) async throws -> AddToAccountAttach
}

/// Which typed field.
public enum AddToAccountField: Sendable, Equatable {
    case name, email
}

@MainActor
@Observable
public final class AddToAccountModel {
    public private(set) var step: KitAddToAccount.Step = .form
    /// `invalid`: the field to fix.
    public private(set) var field: KitAddToAccount.Field?
    /// `other-account`: both emails, masked (never the full address).
    public private(set) var typedEmail: String?
    public private(set) var signedEmail: String?
    public private(set) var name = ""
    public private(set) var email = ""
    /// `busy`: the code to check against Polaris Locker's, when the sign-in has one.
    public private(set) var userCode: String?
    /// The code's page, as text, and the link its QR carries.
    public private(set) var address: String?
    public private(set) var link: String?
    /// The page has opened once: the wait's button says "Open browser" until then.
    public private(set) var opened = false
    /// The last open failed: the screen says so, in the danger tone.
    public private(set) var openFailed = false
    /// Account sign-ins (owned, email-bound) and their wait: the same screen, run over this model's driver.
    public let host: HolderHostState

    private let driver: any AddToAccountDriver
    /// Everything else the views read (platform, presentation, services, `licenseHolder`).
    private let base: KitInputs
    private let deviceKind: String?
    /// Opened from Settings: the app is already running, so Added closes with Done.
    private let fromSettings: Bool
    private var handle: (any AddToAccountHandle)?
    // Bumped when an attempt ends, so a late answer from an old one is dropped.
    private var epoch = 0
    // The account sign-in finished: Try again then attaches again, with no second sign-in.
    private var signedIn = false
    // The email of the account that signed in, when the sign-in named it.
    private var signedInEmail: String?

    public init(
        driver: any AddToAccountDriver, base: KitInputs = KitInputs(), deviceKind: String? = nil,
        fromSettings: Bool = false
    ) {
        self.driver = driver
        self.base = base
        self.deviceKind = deviceKind
        self.fromSettings = fromSettings
        self.host = HolderHostState(driver: driver)
    }

    // MARK: - What the views read

    /// The views' inputs: `base` with the step on top. Name and email are not in it.
    public var inputs: KitInputs {
        var i = base
        if step == .busy, let code = userCode, !code.isEmpty {
            i.deviceCode = KitDeviceCode(phase: .waiting, userCode: code, verificationUri: address)
        }
        i.addToAccount = KitAddToAccount(
            step: step, field: field, deviceKind: deviceKind,
            typedEmail: step == .otherAccount ? typedEmail : nil,
            signedEmail: step == .otherAccount ? signedEmail : nil,
            fromSettings: fromSettings ? true : nil)
        return i
    }

    /// The screen for the current step.
    public var screen: KitScreen<AddToAccountState> { KitStates.addToAccount(inputs) }

    /// The person typed in a field; an `invalid` step goes back to `form`. A busy attempt ignores typing.
    public func setField(_ which: AddToAccountField, _ value: String) {
        if step == .busy { return }
        switch which {
        case .name: name = value
        case .email: email = value
        }
        if step == .invalid {
            step = .form
            field = nil
        }
    }

    /// True when Continue (or Try again) would start the browser sign-in right now: the fields are
    /// valid and no sign-in has finished. A gate arms its tab inside the press only then.
    public var willOpenBrowser: Bool {
        if step == .busy || step == .otherAccount { return false }
        return !name.trimmed.isEmpty && Self.isEmail(email.trimmed) && !signedIn
    }

    // MARK: - Actions

    /// Continue: check the fields, then sign in and attach.
    public func submit() async {
        if step == .busy { return }
        let name = self.name.trimmed
        let email = self.email.trimmed
        let badName = name.isEmpty
        let badEmail = !Self.isEmail(email)
        if badName || badEmail {
            step = .invalid
            field = badName && badEmail ? .both : badName ? .name : .email
            return
        }
        await run(name: name, email: email)
    }

    /// Try again after `failed`: the same attempt, the fields kept. After `other-account` it goes
    /// back to the form to sign in again.
    public func tryAgain() async {
        if step == .otherAccount {
            cancel()
            return
        }
        guard step == .failed else { return }
        await submit()
    }

    /// Bring the browser tab back while the sign-in runs. Call it inside the press.
    public func reopen() async {
        guard let handle else { return }
        let mine = epoch
        let ok = await handle.reopen()
        guard current(mine) else { return }
        opened = opened || ok
        openFailed = !ok
    }

    /// Cancel: back to the form with the fields kept, any sign-in in flight let go.
    public func cancel() {
        let old = handle
        endAttempt()
        signedIn = false
        signedInEmail = nil
        step = .form
        field = nil
        clearWait()
        typedEmail = nil
        signedEmail = nil
        old?.cancel()
        host.cancel()
    }

    // MARK: - The attempt

    private func endAttempt() {
        epoch += 1
        handle = nil
    }

    private func current(_ mine: Int) -> Bool { mine == epoch }

    private func set(_ next: KitAddToAccount.Step, _ mine: Int) {
        guard current(mine) else { return }
        step = next
        field = nil
        clearWait()
    }

    private func clearWait() {
        userCode = nil
        address = nil
        link = nil
        opened = false
        openFailed = false
    }

    private func run(name: String, email: String) async {
        // Try again lets the previous sign-in go before it starts another.
        let previous = handle
        endAttempt()
        let mine = epoch
        previous?.cancel()
        step = .busy
        field = nil
        clearWait()
        do {
            if !signedIn {
                guard try await signIn(name: name, email: email, mine: mine) else { return }
            }
            guard current(mine) else { return }
            signedIn = true
            // Preview first: nothing is written until the account is the one the person typed.
            let preview = try await driver.attach(confirm: false)
            guard current(mine) else { return }
            if case .refused(let code) = preview {
                if code == "account_required" { signedIn = false }
                set(Self.step(of: preview), mine)
                return
            }
            if let signed = signedInEmail,
                signed.trimmed.lowercased() != email.lowercased()
            {
                // A different account signed in than the email typed: the license is added nowhere,
                // and Try again goes back to the form. Both emails are shown masked, never in full.
                signedIn = false
                typedEmail = KitFormat.maskEmail(email)
                signedEmail = KitFormat.maskEmail(signed)
                step = .otherAccount
                field = nil
                return
            }
            let result = try await driver.attach(confirm: true)
            guard current(mine) else { return }
            // No account session after all: Try again signs in again.
            if case .refused(let code) = result, code == "account_required" { signedIn = false }
            set(Self.step(of: result), mine)
        } catch {
            set(.failed, mine)
        }
    }

    /// True when the account sign-in ended signed in; otherwise the step is already set (or the
    /// attempt is no longer the current one).
    private func signIn(name: String, email: String, mine: Int) async throws -> Bool {
        let opened = try await driver.signIn(AddToAccountHints(loginHint: email, nameHint: name))
        guard current(mine) else {
            opened.cancel()
            return false
        }
        handle = opened
        if let code = opened.userCode, !code.isEmpty {
            userCode = code
            address = opened.verificationUri.flatMap { $0.isEmpty ? nil : $0 }
            link = opened.verificationUriComplete.flatMap { $0.isEmpty ? nil : $0 }
            // A code sign-in opens nothing by itself: open its page now, and say so when that fails.
            let ok = await opened.reopen()
            guard current(mine) else { return false }
            self.opened = ok
            openFailed = !ok
        } else {
            // A redirect sign-in opened its own browser when it started.
            self.opened = true
        }
        while true {
            let answer = try await opened.wait()
            guard current(mine) else { return false }
            switch answer {
            case .pending:
                continue
            case .signedIn(let signed):
                signedInEmail = signed
                // Settled: nothing left to cancel on Try again.
                handle = nil
                return true
            case .choose(let grant):
                let completed = try await driver.complete(grant: grant)
                guard current(mine) else { return false }
                if completed {
                    signedInEmail = nil
                    return true
                }
                set(.failed, mine)
                return false
            case .cancelled:
                set(.form, mine)
                return false
            case .expired:
                set(.failed, mine)
                return false
            }
        }
    }

    /// The step an attach answer lands on.
    private static func step(of result: AddToAccountAttach) -> KitAddToAccount.Step {
        switch result {
        case .ok: return .added
        case .refused(let code):
            if code == "license_owned" { return .owned }
            if code == "license_email_bound" { return .emailBound }
            // `account_required` and anything else: Try again.
            return .failed
        }
    }

    private static let emailPattern = try? NSRegularExpression(pattern: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#)

    private static func isEmail(_ value: String) -> Bool {
        let whole = NSRange(value.startIndex..., in: value)
        return emailPattern?.firstMatch(in: value, range: whole)?.range == whole
    }
}

extension String {
    fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
