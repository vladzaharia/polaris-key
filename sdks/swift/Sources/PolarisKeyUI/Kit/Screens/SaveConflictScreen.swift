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
//   - in a short landscape window (under 480 pt tall, two panes of 280 pt) `choose` draws two
//     panes: the heading and cards, and the choices, the reason and Cancel (UX2 D-8); at an
//     accessibility size one column, versions before choices, with the header dropped when short;
//   - a refusal is posted as one announcement after focus moves to the heading; Escape on `kept` is Done;
//   - a deleted other copy has its own title and lede, and "Delete it here too" is a danger
//     outline of its own, never a Keep.
// Bound to a live client through `SaveConflictModel(request:)` (U-08.K3): a `MergeRequest` from
// `client.cloudSync.onConflict` or `conflicts()` supplies both copies and answers the choice with
// `request.keep`; the app does not hand back the save's bytes. The view itself only draws a model.

import PolarisKeyUICore
import SwiftUI

/// Where VoiceOver goes: always the heading, then the message that appears.
private enum SaveFocus: Hashable { case heading, message }

/// Where the short-window two panes begin (UX2 D-8): under 480 pt tall and wide enough for two
/// panes of at least 280 pt with the gutter between them.
enum SaveShortWindow {
    static let belowHeight: CGFloat = 480
    static let paneMinWidth: CGFloat = 280
    static let gutter: CGFloat = 32

    static func applies(_ size: CGSize) -> Bool {
        size.height > 0 && size.height < belowHeight && size.width >= 2 * paneMinWidth + gutter
    }
}

private struct SaveWindowKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// The frames of the parts a layout test reads, in the screen's own coordinate space.
struct SaveFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

public struct SaveConflictView: View {
    let model: SaveConflictModel
    /// A fixed window size in place of the measured one (the layout tests).
    var windowOverride: CGSize?
    /// Called with the frames of the cards and the choices when the two panes are drawn.
    var frameProbe: (([String: CGRect]) -> Void)?
    @Environment(\.polarisKeyStrings) private var strings
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.kitInSheet) private var inSheet
    @AccessibilityFocusState private var focus: SaveFocus?
    @State private var measured: CGSize = .zero

    public init(model: SaveConflictModel) { self.model = model }

    init(
        model: SaveConflictModel, window: CGSize?, frames: (([String: CGRect]) -> Void)? = nil
    ) {
        self.model = model
        self.windowOverride = window
        self.frameProbe = frames
    }

    public var body: some View {
        let screen = model.screen
        if let state = screen.state {
            let window = windowOverride ?? measured
            let short = window.height > 0 && window.height < SaveShortWindow.belowHeight
            let accessibility = dynamicType.isAccessibilitySize
            let twoPane = state == .choose && SaveShortWindow.applies(window) && !accessibility && !inSheet
            Group {
                if twoPane {
                    twoPaneBody(screen, state, window)
                } else {
                    // In a short window at an accessibility size the product header gives way
                    // (DL3) and the actions flow under the content: the title and the reason are
                    // read first, never hidden behind a docked bar.
                    KitScreenScaffold(
                        header: !(short && accessibility),
                        dockActions: state != .choose && !short
                    ) {
                        heading(screen, state)
                    } content: {
                        content(screen, state)
                    } actions: {
                        actions(screen, state)
                    }
                }
            }
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: SaveWindowKey.self, value: geo.size)
                }
                .allowsHitTesting(false).accessibilityHidden(true)
            )
            .onPreferenceChange(SaveWindowKey.self) { measured = $0 }
            .background(escapeIsDone(state))
            .onAppear { focus = .heading }
            .onChange(of: screen.stateName) { _, _ in
                // The heading is where focus rests; a refusal is also said, once, after the
                // heading so the title read does not cut it off.
                focus = state == .keeping ? .message : .heading
                if state == .failed {
                    let line =
                        screen.line("saveConflict.failedDeleted")
                        ?? screen.lineOrKey("saveConflict.failed")
                    let text = strings.string(line)
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 400_000_000)
                        var said = AttributedString(text)
                        said.accessibilitySpeechAnnouncementPriority = .high
                        AccessibilityNotification.Announcement(said).post()
                    }
                }
            }
            .interactiveDismissDisabled(state == .keeping)
        }
    }

    /// Escape on the result is Done (D-4): a hidden default-less key, never reached by VoiceOver.
    @ViewBuilder private func escapeIsDone(_ state: SaveConflictState) -> some View {
        if state == .kept {
            Button("") { model.done() }
                .keyboardShortcut(.cancelAction)
                .opacity(0).frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    private func heading(_ screen: KitScreen<SaveConflictState>, _ state: SaveConflictState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                if state == .kept {
                    // Glyph and the result title, never colour alone.
                    Image(systemName: "checkmark.circle.fill")
                        .font(style.font(.display))
                        .foregroundStyle(style.palette.success)
                        .accessibilityHidden(true)
                }
                KitText(
                    screen.copy.first ?? CopyLine("saveConflict.title"), .title, color: .strong
                )
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($focus, equals: .heading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// D-8, a short landscape window: the heading and the two cards in one pane, the choices, the
    /// slots-full reason and Cancel in the other; both start at the top, nothing is docked, and
    /// each pane scrolls on its own if it must. The decorative pane gives way (DL3).
    private func twoPaneBody(
        _ screen: KitScreen<SaveConflictState>, _ state: SaveConflictState, _ window: CGSize
    ) -> some View {
        kitStyle { style in
            ZStack {
                style.palette.page.ignoresSafeArea()
                if style.ambient && !style.isNative { KitAmbient().ignoresSafeArea() }
                HStack(alignment: .top, spacing: SaveShortWindow.gutter) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: style.space(.md)) {
                            ProductHeader()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            heading(screen, state)
                            content(screen, state)
                                .background(frameReader("cards"))
                        }
                        .padding(.top, style.space(.md))
                        .padding(.bottom, style.space(.md))
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    ScrollView {
                        actions(screen, state)
                            .background(frameReader("choices"))
                            .padding(.top, style.space(.md))
                            .padding(.bottom, style.space(.md))
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
                .padding(.horizontal, style.space(.lg))
            }
            .coordinateSpace(name: "pane")
            .onPreferenceChange(SaveFramesKey.self) { frameProbe?($0) }
        }
    }

    private func frameReader(_ name: String) -> some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: SaveFramesKey.self, value: [name: geo.frame(in: .named("pane"))])
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
                    if let note = screen.line("saveConflict.reopened") {
                        // A choice met a newer copy: nothing was applied, and these are the new versions.
                        HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                            Image(systemName: "info.circle").accessibilityHidden(true)
                            KitText(note, .body, color: .strong)
                        }
                        .accessibilityElement(children: .combine)
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
                    HStack(alignment: .center, spacing: style.space(.xs)) {
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
            if let newer { newerTag(style, newer) }
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

    /// A tag, not a control: the word on a neutral pill, no outline and no accent.
    private func newerTag(_ style: KitResolvedStyle, _ line: CopyLine) -> some View {
        KitText(line, .meta, color: .strong)
            .fontWeight(.semibold)
            .padding(.horizontal, style.space(.xs))
            .padding(.vertical, style.space(.xxs))
            .background(Capsule().fill(style.palette.page))
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
                // On the Mac the row reads right to left, so the retry takes the trailing slot.
                #if os(macOS)
                    chooseAgain(screen)
                    tryAgain(screen)
                #else
                    tryAgain(screen)
                    chooseAgain(screen)
                #endif
                KitButton(line: screen.lineOrKey("common.cancel"), kind: .quiet) { model.cancel() }
            }
        }
    }

    private func tryAgain(_ screen: KitScreen<SaveConflictState>) -> some View {
        KitButton(line: screen.lineOrKey("common.tryAgain"), kind: .secondary) {
            Task { await model.retry() }
        }
    }

    private func chooseAgain(_ screen: KitScreen<SaveConflictState>) -> some View {
        KitButton(line: screen.lineOrKey("saveConflict.chooseAgain"), kind: .secondary) {
            model.chooseAgain()
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
