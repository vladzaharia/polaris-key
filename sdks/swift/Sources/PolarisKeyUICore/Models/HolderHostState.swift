// What the host reports on a holder screen (UK-43.5): an account sign-in that runs from the screen
// (Sign in to that account, Use another account, Sign in as <email>), the page it opened, and the
// problems the screen says in the danger tone. The same wait screen as the add-to-account sign-in
// shows its code, address and QR; Cancel lets the sign-in go and stays live throughout.
//
//   host.signIn(loginHint: email)   // true: signed in (the gate re-reads the license)
//
// A sign-in that does not finish, or a page that does not open, leaves a `problem` on the screen it
// ran on. Nothing here sends a code or writes a license: it is a sign-in, then the host goes on.

import Foundation
import Observation

/// What a holder screen says went wrong, once.
public enum HolderProblem: Sendable, Equatable {
    /// The page did not open ("We couldn't open your browser").
    case openFailed
    /// The sign-in did not finish.
    case signInFailed
    /// The product page has no link to open: there is nothing to scan or open.
    case linkUnavailable

    /// The catalog key of the sentence.
    public var key: String {
        switch self {
        case .openFailed: return "signin.handoff.noBrowser"
        case .signInFailed: return "signin.approve.failed"
        case .linkUnavailable: return "common.linkUnavailable"
        }
    }
}

@MainActor
@Observable
public final class HolderHostState {
    /// An account sign-in runs.
    public private(set) var working = false
    /// Its page has opened once.
    public private(set) var opened = false
    public var problem: HolderProblem?
    /// The wait's code, its page as text and the link its QR carries (a code sign-in only).
    public private(set) var userCode: String?
    public private(set) var address: String?
    public private(set) var link: String?

    /// The email the running sign-in was asked for (the hint), shown masked on the wait.
    public private(set) var hint: String?
    /// The sign-in ended on an account other than the one asked for: both emails, until `takeMismatch()`.
    public private(set) var mismatch: Mismatch?

    /// An account other than the expected one signed in.
    public struct Mismatch: Sendable, Equatable {
        public let expected: String
        public let signed: String
    }

    private let driver: (any AddToAccountDriver)?
    private var handle: (any AddToAccountHandle)?
    private var epoch = 0

    public init(driver: (any AddToAccountDriver)? = nil) { self.driver = driver }

    /// The sign-in shows a code to check: the wait screen replaces the screen it ran on.
    public var waiting: Bool { working && !(userCode ?? "").isEmpty }

    /// The mismatch the last sign-in ended on, once.
    public func takeMismatch() -> Mismatch? {
        defer { mismatch = nil }
        return mismatch
    }

    /// Sign in to an account, with `loginHint` when the license's email is known. True when it ended
    /// signed in; otherwise the problem is on the screen, or the person cancelled. With `expect`, a
    /// sign-in that names a different account is not a success: `mismatch` holds both. A sign-in that
    /// names no account (a redirect one) is never claimed to match: it finishes as before.
    @discardableResult
    public func signIn(loginHint: String? = nil, expect: String? = nil) async -> Bool {
        guard let driver, !working else { return false }
        epoch += 1
        let mine = epoch
        working = true
        problem = nil
        mismatch = nil
        reset()
        hint = (loginHint ?? "").isEmpty ? nil : loginHint
        defer { if mine == epoch { working = false } }
        do {
            let hints = AddToAccountHints(
                loginHint: loginHint ?? "", nameHint: "", purpose: "signin")
            let opened = try await driver.signIn(hints)
            guard mine == epoch else {
                opened.cancel()
                return false
            }
            handle = opened
            if let code = opened.userCode, !code.isEmpty {
                userCode = code
                address = opened.verificationUri.flatMap { $0.isEmpty ? nil : $0 }
                link = opened.verificationUriComplete.flatMap { $0.isEmpty ? nil : $0 }
                let ok = await opened.reopen()
                guard mine == epoch else { return false }
                self.opened = ok
                if !ok { problem = .openFailed }
            } else {
                self.opened = true
            }
            while true {
                let answer = try await opened.wait()
                guard mine == epoch else { return false }
                switch answer {
                case .pending: continue
                case .signedIn(let signed):
                    handle = nil
                    if let expect, !expect.isEmpty, let signed, !signed.isEmpty,
                        signed.lowercased() != expect.lowercased()
                    {
                        mismatch = Mismatch(expected: expect, signed: signed)
                        return false
                    }
                    return true
                case .choose(let grant):
                    guard try await driver.complete(grant: grant) else {
                        problem = .signInFailed
                        return false
                    }
                    guard mine == epoch else { return false }
                    handle = nil
                    return true
                case .cancelled: return false
                case .expired:
                    problem = .signInFailed
                    return false
                }
            }
        } catch {
            if mine == epoch { problem = .signInFailed }
            return false
        }
    }

    /// Bring the page back while the sign-in runs; says so when nothing could open.
    public func reopen() async {
        guard let handle else { return }
        let mine = epoch
        let ok = await handle.reopen()
        guard mine == epoch else { return }
        opened = opened || ok
        problem = ok ? (problem == .openFailed ? nil : problem) : .openFailed
    }

    /// Let the sign-in go. The screen it ran on stays as it was.
    public func cancel() {
        guard working || handle != nil else { return }
        epoch += 1
        handle?.cancel()
        handle = nil
        working = false
        problem = nil
        reset()
        hint = nil
    }

    private func reset() {
        userCode = nil
        address = nil
        link = nil
        opened = false
    }
}
