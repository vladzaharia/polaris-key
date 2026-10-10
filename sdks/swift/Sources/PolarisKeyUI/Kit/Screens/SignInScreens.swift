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

    @ViewBuilder private func heading(_ screen: KitScreen<SignInState>) -> some View {
        switch screen.state {
        case .methods, .error, .none:
            KitText(screen.lineOrKey("signIn.title"), .title, color: .strong)
        case .handoff:
            KitText(handoffTitle, .title, color: .strong)
        case .code:
            KitText(CopyLine("signin.handoff.codeTitle"), .title, color: .strong)
        case .finishing:
            KitText(CopyLine("signin.handoff.finishing"), .title, color: .strong)
        case .choose:
            KitText(CopyLine("signin.choice.title"), .title, color: .strong)
        case .replace:
            KitText(CopyLine("signin.replace.open"), .title, color: .strong)
        case .key:
            KitText(screen.lineOrKey("signin.key.addTitle"), .title, color: .strong)
        case .done:
            KitText(
                CopyLine("signin.return.signedInShort"), .title, color: .strong)
        case .expired:
            KitText(
                screen.line("core.codes.sign-in-expired.title")
                    ?? CopyLine("signin.handoff.tooLong"), .title, color: .strong)
        }
    }

    private var handoffTitle: CopyLine {
        switch model.handoff.state {
        case .noBrowser: return CopyLine("signin.handoff.noBrowser")
        default: return CopyLine("signin.handoff.title")
        }
    }

    @ViewBuilder private func content(_ screen: KitScreen<SignInState>, _ style: KitResolvedStyle)
        -> some View
    {
        switch screen.state {
        case .methods, .error, .none:
            SignInMethodsView(
                screen: screen, providers: providers, onMethod: { _ in model.beginSignIn() },
                onCode: { model.beginSignIn() })
        case .handoff, .code:
            SignInHandoffView(
                screen: model.handoff, request: model.request,
                onCopyLink: { model.linkCopied() })
        case .finishing:
            LoadingIndicator(CopyLine("signin.handoff.finishing"))
        case .choose:
            LicenseChoiceView(screen: model.licenseChoice, choices: model.inputs.choices)
        case .replace:
            ReplaceDeviceView(
                screen: model.licenseChoice, view: model.inputs.replaceView,
                confirmInSystem: true, onReplace: { confirmingReplace = true })
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
                    color: .muted)
            }
        case .expired:
            KitText(CopyLine("signin.handoff.tooLong"), .body, color: .default)
        }
    }

    @ViewBuilder private func actions(_ screen: KitScreen<SignInState>) -> some View {
        KitActionStack {
            switch screen.state {
            case .methods, .error, .none:
                if screen.shows("signin.choice.keyInstead") {
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
                        model.beginSignIn()
                    }
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
            case .choose, .key, .replace:
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
    var onMethod: (String) -> Void
    var onCode: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<SignInState>, providers: [KitProvider], onMethod: @escaping (String) -> Void,
        onCode: @escaping () -> Void
    ) {
        self.screen = screen
        self.providers = providers
        self.onMethod = onMethod
        self.onCode = onCode
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.methods.ledeApp") {
                    KitText(lede, .body, color: .default)
                }
                if let error = screen.line("signIn.methodError") ?? screen.line("signIn.noMethods") {
                    KitText(error, .meta, color: .danger)
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
        .disabled(choice.isFull)
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
                                        ["platform": .text(device.platform),
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
