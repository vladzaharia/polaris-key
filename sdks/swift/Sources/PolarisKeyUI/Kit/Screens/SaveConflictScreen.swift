// @pkey-feature ui.settings
// The SaveConflict screen (U-22 K.3, UI-KITS §4.1): the same save changed on two devices, and the
// person picks the copy to keep. Every line is a catalog key the state machine names
// (States/CloudSyncFamily.swift, `KitStates.saveConflict`); the reference is packages/ui-core/src/
// models/saveConflict.ts, and the React kit after its built UX review (wp/U-22.KF). Outcomes kept:
//   - `choose` has no default: no filled control, no default key, and VoiceOver and keyboard focus
//     rest on the heading. The choices, the slots-full reason and Cancel are ONE undocked column
//     in reading order (this device's version first, the other second, Keep both third): they
//     never dock over the cards at an accessibility size or in a short window, and never swap
//     sides between sizes;
//   - the progress of a choice is a busy line under the title, with no control;
//   - `failed` takes focus on the heading, not on Try again: Try again repeats a choice that may
//     overwrite or delete, so a stray Return must not run it (on macOS it is not the default key);
//   - a deleted other copy has its own title and lede, and "Delete it here too" is a danger
//     outline of its own, never a Keep.
// Not bound to a live client: `SaveConflictModel` takes a `SaveConflictHost`, and the binding to the
// saves client is the K.3T tail.

import PolarisKeyUICore
import SwiftUI

/// Where VoiceOver goes: always the heading, then the message that appears.
private enum SaveFocus: Hashable { case heading, message }

public struct SaveConflictView: View {
    let model: SaveConflictModel
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var focus: SaveFocus?

    public init(model: SaveConflictModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        if let state = screen.state {
            KitScreenScaffold(header: true, dockActions: state != .choose) {
                KitText(screen.copy.first ?? CopyLine("saveConflict.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .heading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .onAppear { focus = .heading }
            .onChange(of: screen.stateName) { _, _ in
                // A refusal and the result are announced; the heading is where focus rests.
                focus = state == .choose ? .heading : .message
            }
            .interactiveDismissDisabled(state == .keeping)
        }
    }

    // MARK: Content

    @ViewBuilder private func content(_ screen: KitScreen<SaveConflictState>, _ state: SaveConflictState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .choose:
                    if let lede = screen.line("saveConflict.lede") ?? screen.line("saveConflict.deletedLede") {
                        KitText(lede, .body)
                    }
                    card(
                        style, who: screen.lineOrKey("saveConflict.thisDevice"),
                        when: screen.line("saveConflict.savedThis"))
                    card(
                        style,
                        who: screen.line("saveConflict.otherDevice")
                            ?? screen.line("saveConflict.deletedElsewhere")
                            ?? screen.lineOrKey("saveConflict.otherUnknown"),
                        when: screen.line("saveConflict.savedOther"))
                case .keeping:
                    HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                        ProgressView().controlSize(.small).accessibilityHidden(true)
                        KitText(screen.lineOrKey("saveConflict.keeping"), .body)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityFocused($focus, equals: .message)
                case .kept:
                    if let kept = screen.copy.first(where: { $0.key.hasPrefix("saveConflict.kept") }) {
                        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(style.palette.success)
                                .accessibilityHidden(true)
                            KitText(kept, .body)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityFocused($focus, equals: .message)
                    }
                case .failed:
                    // Glyph and words, never colour alone; announced when it appears.
                    HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(style.palette.danger)
                            .accessibilityHidden(true)
                        KitText(screen.lineOrKey("saveConflict.failed"), .meta, color: .danger)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityFocused($focus, equals: .message)
                }
            }
        }
    }

    /// One copy: who has it, and when it was saved. Stacked in reading order at every size.
    private func card(_ style: KitResolvedStyle, who: CopyLine, when: CopyLine?) -> some View {
        VStack(alignment: .leading, spacing: style.space(.xxs)) {
            KitText(who, .body, color: .strong)
            if let when { KitText(when, .meta, color: .muted) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(style.space(.md))
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.sunken)
        )
        .accessibilityElement(children: .combine)
    }

    // MARK: Actions

    @ViewBuilder private func actions(_ screen: KitScreen<SaveConflictState>, _ state: SaveConflictState)
        -> some View
    {
        switch state {
        case .choose: choices(screen)
        case .keeping: EmptyView()
        case .kept:
            KitActionStack {
                KitButton(line: screen.lineOrKey("common.done"), kind: .primary) { model.done() }
                    .keyboardShortcut(.defaultAction)
            }
        case .failed:
            KitActionStack {
                KitButton(line: screen.lineOrKey("common.tryAgain"), kind: retryKind) {
                    Task { await model.retry() }
                }
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            }
        }
    }

    /// On macOS Return runs the default button whatever has focus; Try again repeats a choice that
    /// may overwrite or delete, so there it is not the default.
    private var retryKind: KitButtonKind {
        #if os(macOS)
            return .secondary
        #else
            return .primary
        #endif
    }

    /// The choices, the reason Keep both is off, and Cancel: one column, no filled control.
    private func choices(_ screen: KitScreen<SaveConflictState>) -> some View {
        kitStyle { style in
            VStack(spacing: style.space(.sm)) {
                KitButton(line: screen.lineOrKey("saveConflict.keepThis"), kind: .secondary) {
                    Task { await model.keep(.local) }
                }
                if model.isDeletion {
                    KitButton(
                        line: screen.lineOrKey("saveConflict.acceptDelete"), kind: .secondary,
                        danger: true
                    ) {
                        Task { await model.keep(.remote) }
                    }
                    .overlay(Capsule().strokeBorder(style.palette.danger, lineWidth: 1.5))
                } else {
                    KitButton(line: screen.lineOrKey("saveConflict.keepOther"), kind: .secondary) {
                        Task { await model.keep(.remote) }
                    }
                    KitButton(line: screen.lineOrKey("saveConflict.keepBoth"), kind: .secondary) {
                        Task { await model.keep(.both) }
                    }
                    .disabled(!model.canKeepBoth)
                    .accessibilityHint(
                        model.canKeepBoth
                            ? Text("") : Text(strings.string("saveConflict.bothFull")))
                    if let reason = screen.line("saveConflict.bothFull") {
                        // Under Keep both, where the person looks for it.
                        KitText(reason, .meta, color: .muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityHidden(true)
                    }
                }
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
        }
    }
}
