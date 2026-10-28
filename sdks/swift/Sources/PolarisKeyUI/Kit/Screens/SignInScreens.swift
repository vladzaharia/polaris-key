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

/// What a control of an automatic sign-in step does: its primary (Continue, Link) or its secondary
/// (Use another account, No thanks, Not now, Use a code instead, Not you?).
public enum KitAutoSignInAction: Sendable { case primary, secondary }

/// The one sign-in form over a gate model.
public struct SignInView: View {
    @Bindable var model: PolarisKeyGateModel
    var providers: [KitProvider]
    var onClose: (() -> Void)?
    /// Told when a control of an automatic sign-in step is chosen; the host drives the flow.
    var onAutoSignIn: ((KitAutoSignInAction) -> Void)?

    @AccessibilityFocusState private var headingFocused: Bool
    @Environment(\.openURL) private var openURL
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        model: PolarisKeyGateModel, providers: [KitProvider] = [.apple],
        onClose: (() -> Void)? = nil, onAutoSignIn: ((KitAutoSignInAction) -> Void)? = nil
    ) {
        self.onAutoSignIn = onAutoSignIn
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
            // A lapsed grant says so; the list it replaced is gone.
            if model.licenseChoice.state == .grantExpired { return CopyLine("signin.handoff.tooLong") }
            // Full rows after a device limit are that refusal's step: its own title.
            return limitRows
                ? CopyLine("core.codes.device_limit.title") : CopyLine("signin.choice.title")
        case .replace:
            return CopyLine("signin.replace.open")
        case .key:
            return screen.lineOrKey("signin.key.addTitle")
        case .done:
            return screen.line("signin.return.signedInTier") ?? CopyLine("signin.return.signedInShort")
        case .confirm, .linkOffer, .linkDone, .linkConflict, .nearbyPrompt, .nearbyWait,
            .nearbyDone, .deviceLimit, .keyRefused:
            // The first line names the step (the sentence, or the refusal's title).
            return screen.copy.first ?? CopyLine("signIn.title", productArg)
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
                if screen.state == .confirm, let sub = Self.subtitle(screen) {
                    // "as <email>" sits directly under the h1 as its subtitle (SIGN-IN §3.19).
                    VStack(alignment: .leading, spacing: style.space(.xxs)) {
                        KitText(title(screen), .title, color: .strong)
                        KitText(sub, .body, color: .muted)
                    }
                } else {
                    KitText(title(screen), .title, color: .strong)
                }
            }
        }
    }

    /// The confirm step's subtitle: the account, or the Apple Account when no email was shared.
    static func subtitle(_ screen: KitScreen<SignInState>) -> CopyLine? {
        screen.line("signin.auto.confirm.as") ?? screen.line("signin.auto.confirm.asApple")
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
                onMethod: { key in
                    // The Apple row opens the account sheet and runs the exchange; the other
                    // methods hand off to the hosted card.
                    if key == KitProvider.apple.rawValue {
                        model.signInWithProvider()
                    } else {
                        model.beginSignIn(method: Self.methodName(key))
                    }
                },
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
        case .choose where model.licenseChoice.state == .grantExpired:
            EmptyView()
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
                    cancel: nil)
            }
        case .key:
            ActivateBody(
                screen: model.activate, text: $model.keyText,
                onSubmit: { Task { await model.submitKey() } }, onReplaceDevice: nil)
        case .keyRefused:
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let message = screen.copy.first(where: { $0.key.hasSuffix(".message") }) {
                    KitText(message, .body, color: .default)
                }
                #if os(tvOS)
                    if let link = refusalLink(screen) {
                        PolarisQRCode(
                            link.absoluteString,
                            accessibilityLabel: strings.string(
                                "a11y.qrAddKey")
                        )
                        .frame(width: 200, height: 200)
                        KitText(CopyLine("signin.key.scan"), .meta, color: .muted)
                    }
                #endif
            }
        case .confirm:
            ConfirmBody(screen: screen)
        case .linkOffer, .nearbyWait, .linkConflict, .nearbyPrompt, .deviceLimit:
            // The step's sentences under its title; the controls are the actions.
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                ForEach(
                    Array(screen.copy.dropFirst().filter { !Self.autoControls.contains($0.key) }),
                    id: \.key
                ) { line in
                    if line.key == "a11y.nearbyCode" {
                        // The line is the code's screen-reader label, never visible text; the
                        // code itself is drawn large in monospace digits.
                        if let code = model.inputs.autoSignIn?.code {
                            NearbyCodeDigits(code: code, label: strings.string(line))
                        }
                    } else {
                        KitText(
                            line, .body,
                            color: line.key == "signin.nearby.match" ? .muted : .default)
                    }
                }
            }
        case .linkDone, .nearbyDone:
            EmptyView()
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

    /// The keys of an automatic step's controls: not body text.
    private static let autoControls: Set<String> = [
        "signin.auto.confirm.primary", "signin.auto.confirm.other", "signin.linkOffer.primary",
        "signin.linkOffer.decline", "common.notNow", "signin.nearby.code", "signin.nearby.notYou",
        "common.continue", "common.done", "signin.linkOffer.join", "signin.deviceLimit.replace",
        "a11y.externalLink", "common.cancel",
    ]

    /// The refusal's page when the server gave a valid one: the add-key page for the limit, the
    /// product's sign-in for a license another account holds (only when the kit cannot sign in).
    private func refusalLink(_ screen: KitScreen<SignInState>) -> URL? {
        let a = model.inputs.activation
        if screen.shows("core.activation.key-entry-limit.message") {
            return KitLinks.valid(a?.manageUrl)
        }
        return KitLinks.valid(a?.signInUrl)
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
            case .choose where model.licenseChoice.state == .grantExpired:
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
                } else if model.licenseChoice.state == .allFull, let link = browserReplaceLink {
                    // Replace in the browser only where some full row allows it; the page is the
                    // row's own, else the refusal's manageUrl. On return the sign-in resumes.
                    KitButton(
                        line: CopyLine("signin.replace.open"), kind: .primary,
                        glyph: PolarisKitGlyph.newWindow
                    ) {
                        model.replaceOpenedInBrowser()
                        open(link)
                    }
                    .keyboardShortcut(.defaultAction)
                }
                // A raced list keeps its primary: the person picks again and goes on.
                if model.licenseChoice.shows("signin.choice.continue")
                    || (model.licenseChoice.state == .raced && model.inputs.selected != nil
                        && model.inputs.choices?.choices.contains { !$0.isFull } == true)
                {
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
                if limitRows {
                    autoButton("signin.auto.confirm.other", .quiet, shortcut: false)
                }
                cancelButton
            case .confirm:
                autoButton("signin.auto.confirm.primary", .primary)
                autoButton("signin.auto.confirm.other", .quiet)
            case .linkOffer:
                autoButton("signin.linkOffer.primary", .primary, screen: screen)
                autoButton("signin.linkOffer.decline", .quiet)
            case .nearbyPrompt:
                autoButton("common.continue", .primary)
                autoButton("common.notNow", .quiet)
            case .nearbyWait:
                autoButton("signin.nearby.code", .quiet)
                cancelButton
            case .nearbyDone:
                autoButton("common.continue", .primary)
                autoButton("signin.nearby.notYou", .quiet)
            case .deviceLimit:
                // Replace a device opens the refusal's manageUrl and the sign-in resumes on return
                // (the gate runs the provider sign-in once more); Use another account drops the
                // step; Cancel leaves the form for Welcome. Never the key field (SIGN-IN §3.19).
                #if !os(tvOS)
                    if screen.shows("signin.deviceLimit.replace"),
                        let link = KitLinks.valid(model.inputs.autoSignIn?.manageUrl)
                    {
                        KitButton(
                            line: CopyLine("signin.deviceLimit.replace"), kind: .primary,
                            glyph: PolarisKitGlyph.newWindow
                        ) {
                            model.replaceOpenedInBrowser()
                            open(link)
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                #endif
                autoButton("signin.auto.confirm.other", .quiet, shortcut: false)
                cancelButton
            case .linkDone:
                autoButton("common.done", .primary)
            case .linkConflict:
                autoButton("common.done", .primary)
                autoButton("signin.linkOffer.join", .quiet)
            case .keyRefused:
                // Sign in finishes in the app (the account that holds the license); the page is a
                // secondary, and the primary only where the kit has no sign-in to start.
                KitButton(
                    line: screen.shows("core.activation.key-entry-limit.message")
                        ? CopyLine("signin.key.signIn") : CopyLine("signin.key.ownedSignIn"),
                    kind: .primary
                ) {
                    model.beginSignIn()
                }
                .keyboardShortcut(.defaultAction)
                #if !os(tvOS)
                    if screen.shows("signin.key.addInLocker"), let link = refusalLink(screen) {
                        KitButton(
                            line: CopyLine("signin.key.addInLocker"), kind: .secondary,
                            glyph: PolarisKitGlyph.newWindow
                        ) { open(link) }
                    }
                #endif
                KitButton(line: CopyLine("signin.key.differentKey"), kind: .quiet) {
                    model.keyText = ""
                }
            case .key:
                KitButton(
                    line: CopyLine("signin.key.addAndUse"), kind: .primary,
                    busy: model.activate.state == .busy
                ) { Task { await model.submitKey() } }
                .keyboardShortcut(.defaultAction)
                cancelButton
            case .replace:
                // Back returns to the list with the grant intact; Cancel leaves the whole flow.
                KitButton(
                    line: CopyLine("signin.replace.back"), kind: .secondary,
                    action: {
                        if model.choice != nil { model.closeChoiceReplace() } else { cancelSignInStep() }
                    }
                )
                .keyboardShortcut(.cancelAction)
                KitButton(line: CopyLine("common.cancel"), kind: .quiet, escapes: false) {
                    model.cancelSignIn()
                    onClose?()
                }
            }
        }
    }

    /// A control of an automatic step: the line's label, the host told which it was.
    @ViewBuilder private func autoButton(
        _ key: String, _ kind: KitButtonKind, screen: KitScreen<SignInState>? = nil,
        shortcut: Bool = true
    ) -> some View {
        let line = screen?.line(key) ?? model.signInScreen.line(key) ?? CopyLine(key)
        KitButton(line: line, kind: kind) {
            // The confirm step is the model's: Continue completes the grant, the other drops it.
            if model.signInScreen.state == .confirm {
                if kind == .primary {
                    Task { await model.continueAutoSignIn() }
                } else {
                    model.useAnotherAccount()
                }
            } else if kind != .primary, model.inDeviceLimit {
                // The device limit's other account: the grant goes and the methods show.
                model.useAnotherAccount()
            }
            onAutoSignIn?(kind == .primary ? .primary : .secondary)
        }
        .keyboardShortcut(
            kind == .primary ? .defaultAction : (shortcut ? .cancelAction : nil))
    }

    /// Full rows with no free seat and no grant to choose under: a device limit, whatever drew it.
    private var limitRows: Bool {
        model.licenseChoice.state == .allFull && model.choice == nil
            && model.licenseChoice.line("signin.choice.allFullCreate") == nil
    }

    /// Where Replace a device goes in the browser from a list of full rows: only when some full
    /// row allows a replace, to that row's page, else the refusal's `manageUrl`.
    private var browserReplaceLink: URL? {
        let rows = model.inputs.choices?.choices ?? []
        guard rows.contains(where: { $0.isFull && $0.replace?.allowed == true }) else { return nil }
        return rows.lazy.compactMap { KitLinks.valid($0.freeDeviceUrl) }.first
            ?? KitLinks.valid(model.limitManageUrl)
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
        if model.signInScreen.state == .methods || model.inDeviceLimit {
            // A device limit that stopped sign-in leaves the form for Welcome, like the methods.
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

    /// The email (or Continue in browser) row: the primary, or a secondary under the providers.
    @ViewBuilder private func emailRow(_ email: CopyLine?, primary: Bool, _ style: KitResolvedStyle)
        -> some View
    {
        if let email {
            if primary {
                KitButton(line: email, kind: .primary, glyph: PolarisKitGlyph.newWindow) {
                    onMethod(email.key)
                }
                .keyboardShortcut(.defaultAction)
            } else {
                KitButton(line: email, kind: .secondary, glyph: PolarisKitGlyph.newWindow) {
                    onMethod(email.key)
                }
            }
            errorRow(after: "Email", style)
        }
    }

    /// The provider buttons: `isDefault` makes the first the form's default action.
    @ViewBuilder private func providerRows(_ style: KitResolvedStyle, isDefault: Bool)
        -> some View
    {
        VStack(spacing: style.space(.sm)) {
            ForEach(providers, id: \.self) { provider in
                let label = strings.string(
                    "signin.provider.continue", ["provider": .text(provider.name)])
                // Apple's rules (HIG, Sign in with Apple): the logo and "Continue with Apple"
                // on a full-width button, white on a dark ground and black on a light one; same
                // height and capsule as its siblings.
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
                        hairline: style.dark ? nil : Color.black)
                )
                .keyboardShortcut(isDefault && provider == providers.first ? .defaultAction : nil)
                .accessibilityLabel(label)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.string("signin.provider.group"))
        ForEach(providers, id: \.self) { errorRow(after: $0.name, style) }
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let lede = screen.line("signin.methods.ledeApp") {
                    KitText(lede, .body, color: .default)
                }
                KitMethodsStack {
                    let email =
                        screen.line("signin.email.continue")
                        ?? screen.line("signin.desktop.continue")
                    let hasProviders = !providers.isEmpty && screen.shows("signin.provider.continue")
                    // The primary is the model's (SIGN-IN §3.19): Continue in browser on a desktop,
                    // Continue with the provider elsewhere, with email a secondary row. A kit with
                    // no provider row keeps email as the primary.
                    let emailIsPrimary = email?.key == "signin.desktop.continue" || !hasProviders
                    if emailIsPrimary { emailRow(email, primary: true, style) }
                    if hasProviders {
                        providerRows(style, isDefault: !emailIsPrimary)
                    }
                    if !emailIsPrimary { emailRow(email, primary: false, style) }
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

// MARK: - Automatic sign-in's confirm step

/// The confirm step's body (SIGN-IN §3.19): overline labels, a strong license line, 4 pt inside a
/// labelled group and 16 pt between groups. The account is the h1's subtitle, not a body line. A
/// label draws only with its value, and a line missing an argument is not drawn at all.
struct ConfirmBody: View {
    let screen: KitScreen<SignInState>

    /// The license value: the existing license with its seat, or the one created on Continue.
    private var licenseValue: CopyLine? {
        for key in ["signin.consent.licenseLine", "signin.consent.newLicense", "signin.choice.metaNew"] {
            if let line = screen.line(key), line.isComplete() { return line }
        }
        return nil
    }

    var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let label = screen.line("signin.consent.license"), let value = licenseValue {
                    VStack(alignment: .leading, spacing: style.space(.xxs)) {
                        KitText(label, .footnote, color: .muted)
                        KitText(value, .body, color: .strong, weight: .medium)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let label = screen.line("signin.consent.alsoGets") {
                    VStack(alignment: .leading, spacing: style.space(.xxs)) {
                        KitText(label, .footnote, color: .muted)
                        if let profile = screen.line("signin.consent.profile") {
                            KitText(profile, .body, color: .default)
                        }
                        if let pairwise = screen.line("signin.consent.pairwise") {
                            KitText(pairwise, .meta, color: .muted)
                        }
                    }
                    .accessibilityElement(children: .combine)
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
    @AccessibilityFocusState private var racedFocused: Bool
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
                // The full list's lede sits above its rows in every kit (SIGN-IN §3.19).
                ForEach(
                    screen.copy.filter {
                        $0.key.hasPrefix("signin.choice.allFull")
                            || $0.key == "signin.choice.noneReplaceable"
                            || $0.key.hasPrefix("signin.none")
                    }, id: \.key
                ) { line in
                    KitText(line, .body, color: .default)
                }
                if screen.state == .loading {
                    LoadingIndicator(CopyLine("common.loading"))
                }
                ForEach(screen.copy.filter { $0.key.hasSuffix(".raced") }, id: \.key) { line in
                    KitText(line, .meta, color: .default)
                        .padding(style.space(.md))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                                .fill(style.palette.sunken)
                        )
                        // Its own tint and hairline, so in light mode it never reads as a row.
                        .background(
                            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                                .fill(style.palette.accentSolid.opacity(0.12))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                                .strokeBorder(style.palette.accentSolid.opacity(0.35), lineWidth: 1)
                        )
                        .accessibilityFocused($racedFocused)
                        .onAppear { racedFocused = true }
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

/// The nearby wait's code: large monospace digits, labelled for VoiceOver by `a11y.nearbyCode`
/// ("Code to tap: 482 913"), which is never drawn.
struct NearbyCodeDigits: View {
    let code: String
    let label: String

    var body: some View {
        kitStyle { style in
            Text(code)
                .font(style.codeFont(size: CodeDisplay.size))
                .tracking(CodeDisplay.size * CodeDisplay.tracking)
                .foregroundStyle(style.palette.textStrong)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(label)
        }
    }
}
