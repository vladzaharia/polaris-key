// @pkey-feature ui.signin
// The one sign-in form (SIGN-IN.md §3.17, UI-KITS §1.3): SignInView, whose body morphs in place
// through its steps, and the steps as styled parts: SignInMethodsView, SignInHandoffView,
// LicenseChoiceView and ReplaceDeviceView. Nothing stacks on the form except the system confirm
// for a destructive Replace (`confirmationDialog`, D-80).
//
// On iOS every method runs the hosted card in the system browser sheet until the native exchange
// (I-13) lands; "Sign in with a code" reveals the same request's code, so there is one request.

import PolarisKeyUICore
import SwiftUI

/// The sign-in providers a product offers, logo-only in that order (D-21). Only Apple has a
/// system-drawn logo on Apple platforms; the others join with the brand assets that carry their
/// logos.
public enum KitProvider: String, Sendable, CaseIterable {
    case apple

    var symbol: String { "apple.logo" }
    var name: String { "Apple" }
}

/// The one sign-in form over a gate model.
public struct SignInView: View {
    @Bindable var model: PolarisKeyGateModel
    var providers: [KitProvider]
    var onClose: (() -> Void)?

    @State private var confirmingReplace = false
    @AccessibilityFocusState private var headingFocused: Bool
    @Environment(\.openURL) private var openURL

    public init(
        model: PolarisKeyGateModel, providers: [KitProvider] = [.apple],
        onClose: (() -> Void)? = nil
    ) {
        self.model = model
        self.providers = providers
        self.onClose = onClose
    }

    public var body: some View {
        let screen = model.signInScreen
        kitStyle { style in
            KitScreenScaffold(header: true) {
                heading(screen)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($headingFocused)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                content(screen, style)
                    .transition(
                        style.reduceMotion
                            ? .identity : .push(from: .trailing).combined(with: .opacity))
                    .id(screen.stateName)
            } actions: {
                actions(screen)
            }
            .animation(style.morph, value: screen.stateName)
            .onChange(of: screen.stateName) { _, _ in headingFocused = true }
        }
    }

    /// The product's name, for lines that name it outside the state's own copy.
    private var productArg: [String: CopyArgument] { ["product": .text(model.identity.name)] }

    /// The title names the state (DL8): the step, or the refusal it ended in.
    private func title(_ screen: KitScreen<SignInState>) -> CopyLine {
        let handoff = model.handoff
        switch screen.state {
        case .methods, .error, .none:
            return screen.line("signIn.title") ?? CopyLine("signIn.title", productArg)
        case .handoff:
            return handoff.state == .noBrowser || handoff.state == .linkCopied
                ? CopyLine("signin.handoff.noBrowser") : CopyLine("signin.handoff.title")
        case .code:
            if let refusal = handoff.copy.first(where: { $0.key.hasSuffix(".title") }) {
                return refusal
            }
            return CopyLine("signin.handoff.codeTitle")
        case .finishing:
            return model.inputs.signIn?.channel == .deviceCode
                ? CopyLine("signin.handoff.codeTitle") : CopyLine("signin.handoff.title")
        case .choose:
            return CopyLine("signin.choice.title")
        case .replace:
            return CopyLine("signin.replace.open")
        case .key:
            return screen.lineOrKey("signin.key.addTitle")
        case .done:
            return CopyLine("signin.return.signedInShort")
        case .expired:
            return screen.line("core.codes.sign-in-expired.title") ?? CopyLine("signin.handoff.tooLong")
        }
    }

    @ViewBuilder private func heading(_ screen: KitScreen<SignInState>) -> some View {
        kitStyle { style in
            HStack(alignment: .center, spacing: style.space(.xs)) {
                if screen.state == .done {
                    Image(systemName: "checkmark.circle.fill")
                        .font(style.font(.title))
                        .foregroundStyle(style.palette.success)
                        .symbolEffect(.bounce, options: .nonRepeating, isActive: !style.reduceMotion)
                        .accessibilityHidden(true)
                }
                KitText(title(screen), .title, color: .strong)
            }
        }
    }

    /// The method a provider or row names in a failure's sentence.
    private static func methodName(_ key: String) -> String? {
        switch key {
        case "apple": return "Apple"
        case "signin.email.continue", "signin.desktop.continue": return "Email"
        case "signin.passkey": return "Passkey"
        default: return nil
        }
    }

    @ViewBuilder private func content(_ screen: KitScreen<SignInState>, _ style: KitResolvedStyle)
        -> some View
    {
        switch screen.state {
        case .methods, .error, .none:
            // A failed method keeps every method in place, with the failure above them (DL7).
            SignInMethodsView(
                screen: screen.state == .error ? methodsScreen : screen, providers: providers,
                error: screen.state == .error ? screen.copy.first : nil,
                onMethod: { key in model.beginSignIn(method: Self.methodName(key)) },
                onCode: { model.beginSignIn(code: true) })
        case .handoff, .code:
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let body = screen.line("signin.handoff.browserBody"),
                    model.handoff.state == .waiting
                {
                    KitText(body, .body, color: .default)
                }
                SignInHandoffView(
                    screen: model.handoff, request: model.request,
                    onCopyLink: { model.linkCopied() })
            }
        case .finishing:
            HStack(spacing: style.space(.xs)) {
                ProgressView().controlSize(.small).accessibilityHidden(true)
                KitText(CopyLine("signin.handoff.finishing"), .meta, color: .muted)
            }
            .accessibilityElement(children: .combine)
        case .choose:
            LicenseChoiceView(screen: model.licenseChoice, choices: model.inputs.choices)
        case .replace:
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.replace.lede") {
                    KitText(lede, .body, color: .default)
                }
                ReplaceDeviceView(
                    screen: model.licenseChoice, view: model.inputs.replaceView,
                    confirmInSystem: true, onReplace: { confirmingReplace = true })
            }
        case .key:
            ActivateBody(
                screen: model.activate, text: $model.keyText,
                onSubmit: { Task { await model.submitKey() } }, onReplaceDevice: nil)
        case .done:
            if screen.shows("signin.desktop.toast") {
                KitText(
                    CopyLine(
                        "signin.desktop.toast",
                        ["name": .text(model.signedInName ?? ""), "tier": ""]), .body,
                    color: .default)
            }
        case .expired:
            // The title already says the sign-in took too long; only a code's sentence follows.
            if let message = screen.line("core.codes.sign-in-expired.message") {
                KitText(message, .body, color: .default)
            }
        }
    }

    /// The methods, for a failed method's screen.
    private var methodsScreen: KitScreen<SignInState> {
        var inputs = model.inputs
        inputs.error = nil
        return KitStates.signIn(inputs)
    }

    @ViewBuilder private func actions(_ screen: KitScreen<SignInState>) -> some View {
        KitActionStack {
            switch screen.state {
            case .methods, .error, .none:
                if screen.shows("signin.choice.keyInstead") || methodsScreen.shows("signin.choice.keyInstead") {
                    KitButton(line: CopyLine("signin.choice.keyInstead"), kind: .quiet) {
                        model.useLicenseKey()
                    }
                }
                cancelButton
            case .handoff:
                handoffActions
            case .code:
                if model.handoff.shows("signin.handoff.openBrowser") {
                    KitButton(
                        line: CopyLine("signin.handoff.openBrowser"), kind: .primary,
                        glyph: "arrow.up.right"
                    ) { model.reopenBrowser() }
                    .keyboardShortcut(.defaultAction)
                }
                if model.handoff.state == .expired || model.handoff.state == .denied
                    || model.handoff.state == .cancelled
                {
                    KitButton(line: CopyLine("signInHandoff.newCode"), kind: .primary) {
                        model.beginSignIn(code: true)
                    }
                    .keyboardShortcut(.defaultAction)
                }
                cancelButton
            case .finishing:
                EmptyView()
            case .done:
                if screen.shows("signin.done.start") {
                    KitButton(line: screen.lineOrKey("signin.done.start"), kind: .primary) {
                        onClose?()
                    }
                    .keyboardShortcut(.defaultAction)
                }
            case .expired:
                KitButton(line: CopyLine("signin.again"), kind: .primary) { model.beginSignIn() }
                    .keyboardShortcut(.defaultAction)
                cancelButton
            case .choose:
                // Every license full: Replace a device on the card, which comes back to this form
                // (SIGN-IN.md §3.7), until the in-app device list arrives with I-04's choice API.
                if model.licenseChoice.state == .allFull,
                    let link = model.inputs.choices?.choices.lazy
                        .compactMap({ KitLinks.valid($0.freeDeviceUrl) }).first
                {
                    KitButton(
                        line: CopyLine("signin.replace.open"), kind: .primary,
                        glyph: "arrow.up.right"
                    ) { openURL(link) }
                    .keyboardShortcut(.defaultAction)
                }
                if model.licenseChoice.shows("signin.choice.continue") {
                    KitButton(line: CopyLine("signin.choice.continue"), kind: .primary) {}
                        .keyboardShortcut(.defaultAction)
                }
                if model.licenseChoice.shows("signin.choice.keyInstead") {
                    KitButton(line: CopyLine("signin.choice.keyInstead"), kind: .quiet) {
                        model.useLicenseKey()
                    }
                }
                cancelButton
            case .key:
                KitButton(
                    line: CopyLine("signin.key.addAndUse"), kind: .primary,
                    busy: model.activate.state == .busy
                ) { Task { await model.submitKey() } }
                .keyboardShortcut(.defaultAction)
                cancelButton
            case .replace:
                cancelButton
            }
        }
    }

    @ViewBuilder private var handoffActions: some View {
        switch model.handoff.state {
        case .noBrowser, .linkCopied:
            KitButton(line: CopyLine("signin.handoff.useCode"), kind: .primary) { model.useCode() }
                .keyboardShortcut(.defaultAction)
        default:
            KitButton(line: CopyLine("signin.handoff.again"), kind: .primary, glyph: "arrow.up.right") {
                model.reopenBrowser()
            }
            .keyboardShortcut(.defaultAction)
            KitButton(line: CopyLine("signin.handoff.useCode"), kind: .quiet) { model.useCode() }
        }
        cancelButton
    }

    private var cancelButton: some View {
        KitButton(line: CopyLine("common.cancel"), kind: .quiet) {
            if model.signInScreen.state == .methods {
                model.backToWelcome()
                onClose?()
            } else {
                model.cancelSignIn()
            }
        }
        .keyboardShortcut(.cancelAction)
    }
}

// MARK: - Step 1

/// Step 1 (SIGN-IN.md §3.17, §5.1): the logo-only provider row, then the passkey and email rows,
/// then Sign in with a code. The phone's primary is Continue with email.
public struct SignInMethodsView: View {
    let screen: KitScreen<SignInState>
    var providers: [KitProvider]
    /// A failed method's sentence, shown above the methods it leaves in place.
    var error: CopyLine?
    var onMethod: (String) -> Void
    var onCode: () -> Void
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var errorFocused: Bool

    public init(
        screen: KitScreen<SignInState>, providers: [KitProvider], error: CopyLine? = nil,
        onMethod: @escaping (String) -> Void, onCode: @escaping () -> Void
    ) {
        self.screen = screen
        self.providers = providers
        self.error = error
        self.onMethod = onMethod
        self.onCode = onCode
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.methods.ledeApp") {
                    KitText(lede, .body, color: .default)
                }
                if let error {
                    Label {
                        KitText(error, .meta, color: .default)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(style.palette.warning)
                            .accessibilityHidden(true)
                    }
                    .accessibilityFocused($errorFocused)
                    .onAppear { errorFocused = true }
                }
                KitActionStack {
                    if let email = screen.line("signin.email.continue") ?? screen.line("signin.desktop.continue") {
                        KitButton(line: email, kind: .primary, glyph: "arrow.up.right") {
                            onMethod(email.key)
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                    if !providers.isEmpty, screen.shows("signin.provider.continue") {
                        HStack(spacing: style.space(.sm)) {
                            ForEach(providers, id: \.self) { provider in
                                Button {
                                    onMethod(provider.rawValue)
                                } label: {
                                    Image(systemName: provider.symbol)
                                        .font(style.font(.headline))
                                        .frame(maxWidth: .infinity, minHeight: style.controlHeight - 14)
                                }
                                .modifier(KitButtonSkin(kind: .secondary, style: style))
                                .accessibilityLabel(
                                    strings.string(
                                        "signin.provider.continue",
                                        ["provider": .text(provider.name)]))
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(strings.string("signin.provider.group"))
                    }
                    if let passkey = screen.line("signin.passkey") {
                        KitButton(line: passkey, kind: .secondary) { onMethod(passkey.key) }
                    }
                    if let code = screen.line("signin.link.deviceCode") {
                        KitButton(line: code, kind: .quiet) { onCode() }
                    }
                }
            }
        }
    }
}

// MARK: - Step 2

/// Step 2 in place: "Finish in your browser" with its live status, or the code view: the code with
/// Copy, the address with Copy on phones, the countdown, and no QR (DL14: phones browse).
public struct SignInHandoffView: View {
    let screen: KitScreen<SignInHandoffState>
    let request: KitSignInRequest?
    var onCopyLink: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<SignInHandoffState>, request: KitSignInRequest?,
        onCopyLink: @escaping () -> Void = {}
    ) {
        self.screen = screen
        self.request = request
        self.onCopyLink = onCopyLink
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch screen.state {
                case .waiting, .starting, .finishing:
                    if let body = screen.line("signin.handoff.browserBody") {
                        KitText(body, .body, color: .default)
                    }
                    HStack(spacing: style.space(.xs)) {
                        ProgressView().controlSize(.small).accessibilityHidden(true)
                        KitText(
                            screen.line("signin.handoff.waiting") ?? screen.copy.first
                                ?? CopyLine("signin.handoff.waiting"), .meta, color: .muted)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.updatesFrequently)
                case .noBrowser, .linkCopied:
                    KitText(CopyLine("signin.handoff.noBrowserBody"), .body, color: .default)
                    if let url = request?.verificationUriComplete {
                        HStack {
                            Text(KitLinks.display(url))
                                .font(style.font(.meta))
                                .foregroundStyle(style.palette.textDefault)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .accessibilityLabel(
                                    KitLinks.display(request?.verificationUri ?? url))
                            Spacer()
                            Button(strings.string(
                                screen.state == .linkCopied ? "signInHandoff.linkCopied" : "signin.handoff.copyLink")
                            ) {
                                KitPasteboard.copy(url)
                                onCopyLink()
                            }
                            .buttonStyle(KitQuietStyle(color: style.palette.accentFg, reduceMotion: style.reduceMotion))
                            .font(style.font(.label))
                        }
                    }
                case .code:
                    codeView(style)
                case .denied, .expired, .cancelled:
                    if let message = screen.copy.first(where: {
                        $0.key.hasSuffix(".message") || $0.key == "signin.handoff.cancelled"
                    }) {
                        KitText(message, .body, color: .default)
                    }
                case .none:
                    EmptyView()
                }
            }
        }
    }

    @ViewBuilder private func codeView(_ style: KitResolvedStyle) -> some View {
        if let body = screen.line("signin.handoff.codeBody") {
            KitText(body, .body, color: .default)
        }
        if let request {
            CodeDisplay(code: request.userCode)
            if let url = screen.line("signin.handoff.url") {
                HStack {
                    KitText(url, .meta, color: .default)
                    Spacer()
                    if screen.shows("a11y.copyAddress") {
                        Button {
                            KitPasteboard.copy(request.verificationUri)
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(style.palette.textMuted)
                        .accessibilityLabel(strings.string("a11y.copyAddress"))
                    }
                }
            }
            CountdownRing(
                expiresAt: Date(timeIntervalSince1970: TimeInterval(request.expiresAt)),
                total: 600)
        } else {
            LoadingIndicator(CopyLine("signInHandoff.starting"))
        }
    }
}

// MARK: - Step 3

/// Step 3 (SIGN-IN.md §3.6): license rows with the tier pill and "{used} of {limit} devices", the
/// origin in plain words and the term; full licenses without a radio.
public struct LicenseChoiceView: View {
    let screen: KitScreen<LicenseChoiceState>
    let choices: KitLicenseChoices?
    @State private var selected: String?
    @Environment(\.polarisKeyStrings) private var strings

    public init(screen: KitScreen<LicenseChoiceState>, choices: KitLicenseChoices?) {
        self.screen = screen
        self.choices = choices
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.choice.lede") {
                    KitText(lede, .body, color: .default)
                }
                if screen.state == .loading {
                    LoadingIndicator(CopyLine("common.loading"))
                }
                if let rows = choices?.choices, !rows.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, choice in
                            row(choice, style)
                            if index < rows.count - 1 { Divider().padding(.leading, style.space(.md)) }
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                            .fill(style.palette.raised))
                }
                ForEach(screen.copy.filter { $0.key.hasPrefix("signin.choice.allFull") || $0.key == "signin.choice.noneReplaceable" || $0.key.hasSuffix(".raced") || $0.key.hasPrefix("signin.none") }, id: \.key) { line in
                    KitText(line, .meta, color: .default)
                }
            }
        }
    }

    @ViewBuilder private func row(_ choice: KitLicenseChoice, _ style: KitResolvedStyle) -> some View {
        let isSelected = (selected ?? choices?.preselected) == choice.id && !choice.isFull
        Button {
            if !choice.isFull { selected = choice.id }
        } label: {
            HStack(alignment: .top, spacing: style.space(.sm)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(choice.name ?? style.identity.name)
                        .font(style.font(.body))
                        .foregroundStyle(style.palette.textStrong)
                    HStack(spacing: style.space(.xs)) {
                        Text(choice.tierName)
                            .font(style.font(.footnote))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
                        if let seats = choice.seats {
                            Text(strings.string(
                                "signin.choice.devices",
                                ["used": .number(seats.used), "limit": .number(seats.limit)]))
                                .font(style.font(.footnote))
                                .foregroundStyle(style.palette.textMuted)
                        }
                        if choice.isFull {
                            KitText("signin.choice.tag.full", [:], .footnote, color: .muted)
                        }
                    }
                    Text(strings.string(
                        "signin.choice.meta",
                        [
                            "origin": .line(CopyLine(
                                KitStates.originKey(choice),
                                ["developer": .text(style.identity.developer ?? style.identity.name),
                                 "store": "App Store"])),
                            "term": choice.expiresAt.map {
                                .line(CopyLine("signin.term.until", ["date": .text(KitFormat.date($0))]))
                            } ?? .line(CopyLine("signin.term.lifetime")),
                        ]))
                        .font(style.font(.meta))
                        .foregroundStyle(style.palette.textMuted)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(style.palette.accentFg)
                        .accessibilityHidden(true)
                }
            }
            .padding(style.space(.md))
            .background(isSelected ? style.palette.accentSubtle : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A full license is a row without a radio, never dimmed below its contrast (§1.5 rule 9).
        .allowsHitTesting(!choice.isFull)
        .accessibilityRemoveTraits(choice.isFull ? .isButton : [])
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Replace a device in place of the list (SIGN-IN.md §3.7): the license's devices, the least
/// recent preselected, and Replace…, which opens the system confirm on Apple platforms.
public struct ReplaceDeviceView: View {
    let screen: KitScreen<LicenseChoiceState>
    let view: KitReplaceView?
    var confirmInSystem: Bool
    var onReplace: () -> Void
    @State private var selection: String?
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<LicenseChoiceState>, view: KitReplaceView?, confirmInSystem: Bool = true,
        onReplace: @escaping () -> Void
    ) {
        self.screen = screen
        self.view = view
        self.confirmInSystem = confirmInSystem
        self.onReplace = onReplace
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let devices = view?.devices {
                    VStack(spacing: 0) {
                        ForEach(devices) { device in
                            Button {
                                selection = device.id
                            } label: {
                                DeviceRow(
                                    name: device.label, formFactor: device.deviceType,
                                    meta: strings.string(
                                        "signin.replace.meta",
                                        ["platform": .text(KitFormat.platformName(device.platform)),
                                         "when": .text(KitFormat.date(device.lastSeen))]),
                                    leastRecent: device.leastRecent,
                                    selected: device.id == (selection ?? devices.first(where: \.leastRecent)?.id))
                            }
                            .buttonStyle(.plain)
                            .padding(.horizontal, style.space(.md))
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                            .fill(style.palette.raised))
                }
                KitButton(
                    line: CopyLine(confirmInSystem ? "signin.replace.openSystem" : "signin.replace.confirm"),
                    kind: .primary, action: onReplace)
            }
        }
    }
}
