// @pkey-feature ui.settings
// The Cloud Sync screens (U-42.3, UI-KITS §4.1): UnlockSync, RecoveryCode, RingChange and the
// CloudSyncStatus row's `locked` and `ring-changed` states. Every line is a catalog key the state
// machines name (States/CloudSyncFamily.swift). The recovery code is never an input of RecoveryCode:
// it is drawn from the model, once, and leaves memory on Done. Both code screens say that no one
// will ever ask for it. VoiceOver lands on the heading when a screen appears; a refusal is
// announced; motion follows Reduce Motion (`style.morph`).

import PolarisKeyUICore
import SwiftUI

/// A screen's heading. VoiceOver focus lands here on entry.
private struct SyncHeading: View {
    let line: CopyLine
    @AccessibilityFocusState private var focused: Bool

    var body: some View {
        KitText(line, .title, color: .strong)
            .accessibilityAddTraits(.isHeader)
            .accessibilityFocused($focused)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { focused = true }
    }
}

// MARK: - UnlockSync

/// Unlock the synced data with the recovery code, or start over.
public struct UnlockSyncView: View {
    let model: UnlockSyncModel
    @Environment(\.polarisKeyStrings) private var strings
    @FocusState private var fieldFocused: Bool
    @AccessibilityFocusState private var refusalFocused: Bool

    public init(model: UnlockSyncModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if let state = screen.state {
            KitScreenScaffold(header: true) {
                SyncHeading(line: screen.copy.first ?? CopyLine("unlockSync.title"))
                    .id(state)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .kitAnimation(value: screen.stateName)
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
                        KitText(invalid, .meta, color: .danger)
                            .accessibilityFocused($refusalFocused)
                            .onAppear { refusalFocused = true }
                    }
                    if let noAsk = screen.line("recoveryCode.noAsk") {
                        KitText(noAsk, .meta, color: .muted)
                    }
                case .working:
                    if let working = screen.line("common.working") {
                        LoadingIndicator(working)
                    }
                case .failed:
                    if let failed = screen.line("unlockSync.failed") {
                        KitText(failed, .body, color: .danger)
                            .accessibilityFocused($refusalFocused)
                            .onAppear { refusalFocused = true }
                    }
                case .startOver:
                    if let warning = screen.line("unlockSync.startOverWarning") {
                        KitText(warning, .body)
                    }
                }
            }
        }
    }

    /// The recovery code field: a visible label, never logged, never autocorrected.
    @ViewBuilder private func field(_ style: KitResolvedStyle, invalid: Bool) -> some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText("unlockSync.field", [:], .meta, color: .muted)
                .accessibilityHidden(true)
            TextField("", text: $model.code, axis: .vertical)
                .font(style.font(.key))
                .lineLimit(1...3)
                .autocorrectionDisabled()
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                #endif
                .submitLabel(.go)
                .focused($fieldFocused)
                .onSubmit { Task { await model.unlock() } }
                .privacySensitive()
                .accessibilityLabel(strings.string("unlockSync.field"))
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
                            invalid ? style.palette.danger
                                : (fieldFocused ? style.palette.focus : .clear),
                            lineWidth: 2)
                )
        }
    }

    @ViewBuilder private func actions(_ screen: KitScreen<UnlockSyncState>, _ state: UnlockSyncState)
        -> some View
    {
        KitActionStack {
            switch state {
            case .code, .invalid:
                KitButton(line: screen.lineOrKey("unlockSync.unlock"), kind: .primary) {
                    Task { await model.unlock() }
                }
                .keyboardShortcut(.defaultAction)
                KitButton(line: screen.lineOrKey("unlockSync.startOver"), kind: .secondary) {
                    model.askStartOver()
                }
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            case .working:
                EmptyView()
            case .failed:
                KitButton(line: screen.lineOrKey("common.tryAgain"), kind: .primary) {
                    model.retry()
                }
                .keyboardShortcut(.defaultAction)
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            case .startOver:
                // Cancel is the safe way out; the destructive control is never the default.
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
                KitButton(line: screen.lineOrKey("unlockSync.startOverConfirm"), kind: .destructive) {
                    Task { await model.confirmStartOver() }
                }
            }
        }
    }
}

// MARK: - RecoveryCode

/// The new recovery code, shown once. Done waits for the person to confirm they saved it.
public struct RecoveryCodeView: View {
    let model: RecoveryCodeModel
    @State private var copied = false

    public init(model: RecoveryCodeModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if screen.state != nil {
            KitScreenScaffold(header: true) {
                SyncHeading(line: screen.lineOrKey("recoveryCode.title"))
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
            .onDisappear { copied = false }
        }
    }

    @ViewBuilder private func content(_ screen: KitScreen<RecoveryCodeState>) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                KitText(screen.lineOrKey("recoveryCode.lede"), .body)
                if let code = model.code {
                    Text(verbatim: code)
                        .font(style.codeFont(size: 22))
                        .foregroundStyle(style.palette.textStrong)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(style.space(.md))
                        .background(
                            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                                .fill(style.palette.sunken)
                        )
                        .privacySensitive()
                        // Read character by character, as a code is.
                        .accessibilityLabel(code.map(String.init).joined(separator: " "))
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
}

// MARK: - RingChange

/// Confirm a changed ring: it names the device, or says a device did. The recovery code is the
/// primary, safer way in; Accept shows only when a ring was served to accept.
public struct RingChangeView: View {
    let model: RingChangeModel

    public init(model: RingChangeModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if screen.state != nil {
            KitScreenScaffold(header: true) {
                SyncHeading(line: screen.lineOrKey("ringChange.title"))
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
                            KitText(screen.lineOrKey("ringChange.warning"), .meta)
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
        }
    }
}

// MARK: - CloudSyncStatus

/// The status row for `locked` and `ring-changed`. A button draws only when the host gave its
/// handler (the settings host, U-07, wires them); with none the row is the line alone.
public struct CloudSyncStatusView: View {
    let screen: KitScreen<CloudSyncStatusState>
    var onUnlock: (() -> Void)?
    var onReview: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicType

    public init(
        screen: KitScreen<CloudSyncStatusState>, onUnlock: (() -> Void)? = nil,
        onReview: (() -> Void)? = nil
    ) {
        self.screen = screen
        self.onUnlock = onUnlock
        self.onReview = onReview
    }

    public init(model: CloudSyncStatusModel) {
        self.init(screen: model.screen, onUnlock: model.onUnlock, onReview: model.onReview)
    }

    public var body: some View {
        if let state = screen.state, let line = screen.copy.first {
            let handler: (CopyLine, () -> Void)? = {
                switch state {
                case .locked:
                    if let onUnlock, let a = screen.line("cloudSync.unlock") { return (a, onUnlock) }
                case .ringChanged:
                    if let onReview, let a = screen.line("common.review") { return (a, onReview) }
                default: break
                }
                return nil
            }()
            kitStyle { style in
                // One row at normal sizes; the button drops under the text at accessibility sizes.
                let layout = dynamicType.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: style.space(.xs)))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: style.space(.sm)))
                layout {
                    text(style, state, line)
                    if !dynamicType.isAccessibilitySize { Spacer(minLength: style.space(.xs)) }
                    button(handler)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func text(_ style: KitResolvedStyle, _ state: CloudSyncStatusState, _ line: CopyLine)
        -> some View
    {
        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
            Image(systemName: state == .locked ? "lock.fill" : "exclamationmark.triangle")
                .foregroundStyle(
                    state == .locked ? style.palette.textMuted : style.palette.warning
                )
                .accessibilityHidden(true)
            KitText(line, .body)
        }
    }

    @ViewBuilder private func button(_ handler: (CopyLine, () -> Void)?) -> some View {
        if let (label, action) = handler {
            KitButton(line: label, kind: .quiet, fullWidth: false, compact: true, action: action)
                .frame(minHeight: 44)
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
