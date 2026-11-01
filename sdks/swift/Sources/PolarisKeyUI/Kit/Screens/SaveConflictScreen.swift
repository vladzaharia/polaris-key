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
//   - Newer (UX2 D-7) tags the card the app names, between the name and the date; it never fills,
//     focuses or reorders anything, and never shows on the deleted variant;
//   - `kept` draws the success mark above the result title (the heading, where focus rests);
//   - `failed` offers Try again, Choose again and Cancel, none filled and none the default key;
//   - on a short or wide window the scaffold's trailing pane holds the heading, the cards and the
//     undocked choices (UX2 D-8), and at 200 % text one column, versions before choices;
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
                kitStyle { style in
                    VStack(alignment: .leading, spacing: style.space(.sm)) {
                        if state == .kept {
                            // Glyph and the result title, never colour alone.
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 36))
                                .foregroundStyle(style.palette.success)
                                .accessibilityHidden(true)
                        }
                        KitText(
                            screen.copy.first ?? CopyLine("saveConflict.title"), .title,
                            color: .strong
                        )
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($focus, equals: .heading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .onAppear { focus = .heading }
            .onChange(of: screen.stateName) { _, _ in
                // A refusal and the result are announced; the heading is where focus rests.
                focus = state == .keeping ? .message : .heading
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
                        when: screen.line("saveConflict.savedThis"),
                        newer: screen.line("saveConflict.newerThis"))
                    card(
                        style,
                        who: screen.line("saveConflict.otherDevice")
                            ?? screen.line("saveConflict.deletedElsewhere")
                            ?? screen.lineOrKey("saveConflict.otherUnknown"),
                        when: screen.line("saveConflict.savedOther"),
                        newer: screen.line("saveConflict.newerOther"))
                case .keeping:
                    HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                        ProgressView().controlSize(.small).accessibilityHidden(true)
                        KitText(screen.lineOrKey("saveConflict.keeping"), .body)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityFocused($focus, equals: .message)
                case .kept:
                    // The title above is the result; Keep both adds what happened to the other copy.
                    if let note = screen.line("saveConflict.keptCopy") {
                        KitText(note, .body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .failed:
                    // Glyph and words, never colour alone; announced when it appears.
                    HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(style.palette.danger)
                            .accessibilityHidden(true)
                        KitText(
                            screen.line("saveConflict.failedDeleted")
                                ?? screen.lineOrKey("saveConflict.failed"), .meta, color: .danger)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    /// One copy: who has it, and when it was saved. Stacked in reading order at every size.
    private func card(_ style: KitResolvedStyle, who: CopyLine, when: CopyLine?, newer: CopyLine?)
        -> some View
    {
        VStack(alignment: .leading, spacing: style.space(.xxs)) {
            KitText(who, .body, color: .strong)
            if let newer {
                // A tag, not a control: an outline and the word, in the accent's text colour.
                KitText(newer, .meta, color: .accent)
                    .fontWeight(.semibold)
                    .padding(.horizontal, style.space(.xs))
                    .padding(.vertical, 2)
                    .overlay(Capsule().strokeBorder(style.palette.accentFg, lineWidth: 1))
            }
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
            // Three controls, none filled: a stray Return must not repeat a choice that may
            // overwrite or delete, and none is the default.
            KitActionStack {
                KitButton(line: screen.lineOrKey("common.tryAgain"), kind: .secondary) {
                    Task { await model.retry() }
                }
                KitButton(line: screen.lineOrKey("saveConflict.chooseAgain"), kind: .secondary) {
                    model.chooseAgain()
                }
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            }
        }
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
