// @pkey-feature ui.signin ui.settings
// The holder screens (UK-43.5, UI-KITS §4.1): ActivateDone and AddToAccount, activation without an
// account. After a key activates the license is floating, held by the key alone; ActivateDone says
// so and recommends an account once, quietly; AddToAccount collects a name and an email, and the
// browser confirms the email. Every line is a catalog key the state machines name
// (States/HoldersFamily.swift); the screens write no string of their own.
//
// The rules the screens keep:
//   - Form, invalid and busy are one view: typing after a validation error never rebuilds the
//     fields. Keyboard focus moves only on entering invalid (to the first wrong field), never when
//     invalid goes back to the form.
//   - Focus: VoiceOver lands on the heading on each step, and on Add when the person came back from
//     it. A problem is announced once, when it appears, not read twice.
//   - The code's Copy copies the code and says so (copy-code labels). The wait shows the code, "Or
//     go to <address>", a QR on a wide window, "Open browser" until the page has opened once and then
//     "Open Polaris Locker again". A page that did not open says so in the danger tone.
//   - Account sign-ins (Sign in to that account, Use another account, Sign in as <email>) use the
//     same wait screen and finish or show a danger line; Cancel stays live throughout.
//   - Email-bound leads with Verify, other-account with Try again. A busy action disables the
//     others; Cancel and Open browser stay live. Escape is never a decline: the only Escape is Cancel
//     (back, fields kept), and on Added it goes forward to the product.
//   - A missing product-page link is a danger line, never an empty QR or a button that opens nothing.
// Motion follows Reduce Motion: the morph, at most three staggered reasons and one check draw; with it
// on, an instant swap.

import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

// MARK: - What a step offers (pure: the rules above, testable without a window)

/// What a holder button does.
enum HolderAction: Hashable {
    case start, add, signInAs, submit, cancel, tryAgain, reopen, verify, otherAccount, signIn, done
}

/// One button of a step, in its group.
struct HolderButtonSpec: Equatable {
    let key: String
    let action: HolderAction
    let kind: KitButtonKind
    var external = false
    var busy = false
    var enabled = true
}

/// What the host adds to the screen's own state.
struct HolderExtras: Equatable {
    /// An account sign-in runs, or the add-to-account attempt waits.
    var working = false
    /// The page has opened once.
    var opened = false
    /// Verify has no page to open: it is left out.
    var noVerify = false
}

/// A code sign-in's wait: the code, its page as text, and the link its QR carries.
struct HolderWait: Equatable {
    var code: String?
    var address: String?
    var link: String?
}

enum HolderPlan {
    /// The buttons of a step, primary first. `keys` are the copy keys the state names.
    static func buttons(
        _ component: KitComponent, state: String, keys: Set<String>, _ x: HolderExtras
    ) -> [HolderButtonSpec] {
        func spec(
            _ key: String, _ action: HolderAction, _ kind: KitButtonKind, external: Bool = false,
            busy: Bool = false
        ) -> HolderButtonSpec? {
            keys.contains(key)
                ? HolderButtonSpec(key: key, action: action, kind: kind, external: external, busy: busy)
                : nil
        }
        let cancel = spec("common.cancel", .cancel, .quiet)
        let start = spec("signin.done.start", .start, .quiet)
        var specs: [HolderButtonSpec?]
        switch (component, state) {
        case (.activateDone, "waiting"):
            specs = [
                spec("signin.done.start", .start, .primary),
                spec("activate.waitingSignIn", .signInAs, .secondary, busy: x.working),
            ]
        case (.activateDone, _):
            specs = [spec("signin.done.start", .start, .primary)]
        case (_, "form"), (_, "invalid"):
            specs = [spec("common.continue", .submit, .primary), cancel]
        case (_, "busy"):
            specs = [
                spec("common.continue", .submit, .primary, busy: true),
                spec("signin.handoff.again", .reopen, .secondary), cancel,
            ]
        case (_, "waiting"):
            // The wait's first act is the page itself; once it has opened, the way back to it.
            specs = [
                HolderButtonSpec(
                    key: x.opened ? "activate.attach.reopen" : "signin.handoff.openBrowser",
                    action: .reopen, kind: .primary, external: true),
                cancel,
            ]
        case (_, "added"):
            // From Settings the app is running: Done closes. From the gate Start using goes on.
            specs = [
                keys.contains("common.done")
                    ? spec("common.done", .done, .primary) : spec("signin.done.start", .start, .primary)
            ]
        case (_, "owned"):
            specs = [spec("signin.key.ownedSignIn", .signIn, .primary, busy: x.working), cancel]
        case (_, "email-bound"):
            let verify =
                x.noVerify ? nil : spec("activate.otherEmail.verify", .verify, .primary, external: true)
            let other = spec(
                "signin.auto.confirm.other", .otherAccount, verify == nil ? .primary : .secondary,
                busy: x.working)
            specs = [verify, other, start]
        case (_, "other-account"):
            specs = [spec("common.tryAgain", .tryAgain, .primary), start]
        case (_, "failed"):
            specs = [spec("common.tryAgain", .tryAgain, .primary), cancel]
        default:
            specs = []
        }
        var out = specs.compactMap { $0 }
        // Cancel lets a running account sign-in go and is always there while one runs.
        if x.working, !out.contains(where: { $0.action == .cancel }) {
            out.append(HolderButtonSpec(key: "common.cancel", action: .cancel, kind: .quiet))
        }
        // A busy action disables the others; Cancel and the page's own button stay live.
        if out.contains(where: { $0.busy }) {
            out = out.map { spec in
                var s = spec
                if !s.busy, s.action != .cancel, s.action != .reopen { s.enabled = false }
                return s
            }
        }
        return out
    }

    /// The title line's key for a step.
    static func titleKey(_ component: KitComponent, state: String) -> String {
        switch (component, state) {
        case (.activateDone, _): return "activate.done.title"
        case (_, "waiting"): return "activate.attach.waitTitle"
        case (_, "added"): return "activate.attach.done"
        case (_, "owned"): return "activate.owned.title"
        case (_, "email-bound"): return "activate.otherEmail.title"
        case (_, "other-account"): return "activate.otherAccount.title"
        default: return "activate.recommend.action"
        }
    }

    /// Form, invalid and busy are one body: one identity, so typing never rebuilds the fields.
    static func group(_ component: KitComponent, state: String) -> String {
        component == .addToAccount && ["form", "invalid", "busy"].contains(state) ? "form" : state
    }
}

// MARK: - A step, as the views read it

/// A step's screen, with what the host reports.
struct HolderStep {
    let component: KitComponent
    let state: String
    let copy: [CopyLine]
    var field: KitAddToAccount.Field?
    var wait: HolderWait?
    var extras = HolderExtras()
    var problem: HolderProblem?
    /// The portal action has no page to open (portal mode with no link).
    var noPortalAction = false

    var keys: Set<String> { Set(copy.map(\.key)) }
    func line(_ key: String) -> CopyLine? { copy.first { $0.key == key } }
    var group: String { HolderPlan.group(component, state: state) }
    var title: CopyLine {
        line(HolderPlan.titleKey(component, state: state)) ?? CopyLine(HolderPlan.titleKey(component, state: state))
    }
    var buttons: [HolderButtonSpec] {
        HolderPlan.buttons(component, state: state, keys: keys, extras)
    }

    init<S: KitStateID>(
        _ screen: KitScreen<S>, field: KitAddToAccount.Field? = nil, wait: HolderWait? = nil,
        extras: HolderExtras = HolderExtras(), problem: HolderProblem? = nil
    ) {
        self.component = S.component
        self.state = screen.stateName
        self.copy = screen.copy
        self.field = field
        self.wait = wait
        self.extras = extras
        self.problem = problem
    }
}

/// What each button does. A host sets the ones it has; the rest do nothing.
struct HolderHandlers {
    var start: () -> Void = {}
    var add: () -> Void = {}
    var signInAs: () -> Void = {}
    var submit: () -> Void = {}
    var cancel: () -> Void = {}
    var tryAgain: () -> Void = {}
    var reopen: () -> Void = {}
    var verify: () -> Void = {}
    var otherAccount: () -> Void = {}
    var signIn: () -> Void = {}
    var done: () -> Void = {}

    func run(_ action: HolderAction) {
        switch action {
        case .start: start()
        case .add: add()
        case .signInAs: signInAs()
        case .submit: submit()
        case .cancel: cancel()
        case .tryAgain: tryAgain()
        case .reopen: reopen()
        case .verify: verify()
        case .otherAccount: otherAccount()
        case .signIn: signIn()
        case .done: done()
        }
    }
}

/// The two typed fields' values.
struct HolderFields {
    var name: Binding<String>
    var email: Binding<String>
}

/// Where the keyboard is.
private enum HolderField: Hashable { case name, email }

// MARK: - The page

/// One holder step in the kit's scaffold: heading, body, actions.
struct HolderPage: View {
    let step: HolderStep
    var fields: HolderFields?
    let handlers: HolderHandlers
    /// Focus goes to Add instead of the heading (the person came back from AddToAccount).
    var returned = false

    @AccessibilityFocusState private var headingFocused: Bool
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        kitStyle { style in
            KitScreenScaffold(header: true) {
                HolderHeading(step: step)
                    .accessibilityFocused($headingFocused)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                HolderBody(step: step, fields: fields, handlers: handlers, returned: returned)
                    .id(step.group)
                    .transition(style.reduceMotion ? .identity : .opacity)
            } actions: {
                HolderActions(step: step, handlers: handlers)
            }
            .animation(style.morph, value: step.group)
            .onAppear { headingFocused = !returned }
            .onChange(of: step.group) { _, _ in headingFocused = true }
        }
    }
}

/// The step's title. The two ends of the happy path draw a check beside it, once.
struct HolderHeading: View {
    let step: HolderStep
    @State private var drawn = false

    private var check: Bool {
        (step.component == .activateDone && step.state == "ready") || step.state == "added"
    }

    var body: some View {
        kitStyle { style in
            HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                if check {
                    checkmark(style)
                }
                KitText(step.title, .title, color: .strong)
                    .lineLimit(6)
                    // A long name shrinks before a word breaks in the middle (AX5).
                    .minimumScaleFactor(0.6)
                    .accessibilityAddTraits(.isHeader)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        }
    }

    @ViewBuilder private func checkmark(_ style: KitResolvedStyle) -> some View {
        let image = Image(systemName: "checkmark.circle.fill")
            .font(style.font(.title))
            .foregroundStyle(style.palette.success)
            .accessibilityHidden(true)
        #if compiler(>=6.2)
            if #available(iOS 26.0, macOS 26.0, *) {
                image
                    .symbolEffect(.drawOn, isActive: !drawn && !style.reduceMotion)
                    .onAppear { drawn = true }
            } else {
                image
                    .symbolEffect(.bounce, options: .nonRepeating, isActive: !style.reduceMotion)
            }
        #else
            image
                .symbolEffect(.bounce, options: .nonRepeating, isActive: !style.reduceMotion)
        #endif
    }
}

// MARK: - The body

struct HolderBody: View {
    let step: HolderStep
    var fields: HolderFields?
    let handlers: HolderHandlers
    var returned = false

    @FocusState private var focused: HolderField?
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var addFocused: Bool

    var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch (step.component, step.state) {
                case (.activateDone, "ready"): ready(style)
                case (.activateDone, _):
                    paragraphs(["activate.done.device", "activate.waiting"])
                case (_, "form"), (_, "invalid"), (_, "busy"), (_, "failed"): form(style)
                case (_, "waiting"): wait(style)
                case (_, "added"): paragraphs(["activate.attach.syncOn"])
                case (_, "owned"): paragraphs(["activate.owned.lede"])
                case (_, "email-bound"): paragraphs(["activate.otherEmail.body"])
                case (_, "other-account"): paragraphs(["activate.otherAccount.body"])
                default: EmptyView()
                }
                if let problem = visibleProblem {
                    problemLine(problem, style)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // A problem on the screen: the host's, or the missing portal link.
    private var visibleProblem: HolderProblem? {
        step.problem ?? (step.noPortalAction ? .linkUnavailable : nil)
    }

    @ViewBuilder private func paragraphs(_ keys: [String]) -> some View {
        ForEach(keys, id: \.self) { key in
            if let line = step.line(key) { KitText(line, .body) }
        }
    }

    // MARK: ActivateDone

    @ViewBuilder private func ready(_ style: KitResolvedStyle) -> some View {
        if let device = step.line("activate.done.device") { KitText(device, .body, color: .muted) }
        VStack(alignment: .leading, spacing: style.space(.sm)) {
            // The badge sits on its own line: the title is never squeezed beside it.
            if let badge = step.line("activate.recommend.badge") {
                KitText(badge, .footnote, color: .accent)
                    .padding(.horizontal, style.space(.xs))
                    .padding(.vertical, style.space(.xxs) / 2)
                    .background(Capsule().fill(style.palette.accentSolid.opacity(0.14)))
            }
            if let title = step.line("activate.recommend.title") {
                KitText(title, .headline, color: .strong)
                    .lineLimit(6)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                ForEach(Array(reasonKeys.enumerated()), id: \.element) { index, key in
                    if let line = step.line(key) {
                        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                            Image(systemName: Self.symbol(key))
                                .foregroundStyle(style.palette.accentFg)
                                .frame(width: 22)
                                .accessibilityHidden(true)
                            KitText(line, .body)
                        }
                        .modifier(StaggerIn(index: index))
                    }
                }
            }
            addAction(style)
        }
        .padding(style.space(.md))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                .fill(style.palette.sunken)
        )
        .overlay(
            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                .strokeBorder(style.palette.border, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        if let skip = step.line("activate.recommend.skip") { KitText(skip, .body, color: .muted) }
    }

    private var reasonKeys: [String] {
        step.copy.map(\.key).filter { $0.hasPrefix("activate.recommend.") }
            .filter {
                ["sync", "recover", "devices", "portal"].contains(String($0.dropFirst("activate.recommend.".count)))
            }
    }

    private static func symbol(_ key: String) -> String {
        switch key {
        case "activate.recommend.sync": return "arrow.triangle.2.circlepath"
        case "activate.recommend.recover": return "lock"
        case "activate.recommend.devices": return "arrow.left.arrow.right"
        default: return "checkmark.circle"
        }
    }

    /// Add your name and email: inside the card, so it reads as what the recommendation offers. With
    /// no in-app channel it opens Polaris Locker (↗). With no page to open it is left out.
    @ViewBuilder private func addAction(_ style: KitResolvedStyle) -> some View {
        let portal = step.line("signin.key.addInLocker")
        if let line = portal ?? step.line("activate.recommend.action"), !step.noPortalAction {
            KitButton(
                line: line, kind: .secondary, glyph: portal == nil ? nil : PolarisKitGlyph.externalArrow
            ) { handlers.add() }
            .accessibilityFocused($addFocused)
            .onAppear { addFocused = returned }
        }
    }

    // MARK: AddToAccount

    @ViewBuilder private func form(_ style: KitResolvedStyle) -> some View {
        let isFailed = step.state == "failed"
        if let lede = step.line("activate.attach.lede") { KitText(lede, .body) }
        if isFailed, let failed = step.line("activate.attach.failed") {
            problemLine(.signInFailed, style, override: failed)
        } else if let fields {
            let busy = step.state == "busy"
            field(
                fields.name, label: "activate.attach.name", error: "activate.attach.nameRequired",
                kind: .name, busy: busy, style)
            field(
                fields.email, label: "signin.email.label", error: "signin.email.invalid",
                kind: .email, busy: busy, style)
            if let fine = step.line("activate.attach.fine") { KitText(fine, .meta, color: .muted) }
            if busy, let working = step.line("common.working") {
                LoadingIndicator(working)
            }
        }
    }

    @ViewBuilder private func field(
        _ text: Binding<String>, label: String, error: String, kind: HolderField, busy: Bool,
        _ style: KitResolvedStyle
    ) -> some View {
        let message = step.line(error)
        let invalid = message != nil
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText(label, [:], .meta, color: .muted).accessibilityHidden(true)
            TextField("", text: text)
                .textFieldStyle(.plain)
                .font(style.font(.body))
                .focused($focused, equals: kind)
                .submitLabel(kind == .name ? .next : .go)
                .onSubmit {
                    if kind == .name { focused = .email } else { handlers.submit() }
                }
                .disabled(busy)
                .modifier(HolderFieldTraits(isEmail: kind == .email))
                .padding(.horizontal, style.space(.md))
                .frame(minHeight: max(style.controlHeight, 44))
                .background(
                    RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                        .fill(style.palette.sunken)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                        .strokeBorder(
                            invalid
                                ? style.palette.danger
                                : (focused == kind ? style.palette.focus : .clear), lineWidth: 2)
                )
                .opacity(busy ? 0.6 : 1)
                .accessibilityLabel(strings.string(label))
                .accessibilityValue(message.map { Text(strings.string($0)) } ?? Text(""))
            if let message {
                // Seen beside the field it names; read with it (the field's value), announced once.
                HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger).accessibilityHidden(true)
                    KitText(message, .meta, color: .danger)
                }
                .accessibilityHidden(true)
            }
        }
        .onChange(of: step.state) { old, new in
            // Entering invalid puts the keyboard on the first wrong field. Invalid going back to the
            // form (the person typed) never moves it.
            guard new == "invalid", old != "invalid" else { return }
            let first: HolderField =
                step.line("activate.attach.nameRequired") != nil ? .name : .email
            if kind == first { focused = first }
        }
        .onAppear {
            #if os(macOS)
                // A pointer: Name is ready to type in.
                if kind == .name, step.state == "form" { focused = .name }
            #endif
        }
    }

    // MARK: The wait

    @ViewBuilder private func wait(_ style: KitResolvedStyle) -> some View {
        if let code = step.wait?.code, !code.isEmpty {
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                KitText("part.code.label", [:], .meta, color: .muted)
                CodeDisplay(code: code)
            }
        }
        if let check = step.line("activate.attach.waitCheck") { KitText(check, .meta, color: .muted) }
        let address = KitLinks.display(step.wait?.address ?? DEVICE_CODE_PAGE)
        KitText(CopyLine("signin.handoff.url", ["url": .text(address)]), .body)
        if let link = step.wait?.link, KitLinks.valid(link) != nil, HolderWide.isWide {
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                KitText("part.qr.scanInstead", [:], .meta, color: .muted)
                PolarisQRCode(link, accessibilityLabel: strings.string("a11y.qr"))
                    .frame(width: 180, height: 180)
            }
        }
    }

    // MARK: A problem

    /// A refusal: glyph and words (never colour alone). Announced once, when it appears.
    private func problemLine(
        _ problem: HolderProblem, _ style: KitResolvedStyle, override: CopyLine? = nil
    ) -> some View {
        let line = override ?? CopyLine(problem.key)
        return HolderProblemLine(line: line)
    }
}

/// The danger line, announced once as it appears (VoiceOver is not also sent to it).
struct HolderProblemLine: View {
    let line: CopyLine
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        kitStyle { style in
            HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(style.palette.danger)
                    .accessibilityHidden(true)
                KitText(line, .meta, color: .danger)
            }
            .accessibilityElement(children: .combine)
            .onAppear { AccessibilityNotification.Announcement(strings.string(line)).post() }
        }
    }
}

/// Whether the window can carry the QR beside the rest.
enum HolderWide {
    #if os(macOS)
        static var isWide: Bool { true }
    #else
        @MainActor static var isWide: Bool {
            #if canImport(UIKit)
                UIDevice.current.userInterfaceIdiom != .phone
            #else
                false
            #endif
        }
    #endif
}

/// Name and email's input traits.
private struct HolderFieldTraits: ViewModifier {
    let isEmail: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
            if isEmail {
                content
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } else {
                content
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
            }
        #else
            content.autocorrectionDisabled()
        #endif
    }
}

/// A reason arrives after the one before it, up to the third; under Reduce Motion it is just there.
private struct StaggerIn: ViewModifier {
    let index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion || index >= 3 ? 1 : 0)
            .offset(y: shown || reduceMotion || index >= 3 ? 0 : 6)
            .onAppear {
                guard !reduceMotion, index < 3 else { return }
                withAnimation(.smooth(duration: 0.26).delay(0.06 * Double(index))) { shown = true }
            }
    }
}

// MARK: - The actions

struct HolderActions: View {
    let step: HolderStep
    let handlers: HolderHandlers
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        let specs = step.buttons
        KitActionStack {
            ForEach(Array(specs.enumerated()), id: \.offset) { _, spec in
                KitButton(
                    line: step.line(spec.key) ?? CopyLine(spec.key), kind: spec.kind, busy: spec.busy,
                    glyph: spec.external ? PolarisKitGlyph.externalArrow : nil
                ) { handlers.run(spec.action) }
                .disabled(!spec.enabled)
                .opacity(spec.enabled ? 1 : 0.5)
            }
        }
        .animation(nil, value: specs.map(\.key))
    }
}

// MARK: - ActivateDone

/// "<Product> is ready", after a key activated: the license line, and the recommendation to keep it
/// in an account, once, quietly. Start using is always the one primary.
public struct ActivateDoneView: View {
    let inputs: KitInputs
    let host: HolderHostState
    let portalLink: String?
    let onStart: () -> Void
    let onAdd: () -> Void
    let onSignedIn: () -> Void
    /// The one opener: only a link `KitLinks` accepts (https, or loopback http) reaches it.
    @Environment(\.openURL) private var opener

    /// - Parameters:
    ///   - inputs: the license's facts (`activateDone`, `licenseHolder`) over the product's.
    ///   - host: the account sign-in a waiting license starts ("Sign in as ...").
    ///   - portalLink: the product page, for a kit with no in-app channel; nil leaves the action out
    ///     and says so.
    ///   - onAdd: Add your name and email, in the app.
    ///   - onSignedIn: the sign-in a waiting license started finished: the gate re-reads the license.
    public init(
        inputs: KitInputs, host: HolderHostState, portalLink: String? = nil,
        onStart: @escaping () -> Void, onAdd: @escaping () -> Void,
        onSignedIn: (() -> Void)? = nil
    ) {
        self.inputs = inputs
        self.host = host
        self.portalLink = portalLink
        self.onStart = onStart
        self.onAdd = onAdd
        self.onSignedIn = onSignedIn ?? onStart
    }

    public var body: some View {
        if host.waiting {
            HolderPage(
                step: waitStep, handlers: handlers)
        } else {
            let screen = KitStates.activateDone(inputs)
            if screen.state != nil {
                HolderPage(step: step(screen), handlers: handlers, returned: inputs.activateDone?.returned == true)
            }
        }
    }

    private func step(_ screen: KitScreen<ActivateDoneState>) -> HolderStep {
        var step = HolderStep(
            screen, extras: HolderExtras(working: host.working, opened: host.opened),
            problem: host.problem)
        step.noPortalAction = screen.shows("signin.key.addInLocker") && KitLinks.valid(portalLink) == nil
        return step
    }

    /// The account sign-in's wait is the add-to-account wait.
    private var waitStep: HolderStep {
        var i = inputs
        i.addToAccount = KitAddToAccount(step: .busy)
        i.deviceCode = KitDeviceCode(
            phase: .waiting, userCode: host.userCode, verificationUri: host.address)
        return HolderStep(
            KitStates.addToAccount(i),
            wait: HolderWait(code: host.userCode, address: host.address, link: host.link),
            extras: HolderExtras(working: true, opened: host.opened), problem: host.problem)
    }

    private var handlers: HolderHandlers {
        var h = HolderHandlers()
        h.start = onStart
        h.add = {
            #if os(tvOS)
                // A TV opens nothing: the flow shows the manage QR.
                onAdd()
            #else
                if let url = KitLinks.valid(portalLink),
                    KitStates.activateDone(inputs).shows("signin.key.addInLocker")
                {
                    opener(url) { ok in if !ok { host.problem = .openFailed } }
                } else {
                    onAdd()
                }
            #endif
        }
        h.signInAs = {
            Task {
                if await host.signIn(loginHint: inputs.licenseHolder?.email) { onSignedIn() }
            }
        }
        h.reopen = { Task { await host.reopen() } }
        h.cancel = { host.cancel() }
        return h
    }
}

// MARK: - AddToAccount

/// Add your name and email: the person types them here, and the browser confirms the email.
public struct AddToAccountView: View {
    let model: AddToAccountModel
    let onCancel: () -> Void
    let onStart: () -> Void
    let onDone: () -> Void
    let onVerify: (() -> Bool)?
    let onSignedIn: () -> Void

    /// - Parameters:
    ///   - onCancel: leave for the screen that opened this one (Done), the fields kept.
    ///   - onStart: Start using the product.
    ///   - onDone: close, after Added from Settings; defaults to `onStart`.
    ///   - onVerify: open the account page where the license's email is verified; true when it opened.
    ///     nil leaves Verify out.
    ///   - onSignedIn: an account sign-in finished: the gate re-reads the license.
    public init(
        model: AddToAccountModel, onCancel: @escaping () -> Void, onStart: @escaping () -> Void,
        onDone: (() -> Void)? = nil, onVerify: (() -> Bool)? = nil, onSignedIn: (() -> Void)? = nil
    ) {
        self.model = model
        self.onCancel = onCancel
        self.onStart = onStart
        self.onDone = onDone ?? onStart
        self.onVerify = onVerify
        self.onSignedIn = onSignedIn ?? onStart
    }

    private var fields: HolderFields {
        HolderFields(
            name: Binding(get: { model.name }, set: { model.setField(.name, $0) }),
            email: Binding(get: { model.email }, set: { model.setField(.email, $0) }))
    }

    private var step: HolderStep {
        let host = model.host
        let working = host.working || model.step == .busy
        if host.waiting {
            var i = model.inputs
            i.addToAccount = KitAddToAccount(
                step: .busy, deviceKind: i.addToAccount?.deviceKind)
            i.deviceCode = KitDeviceCode(
                phase: .waiting, userCode: host.userCode, verificationUri: host.address)
            return HolderStep(
                KitStates.addToAccount(i),
                wait: HolderWait(code: host.userCode, address: host.address, link: host.link),
                extras: HolderExtras(working: true, opened: host.opened), problem: host.problem)
        }
        let wait: HolderWait? =
            model.userCode.map { HolderWait(code: $0, address: model.address, link: model.link) }
        let problem: HolderProblem? = host.problem ?? (model.openFailed ? .openFailed : nil)
        return HolderStep(
            model.screen, field: model.field, wait: wait,
            extras: HolderExtras(
                working: working, opened: model.opened, noVerify: onVerify == nil),
            problem: problem)
    }

    public var body: some View {
        let current = step
        HolderPage(step: current, fields: fields, handlers: handlers(current))
            // Escape is Cancel: back, the fields kept. On Added it goes forward to the product.
            // Never a decline.
            .accessibilityAction(.escape) { escape(current) }
            #if os(macOS)
                .onExitCommand { escape(current) }
            #else
                .interactiveDismissDisabled(current.state == "added" || current.extras.working)
            #endif
    }

    private func escape(_ step: HolderStep) {
        if step.state == "added" { onDone() } else { cancel(step) }
    }

    /// Cancel lets a running sign-in go and stays where the person was; otherwise it leaves.
    private func cancel(_ step: HolderStep) {
        if model.host.working {
            model.host.cancel()
        } else if model.step == .busy {
            model.cancel()
        } else {
            model.cancel()
            onCancel()
        }
    }

    private func handlers(_ current: HolderStep) -> HolderHandlers {
        var h = HolderHandlers()
        h.start = onStart
        h.done = onDone
        h.submit = { Task { await model.submit() } }
        h.tryAgain = { Task { await model.tryAgain() } }
        h.cancel = { cancel(current) }
        h.reopen = {
            if model.host.waiting {
                Task { await model.host.reopen() }
            } else {
                Task { await model.reopen() }
            }
        }
        h.verify = {
            if let onVerify, !onVerify() { model.host.problem = .openFailed }
        }
        let signIn: () -> Void = {
            Task { if await model.host.signIn() { onSignedIn() } }
        }
        h.signIn = signIn
        h.otherAccount = signIn
        return h
    }
}

// MARK: - A still, for previews and renders

/// A step drawn from its inputs alone: no model, no network.
struct HolderPreview: View {
    let inputs: KitInputs
    let component: KitComponent
    @State private var name: String
    @State private var email: String

    init(inputs: KitInputs, component: KitComponent) {
        self.inputs = inputs
        self.component = component
        // A rejected field shows what was typed.
        let step = inputs.addToAccount?.step
        _name = State(initialValue: step == .invalid && inputs.addToAccount?.field == .email ? "Ada Lovelace" : "")
        _email = State(
            initialValue: step == .invalid && inputs.addToAccount?.field == .name ? "ada@example.com" : "")
    }

    var body: some View {
        let fields = HolderFields(name: $name, email: $email)
        switch component {
        case .activateDone:
            ActivateDoneView(
                inputs: inputs, host: HolderHostState(),
                portalLink: "https://polaris.locker/activate?product=tidewater", onStart: {},
                onAdd: {})
        default:
            let screen = KitStates.addToAccount(inputs)
            let wait: HolderWait? = inputs.deviceCode?.userCode.map {
                HolderWait(
                    code: $0, address: inputs.deviceCode?.verificationUri,
                    link: DEVICE_CODE_PAGE + "?user_code=" + $0)
            }
            HolderPage(
                step: HolderStep(
                    screen, field: inputs.addToAccount?.field, wait: wait,
                    extras: HolderExtras(working: inputs.addToAccount?.step == .busy)),
                fields: fields, handlers: HolderHandlers())
        }
    }
}

// MARK: - The sign-in form's holder steps

/// The step's screen for a sign-in form's `key-done`, `attach` or `added`.
@MainActor private func holderStep(_ state: SignInState?, _ inputs: KitInputs) -> HolderStep? {
    switch state {
    case .keyDone:
        let screen = KitStates.activateDone(inputs)
        return screen.state == nil ? nil : HolderStep(screen)
    case .attach, .added:
        let screen = KitStates.addToAccount(inputs, asAdded: state == .added)
        return screen.state == nil
            ? nil : HolderStep(screen, field: inputs.addToAccount?.field)
    default:
        return nil
    }
}

/// The form's body for a holder step. With the gate's flow the typed values and actions are live;
/// without one the form draws as the matrix names it.
struct HolderSignInBody: View {
    let inputs: KitInputs
    let state: SignInState?
    let onStart: () -> Void
    var flow: HolderFlowModel?
    @Environment(\.openURL) private var opener
    @State private var name = ""
    @State private var email = ""

    var body: some View {
        if let flow {
            let live = HolderFormLive(flow: flow, state: state, opener: opener, onStart: onStart)
            if let step = live.step {
                HolderBody(step: step, fields: live.fields, handlers: live.handlers)
            }
        } else if let step = holderStep(state, inputs) {
            HolderBody(
                step: step, fields: HolderFields(name: $name, email: $email),
                handlers: HolderHandlers(start: onStart))
        }
    }
}

/// The form's actions for a holder step.
struct HolderSignInActions: View {
    let inputs: KitInputs
    let state: SignInState?
    let onStart: () -> Void
    var flow: HolderFlowModel?
    @Environment(\.openURL) private var opener

    var body: some View {
        if let flow {
            let live = HolderFormLive(flow: flow, state: state, opener: opener, onStart: onStart)
            if let step = live.step { HolderActions(step: step, handlers: live.handlers) }
        } else if let step = holderStep(state, inputs) {
            HolderActions(step: step, handlers: HolderHandlers(start: onStart, done: onStart))
        }
    }
}

/// A holder step of the sign-in form over the gate's flow: its screen, its typed values and its actions.
@MainActor struct HolderFormLive {
    let flow: HolderFlowModel
    let state: SignInState?
    let opener: OpenURLAction
    let onStart: () -> Void

    var step: HolderStep? {
        switch state {
        case .keyDone:
            let screen = KitStates.activateDone(flow.doneInputs)
            return screen.state == nil
                ? nil
                : HolderStep(
                    screen, extras: HolderExtras(working: flow.doneHost.working), problem: flow.doneHost.problem)
        case .attach, .added:
            let model = flow.add
            let screen = KitStates.addToAccount(model.inputs, asAdded: state == .added)
            return screen.state == nil
                ? nil
                : HolderStep(
                    screen, field: model.field,
                    wait: model.userCode.map { HolderWait(code: $0, address: model.address, link: model.link) },
                    extras: HolderExtras(
                        working: model.step == .busy, opened: model.opened, noVerify: flow.verifyLink == nil),
                    problem: model.host.problem ?? (model.openFailed ? .openFailed : nil))
        default:
            return nil
        }
    }

    var fields: HolderFields {
        HolderFields(
            name: Binding(get: { flow.add.name }, set: { flow.add.setField(.name, $0) }),
            email: Binding(get: { flow.add.email }, set: { flow.add.setField(.email, $0) }))
    }

    var handlers: HolderHandlers {
        var h = HolderHandlers()
        let flow = flow
        let onStart = onStart
        h.start = {
            flow.finish()
            onStart()
        }
        h.done = h.start
        h.add = { flow.openAdd() }
        h.submit = { Task { await flow.add.submit() } }
        h.tryAgain = { Task { await flow.add.tryAgain() } }
        h.cancel = { flow.cancelAdd() }
        h.reopen = { Task { await flow.add.reopen() } }
        h.verify = {
            if let link = flow.verifyLink, let url = KitLinks.valid(link),
                holderOpening(opener, failed: { flow.add.host.problem = .openFailed })(url)
            {
                return
            }
            flow.add.host.problem = .openFailed
        }
        h.signIn = { Task { if await flow.add.host.signIn() { flow.finish() } } }
        h.otherAccount = h.signIn
        h.signInAs = {
            Task { if await flow.doneHost.signIn(loginHint: flow.facts.holderEmail) { flow.finish() } }
        }
        return h
    }
}
