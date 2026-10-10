// @pkey-feature ui.activate
// The activate family of ui-matrix.json: Welcome, Activate and OfflineActivation.

import Foundation

public enum WelcomeState: String, KitStateID {
    case `default`, busy
    case capabilityLimited = "capability-limited"
    public static let component = KitComponent.welcome
}

public enum ActivateState: String, KitStateID {
    case empty, typing, parsed
    case cutShort = "cut-short"
    case busy, rejected
    case deviceLimit = "device-limit"
    case done
    public static let component = KitComponent.activate
}

public enum OfflineActivationState: String, KitStateID {
    case `default`, loaded
    case rejectedSignature = "rejected-signature"
    case done
    public static let component = KitComponent.offlineActivation
}

/// The live verdict on what is in the key field (UI-KITS §4.3): the prefix names the product as
/// soon as it parses, a short secret is caught on submit. The shape is the Worker's
/// (`packages/worker/src/crypto.ts` `LICENSE_KEY_SHAPE`): `pkey_<slug>_` and 22 base64url
/// characters.
public struct KeyVerdict: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case empty, typing, parsed, cutShort, malformed, submittedEmpty
    }

    public static let prefix = "pkey_"
    public static let secretLength = 22

    public let kind: Kind
    /// The product slug the key names, once it parses that far.
    public let slug: String?
    /// The secret characters present.
    public let used: Int

    /// `pkey_<slug>_`, the key's public prefix.
    public var keyPrefix: String? { slug.map { "\(Self.prefix)\($0)_" } }

    public init(_ text: String, submitted: Bool = false) {
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        func ascii(_ c: Character, _ set: String) -> Bool { c.isASCII && set.contains(c) }
        let lowerDigitsDash = "abcdefghijklmnopqrstuvwxyz0123456789-"
        let secretChars =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        if key.isEmpty {
            self.init(kind: submitted ? .submittedEmpty : .empty, slug: nil, used: 0)
            return
        }
        guard key.hasPrefix(Self.prefix) else {
            let typing = Self.prefix.hasPrefix(key) && !submitted
            self.init(kind: typing ? .typing : .malformed, slug: nil, used: 0)
            return
        }
        let rest = key.dropFirst(Self.prefix.count)
        guard let underscore = rest.firstIndex(of: "_") else {
            let slugSoFar = rest.allSatisfy { ascii($0, lowerDigitsDash) }
            self.init(kind: slugSoFar && !submitted ? .typing : .malformed, slug: nil, used: 0)
            return
        }
        let slug = String(rest[rest.startIndex..<underscore])
        let secret = rest[rest.index(after: underscore)...]
        guard !slug.isEmpty, slug.allSatisfy({ ascii($0, lowerDigitsDash) }),
            secret.allSatisfy({ ascii($0, secretChars) })
        else {
            self.init(kind: .malformed, slug: nil, used: 0)
            return
        }
        let used = secret.count
        let kind: Kind
        if used == Self.secretLength {
            kind = .parsed
        } else if used > Self.secretLength {
            kind = .malformed
        } else {
            kind = submitted ? .cutShort : .typing
        }
        self.init(kind: kind, slug: slug, used: used)
    }

    private init(kind: Kind, slug: String?, used: Int) {
        self.kind = kind
        self.slug = slug
        self.used = used
    }
}

extension KitStates {
    /// The gate's first screen: the product hero, Sign in and Use a license key, and the extras
    /// the product supports.
    public static func welcome(_ i: KitInputs) -> KitScreen<WelcomeState> {
        let c = Ctx(i)
        let title = c.line("welcome.title", c.productArg)
        if !i.isOn(.license) {
            // No license, so no key path: sign-in registers, or an open product has no gate.
            guard i.registration == .requiresIdentity else { return .hidden }
            return KitScreen(
                .capabilityLimited, [title, c.line("welcome.ledeSignInOnly", c.productArg)])
        }
        if i.pending != nil {
            return KitScreen(.busy, [title, c.line("common.working"), c.line("a11y.busy")])
        }
        let signIn = i.isOn(.identity) && i.capabilities.signIn
        let key = i.capabilities.keyEntry
        if !signIn && key {
            return KitScreen(.capabilityLimited, [title, c.line("welcome.ledeKeyOnly")])
        }
        if signIn && !key {
            return KitScreen(
                .capabilityLimited, [title, c.line("welcome.ledeSignInOnly", c.productArg)])
        }
        var lines = [c.line("a11y.productIcon", c.productArg), title]
        if let developer = c.identity.developer {
            lines.append(c.line("common.byDeveloper", ["developer": .text(developer)]))
        }
        lines += [c.line("welcome.lede"), c.line("welcome.signIn"), c.line("welcome.useKey")]
        if i.capabilities.trial { lines.append(c.line("welcome.trial")) }
        if i.capabilities.enroll { lines.append(c.line("welcome.continueFree")) }
        if i.capabilities.restore { lines.append(c.line("welcome.restore")) }
        if i.capabilities.offlineActivation { lines.append(c.line("welcome.offline")) }
        return KitScreen(.default, lines)
    }

    /// License key entry with a live verdict. A floating key never needs an account (the Must
    /// not): an `ok` activation is `done` whether or not anyone is signed in.
    public static func activate(_ i: KitInputs) -> KitScreen<ActivateState> {
        let c = Ctx(i)
        guard i.isOn(.license) else { return .hidden }
        if i.pending == .activate {
            return KitScreen(.busy, [c.line("activate.busy"), c.line("a11y.busy")])
        }
        let text = i.keyField?.text ?? ""
        let verdict = KeyVerdict(text, submitted: i.keyField?.submitted ?? false)
        if let activation = i.activation {
            return activationOutcome(activation, verdict: verdict, c)
        }
        switch verdict.kind {
        case .submittedEmpty:
            return KitScreen(.rejected, [c.line("part.keyField.empty")])
        case .empty:
            return KitScreen(
                .empty,
                [
                    c.line("activate.title"), c.line("activate.lede"),
                    c.line("part.keyField.label"), c.line("part.keyField.placeholder"),
                    c.line("common.paste"), c.line("activate.submit"),
                ])
        case .malformed:
            return KitScreen(.rejected, [c.line("part.keyField.malformed")])
        case .typing:
            return KitScreen(.typing, [c.line("part.keyField.label"), c.line("activate.submit")])
        case .parsed:
            return KitScreen(
                .parsed, [c.line("part.keyField.forProduct", c.productArg), c.line("activate.submit")])
        case .cutShort:
            return KitScreen(
                .cutShort,
                [
                    c.line(
                        "part.keyField.cutShort",
                        [
                            "prefix": .text(verdict.keyPrefix ?? KeyVerdict.prefix),
                            "used": .number(verdict.used),
                            "limit": .number(KeyVerdict.secretLength),
                        ])
                ])
        }
    }

    static func activationOutcome(
        _ a: KitActivation, verdict: KeyVerdict, _ c: Ctx
    ) -> KitScreen<ActivateState> {
        switch a.result {
        case "ok":
            return KitScreen(
                .done,
                [
                    c.line("core.activation.ok.title"),
                    c.line("core.activation.ok.message", c.productArg),
                    c.line(
                        "part.keyField.verdict",
                        ["product": c.product, "tier": "", "term": ""]),
                ])
        case "device-limit":
            var lines = [
                c.line("core.activation.device-limit.title"),
                c.line("core.activation.device-limit.message", c.productArg),
                c.line("deviceLimit.title"),
            ]
            if let used = a.deviceCount, let limit = a.limit {
                lines.append(
                    c.line(
                        "part.seatMeter.caption", ["used": .number(used), "limit": .number(limit)]))
            }
            // A missing link hides its control and names the fix in words (DL6, DL14).
            if KitLinks.valid(a.manageUrl) == nil {
                lines.append(c.line("deviceLimit.noManage", c.productArg))
            }
            return KitScreen(.deviceLimit, lines)
        case "refused":
            return KitScreen(.rejected, c.codeLines(a.code))
        default:
            let base = "core.activation.\(a.result)"
            if KitCopy.bundled.has("\(base).title") {
                return KitScreen(
                    .rejected, [c.line("\(base).title"), c.line("\(base).message", c.productArg)])
            }
            return KitScreen(.rejected, c.codeLines(a.code))
        }
    }

    /// Two numbered actions, then the verdict. A loaded file is not an activation until its
    /// signature verifies (the Must not).
    public static func offlineActivation(_ i: KitInputs) -> KitScreen<OfflineActivationState> {
        let c = Ctx(i)
        guard i.isOn(.license), i.capabilities.offlineActivation else { return .hidden }
        let o = i.offline ?? KitOffline()
        let submitted = o.submitted ?? false
        let file = o.file ?? false
        if submitted && file {
            if o.verified == true { return KitScreen(.done, [c.line("offlineActivation.done")]) }
            if o.verified == false {
                return KitScreen(
                    .rejectedSignature,
                    [
                        c.line("core.codes.bundle-jws-rejected.title"),
                        c.line("core.codes.bundle-jws-rejected.message", c.productArg),
                    ])
            }
            return KitScreen(.loaded, [c.line("offlineActivation.submit")])
        }
        if submitted {
            return KitScreen(
                .loaded, [c.line("offlineActivation.empty"), c.line("offlineActivation.submit")])
        }
        if file { return KitScreen(.loaded, [c.line("offlineActivation.submit")]) }
        if o.copied == true {
            return KitScreen(
                .loaded,
                [c.line("offlineActivation.codeCopied"), c.line("offlineActivation.submit")])
        }
        return KitScreen(
            .default,
            [
                c.line("offlineActivation.title"), c.line("offlineActivation.request"),
                c.line("offlineActivation.product", c.productArg),
                c.line("offlineActivation.copyCode"), c.line("offlineActivation.loadHint"),
                c.line("offlineActivation.loadFile"), c.line("offlineActivation.paste"),
                c.line("offlineActivation.dropHint"), c.line("offlineActivation.submit"),
            ])
    }
}

/// The kit's one validating opener check (DL14): only https links (and the loopback redirect)
/// the server or the integrator supplied are shown, encoded or opened. An invalid link hides its
/// control; the kit never makes one up.
public enum KitLinks {
    /// `link` when it is a usable https URL (or an http loopback), else nil.
    public static func valid(_ link: String?) -> URL? {
        guard let link, let url = URL(string: link), let scheme = url.scheme?.lowercased(),
            let host = url.host, !host.isEmpty
        else { return nil }
        if scheme == "https" { return url }
        if scheme == "http", host == "127.0.0.1" || host == "localhost" || host == "[::1]" {
            return url
        }
        return nil
    }

    /// The default device-code page (SIGN-IN.md D-16): `key.plrs.im/tv` on TV and console,
    /// `key.plrs.im/device` elsewhere. A product's `deviceCodeUrl` wins when it is valid.
    public static func deviceCodePage(_ identity: ResolvedIdentity, platform: KitPlatform)
        -> String
    {
        if let custom = valid(identity.deviceCodeUrl) { return custom.absoluteString }
        return platform.isTV ? "https://key.plrs.im/tv" : "https://key.plrs.im/device"
    }

    /// A URL as people read it: no scheme, no trailing slash.
    public static func display(_ url: String) -> String {
        var s = url
        for scheme in ["https://", "http://"] where s.hasPrefix(scheme) {
            s.removeFirst(scheme.count)
        }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
