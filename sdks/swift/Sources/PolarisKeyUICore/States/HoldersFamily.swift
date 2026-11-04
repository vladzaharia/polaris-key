// @pkey-feature ui.signin ui.settings
// The holders family of ui-matrix.json: ActivateDone and AddToAccount (activation without an
// account), a port of @polaris-key/ui-core's models/holders.ts. After a key activates the license
// is floating, held by the key alone; ActivateDone says so and recommends an account once, quietly;
// AddToAccount collects a name and an email, and the browser confirms the email. The rules the rows
// pin:
//   - the reasons are written once (`recommendReasons`): Cloud Sync only when the product has it;
//     getting the license back and moving it to a new device only when Identity is on; with
//     Identity off the one line sends the person to the portal;
//   - the holder is `licenseHolder.email`: empty is floating, set is waiting for that email with
//     Identity on (with Identity off it is ready, one portal line), which
//     a screen shows masked (`KitFormat.maskEmail`) and never in full;
//   - skipping is never a refusal: Start using is always the one primary.

import Foundation

public enum ActivateDoneState: String, KitStateID {
    case ready, waiting
    public static let component = KitComponent.activateDone
}

public enum AddToAccountState: String, KitStateID {
    case form, invalid, busy, waiting, added, owned
    case emailBound = "email-bound"
    case otherAccount = "other-account"
    case failed
    public static let component = KitComponent.addToAccount
}

/// A run of a reason line: the first words are a lead-in a renderer may draw strong.
public struct KitLeadRun: Sendable, Equatable {
    public let text: String
    public let strong: Bool

    public init(text: String, strong: Bool) {
        self.text = text
        self.strong = strong
    }
}

extension KitFormat {
    /// An email with its middle hidden, `a•••@example.com`: what a screen shows of an address it
    /// did not just type. An address with no local part or no domain is "", so a screen shows no
    /// half-hidden fragment.
    public static func maskEmail(_ email: String?) -> String {
        guard let email, let at = email.lastIndex(of: "@"), at != email.startIndex else { return "" }
        let domain = email[email.index(after: at)...]
        guard let first = email.unicodeScalars.first, !domain.isEmpty else { return "" }
        return "\(Character(first))\u{2022}\u{2022}\u{2022}@\(domain)"
    }

    /// The license line as drawn: a segment whose value is unknown (an argument the state could not give,
    /// left as `{term}`) is dropped, never drawn with its brace. Nil when nothing is left.
    public static func deviceLine(_ text: String) -> String? {
        let parts = text.components(separatedBy: " · ").filter { !$0.contains("{") && !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }

    /// Split a formatted reason on `**` into runs; the odd-numbered pieces are the strong lead-in
    /// (ui-core's `leadParts`). A renderer draws each run itself and never hands the string to a
    /// markup parser.
    public static func leadParts(_ text: String) -> [KitLeadRun] {
        text.components(separatedBy: "**").enumerated().compactMap { index, piece in
            piece.isEmpty ? nil : KitLeadRun(text: piece, strong: index % 2 == 1)
        }
    }
}

extension KitStates {
    /// The copy keys of the recommendation's reason lines, in the order they show.
    public static func recommendReasons(identity: Bool, sync: Bool) -> [String] {
        if !identity { return ["activate.recommend.portal"] }
        return (sync ? ["activate.recommend.sync"] : []) + [
            "activate.recommend.recover", "activate.recommend.devices",
        ]
    }

    /// The reasons for what the input's services turn on.
    static func reasons(_ i: KitInputs) -> [String] {
        let on = i.closedServices
        return recommendReasons(identity: on.contains(.identity), sync: on.contains(.sync))
    }

    /// The step after a license key activates: "<Product> is ready", the license line, and the
    /// recommendation when no email holds the license; a license sent to an email that has no
    /// account yet shows the waiting line instead.
    public static func activateDone(_ i: KitInputs) -> KitScreen<ActivateDoneState> {
        let on = i.closedServices
        guard on.contains(.license), let done = i.activateDone else { return .hidden }
        let c = Ctx(i)
        // Swift's KitActivation carries no tier or term: ActivateDone's own facts are the source.
        var args = c.productArg
        args["developer"] = c.developerArg["developer"]
        if let tier = done.tier { args["tier"] = .text(tier) }
        if let term = done.term { args["term"] = .text(term) }
        if let kind = done.deviceKind { args["deviceKind"] = .text(kind) }
        if let n = done.position { args["n"] = .number(n) }
        if let limit = done.limit { args["limit"] = .number(limit) }
        let masked = KitFormat.maskEmail(i.licenseHolder?.email)
        // Waiting needs Identity: with it off the license sent to an email still draws ready, with
        // the one portal line.
        if !masked.isEmpty, on.contains(.identity) {
            args["maskedEmail"] = .text(masked)
            return KitScreen(
                .waiting,
                [
                    "activate.done.title", "activate.done.device", "activate.waiting",
                    "activate.waitingSignIn", "signin.done.start",
                ].map { c.line($0, args) })
        }
        let portal = !on.contains(.identity) || (done.addIn ?? i.licenseHolder?.addIn) == .portal
        var keys = [
            "activate.done.title", "activate.done.device", "activate.recommend.title",
            "activate.recommend.badge",
        ]
        keys += reasons(i)
        // With Identity off, or a kit with no in-app channel, the action opens polaris.locker, so
        // it says that (an external link).
        keys.append(portal ? "signin.key.addInLocker" : "activate.recommend.action")
        // A TV opens its in-app QR, not a browser: no ↗ and no external-link hint.
        if portal && !i.platform.isTV { keys.append("a11y.externalLink") }
        keys += ["activate.recommend.skip", "signin.done.start"]
        return KitScreen(.ready, keys.map { c.line($0, args) })
    }

    /// Add your name and email: the person types them here, the browser confirms the email.
    /// `asAdded` draws the `added` step whatever the input says (the sign-in form's `added`).
    public static func addToAccount(_ i: KitInputs, asAdded: Bool = false)
        -> KitScreen<AddToAccountState>
    {
        let on = i.closedServices
        guard on.contains(.identity), on.contains(.license), let a = i.addToAccount else {
            return .hidden
        }
        let c = Ctx(i)
        let masked: String = {
            if let typed = a.typedEmail, !typed.isEmpty { return typed }
            return KitFormat.maskEmail(i.licenseHolder?.email)
        }()
        var args = c.productArg
        if let kind = a.deviceKind { args["deviceKind"] = .text(kind) }
        if !masked.isEmpty { args["maskedEmail"] = .text(masked) }
        if let signed = a.signedEmail, !signed.isEmpty { args["email"] = .text(signed) }
        func lines(_ keys: [String]) -> [CopyLine] { keys.map { c.line($0, args) } }

        let name = "activate.attach.name"
        let email = "signin.email.label"
        let fields = [
            "activate.recommend.action", "activate.attach.lede", name, email,
            "activate.attach.fine", "common.continue", "common.cancel",
        ]
        switch asAdded ? .added : a.step {
        case .form:
            return KitScreen(.form, lines(fields))
        case .invalid:
            let bad = (a.field ?? .both) == .both ? [name, email] : [(a.field == .name) ? name : email]
            return KitScreen(
                .invalid,
                lines(
                    fields + (bad.contains(name) ? ["activate.attach.nameRequired"] : [])
                        + (bad.contains(email) ? ["signin.email.invalid"] : [])))
        case .busy:
            // The person confirms the email in Polaris Locker: the form gives way to `waiting`,
            // the code they check there. With no code to show, the form stays greyed behind Working.
            if let code = i.deviceCode, code.userCode?.isEmpty == false {
                return KitScreen(
                    .waiting,
                    lines([
                        "activate.attach.waitTitle", "part.code.label", "a11y.code",
                        "a11y.copyCode", "activate.attach.waitCheck", "activate.attach.reopen",
                        "common.cancel",
                    ]))
            }
            // The person is in the browser, which can take minutes: Continue stays (busy), Open the
            // browser again brings the tab back, and Cancel is the way out.
            return KitScreen(
                .busy,
                lines(
                    fields.filter { $0 != "common.cancel" } + [
                        "common.working", "signin.handoff.again", "common.cancel",
                    ]))
        case .added:
            // From Settings the app is already running: the screen closes with Done.
            let closing = a.fromSettings == true ? "common.done" : "signin.done.start"
            return KitScreen(
                .added,
                lines(
                    ["activate.attach.done"] + (on.contains(.sync) ? ["activate.attach.syncOn"] : [])
                        + [closing]))
        case .owned:
            // Someone attached the license while this screen was open.
            return KitScreen(
                .owned,
                lines([
                    "activate.owned.title", "activate.owned.lede", "signin.key.ownedSignIn",
                    "common.cancel",
                ]))
        case .emailBound:
            // The license's email is not the account's; the license keeps working. The sentence
            // and "Verify that email" name the email; with none known both are left out.
            let known = !masked.isEmpty
            return KitScreen(
                .emailBound,
                lines(
                    ["activate.otherEmail.title"]
                        + (known ? ["activate.otherEmail.body", "activate.otherEmail.verify"] : [])
                        + ["signin.auto.confirm.other", "signin.done.start"]))
        case .otherAccount:
            // A different account signed in than the email typed: the license was added nowhere.
            let both = !masked.isEmpty && args["email"] != nil
            return KitScreen(
                .otherAccount,
                lines(
                    ["activate.otherAccount.title"] + (both ? ["activate.otherAccount.body"] : [])
                        + ["common.tryAgain", "signin.done.start"]))
        case .failed:
            return KitScreen(
                .failed,
                lines([
                    "activate.recommend.action", "activate.attach.failed", "common.tryAgain",
                    "common.cancel",
                ]))
        }
    }

    /// The sign-in form's step after a key with no account: the holders' screens in the form's
    /// body, under the form's own state names. A screen hidden here leaves the form hidden.
    static func holderStep(_ step: KitHolderFormStep, _ i: KitInputs) -> KitScreen<SignInState> {
        switch step {
        case .keyDone:
            let screen = activateDone(i)
            return screen.isHidden ? .hidden : KitScreen(.keyDone, screen.copy)
        case .attach:
            let screen = addToAccount(i)
            return screen.isHidden ? .hidden : KitScreen(.attach, screen.copy)
        case .added:
            let screen = addToAccount(i, asAdded: true)
            return screen.isHidden ? .hidden : KitScreen(.added, screen.copy)
        }
    }
}
