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

/// The sign-in providers a product offers, in that order, each a full-width labelled button (D-21). Only Apple has a
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
                            ? .identity : .push(from: .trailing).combined(with: .opacity)
                    )
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
            return screen.line("core.codes.sign-in-expired.title")
                ?? CopyLine("signin.handoff.tooLong")
        }
    }

    @ViewBuilder private func heading(_ screen: KitScreen<SignInState>) -> some View {
        kitStyle { style in
            HStack(alignment: .center, spacing: style.space(.xs)) {
                if screen.state == .done {
                    Image(systemName: "checkmark.circle.fill")
                        .font(style.font(.title))
                        .foregroundStyle(style.palette.success)
                        .symbolEffect(
                            .bounce, options: .nonRepeating, isActive: !style.reduceMotion
                        )
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
                failedMethod: model.inputs.signIn?.method,
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
            LicenseChoiceView(
                screen: model.licenseChoice, choices: model.inputs.choices,
                selectedId: model.choice == nil ? nil : model.inputs.selected,
                onSelect: model.choice == nil ? nil : { model.selectLicense($0) })
        case .replace:
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.replace.lede") {
                    KitText(lede, .body, color: .default)
                }
                ReplaceDeviceView(
                    screen: model.licenseChoice, view: model.inputs.replaceView,
                    confirmInSystem: true,
                    onReplaceDevice: replaceDevice,
                    onBrowser: replaceInBrowser,
                    cancel: Self.isMac ? { cancelSignInStep() } : nil)
            }
        case .key:
            ActivateBody(
                screen: model.activate, text: $model.keyText,
                onSubmit: { Task { await model.submitKey() } }, onReplaceDevice: nil)
        case .done:
            if screen.shows("signin.desktop.toast") {
                // "Signed in as <name> · <Tier> license"; without both, the plain sentence.
                if let name = model.inputs.signIn?.name, !name.isEmpty,
                    let tier = model.inputs.signIn?.tier, !tier.isEmpty
                {
                    KitText(
                        CopyLine(
                            "signin.desktop.toast", ["name": .text(name), "tier": .text(tier)]),
                        .body, color: .default)
                } else {
                    KitText(CopyLine("signin.return.signedInShort"), .body, color: .default)
                }
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
                if screen.shows("signin.choice.keyInstead")
                    || methodsScreen.shows("signin.choice.keyInstead")
                {
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
                        glyph: PolarisKitGlyph.newWindow
                    ) { model.reopenBrowser() }
                    .keyboardShortcut(.defaultAction)
                }
                if model.handoff.state == .expired || model.handoff.state == .denied
                    || model.handoff.state == .failed || model.handoff.state == .cancelled
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
                // Every license full: Replace a device in the app when the choice runs in it and a
                // license allows it, else on the card, which comes back to this form (SIGN-IN.md
                // §3.7).
                if model.licenseChoice.state == .allFull, model.choice != nil,
                    model.options.replace == .inline,
                    let full = model.inputs.choices?.choices.first(where: {
                        $0.isFull && $0.replace?.allowed != false
                    })
                {
                    KitButton(line: CopyLine("signin.replace.open"), kind: .primary) {
                        Task { await model.openChoiceReplace(licenseId: full.id) }
                    }
                    .keyboardShortcut(.defaultAction)
                } else if model.licenseChoice.state == .allFull,
                    let link = model.inputs.choices?.choices.lazy
                        .compactMap({ KitLinks.valid($0.freeDeviceUrl) }).first
                {
                    KitButton(
                        line: CopyLine("signin.replace.open"), kind: .primary,
                        glyph: PolarisKitGlyph.newWindow
                    ) { open(link) }
                    .keyboardShortcut(.defaultAction)
                }
                if model.licenseChoice.shows("signin.choice.continue") {
                    KitButton(
                        line: CopyLine("signin.choice.continue"), kind: .primary,
                        busy: model.choice?.phase == .working
                    ) {
                        Task { await model.confirmLicenseChoice() }
                    }
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
                // On a Mac Cancel sits in the same row as Replace… (inside the list's view).
                if !Self.isMac { cancelButton }
            }
        }
    }

    /// Replace in the app: the choice's own call when it runs here, else the host's handler.
    private var replaceDevice: ((String?) -> Void)? {
        if model.choice != nil {
            return { id in
                if let id { Task { await model.replaceChoiceDevice(id) } }
            }
        }
        return model.handlers.replaceDevice.map { handler in
            { (id: String?) in
                if let id { handler(id) }
            }
        }
    }

    /// Replace a Device in the browser: the license's own page.
    private var replaceInBrowser: (() -> Void)? {
        let link =
            KitLinks.valid(model.inputs.activation?.manageUrl)
            ?? model.inputs.choices?.choices.lazy.compactMap { KitLinks.valid($0.freeDeviceUrl) }.first
        guard let link else { return nil }
        return { open(link) }
    }

    /// The one place this form opens a link (the card's page, already validated).
    private func open(_ link: URL) { openURL(link) }

    private static var isMac: Bool {
        #if os(macOS)
            return true
        #else
            return false
        #endif
    }

    @ViewBuilder private var handoffActions: some View {
        switch model.handoff.state {
        case .noBrowser, .linkCopied:
            KitButton(line: CopyLine("signin.handoff.useCode"), kind: .primary) { model.useCode() }
                .keyboardShortcut(.defaultAction)
        default:
            KitButton(
                line: CopyLine("signin.handoff.again"), kind: .primary, glyph: PolarisKitGlyph.newWindow
            ) {
                model.reopenBrowser()
            }
            .keyboardShortcut(.defaultAction)
            KitButton(line: CopyLine("signin.handoff.useCode"), kind: .quiet) { model.useCode() }
        }
        cancelButton
    }

    private func cancelSignInStep() {
        if model.signInScreen.state == .methods {
            model.backToWelcome()
            onClose?()
        } else {
            model.cancelSignIn()
        }
    }

    @Environment(\.kitInSheet) private var inSheet

    /// Cancel: a quiet link on iOS; on a Mac "Back" inline and "Cancel" in a sheet, a bordered
    /// secondary directly left of the default.
    private var cancelButton: some View {
        KitButton(
            line: CopyLine(Self.isMac && !inSheet ? "common.back" : "common.cancel"),
            kind: Self.isMac ? .secondary : .quiet
        ) { cancelSignInStep() }
        .keyboardShortcut(.cancelAction)
    }
}

// MARK: - Step 1

/// Step 1 (SIGN-IN.md §3.17, §5.1): the logo-only provider row, then the passkey and email rows,
/// then Sign in with a code. The phone's primary is Continue with email.
public struct SignInMethodsView: View {
    let screen: KitScreen<SignInState>
    var providers: [KitProvider]
    /// A failed method's sentence, shown under the method that failed (DL7), every method left
    /// in place.
    var error: CopyLine?
    /// The failed method's name (`Apple`, `Email`, `Passkey`).
    var failedMethod: String?
    var onMethod: (String) -> Void
    var onCode: () -> Void
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var errorFocused: Bool

    public init(
        screen: KitScreen<SignInState>, providers: [KitProvider], error: CopyLine? = nil,
        failedMethod: String? = nil, onMethod: @escaping (String) -> Void,
        onCode: @escaping () -> Void
    ) {
        self.screen = screen
        self.providers = providers
        self.error = error
        self.failedMethod = failedMethod
        self.onMethod = onMethod
        self.onCode = onCode
    }

    /// The error, when it is complete and belongs under `method`'s control.
    @ViewBuilder private func errorRow(after method: String, _ style: KitResolvedStyle)
        -> some View
    {
        if let error, error.isComplete(), failedMethod == method {
            Label {
                KitText(error, .meta, color: .default)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(style.palette.warning)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityFocused($errorFocused)
            .onAppear { errorFocused = true }
        }
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.methods.ledeApp") {
                    KitText(lede, .body, color: .default)
                }
                KitMethodsStack {
                    if let email = screen.line("signin.email.continue")
                        ?? screen.line("signin.desktop.continue")
                    {
                        KitButton(line: email, kind: .primary, glyph: PolarisKitGlyph.newWindow) {
                            onMethod(email.key)
                        }
                        .keyboardShortcut(.defaultAction)
                        errorRow(after: "Email", style)
                    }
                    if !providers.isEmpty, screen.shows("signin.provider.continue") {
                        VStack(spacing: style.space(.sm)) {
                            ForEach(providers, id: \.self) { provider in
                                let label = strings.string(
                                    "signin.provider.continue",
                                    ["provider": .text(provider.name)])
                                // Apple's rules (HIG, Sign in with Apple): the logo and "Continue
                                // with Apple" on a full-width button, white on a dark ground and
                                // black on a light one; same height and capsule as its siblings.
                                Button {
                                    onMethod(provider.rawValue)
                                } label: {
                                    HStack(spacing: style.space(.xs)) {
                                        Image(systemName: provider.symbol)
                                            .font(style.font(.button))
                                            .accessibilityHidden(true)
                                        Text(label)
                                            .font(style.font(.button))
                                            .multilineTextAlignment(.center)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: style.controlHeight - 14)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(
                                    KitCapsuleStyle(
                                        fill: AnyShapeStyle(style.dark ? Color.white : Color.black),
                                        label: style.dark ? .black : .white,
                                        reduceMotion: style.reduceMotion,
                                        height: style.controlHeight,
                                        hairline: style.dark ? nil : Color.black))
                                .accessibilityLabel(label)
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(strings.string("signin.provider.group"))
                        ForEach(providers, id: \.self) { errorRow(after: $0.name, style) }
                    }
                    if let passkey = screen.line("signin.passkey") {
                        KitButton(line: passkey, kind: .secondary) { onMethod(passkey.key) }
                        errorRow(after: "Passkey", style)
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

    /// The address as shown (the scheme dropped); VoiceOver reads the bare address.
    private func linkText(_ url: String, _ style: KitResolvedStyle) -> some View {
        Text(KitLinks.display(url))
            .font(style.font(.meta))
            .foregroundStyle(style.palette.textDefault)
            .lineLimit(1)
            .truncationMode(.middle)
            .accessibilityLabel(KitLinks.display(request?.verificationUri ?? url))
    }

    private func copyLinkButton(_ url: String, _ style: KitResolvedStyle) -> some View {
        Button(
            strings.string(
                screen.state == .linkCopied
                    ? "signInHandoff.linkCopied" : "signin.handoff.copyLink")
        ) {
            KitPasteboard.copy(url)
            onCopyLink()
        }
        .buttonStyle(
            KitQuietStyle(color: style.palette.accentFg, reduceMotion: style.reduceMotion)
        )
        .font(style.font(.label))
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
                        // Copy link keeps its whole label; the address gives way in the middle
                        // ("pola…JHT") when the column is narrow (iPad, AX sizes).
                        HStack {
                            linkText(url, style)
                            Spacer(minLength: style.space(.xs))
                            copyLinkButton(url, style).fixedSize()
                        }
                    }
                case .code:
                    codeView(style)
                case .denied, .failed, .expired, .cancelled:
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
            // "Check the code there matches this one" sits with the code it asks about (§4.3).
            KitText(CopyLine("signin.handoff.check"), .meta, color: .muted)
            if let url = screen.line("signin.handoff.url") {
                HStack {
                    KitText(url, .meta, color: .default)
                    Spacer()
                    if screen.shows("a11y.copyAddress") {
                        Button {
                            KitPasteboard.copy(request.verificationUri)
                        } label: {
                            #if os(macOS)
                                Text(strings.string("signin.handoff.copyLink"))
                                    .font(style.font(.label))
                                    .frame(minHeight: 28)
                                    .contentShape(Rectangle())
                            #else
                                Image(systemName: "doc.on.doc")
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            #endif
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
    /// The pick the model holds (a live choice); nil lets the view keep its own.
    let selectedId: String?
    /// Told on every pick, so a live model follows the view.
    let onSelect: ((String) -> Void)?
    @State private var selected: String?
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<LicenseChoiceState>, choices: KitLicenseChoices?,
        selectedId: String? = nil, onSelect: ((String) -> Void)? = nil
    ) {
        self.screen = screen
        self.choices = choices
        self.selectedId = selectedId
        self.onSelect = onSelect
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
                            if index < rows.count - 1 {
                                Divider().padding(.leading, style.space(.md))
                            }
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                            .fill(style.palette.raised)
                    )
                    // The selected row's tint follows the group's corners.
                    .clipShape(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous))
                }
                ForEach(
                    screen.copy.filter {
                        $0.key.hasPrefix("signin.choice.allFull")
                            || $0.key == "signin.choice.noneReplaceable"
                            || $0.key.hasSuffix(".raced") || $0.key.hasPrefix("signin.none")
                    }, id: \.key
                ) { line in
                    KitText(line, .meta, color: .default)
                }
            }
        }
    }

    /// The meter under a license's counter: its seats, muted when the license is full. A row with
    /// no seats (a key hidden by D-54) draws none.
    static func meter(for choice: KitLicenseChoice) -> (used: Int, limit: Int, muted: Bool)? {
        guard let seats = choice.seats, seats.limit > 0 else { return nil }
        return (seats.used, seats.limit, choice.isFull)
    }

    @ViewBuilder private func tierAndSeats(_ choice: KitLicenseChoice, _ style: KitResolvedStyle)
        -> some View
    {
        Text(choice.tierName)
            .font(style.font(.footnote))
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
        if let seats = choice.seats {
            Text(
                strings.string(
                    "signin.choice.devices",
                    ["used": .number(seats.used), "limit": .number(seats.limit)])
            )
            .font(style.font(.footnote))
            .foregroundStyle(style.palette.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        if choice.isFull {
            KitText("signin.choice.tag.full", [:], .footnote, color: .muted)
        }
    }

    @ViewBuilder private func row(_ choice: KitLicenseChoice, _ style: KitResolvedStyle)
        -> some View
    {
        let isSelected =
            (selectedId ?? selected ?? choices?.preselected) == choice.id && !choice.isFull
        Button {
            if !choice.isFull {
                selected = choice.id
                onSelect?(choice.id)
            }
        } label: {
            HStack(alignment: .top, spacing: style.space(.sm)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(choice.name ?? style.identity.name)
                        .font(style.font(.body))
                        .foregroundStyle(style.palette.textStrong)
                        .fixedSize(horizontal: false, vertical: true)
                    // The tier, seats and Full tag share a line when they fit and stack when they
                    // do not; the tier name never breaks inside its capsule ("Pr/o" at AX5).
                    // The tier never breaks inside its capsule ("Pr/o" at AX5); the seats wrap.
                    HStack(spacing: style.space(.xs)) { tierAndSeats(choice, style) }
                    // The neutral seat meter under the counter; a full license's used segments
                    // read in text-muted (SIGN-IN.md §3.6).
                    if let meter = Self.meter(for: choice) {
                        SeatMeter(
                            used: meter.used, limit: meter.limit, showsCaption: false,
                            muted: meter.muted)
                    }
                    Text(
                        strings.string(
                            "signin.choice.meta",
                            [
                                "origin": .line(
                                    CopyLine(
                                        KitStates.originKey(choice),
                                        [
                                            "developer": .text(
                                                style.identity.developer ?? style.identity.name),
                                            "store": "App Store",
                                        ])),
                                "term": choice.expiresAt.map {
                                    .line(
                                        CopyLine(
                                            "signin.term.until", ["date": .text(KitFormat.date($0))]
                                        ))
                                } ?? .line(CopyLine("signin.term.lifetime")),
                            ])
                    )
                    .font(style.font(.meta))
                    .foregroundStyle(style.palette.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
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
    /// Confirmed: the chosen device's id. Nil hides Replace… (no way to do it in the app).
    var onReplace: ((String?) -> Void)?
    /// The browser path, offered when the app cannot replace (Replace a Device ↗).
    var onBrowser: (() -> Void)?
    /// Cancel, drawn beside Replace… on a Mac.
    var cancel: (() -> Void)?
    @State private var selection: String?
    @State private var confirming = false
    @Environment(\.polarisKeyStrings) private var strings
    @Environment(\.kitInSheet) private var inSheet

    private static var formFactor: String {
        #if os(macOS)
            return "mac"
        #else
            return "iphone"
        #endif
    }

    /// The device the Replace… confirm names: the picked one, else the least recent.
    private var target: KitReplaceDevice? {
        let devices = view?.devices ?? []
        return devices.first { $0.id == selection } ?? devices.first(where: \.leastRecent)
    }

    public init(
        screen: KitScreen<LicenseChoiceState>, view: KitReplaceView?, confirmInSystem: Bool = true,
        onReplace: @escaping () -> Void
    ) {
        self.screen = screen
        self.view = view
        self.confirmInSystem = confirmInSystem
        self.onReplace = { _ in onReplace() }
    }

    /// With the host's device-aware handler (nil: the form offers the browser path instead).
    init(
        screen: KitScreen<LicenseChoiceState>, view: KitReplaceView?, confirmInSystem: Bool = true,
        onReplaceDevice: ((String?) -> Void)?, onBrowser: (() -> Void)?, cancel: (() -> Void)? = nil
    ) {
        self.screen = screen
        self.view = view
        self.confirmInSystem = confirmInSystem
        self.onReplace = onReplaceDevice
        self.onBrowser = onBrowser
        self.cancel = cancel
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
                                        [
                                            "platform": .text(
                                                KitFormat.platformName(device.platform)),
                                            "when": .text(KitFormat.date(device.lastSeen)),
                                        ]),
                                    leastRecent: device.leastRecent,
                                    selected: device.id
                                        == (selection ?? devices.first(where: \.leastRecent)?.id))
                            }
                            .buttonStyle(.plain)
                            .padding(.horizontal, style.space(.md))
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                            .fill(style.palette.raised))
                }
                KitActionStack {
                    if let cancel {
                        KitButton(
                            line: CopyLine(inSheet ? "common.cancel" : "common.back"),
                            kind: .secondary, action: cancel
                        )
                        .keyboardShortcut(.cancelAction)
                    }
                    if onReplace != nil {
                        KitButton(
                            line: CopyLine(
                                confirmInSystem
                                    ? "signin.replace.openSystem" : "signin.replace.confirm"),
                            kind: .primary,
                            action: {
                                if confirmInSystem { confirming = true } else { onReplace?(target?.id) }
                            }
                        )
                        .keyboardShortcut(.defaultAction)
                    } else if let onBrowser {
                        KitButton(
                            line: CopyLine("signin.replace.open"), kind: .primary,
                            glyph: PolarisKitGlyph.newWindow, action: onBrowser
                        )
                        .keyboardShortcut(.defaultAction)
                    }
                }
                .confirmationDialog(
                    strings.string(
                        "signin.replace.title", ["device": .text(target?.label ?? "")]),
                    isPresented: $confirming, titleVisibility: .visible
                ) {
                    Button(
                        strings.string(
                            "signin.replace.confirmNamed", ["device": .text(target?.label ?? "")]),
                        role: .destructive, action: { onReplace?(target?.id) })
                    Button(strings.string("common.cancel"), role: .cancel) {}
                } message: {
                    Text(
                        strings.string(
                            "signin.replace.consequence",
                            [
                                "device": .text(target?.label ?? ""),
                                "product": .text(style.identity.name),
                                "thisDevice": .text(
                                    strings.string(
                                        "part.thisDevice", ["formFactor": .text(Self.formFactor)])),
                            ]))
                }
            }
        }
    }
}
