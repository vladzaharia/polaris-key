// @pkey-feature ui.signin
// The signIn family of ui-matrix.json: the one sign-in form (SIGN-IN.md §3.17) as SignIn, its
// step 2 SignInHandoff and its step 3 KitLicenseChoice (with Replace a device in place).
//
// The form's body morphs in place; nothing stacks on it except the system confirm for Replace where
// the platform expects one (D-80). Device-code sign-ins never choose a license in the app (D4):
// they choose on the card.

import Foundation

public enum SignInState: String, KitStateID {
    case methods, handoff, code, finishing, choose, replace, key, done, error, expired
    public static let component = KitComponent.signIn
}

public enum SignInHandoffState: String, KitStateID {
    case starting, waiting
    case noBrowser = "no-browser"
    case code
    case linkCopied = "link-copied"
    case finishing, denied, expired, cancelled
    public static let component = KitComponent.signInHandoff
}

public enum LicenseChoiceState: String, KitStateID {
    case loading, many, one, current, keep, new, create
    case allFull = "all-full"
    case mixed
    case replaceOpen = "replace-open"
    case raced
    case noneKeys = "none-keys"
    case noneNoKeys = "none-no-keys"
    case grantExpired = "grant-expired"
    public static let component = KitComponent.licenseChoice
}

extension KitPlatform {
    /// Platforms whose Replace a device confirms in the system dialog (`confirmationDialog`,
    /// SIGN-IN.md D-80): the Apple kits.
    var confirmsReplaceInSystem: Bool { os == .macos || os == .ios || os == .visionos }
}

extension KitStates {
    /// The one sign-in form. A step change never restarts the flow or drops the account (the Must
    /// not): Use a license key instead, while choosing, is the `key` step of the same form.
    public static func signIn(_ i: KitInputs) -> KitScreen<SignInState> {
        let c = Ctx(i)
        guard i.isOn(.identity) else { return .hidden }
        let s = i.signIn ?? KitSignIn()
        let keyPath = i.isOn(.license) && i.capabilities.keyEntry
        let deviceCode = s.channel == .deviceCode ? i.deviceCode : nil

        if let error = i.error {
            if error.code == "sign-in-unavailable" {
                return KitScreen(.error, [c.line("signIn.noMethods", c.productArg)])
            }
            return KitScreen(
                .error, [c.line("signIn.methodError", ["method": .text(s.method ?? "")])])
        }
        if s.outcome == .expired {
            return KitScreen(.expired, [c.line("signin.handoff.tooLong"), c.line("signin.again")])
        }
        if deviceCode?.phase == .expired {
            return KitScreen(
                .expired,
                [
                    c.line("core.codes.sign-in-expired.title"),
                    c.line("core.codes.sign-in-expired.message", c.productArg),
                    c.line("signin.again"),
                ])
        }
        if s.outcome == .signedIn {
            // How the form ends (plans/UK-02b.md §4.5): a license issued now gets Done; an
            // existing one opens the app with the toast; without License there is no tier.
            if !i.isOn(.license) {
                return KitScreen(.done, [c.line("signin.return.signedInShort")])
            }
            if s.issuedNow == true {
                return KitScreen(
                    .done,
                    [c.line("signin.return.signedInShort"), c.line("signin.done.start", c.productArg)])
            }
            return KitScreen(.done, [c.line("signin.desktop.toast", ["name": "", "tier": ""])])
        }
        if s.outcome == .choose, s.channel == .browser {
            if s.event == .haveKey, keyPath {
                var lines = [
                    c.line("signin.key.addTitle", c.productArg), c.line("part.keyField.label"),
                ]
                if let a = i.activation, a.result == "refused" { lines += c.codeLines(a.code) }
                return KitScreen(.key, lines)
            }
            if s.event == .openReplace, s.replace == .inline {
                var lines = [
                    c.line("signin.replace.open"),
                    c.line("signin.replace.lede", ["thisDevice": c.thisDeviceTitle]),
                ]
                if i.platform.confirmsReplaceInSystem {
                    lines.append(c.line("signin.replace.openSystem"))
                } else {
                    lines.append(
                        c.line("signin.replace.title", ["device": .text(c.replaceTarget ?? "")]))
                }
                return KitScreen(.replace, lines)
            }
            var lines = [c.line("signin.choice.title")]
            if i.platform.isDesktop {
                lines.append(c.line("signin.desktop.notifyChoose", ["app": c.product]))
            }
            let browserReplace =
                s.replace == .browser && s.event == .openReplace
            return KitScreen(
                .choose, lines, extraActions: browserReplace ? [.replaceInBrowser] : [])
        }
        if s.redeeming == true || deviceCode?.phase == .ok {
            return KitScreen(.finishing, [c.line("signin.handoff.finishing"), c.line("a11y.busy")])
        }
        if s.channel == .deviceCode || (s.outcome == .pending && s.event == .useCode) {
            // The code itself is SignInHandoff's: the form's own body is empty here.
            return KitScreen(.code, [])
        }
        if s.outcome == .pending {
            return KitScreen(
                .handoff,
                [
                    c.line("signin.handoff.title"),
                    c.line("signin.handoff.browserBody", ["app": c.product]),
                    c.line("signin.handoff.waiting"), c.line("signin.handoff.again"),
                    c.line("signin.handoff.useCode"),
                ])
        }
        return KitScreen(.methods, methodLines(c, keyPath: keyPath))
    }

    /// Step 1's methods per platform (SIGN-IN.md §5.1): desktop leads with Continue in browser;
    /// phones and the web add the passkey and email rows, and phones Sign in with a code.
    static func methodLines(_ c: Ctx, keyPath: Bool) -> [CopyLine] {
        let p = c.i.platform
        var lines = [
            c.line("signIn.title", c.productArg),
            c.line("signin.methods.ledeApp", c.productArg),
            c.line("signin.provider.group"),
            c.line("signin.provider.continue", ["provider": ""]),
        ]
        if p.isDesktop {
            lines.append(c.line("signin.desktop.continue"))
            if keyPath { lines.append(c.line("signin.choice.keyInstead")) }
            lines.append(c.line("signin.menu.signIn"))
        } else {
            lines += [c.line("signin.passkey"), c.line("signin.email.continue")]
            if p.os != .web, c.i.capabilities.deviceCode {
                lines.append(c.line("signin.link.deviceCode"))
            }
            if keyPath { lines.append(c.line("signin.choice.keyInstead")) }
        }
        lines.append(c.line("common.cancel"))
        return lines
    }

    /// Step 2 in place: "Finish in your browser", or the code. On a device-code channel the poll's
    /// phase alone selects the state, and a lapsed code is never polled again: the public user
    /// code is shown, never used as the polling handle (the Must not).
    public static func signInHandoff(_ i: KitInputs) -> KitScreen<SignInHandoffState> {
        let c = Ctx(i)
        guard i.isOn(.identity) else { return .hidden }
        let s = i.signIn ?? KitSignIn()
        if s.channel == .deviceCode {
            switch i.deviceCode?.phase ?? .starting {
            case .starting:
                return KitScreen(.starting, [c.line("signInHandoff.starting"), c.line("a11y.busy")])
            case .waiting, .slowDown:
                return KitScreen(.code, codeLines(c))
            case .ok:
                return KitScreen(
                    .finishing,
                    [c.line("signInHandoff.ok"), c.line("signin.handoff.finishing")])
            case .denied:
                return KitScreen(
                    .denied,
                    [
                        c.line("core.codes.sign-in-denied.title"),
                        c.line("core.codes.sign-in-denied.message", c.productArg),
                        c.line("signInHandoff.newCode"),
                    ])
            case .expired:
                return KitScreen(
                    .expired,
                    [
                        c.line("core.codes.sign-in-expired.title"),
                        c.line("core.codes.sign-in-expired.message", c.productArg),
                        c.line("signInHandoff.newCode"),
                    ])
            case .cancelled:
                return KitScreen(
                    .cancelled,
                    [c.line("signin.handoff.cancelled"), c.line("signInHandoff.newCode")])
            }
        }
        if s.redeeming == true {
            return KitScreen(.finishing, [c.line("signin.handoff.finishing")])
        }
        if s.outcome == .pending, s.event == .useCode {
            return KitScreen(.starting, [c.line("signInHandoff.starting"), c.line("a11y.busy")])
        }
        if s.outcome == .pending, s.browserOpened == false {
            if s.event == .copyLink {
                return KitScreen(.linkCopied, [c.line("signInHandoff.linkCopied")])
            }
            return KitScreen(
                .noBrowser,
                [
                    c.line("signin.handoff.noBrowser"), c.line("signin.handoff.noBrowserBody"),
                    c.line("signin.handoff.copyLink"),
                ])
        }
        return KitScreen(
            .waiting,
            [
                c.line("signin.handoff.title"), c.line("signin.handoff.waiting"),
                c.line("signin.handoff.again"), c.line("signin.handoff.useCode"),
                c.line("common.cancel"),
            ])
    }

    /// The code view per DL14: a QR only where the device cannot browse (TV); phones and tablets
    /// show the address with Copy; desktops and the web give the address in a sentence.
    static func codeLines(_ c: Ctx) -> [CopyLine] {
        let p = c.i.platform
        let page = KitLinks.deviceCodePage(c.identity, platform: p)
        let url: CopyArgument = .text(KitLinks.display(page))
        var lines = [
            c.line("signin.handoff.codeTitle"), c.line("part.code.label"),
            c.line("a11y.code", ["code": ""]),
        ]
        if p.isTV {
            lines.append(c.line("a11y.qr"))
            if p.os == .android || p.os == .tvos {
                lines += [c.line("signInHandoff.scanTv"), c.line("signin.handoff.url", ["url": url])]
            } else {
                lines += [c.line("signInHandoff.scan", ["url": url]), c.line("part.qr.enlarge")]
            }
        } else if p.isHandheld {
            lines += [
                c.line("a11y.copyCode"), c.line("signin.handoff.url", ["url": url]),
                c.line("a11y.copyAddress"), c.line("signin.handoff.openBrowser"),
            ]
        } else {
            lines += [
                c.line("signin.handoff.codeBody", ["url": url]), c.line("a11y.copyCode"),
                c.line("signin.handoff.openBrowser"),
            ]
        }
        return lines
    }

    /// Step 3: the license choice (plans/I-04.md §G's views). Keep, create and add-to-account stay
    /// three outcomes (the Must not).
    public static func licenseChoice(_ i: KitInputs) -> KitScreen<LicenseChoiceState> {
        let c = Ctx(i)
        guard i.isOn(.identity), i.isOn(.license) else { return .hidden }
        let s = i.signIn ?? KitSignIn()
        let title = c.line("signin.choice.title")
        if i.loading == true { return KitScreen(.loading, [title, c.line("common.loading")]) }
        if s.grantExpired == true {
            return KitScreen(
                .grantExpired, [c.line("signin.handoff.tooLong"), c.line("signin.again")])
        }
        if s.raced == true {
            if s.event == .confirmReplace {
                return KitScreen(.raced, [c.line("signin.replace.raced")])
            }
            return KitScreen(.raced, [c.line("signin.choice.raced")])
        }
        if s.event == .openReplace, s.replace == .inline, i.replaceView != nil {
            let device = CopyArgument.text(c.replaceTarget ?? "")
            return KitScreen(
                .replaceOpen,
                [
                    c.line("signin.replace.open"),
                    c.line("signin.replace.title", ["device": device]),
                    c.line(
                        "signin.replace.consequence",
                        ["device": device, "product": c.product, "thisDevice": c.thisDevice]),
                    c.line("signin.replace.confirm"), c.line("signin.replace.back"),
                ])
        }
        guard let view = i.choices else {
            return KitScreen(.loading, [title, c.line("common.loading")])
        }
        let browserReplace: [KitAction] =
            s.replace == .browser && s.event == .openReplace ? [.replaceInBrowser] : []
        switch view.state {
        case "none":
            let get = view.getLicense
            if get?.keyEntry == true {
                return KitScreen(
                    .noneKeys,
                    [
                        c.line("signin.none.title", c.productArg), c.line("signin.none.body"),
                        c.line("signin.choice.keyInstead"),
                    ])
            }
            var lines = [c.line("signin.none.title", c.productArg), c.line("signin.none.body")]
            if KitLinks.valid(get?.purchaseUrl) != nil {
                lines.append(c.line("signin.none.get", c.productArg))
            }
            lines.append(c.line("signin.none.otherAccount"))
            return KitScreen(.noneNoKeys, lines)
        case "autoIssue":
            return KitScreen(
                .new,
                [
                    c.line("signin.choice.ledeNew", c.productArg.merging(c.developerArg) { a, _ in a }),
                    c.line("signin.choice.tag.new"), c.line("signin.choice.metaNew"),
                ])
        default:
            break
        }
        if i.selected == "create", view.create != nil {
            return KitScreen(
                .create, [c.line("signin.choice.create"), c.line("signin.choice.createMeta")])
        }
        let choices = view.choices
        if !choices.isEmpty, choices.allSatisfy(\.isFull) {
            let lead: CopyLine
            if view.create != nil {
                lead = c.line("signin.choice.allFullCreate")
            } else if choices.allSatisfy({ $0.replace == nil }) {
                lead = c.line("signin.choice.noneReplaceable", c.developerArg)
            } else {
                lead = c.line("signin.choice.allFull")
            }
            return KitScreen(
                .allFull, [lead, c.line("signin.choice.tag.full")], extraActions: browserReplace)
        }
        if view.keep {
            return KitScreen(
                .keep, [c.line("signin.choice.keep"), c.line("signin.choice.keepMeta", c.productArg)])
        }
        if choices.contains(where: \.current) {
            return KitScreen(.current, [c.line("signin.choice.tag.current")])
        }
        let accessKinds = Set(choices.map(\.access))
        if accessKinds.contains("account"), accessKinds.contains("seats") {
            // "Your other {product} items still apply" needs the entitlement model, which no SDK
            // result carries yet (vocabulary.unreached): the state shows no line of its own.
            return KitScreen(.mixed, [])
        }
        let lede = c.line("signin.choice.lede", ["product": c.product, "device": c.thisDevice])
        if choices.count == 1 {
            return KitScreen(.one, [title, lede, c.line("signin.choice.continue")])
        }
        var lines = [
            title, lede, c.line("signin.choice.group", c.productArg),
        ]
        var origins: [String] = []
        var terms: [String] = []
        for choice in choices {
            let origin = originKey(choice)
            if !origins.contains(origin) { origins.append(origin) }
            let term = choice.expiresAt == nil ? "signin.term.lifetime" : "signin.term.until"
            if !terms.contains(term) { terms.append(term) }
        }
        lines += [
            c.line("signin.choice.meta", ["origin": "", "term": ""]),
            c.line("signin.choice.devices", ["used": 0, "limit": 0]),
        ]
        lines += origins.map { c.line($0, c.developerArg) }
        lines += terms.map { c.line($0, ["date": ""]) }
        lines.append(c.line("signin.choice.continue"))
        return KitScreen(.many, lines)
    }

    /// The origin line in plain words (SIGN-IN.md §3.6, O-17). The view carries no key's last six
    /// characters, so a key or a purchase reads "Added with a key".
    public static func originKey(_ choice: KitLicenseChoice) -> String {
        switch choice.origin {
        case "signin": return "signin.choice.origin.signIn"
        case "store": return "signin.choice.origin.store"
        case "free": return "signin.choice.origin.free"
        case "developer": return "signin.choice.origin.developer"
        default: return "signin.choice.origin.keyAdded"
        }
    }
}

extension Ctx {
    /// "this iPhone", "this computer": the device in a sentence.
    var thisDevice: CopyArgument {
        .line(CopyLine("part.thisDevice", ["formFactor": formFactor]))
    }

    /// "This iPhone", capitalised as a label.
    var thisDeviceTitle: CopyArgument {
        .line(CopyLine("part.thisDeviceTitle", ["formFactor": formFactor]))
    }

    /// The device Replace would sign out: the least recent of the replace view.
    var replaceTarget: String? {
        guard let devices = i.replaceView?.devices else { return nil }
        let target = devices.first(where: \.leastRecent) ?? devices.min { $0.lastSeen < $1.lastSeen }
        return target?.label
    }
}
