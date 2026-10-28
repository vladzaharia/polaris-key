// @pkey-feature ui.settings
// The Cloud Sync screens (U-42.3, UI-KITS §4.1): UnlockSync, RecoveryCode, RingChange and the
// CloudSyncStatus row. Every line is a catalog key the state machines name
// (States/CloudSyncFamily.swift). The recovery code is never an input of RecoveryCode: it is drawn
// from the model, once, as groups that never break, and leaves memory on Done. Both code screens say
// that no one will ever ask for it.
//
// Focus: VoiceOver lands on the heading when a screen appears (it names what is being asked before
// any button is read); a refusal and the working line take VoiceOver focus when they appear. The
// matrix's `focus` is KEYBOARD focus here: the start-over step puts it on Cancel, so Return never
// reaches the destructive action. Motion follows Reduce Motion.

import PolarisKeyUICore
import SwiftUI

/// Where VoiceOver goes on UnlockSync.
private enum UnlockFocus: Hashable { case heading, message }

// MARK: - UnlockSync

/// Unlock the synced data with the recovery code, or start over.
public struct UnlockSyncView: View {
    let model: UnlockSyncModel
    @Environment(\.polarisKeyStrings) private var strings
    @FocusState private var fieldFocused: Bool
    @FocusState private var cancelFocused: Bool
    @AccessibilityFocusState private var focus: UnlockFocus?

    public init(model: UnlockSyncModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if let state = screen.state {
            KitScreenScaffold(header: true) {
                KitText(screen.copy.first ?? CopyLine("unlockSync.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .heading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .kitAnimation(value: screen.stateName)
            // A new key's code is on its way: the screen stays until it has been handed on.
            .interactiveDismissDisabled(model.minting)
            .onAppear {
                focus = .heading
                #if os(macOS)
                    fieldFocused = state == .code || state == .invalid
                #endif
            }
            .onChange(of: screen.stateName) { _, _ in
                // A refusal and the progress line are what changed; the heading did not.
                switch model.step {
                case .invalid, .failed, .startOverFailed, .working, .noCode: focus = .message
                default: focus = .heading
                }
                cancelFocused = model.step == .startOver
            }
            .onChange(of: model.code) { _, new in
                // The Go key: a vertical field inserts a newline instead of submitting.
                if new.contains("\n") {
                    model.code = new.replacingOccurrences(of: "\n", with: "")
                    submit()
                } else {
                    model.codeEdited()
                }
            }
        }
    }

    /// Unlock, or put the person in the field when it is empty (nothing was checked).
    private func submit() {
        if model.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fieldFocused = true
        } else {
            Task { await model.unlock() }
        }
    }

    @ViewBuilder private func content(_ screen: KitScreen<UnlockSyncState>, _ state: UnlockSyncState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .code, .invalid:
                    if let lede = screen.line("unlockSync.lede") { KitText(lede, .body) }
                    field(style, invalid: state == .invalid)
                    if let invalid = screen.line("unlockSync.invalid") {
                        message(invalid, style)
                    }
                    if let noAsk = screen.line("recoveryCode.noAsk") {
                        KitText(noAsk, .meta, color: .muted)
                    }
                case .working:
                    if let working = screen.line("common.working") {
                        LoadingIndicator(working)
                            .accessibilityFocused($focus, equals: .message)
                    }
                case .failed:
                    if let failed = screen.line("unlockSync.failed") { message(failed, style) }
                case .startOverFailed:
                    if let failed = screen.line("unlockSync.startOverFailed") {
                        message(failed, style)
                    }
                case .noCode:
                    if let none = screen.line("unlockSync.noCode") { message(none, style, danger: false) }
                case .startOver:
                    if let warning = screen.line("unlockSync.startOverWarning") {
                        KitText(warning, .body)
                    }
                }
            }
        }
    }

    /// A refusal: glyph and words (never colour alone), announced when it appears.
    private func message(_ line: CopyLine, _ style: KitResolvedStyle, danger: Bool = true)
        -> some View
    {
        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
            Image(systemName: danger ? "exclamationmark.circle.fill" : "info.circle")
                .foregroundStyle(danger ? style.palette.danger : style.palette.textMuted)
                .accessibilityHidden(true)
            KitText(line, .meta, color: danger ? .danger : .default)
        }
        .accessibilityElement(children: .combine)
        .accessibilityFocused($focus, equals: .message)
    }

    /// The recovery code field: a visible label, Paste inside while empty, never logged or
    /// autocorrected.
    @ViewBuilder private func field(_ style: KitResolvedStyle, invalid: Bool) -> some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText("unlockSync.field", [:], .meta, color: .muted)
                .accessibilityHidden(true)
            HStack(spacing: style.space(.xs)) {
                TextField("", text: $model.code, axis: .vertical)
                    .font(style.font(.key))
                    .lineLimit(1...3)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        .keyboardType(.asciiCapable)
                    #endif
                    .submitLabel(.go)
                    .focused($fieldFocused)
                    .onSubmit { submit() }
                    .privacySensitive()
                    .accessibilityLabel(strings.string("unlockSync.field"))
                paste
            }
            .padding(.horizontal, style.space(.md))
            .padding(.vertical, style.space(.xs))
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
                            : (fieldFocused ? style.palette.focus : .clear),
                        lineWidth: 2)
            )
        }
    }

    /// Paste, while the field is empty: a code usually comes from a password manager or a note.
    @ViewBuilder private var paste: some View {
        if model.code.isEmpty {
            #if os(iOS)
                PasteButton(payloadType: String.self) { values in
                    if let first = values.first {
                        Task { @MainActor in
                            model.code = first.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
            #elseif os(macOS)
                Button(strings.string("common.paste")) {
                    if let pasted = NSPasteboard.general.string(forType: .string) {
                        model.code = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
            #endif
        }
    }

    @ViewBuilder private func actions(_ screen: KitScreen<UnlockSyncState>, _ state: UnlockSyncState)
        -> some View
    {
        KitActionStack {
            switch state {
            case .code, .invalid:
                KitButton(line: screen.lineOrKey("unlockSync.unlock"), kind: .primary) { submit() }
                    .keyboardShortcut(.defaultAction)
                KitButton(line: screen.lineOrKey("unlockSync.startOver"), kind: .secondary) {
                    model.askStartOver()
                }
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            case .working:
                EmptyView()
            case .failed, .startOverFailed:
                KitButton(line: screen.lineOrKey("common.tryAgain"), kind: .primary) {
                    Task { await model.retry() }
                }
                .keyboardShortcut(.defaultAction)
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            case .noCode:
                KitButton(line: screen.lineOrKey("unlockSync.startOver"), kind: .primary) {
                    model.askStartOver()
                }
                .keyboardShortcut(.defaultAction)
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            case .startOver:
                // The destructive action first and Cancel last, as in every stack of the kit: the
                // slot a person backs out through is never the one that wipes the data. Keyboard
                // focus starts on Cancel and the destructive action is never the default.
                KitButton(line: screen.lineOrKey("unlockSync.startOverConfirm"), kind: .destructive) {
                    Task { await model.confirmStartOver() }
                }
                .disabled(!model.startOverArmed)
                .opacity(model.startOverArmed ? 1 : 0.5)
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
                    .focused($cancelFocused)
                    .onAppear { cancelFocused = true }
            }
        }
    }
}

// MARK: - RecoveryCode

/// The new recovery code, shown once, as groups that never break. Done waits for the person to
/// confirm they saved it, and the screen cannot be swiped away before that.
public struct RecoveryCodeView: View {
    let model: RecoveryCodeModel
    @State private var copied = false
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var headingFocused: Bool

    public init(model: RecoveryCodeModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if screen.state != nil {
            KitScreenScaffold(header: true) {
                KitText(screen.lineOrKey("recoveryCode.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($headingFocused)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onAppear { headingFocused = true }
            } content: {
                content(screen)
            } actions: {
                KitActionStack {
                    if model.saved {
                        KitButton(line: screen.lineOrKey("common.done"), kind: .primary) {
                            copied = false
                            model.done()
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                }
            }
            .kitAnimation(value: screen.stateName)
            // A once-only code cannot be swiped away before it is saved.
            .interactiveDismissDisabled(!model.saved)
            .onDisappear { copied = false }
        }
    }

    /// The code's groups, in rows of four (two at accessibility sizes). A group is one unit.
    static func rows(_ code: String, perRow: Int) -> [[String]] {
        let groups = code.split(separator: "-").map(String.init)
        return stride(from: 0, to: groups.count, by: perRow).map {
            Array(groups[$0..<min($0 + perRow, groups.count)])
        }
    }

    @ViewBuilder private func content(_ screen: KitScreen<RecoveryCodeState>) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                KitText(screen.lineOrKey("recoveryCode.lede"), .body)
                if let code = model.code {
                    codeGrid(code, style)
                    KitButton(
                        line: CopyLine(copied ? "common.copied" : "recoveryCode.copy"),
                        kind: .secondary, glyph: copied ? "checkmark" : "doc.on.doc"
                    ) {
                        KitPasteboard.copySensitive(code)
                        copied = true
                    }
                }
                KitText(screen.lineOrKey("recoveryCode.noAsk"), .meta, color: .muted)
                Toggle(
                    isOn: Binding(get: { model.saved }, set: { model.setSaved($0) })
                ) {
                    KitText(screen.lineOrKey("recoveryCode.saved"), .body)
                }
                .frame(minHeight: 44)
            }
        }
    }

    private func codeGrid(_ code: String, _ style: KitResolvedStyle) -> some View {
        // The widest layout that fits the width: four to a row, then two, then one (at
        // accessibility sizes four never fits). A group is never cut.
        let layouts = dynamicType.isAccessibilitySize ? [2, 1] : [4, 2, 1]
        // Read group by group, each character apart, with a pause between groups.
        let spoken = code.split(separator: "-").map { $0.map(String.init).joined(separator: " ") }
            .joined(separator: ", ")
        return ViewThatFits(in: .horizontal) {
            ForEach(layouts, id: \.self) { perRow in
                Grid(
                    alignment: .leading, horizontalSpacing: style.space(.md),
                    verticalSpacing: style.space(.xs)
                ) {
                    ForEach(Array(Self.rows(code, perRow: perRow).enumerated()), id: \.offset) {
                        _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, group in
                                Text(verbatim: group)
                                    .font(style.font(.code))
                                    .foregroundStyle(style.palette.textStrong)
                                    .fixedSize()
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(style.space(.md))
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.sunken)
        )
        .privacySensitive()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(strings.string("a11y.recoveryCode", ["code": .text(spoken)]))
    }
}

// MARK: - RingChange

/// Confirm a changed ring: it names the device, or says a device did. The recovery code is the
/// primary, safer way in; Accept shows only when a ring was served to accept.
public struct RingChangeView: View {
    let model: RingChangeModel
    private enum Focus: Hashable { case heading, failure }
    @AccessibilityFocusState private var focus: Focus?

    public init(model: RingChangeModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if screen.state != nil {
            KitScreenScaffold(header: true) {
                KitText(screen.lineOrKey("ringChange.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .heading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onAppear { focus = .heading }
            } content: {
                kitStyle { style in
                    VStack(alignment: .leading, spacing: style.space(.md)) {
                        KitText(
                            screen.line("ringChange.body") ?? screen.lineOrKey("ringChange.bodyUnknown"),
                            .body)
                        HStack(alignment: .top, spacing: style.space(.xs)) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(style.palette.warning)
                                .accessibilityHidden(true)
                            KitText(
                                screen.line("ringChange.warning")
                                    ?? screen.lineOrKey("ringChange.warningNoServed"), .meta)
                        }
                        if let failed = screen.line("ringChange.failed") {
                            HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(style.palette.danger)
                                    .accessibilityHidden(true)
                                KitText(failed, .meta, color: .danger)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityFocused($focus, equals: .failure)
                        }
                    }
                }
            } actions: {
                KitActionStack {
                    KitButton(line: screen.lineOrKey("ringChange.useCode"), kind: .primary) {
                        model.useRecoveryCode()
                    }
                    .keyboardShortcut(.defaultAction)
                    if let accept = screen.line("ringChange.accept") {
                        KitButton(line: accept, kind: .secondary, busy: model.busy) {
                            Task { await model.accept() }
                        }
                    }
                    KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) {
                        model.cancel()
                    }
                }
            }
            .kitAnimation(value: screen.stateName)
            // A failure is announced; a ring that moved again names a (possibly new) device, so the
            // heading is read again.
            .onChange(of: screen.stateName) { _, new in
                if new == RingChangeState.failed.rawValue { focus = .failure }
            }
            .onChange(of: model.inputs.ringChange?.served) { _, _ in focus = .heading }
        }
    }
}

// MARK: - CloudSyncStatus

/// The status row for `locked` and `ring-changed`. Its button always draws: Unlock sync opens
/// UnlockSync and Review opens RingChange, so the row is never a dead end.
public struct CloudSyncStatusView: View {
    let screen: KitScreen<CloudSyncStatusState>
    let onUnlock: () -> Void
    let onReview: () -> Void
    let onSignIn: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicType

    public init(
        screen: KitScreen<CloudSyncStatusState>, onUnlock: @escaping () -> Void,
        onReview: @escaping () -> Void, onSignIn: (() -> Void)? = nil
    ) {
        self.screen = screen
        self.onUnlock = onUnlock
        self.onReview = onReview
        self.onSignIn = onSignIn
    }

    @MainActor public init(model: CloudSyncStatusModel) {
        self.init(
            screen: model.screen, onUnlock: model.onUnlock, onReview: model.onReview,
            onSignIn: model.onSignIn)
    }

    public var body: some View {
        if let state = screen.state, let line = screen.copy.first {
            let action: (CopyLine, () -> Void)? = {
                if signedOut(line) {
                    return onSignIn.flatMap { run in screen.line("cloudSync.signIn").map { ($0, run) } }
                }
                switch state {
                case .locked: return screen.line("cloudSync.unlock").map { ($0, onUnlock) }
                case .ringChanged: return screen.line("common.review").map { ($0, onReview) }
                default: return screen.line("common.review").map { ($0, onReview) }
                }
            }()
            kitStyle { style in
                // One row at normal sizes; the button drops under the text at accessibility sizes.
                let layout =
                    dynamicType.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: style.space(.xs)))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: style.space(.sm)))
                layout {
                    text(style, state, line)
                    if !dynamicType.isAccessibilitySize { Spacer(minLength: style.space(.xs)) }
                    if let (label, run) = action {
                        KitButton(line: label, kind: .quiet, fullWidth: false, compact: true, action: run)
                            .frame(minHeight: 44)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// A failed sync with nobody signed in is not a fault (ui-core: neutral tone, Sign in to sync).
    private func signedOut(_ line: CopyLine) -> Bool { line.key == "cloudSync.signedOut" }

    private enum Tone { case neutral, warning, danger }

    /// The glyph and tone per state, as ui-core assigns them: locked, ring-changed and signed-out are
    /// neutral, an error is danger, a conflict is the one warning.
    private func glyph(_ state: CloudSyncStatusState, signedOut: Bool) -> (String, Tone) {
        switch state {
        case .locked: return ("lock.fill", .neutral)
        case .synced: return ("checkmark.circle", .neutral)
        case .syncing: return ("arrow.triangle.2.circlepath", .neutral)
        case .offline: return ("icloud.slash", .neutral)
        case .ringChanged: return ("exclamationmark.triangle", .neutral)
        case .conflict: return ("exclamationmark.triangle", .warning)
        case .error: return signedOut ? ("person.crop.circle", .neutral) : ("exclamationmark.circle", .danger)
        }
    }

    private func text(_ style: KitResolvedStyle, _ state: CloudSyncStatusState, _ line: CopyLine)
        -> some View
    {
        let (name, tone) = glyph(state, signedOut: signedOut(line))
        let color: Color
        switch tone {
        case .neutral: color = style.palette.textMuted
        case .warning: color = style.palette.warning
        case .danger: color = style.palette.danger
        }
        return HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
            Image(systemName: name)
                .foregroundStyle(color)
                .accessibilityHidden(true)
            KitText(line, .body)
        }
    }
}

/// The settings host's Cloud Sync section (Q-7): the status row, and the screen in front of it. The
/// row follows `client.cloudSync`; Unlock, Review and Start over switch screens, and "New recovery
/// code" is `model.requestNewRecoveryCode()`.
public struct CloudSyncKitView: View {
    @Bindable var host: CloudSyncKitHostModel

    public init(host: CloudSyncKitHostModel) { self.host = host }

    public var body: some View {
        Group {
            if let row = host.status { CloudSyncStatusView(model: row) }
        }
        .task {
            await host.start()
        }
        .onDisappear { host.stop() }
        .sheet(
            isPresented: Binding(
                get: { host.screen != nil }, set: { if !$0 { host.dismiss() } })
        ) {
            Group {
                switch host.screen {
                case .unlock: if let m = host.unlockModel { UnlockSyncView(model: m) }
                case .ringChange: if let m = host.ringModel { RingChangeView(model: m) }
                case .recoveryCode: if let m = host.recoveryModel { RecoveryCodeView(model: m) }
                case nil: EmptyView()
                }
            }
            .interactiveDismissDisabled(host.unlockModel?.minting == true || host.screen == .recoveryCode)
        }
    }
}

extension View {
    /// The kit's morph between states, none under Reduce Motion.
    fileprivate func kitAnimation<V: Equatable>(value: V) -> some View {
        modifier(KitMorph(value: value))
    }
}

private struct KitMorph<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : .smooth(duration: 0.26), value: value)
    }
}
