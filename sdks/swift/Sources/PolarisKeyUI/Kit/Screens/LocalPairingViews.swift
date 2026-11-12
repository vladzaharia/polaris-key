// @pkey-feature connect.local
// Pair with a Code, the SwiftUI kit (CC-29K.2): LocalPairingView draws every `LocalPairingState` and
// PairedDevicesView the list. The reference is the React kit after its built UX review
// (packages/sdk-react/src/kit/localPairing.tsx) and ui-core's models/local.ts; the words are the
// catalog keys the state machine names (States/LocalFamily.swift). Rules kept:
//   - the code is the largest thing on the show screen (the kit's code face, 40 pt over the title),
//     read digit by digit, with the QR beside it from 600 pt of window and under it otherwise;
//   - no state confirms by default: focus rests on the heading, on confirm on Not now, and Pair is
//     filled but not the Mac's Return key, so a stray key never pairs;
//   - a control drawn but unavailable (Pair under 8 digits, Show a new code while it waits) stays
//     pressable and answers its reason, so VoiceOver never meets a dead button;
//   - the other device's name is unauthenticated text: isolated, never truncated in the consent title;
//   - answers are announced once: a new code, a notice, a refusal, the wait over.

import PolarisKeyUICore
import SwiftUI

private enum PairFocus: Hashable { case heading, notNow, code, name, tile }

/// The window the screen is drawn in, measured, for the show screen's panes.
private struct PairWindowKey: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

// MARK: - LocalPairing

public struct LocalPairingView: View {
    let model: LocalPairingModel
    /// The name each category goes by on screen, by id; an id without one is drawn as words.
    let categoryLabels: [String: String]
    @Environment(\.polarisKeyStrings) private var strings
    @Environment(\.scenePhase) private var scenePhase
    @AccessibilityFocusState private var focus: PairFocus?
    @State private var window = CGSize.zero
    @State private var last: KitScreen<LocalPairingState>?
    @State private var copied = false
    #if os(macOS)
        @FocusState private var fieldFocus: Bool
    #endif

    public init(model: LocalPairingModel, categoryLabels: [String: String] = [:]) {
        self.model = model
        self.categoryLabels = categoryLabels
    }

    public var body: some View {
        let live = model.screen
        let screen = live.state != nil ? live : (last ?? live)
        if let state = screen.state {
            KitScreenScaffold(
                header: state == .scan ? false : (state != .show || layout.logo),
                dockActions: false
            ) {
                heading(screen, state)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: PairWindowKey.self, value: geo.size)
                        .accessibilityHidden(true)
                }
            )
            .onPreferenceChange(PairWindowKey.self) { window = $0 }
            .onChange(of: live.stateName, initial: true) { _, _ in
                if live.state != nil { last = live }
            }
            .onAppear { focus = start(state) }
            .onChange(of: screen.stateName) { _, _ in
                focus = start(state)
                if let line = announcement(screen, state) { announce(strings.string(line)) }
            }
            .onChange(of: model.rotation) { _, _ in
                // A code that replaced the one being looked at: the notice and the new code are told in one go, apart from
                // the action that asked for it, and the tile takes focus. The first code of a window is told with its state.
                if let code = model.state.code, state == .show, model.replaced {
                    announce(newCodeAnnouncement(screen, code))
                    focus = .tile
                }
            }
            .onChange(of: model.state.nameError) { _, new in
                if new != nil, let line = screen.line("devices.renameFailed") { announce(strings.string(line)) }
            }
            .onChange(of: model.state.error) { _, new in
                if let new, let line = errorLine(new, screen) { announce(strings.string(line)) }
            }
            .onChange(of: model.state.notice) { _, new in
                if new == .blocked, let l = screen.line("localPairing.blockedTitle") {
                    announce(strings.string(l))
                }
            }
            .onChange(of: model.state.cooldownLeft) { old, new in
                // The wait is over: the person is told, and focus rests on the heading above the control that woke up.
                if state == .closed, old != 0, new == 0 {
                    focus = .heading
                    announce(strings.string("localPairing.showNew"))
                }
            }
            .modifier(ScanSignals(model: model, screen: screen, strings: strings))
            // Back from Settings with the camera allowed there: the camera starts.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.cameraChanged() } }
            }
            .interactiveDismissDisabled(state == .confirm || state == .joining)
            .background(escapeCloses(state))
            // A swipe-down must not leave a window open for the other person.
            .onDisappear { if !model.left { Task { await model.cancel() } } }
        }
    }

    private var layout: KitLocalPairingLayout {
        KitLocalPairingLayout.of(
            width: window.width == 0 ? 390 : window.width,
            height: window.height == 0 ? 844 : window.height)
    }

    /// Where VoiceOver starts: Not now on a consent (a stray double tap never pairs), else the heading.
    private func start(_ state: LocalPairingState) -> PairFocus {
        state == .confirm ? .notNow : .heading
    }

    @ViewBuilder private func escapeCloses(_ state: LocalPairingState) -> some View {
        if [
            .paired, .failed, .off, .networkBlocked, .closed, .enter, .confirm, .scanPrompt, .scan, .cameraOff,
        ].contains(state) {
            Button("") { Task { await close(state) } }
                .keyboardShortcut(.cancelAction)
                .focusable(false)
                .opacity(0).frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    private func close(_ state: LocalPairingState) async {
        switch state {
        case .paired: await model.done()
        case .enter, .scanPrompt, .scan, .cameraOff: await model.backToChoose()
        case .confirm: await model.notNow()
        default: await model.closeScreen()
        }
    }

    /// The notice's words, then the new code: "Wrong code entered. The code changed. New code 4 8 1 2 ...".
    private func newCodeAnnouncement(_ screen: KitScreen<LocalPairingState>, _ code: String) -> String {
        var parts: [String] = []
        for key in [
            "localPairing.rotatedTitle", "localPairing.notPairedWith", "localPairing.rotatedBody",
            "localPairing.tooManyAgainBody",
        ] {
            if let line = screen.line(key) { parts.append(strings.string(line)) }
        }
        parts.append(strings.string("a11y.newCode", ["code": .text(spelled(code))]))
        return parts.map { $0.hasSuffix(".") ? $0 : $0 + "." }.joined(separator: " ")
    }

    private func spelled(_ code: String) -> String { code.map(String.init).joined(separator: " ") }

    /// What a change of state says beyond the heading.
    private func announcement(_ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState)
        -> CopyLine?
    {
        switch state {
        case .show:
            guard let code = model.state.code else { return nil }
            return CopyLine("a11y.linkCode", ["code": .text(spelled(code))])
        case .opening: return screen.line("a11y.busy")
        case .paired: return screen.line("localPairing.pairedBody")
        case .failed, .off, .networkBlocked: return screen.copy.dropFirst().first
        default: return nil
        }
    }

    private func errorLine(_ e: KitLocalPairing.EntryError, _ screen: KitScreen<LocalPairingState>)
        -> CopyLine?
    {
        switch e {
        case .wrong: return screen.line("localPairing.wrongCode")
        case .spent: return screen.line("localPairing.spentCode")
        case .tooMany: return screen.line("localPairing.cooldownTitle")
        case .notFound: return screen.line("localPairing.notFoundTitle")
        case .notACode: return screen.line("localPairing.notACode")
        }
    }

    // MARK: Heading

    private func titleLine(_ screen: KitScreen<LocalPairingState>) -> CopyLine {
        screen.copy.first ?? CopyLine("localPairing.title")
    }

    private func heading(_ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                if state == .paired { ResultMark(kind: .success) }
                if [.failed, .off, .networkBlocked].contains(state)
                    || (state == .closed)
                {
                    ResultMark(kind: .danger)
                }
                KitText(titleLine(screen), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .heading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // The refusals say their reason as the lede, under the title.
                if state == .off || state == .networkBlocked,
                    let reason = screen.copy.dropFirst().first
                {
                    KitText(reason, .body)
                }
            }
        }
    }

    // MARK: Content

    @ViewBuilder private func content(
        _ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState
    ) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .choose: choose(screen, style)
                case .scanPrompt:
                    if let body = screen.line("localPairing.cameraPrePrompt") { KitText(body, .body) }
                case .scan: scan(screen, style)
                case .cameraOff: cameraOff(screen, style)
                case .opening, .show: show(screen, state, style)
                case .closed: closed(screen, style)
                case .enter, .joining: enter(screen, state, style)
                case .confirm: confirm(screen, style)
                case .waiting:
                    wait(screen.line("localPairing.waitingWith"), style)
                    shares(screen, style)
                case .paired: paired(screen, style)
                case .failed:
                    if let reason = screen.copy.dropFirst().first { KitText(reason, .body) }
                case .networkBlocked, .off: EmptyView()
                }
            }
        }
    }

    private func choose(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        let full = model.state.full == true
        return VStack(alignment: .leading, spacing: style.space(.md)) {
            if full, let t = screen.line("core.codes.local-links-full.title"),
                let m = screen.line("core.codes.local-links-full.message")
            {
                notice(t, body: m, style: style, link: screen.line("localPairing.pairedDevices")) {}
            } else if let body = screen.line("localPairing.chooseBody") {
                KitText(body, .body)
            }
            // Either device can show the code: neither way is the filled one. Scan a code leads
            // where the device can scan; typing is reached from the scan screens.
            if let scan = screen.line("localPairing.scan") {
                KitButton(line: scan, kind: .secondary) { Task { await model.scan() } }
                    .opacity(full ? 0.5 : 1)
            }
            KitButton(line: screen.lineOrKey("localPairing.show"), kind: .secondary) {
                Task { await model.show() }
            }
            .opacity(full ? 0.5 : 1)
            if let enter = screen.line("localPairing.enter") {
                KitButton(line: enter, kind: .secondary) { Task { await model.enter() } }
                    .opacity(full ? 0.5 : 1)
            }
            if let hint = screen.line("localPairing.prePrompt") { KitText(hint, .meta, color: .muted) }
        }
    }

    // MARK: Scan

    @ViewBuilder private func scan(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        let label = strings.string(screen.lineOrKey("a11y.cameraView"))
        let busy = screen.line("localPairing.cameraBusy").map { strings.string($0) }
        let h = window.height == 0 ? 844 : window.height
        let wide = window.width > h && h < 520
        if wide {
            // A landscape phone: the camera takes the whole height beside the words.
            HStack(alignment: .top, spacing: style.space(.lg)) {
                ScanViewfinder(source: model.scanSource, label: label, side: max(160, h - 150), message: busy)
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    scanWords(screen, style)
                }
            }
        } else {
            // Portrait: the camera is as tall as the room that is left, so the actions stay in view.
            if let body = screen.line("localPairing.scanBody") { KitText(body, .body) }
            ScanViewfinder(
                source: model.scanSource, label: label, side: min(360, max(200, h - 420)), message: busy
            )
            .frame(maxWidth: .infinity)
            scanNotice(screen, style)
            shares(screen, style)
        }
    }

    @ViewBuilder private func scanWords(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let body = screen.line("localPairing.scanBody") { KitText(body, .body) }
        scanNotice(screen, style)
        shares(screen, style)
    }

    /// Why the last read did not pair, in the danger treatment (a passing notice stays neutral).
    @ViewBuilder private func scanNotice(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let notice = model.state.scanNotice, let line = screen.line(KitStates.scanNoticeKey(notice)) {
            HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(style.palette.danger).accessibilityHidden(true)
                KitText(line, .body, color: .danger)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private func cameraOff(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        VStack(alignment: .leading, spacing: style.space(.xxs)) {
            KitText(screen.lineOrKey("localPairing.cameraOffTitle"), .label, color: .strong)
            if let body = screen.line("localPairing.cameraOffBody") { KitText(body, .body) }
        }
        shares(screen, style)
    }

    // MARK: Show

    @ViewBuilder private func show(
        _ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState, _ style: KitResolvedStyle
    ) -> some View {
        let opening = state == .opening
        let panes = layout.panes == 2
        if let body = screen.line("localPairing.showBody") { KitText(body, .body) }
        if panes {
            HStack(alignment: .top, spacing: style.space(.lg)) {
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    codeTile(screen, opening, style)
                    timeRow(screen, opening, style)
                    showNotice(screen, style)
                    waitingRow(screen, opening, style)
                }
                qr(screen, opening, size: layout.logo ? 184 : 160)
            }
        } else {
            codeTile(screen, opening, style)
            timeRow(screen, opening, style)
            if layout.noticeBeforeQr { showNotice(screen, style) }
            qr(screen, opening, size: 184).frame(maxWidth: .infinity)
            if !layout.noticeBeforeQr { showNotice(screen, style) }
            waitingRow(screen, opening, style)
        }
    }

    /// The code in the kit's code face, the changed digits lit; a placeholder while the window opens.
    private func codeTile(_ screen: KitScreen<LocalPairingState>, _ opening: Bool, _ style: KitResolvedStyle)
        -> some View
    {
        let code = model.state.code ?? ""
        return Group {
            if opening || code.isEmpty {
                RoundedRectangle(cornerRadius: 8).fill(style.palette.border.opacity(0.6))
                    .frame(width: 220, height: 36)
                    .accessibilityHidden(true)
            } else {
                Text(lit(code, style))
                    .font(style.codeFont(size: CodeDisplay.size))
                    .tracking(CodeDisplay.size * CodeDisplay.tracking)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .accessibilityLabel(
                        strings.string(
                            "a11y.linkCode", ["code": .text(spelled(code))])
                    )
                    .accessibilityFocused($focus, equals: .tile)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 64)
        .padding(.horizontal, style.space(.md))
        .padding(.vertical, style.space(.sm))
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .strokeBorder(style.palette.border, lineWidth: 1)
        )
    }

    /// The digits that just changed, lit for a moment (the first two never change).
    private func lit(_ code: String, _ style: KitResolvedStyle) -> AttributedString {
        var out = AttributedString(code)
        out.foregroundColor = style.palette.textStrong
        let chars = Array(code)
        for index in model.changed where index < chars.count {
            let start = out.index(out.startIndex, offsetByCharacters: index)
            let end = out.index(start, offsetByCharacters: 1)
            out[start..<end].backgroundColor = style.palette.accentSubtle
        }
        return out
    }

    private func timeRow(_ screen: KitScreen<LocalPairingState>, _ opening: Bool, _ style: KitResolvedStyle)
        -> some View
    {
        let left = model.state.secondsLeft ?? 0
        return HStack(spacing: style.space(.xs)) {
            ZStack {
                Circle().stroke(style.palette.border, lineWidth: 2)
                Circle().trim(from: 0, to: opening ? 1 : min(1, Double(left) / 300))
                    .stroke(style.palette.accentSolid, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)
            // The ring says the time; VoiceOver reads it once a minute at most, never each second.
            if !opening, let line = screen.line("localPairing.expires") {
                KitText(line, .meta, color: .muted)
                    .monospacedDigit()
                    .accessibilityLabel(
                        Text(
                            strings.string(
                                "localPairing.expires",
                                ["time": .text(kitCountdown((left / 60) * 60))]))
                    )
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .frame(maxWidth: .infinity)
        .opacity(opening ? 0 : 1)
    }

    private func qr(_ screen: KitScreen<LocalPairingState>, _ opening: Bool, size: CGFloat) -> some View {
        Group {
            if opening || model.qr == nil {
                RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.0001))
                    .frame(width: size, height: size).accessibilityHidden(true)
            } else if let text = model.qr {
                PolarisQRCode(text, accessibilityLabel: strings.string("a11y.qrPairing"))
                    .frame(width: size, height: size)
            }
        }
    }

    @ViewBuilder private func showNotice(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let n = model.state.notice {
            let renewing = model.state.busy == .newCode
            let action = screen.line("localPairing.showNew")
            switch n {
            case .rotated:
                notice(
                    screen.lineOrKey("localPairing.rotatedTitle"),
                    body: screen.line("localPairing.rotatedBody"), style: style, link: action,
                    busy: renewing
                ) { Task { await model.showNew() } }
            case .declined:
                let who = screen.line("localPairing.notPairedWith")
                notice(
                    who ?? screen.lineOrKey("localPairing.rotatedBody"),
                    body: who == nil ? nil : screen.line("localPairing.rotatedBody"), style: style,
                    link: action, busy: renewing
                ) { Task { await model.showNew() } }
            case .guessing:
                notice(
                    screen.lineOrKey("localPairing.rotatedTitle"),
                    body: screen.line("localPairing.tooManyAgainBody"), style: style, link: action,
                    busy: renewing
                ) { Task { await model.showNew() } }
            case .blocked:
                notice(
                    screen.lineOrKey("localPairing.blockedTitle"),
                    body: screen.line("localPairing.blockedBody"), style: style, link: nil
                ) {}
            }
        }
    }

    private func waitingRow(_ screen: KitScreen<LocalPairingState>, _ opening: Bool, _ style: KitResolvedStyle)
        -> some View
    {
        wait(opening ? screen.line("a11y.busy") : screen.line("localPairing.waitingDevice"), style)
    }

    private func wait(_ line: CopyLine?, _ style: KitResolvedStyle) -> some View {
        Group {
            if let line {
                HStack(spacing: style.space(.sm)) {
                    ProgressView().controlSize(.small).accessibilityHidden(true)
                    KitText(line, .body, color: .muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    // MARK: Closed

    @ViewBuilder private func closed(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let why = screen.copy.dropFirst().first { KitText(why, .body) }
        if model.state.warn == true, let t = screen.line("localPairing.tooManyAgainTitle") {
            notice(t, body: screen.line("localPairing.tooManyAgainBody"), style: style, link: nil) {}
        }
    }

    // MARK: Enter

    @ViewBuilder private func enter(
        _ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState, _ style: KitResolvedStyle
    ) -> some View {
        let busy = state == .joining
        let e = model.state.error
        if let body = screen.line("localPairing.enterBody") { KitText(body, .body) }
        if e == .tooMany || e == .notFound {
            notice(
                screen.lineOrKey(e == .tooMany ? "localPairing.cooldownTitle" : "localPairing.notFoundTitle"),
                body: screen.line(e == .tooMany ? "localPairing.cooldownBody" : "localPairing.notFoundBody"),
                style: style, link: nil
            ) {}
        }
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText(screen.lineOrKey("localPairing.codeLabel"), .meta, color: .muted)
                .accessibilityHidden(true)
            codeField(screen, busy: busy, style)
            if let message = fieldMessage(screen) {
                HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger).accessibilityHidden(true)
                    KitText(message, .meta, color: .danger)
                }
                .accessibilityElement(children: .combine)
            }
            if !busy, model.state.triesLeft == 1, let l = screen.line("localPairing.triesLeft") {
                KitText(l, .meta, color: .muted)
            }
        }
        if busy {
            wait(screen.line("a11y.busy"), style)
        }
        shares(screen, style)
    }

    private func fieldMessage(_ screen: KitScreen<LocalPairingState>) -> CopyLine? {
        guard model.state.step == .enter, let e = model.state.error else {
            return model.state.step == .enter && model.state.triesLeft == 0 && (model.state.entry ?? "").count >= 2
                ? screen.line("localPairing.spentCode") : nil
        }
        switch e {
        case .wrong, .spent, .notACode: return errorLine(e, screen)
        default: return nil
        }
    }

    private func codeField(_ screen: KitScreen<LocalPairingState>, busy: Bool, _ style: KitResolvedStyle)
        -> some View
    {
        let invalid = model.state.error == .wrong || model.state.error == .notACode
        let binding = Binding(
            get: { model.state.entry ?? "" }, set: { model.setEntry($0) })
        let placeholder = screen.line("localPairing.codePlaceholder").map { strings.string($0) } ?? ""
        // The placeholder is a non-value at 40 %, so it never reads as masked digits.
        let prompt = Text(placeholder).foregroundStyle(style.palette.textMuted.opacity(0.4))
        return Group {
            #if os(macOS)
                TextField("", text: binding, prompt: prompt)
                    .focused($fieldFocus)
            #else
                TextField("", text: binding, prompt: prompt)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
            #endif
        }
        .textFieldStyle(.plain)
        .font(style.codeFont(size: 28))
        .monospacedDigit()
        .disabled(busy)
        .submitLabel(.go)
        .onSubmit { Task { await model.pair() } }
        .padding(.horizontal, style.space(.md))
        .frame(minHeight: 52)
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.sunken)
        )
        .overlay(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .strokeBorder(invalid ? style.palette.danger : .clear, lineWidth: 2)
        )
        .opacity(busy ? 0.6 : 1)
        .accessibilityLabel(strings.string(screen.lineOrKey("localPairing.codeLabel")))
        .accessibilityValue(
            Text(
                (model.state.entry ?? "").filter(\.isNumber).map(String.init).joined(separator: " "))
        )
        .accessibilityFocused($focus, equals: .code)
        #if os(macOS)
            .onAppear { fieldFocus = true }
        #endif
    }

    // MARK: Confirm and paired

    private func confirm(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle) -> some View {
        VStack(alignment: .leading, spacing: style.space(.md)) {
            if let body = screen.line("localPairing.confirmBody") { KitText(body, .body) }
            shares(screen, style)
        }
    }

    @ViewBuilder private func paired(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let body = screen.line("localPairing.pairedBody") { KitText(body, .body) }
        if model.state.cantConnect == true, let t = screen.line("localPairing.cantConnectTitle") {
            notice(
                t, body: screen.line("localPairing.cantConnectBody"), style: style,
                link: screen.line("localPairing.pairedDevices")
            ) { Task { await model.done() } }
        }
        VStack(alignment: .leading, spacing: style.space(.xs)) {
            KitText(screen.lineOrKey("localPairing.nameLabel"), .meta, color: .muted)
                .accessibilityHidden(true)
            TextField("", text: Binding(get: { model.name }, set: { model.setName($0) }))
                .textFieldStyle(.plain)
                .font(style.font(.body))
                .onSubmit { Task { await model.done() } }
                .padding(.horizontal, style.space(.md))
                .frame(minHeight: max(style.controlHeight, 44))
                .background(
                    RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                        .fill(style.palette.sunken)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                        .strokeBorder(model.state.nameError != nil ? style.palette.danger : .clear, lineWidth: 2)
                )
                .accessibilityLabel(strings.string(screen.lineOrKey("localPairing.nameLabel")))
                .accessibilityFocused($focus, equals: .name)
            if let failed = screen.line("devices.renameFailed") {
                HStack(alignment: .firstTextBaseline, spacing: style.space(.xs)) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger).accessibilityHidden(true)
                    KitText(failed, .meta, color: .danger)
                }
            } else if let hint = screen.line("localPairing.nameHint") {
                KitText(hint, .meta, color: .muted)
            }
        }
    }

    // MARK: Shared pieces

    /// What each of you shares: the categories before the choice, or that nothing is shared yet.
    @ViewBuilder private func shares(_ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle)
        -> some View
    {
        if let head = screen.line("linkPairing.shares") {
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                KitText(head, .label, color: .default).accessibilityAddTraits(.isHeader)
                KitWrap(spacing: style.space(.xs)) {
                    ForEach(model.state.categories ?? [], id: \.self) { id in
                        Text(categoryLabels[id] ?? kitCategoryFallback(id))
                            .font(style.font(.body))
                            .foregroundStyle(style.palette.textStrong)
                            .padding(.horizontal, style.space(.sm))
                            .padding(.vertical, style.space(.xxs))
                            .frame(minHeight: 32)
                            .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
                    }
                }
            }
            .accessibilityElement(children: .combine)
        } else if let none = screen.line("linkPairing.sharesNone") {
            KitText(none, .body)
        }
    }

    /// A notice: its title in the neutral tone with the kit's info mark, the words under it and the
    /// action as a quiet link on its own line, underlined at rest so it reads as a link.
    private func notice(
        _ title: CopyLine, body: CopyLine?, style: KitResolvedStyle, link: CopyLine?,
        busy: Bool = false, action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: style.space(.sm)) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(style.palette.textMuted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: style.space(.xxs)) {
                KitText(title, .label, color: .strong)
                if let body { KitText(body, .body) }
                if let link {
                    Button(action: { if !busy { action() } }) {
                        HStack(spacing: style.space(.xs)) {
                            Text(strings.string(link)).underline()
                            if busy { ProgressView().controlSize(.small) }
                        }
                        .font(style.font(.body).weight(.medium))
                        .foregroundStyle(style.palette.accentFg)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(busy ? .updatesFrequently : [])
                }
            }
            Spacer(minLength: 0)
        }
        .padding(style.space(.md))
        .background(
            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                .fill(style.palette.raised)
        )
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.updatesFrequently)
    }

    // MARK: Actions

    @ViewBuilder private func actions(
        _ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState
    ) -> some View {
        let disabled = Set(screen.disabledKeys)
        KitActionStack {
            switch state {
            case .choose:
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) {
                    Task { await model.closeScreen() }
                }
            case .opening, .show:
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.cancel() } }
                link(screen.lineOrKey("localPairing.toEnter")) { Task { await model.toEnter() } }
            case .closed:
                let cooling = disabled.contains("localPairing.showNewIn")
                KitButton(
                    line: screen.lineOrKey(cooling ? "localPairing.showNewIn" : "localPairing.showNew"),
                    // Unavailable, it is the outlined secondary at full contrast, never a faded primary.
                    kind: cooling ? .secondary : .primary
                ) { Task { await model.showNew() } }
                KitButton(line: CopyLine("common.close"), kind: .quiet) { Task { await model.closeScreen() } }
            case .enter, .joining:
                let joining = state == .joining
                let unavailable = disabled.contains("localPairing.pair") && !joining
                KitButton(
                    line: screen.lineOrKey("localPairing.pair"), kind: unavailable ? .secondary : .primary,
                    busy: joining
                ) { Task { await model.pair() } }
                // Dimmed, still pressable: its reason is what VoiceOver says about it.
                .accessibilityHint(
                    disabled.contains("localPairing.pair") && !joining
                        ? Text(fieldMessage(screen).map { strings.string($0) } ?? "") : Text(""))
                if joining {
                    KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.cancel() } }
                } else {
                    if let instead = screen.line("localPairing.scanInstead") {
                        link(instead) { Task { await model.scanInstead() } }
                    } else {
                        link(screen.lineOrKey("localPairing.toShow")) { Task { await model.toShow() } }
                    }
                    KitButton(line: CopyLine("common.back"), kind: .quiet) {
                        Task { await model.backToChoose() }
                    }
                }
            case .scanPrompt:
                KitButton(line: screen.lineOrKey("common.continue"), kind: .primary) {
                    Task { await model.continueToCamera() }
                }
                link(screen.lineOrKey("localPairing.enterInstead")) { Task { await model.enterInstead() } }
            case .scan:
                link(screen.lineOrKey("localPairing.enterInstead")) { Task { await model.enterInstead() } }
                KitButton(line: CopyLine("common.back"), kind: .quiet) { Task { await model.backToChoose() } }
            case .cameraOff:
                if screen.line("localPairing.openSettings") != nil {
                    KitButton(line: CopyLine("localPairing.openSettings"), kind: .primary) {
                        KitSettingsOpener.open()
                    }
                }
                link(screen.lineOrKey("localPairing.enterInstead")) { Task { await model.enterInstead() } }
                KitButton(line: CopyLine("common.back"), kind: .quiet) { Task { await model.backToChoose() } }
            case .confirm:
                let busy = model.state.busy
                KitButton(
                    line: screen.lineOrKey("localPairing.pair"), kind: .primary,
                    busy: busy == .pair, returnKey: false
                ) { Task { await model.confirm() } }
                .opacity(busy == .notNow ? 0.5 : 1)
                KitButton(line: CopyLine("common.notNow"), kind: .quiet, busy: busy == .notNow) {
                    Task { await model.notNow() }
                }
                .opacity(busy == .pair ? 0.5 : 1)
                .accessibilityFocused($focus, equals: .notNow)
            case .waiting:
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.cancel() } }
            case .paired:
                KitButton(line: CopyLine("common.done"), kind: .primary) { Task { await model.done() } }
            case .failed:
                let full = model.state.reason == .full
                if full {
                    KitButton(line: CopyLine("common.close"), kind: .primary) {
                        Task { await model.closeScreen() }
                    }
                }
                KitButton(line: CopyLine("common.tryAgain"), kind: full ? .secondary : .primary) {
                    Task { await model.retry() }
                }
                if !full {
                    KitButton(line: CopyLine("common.close"), kind: .quiet) { Task { await model.closeScreen() } }
                }
            case .networkBlocked:
                let settings = model.state.canOpenSettings == true
                if settings {
                    KitButton(line: CopyLine("localPairing.openSettings"), kind: .primary) {
                        KitSettingsOpener.open()
                    }
                }
                KitButton(line: CopyLine("common.tryAgain"), kind: settings ? .secondary : .primary) {
                    Task { await model.retry() }
                }
                KitButton(line: CopyLine("common.close"), kind: .quiet) { Task { await model.closeScreen() } }
            case .off:
                KitButton(line: CopyLine("common.close"), kind: .secondary) { Task { await model.closeScreen() } }
            }
        }
    }

    /// A text link under the actions: 44 pt tall, underlined, in the accent.
    private func link(_ line: CopyLine, _ action: @escaping () -> Void) -> some View {
        kitStyle { style in
            Button(action: action) {
                Text(strings.string(line)).underline()
                    .font(style.font(.body).weight(.medium))
                    .foregroundStyle(style.palette.accentFg)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// What the scan steps tell without being asked: a refusal of what was read (announced, with a
/// warning tap), a read (a light tap as the screen says it is waiting), a pairing (the success tap),
/// and the camera being taken away. They sit on the root view, which outlives each update.
private struct ScanSignals: ViewModifier {
    let model: LocalPairingModel
    let screen: KitScreen<LocalPairingState>
    let strings: KitStrings

    func body(content: Content) -> some View {
        content
            .onChange(of: model.state.scanNotice) { _, new in
                if let new, new != .notReady, new != .preparing,
                    let line = screen.line(KitStates.scanNoticeKey(new))
                {
                    announce(strings.string(line))
                }
            }
            .sensoryFeedback(trigger: model.state.scanNotice) { _, new in
                switch new {
                case .otherApp?, .notFound?, .stale?: .warning
                default: nil
                }
            }
            .sensoryFeedback(trigger: model.state.step) { old, new in
                if new == .paired { return .success }
                return old == .scan && new == .waiting ? .impact(weight: .light) : nil
            }
            .onChange(of: model.scanSource?.interrupted ?? false, initial: true) { _, busy in
                model.setCameraBusy(busy)
            }
    }
}

/// Opens the app's page in Settings (iOS) or System Settings' privacy pane (macOS).
enum KitSettingsOpener {
    @MainActor static func open() {
        #if os(iOS) || os(visionOS)
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #elseif os(macOS)
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork") {
                NSWorkspace.shared.open(url)
            }
        #endif
    }
}
