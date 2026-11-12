// @pkey-feature connect.local
// Pair with a Code, the SwiftUI kit (CC-29K.2): LocalPairingView draws every `LocalPairingState` and
// PairedDevicesView the list. The reference is the React kit after its built UX review
// (packages/sdk-react/src/kit/localPairing.tsx) and ui-core's models/local.ts; the words are the
// catalog keys the state machine names (States/LocalFamily.swift). Rules kept:
//   - the show step is one window with two views: the code view (the digits, the kit's code face,
//     40 pt over the title) and the QR view (the QR alone), each with one link to the other;
//     switching never renews the code, and a new window opens on the view last chosen;
//   - the QR view is the plain QR behind `qrCard` (one place to swap the Light Card in), in two
//     columns in a wide, short window (UI-KITS 4.9);
//   - no state confirms by default: focus rests on the heading, on confirm on Not now, and Pair is
//     filled but not the Mac's Return key, so a stray key never pairs;
//   - a control drawn but unavailable (Pair under 8 digits, Show a new code while it waits) stays
//     pressable and answers its reason, so VoiceOver never meets a dead button;
//   - the other device's name is unauthenticated text: isolated, never truncated in the consent title;
//   - answers are announced once: a new code, a notice, a refusal, the wait over.

import PolarisKeyUICore
import SwiftUI

private enum PairFocus: Hashable { case heading, notNow, code, name, tile, card }

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
    @Environment(\.dynamicTypeSize) private var dynamicType
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
                header: state == .scan ? false : (!isShow(state) || layout.logo),
                dockActions: false, fullWidth: inColumns(state)
            ) {
                heading(screen, state)
            } content: {
                content(screen, state)
            } actions: {
                // In two columns the actions sit under the words, inside the column.
                if !inColumns(state) { actions(screen, state) }
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
            .onChange(of: screen.stateName) { old, _ in
                focus = start(state)
                if let line = announcement(screen, state, from: old) { announce(strings.string(line)) }
            }
            .onChange(of: model.state.expired) { _, gone in
                // The title says "Code expired"; a screen reader also hears the sentence, once.
                if gone == true { announce(strings.string("localPairing.failedExpired")) }
            }
            .onChange(of: model.rotation) { _, _ in
                // A code that replaced the one being looked at: the notice and the new code are told in one go, apart from
                // the action that asked for it, and the tile takes focus. The first code of a window is told with its state.
                if let code = model.state.code, isShow(state), model.replaced {
                    if model.renewedFromExpired {
                        // Show a new code from a dead window: "The code changed.", and focus goes to the stage.
                        let said = strings.string("localPairing.rotatedBody")
                        let digits = strings.string("a11y.newCode", ["code": .text(spelled(code))])
                        announce(state == .show ? said + " " + digits : said)
                        focus = state == .show ? .tile : .card
                    } else {
                        announce(newCodeAnnouncement(screen, state == .show ? code : nil))
                        focus = state == .show ? .tile : .heading
                    }
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

    private func isShow(_ state: LocalPairingState) -> Bool { state == .show || state == .showQr }

    /// The QR view in two columns, or the scan view on a landscape phone: the words and the actions
    /// at the start, the card or the camera at the end, with no 480 pt cap on the column.
    private func inColumns(_ state: LocalPairingState) -> Bool {
        (state == .showQr && qrTwoColumns) || (state == .scan && scanWide)
    }

    private var qrTwoColumns: Bool {
        #if os(iOS)
            // The scaffold's split arrangement (an iPad in landscape) gives the content a 480 pt pane: one column there,
            // and at accessibility text sizes (the root text size is what the 720 pt is measured at).
            kitQrTwoColumns(
                width: window.width == 0 ? 390 : window.width, height: windowHeight,
                textScale: dynamicType.isAccessibilitySize ? 2 : 1)
                && KitArrangement.of(CGSize(width: window.width, height: windowHeight)) != .split
        #else
            false
        #endif
    }

    private var windowHeight: CGFloat { window.height == 0 ? 844 : window.height }

    /// A landscape phone: the camera takes the height, beside the words.
    private var scanWide: Bool { window.width > windowHeight && windowHeight < 520 }

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
            .opening, .show, .showQr,
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
        case .opening, .show, .showQr: await model.cancel()
        default: await model.closeScreen()
        }
    }

    /// The notice's words, then the new code: "Wrong code entered. The code changed. New code 4 8 1 2 ...".
    private func newCodeAnnouncement(_ screen: KitScreen<LocalPairingState>, _ code: String?) -> String {
        var parts: [String] = []
        for key in [
            "localPairing.rotatedTitle", "localPairing.notPairedWith", "localPairing.rotatedBody",
            "localPairing.tooManyAgainBody",
        ] {
            if let line = screen.line(key) { parts.append(strings.string(line)) }
        }
        // The QR view says the change without the digits.
        if let code { parts.append(strings.string("a11y.newCode", ["code": .text(spelled(code))])) }
        return parts.map { $0.hasSuffix(".") ? $0 : $0 + "." }.joined(separator: " ")
    }

    private func spelled(_ code: String) -> String { code.map(String.init).joined(separator: " ") }

    /// What a change of state says beyond the heading.
    private func announcement(
        _ screen: KitScreen<LocalPairingState>, _ state: LocalPairingState, from old: String
    ) -> CopyLine? {
        switch state {
        case .showQr:
            // A switch says the new view's line; the code is never said here.
            return screen.line("localPairing.qrBody")
        case .show:
            if old == LocalPairingState.showQr.rawValue { return screen.line("localPairing.showBody") }
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
                case .opening, .show, .showQr: show(screen, state, style)
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
        // The interruption is the source's own word: a view that has just appeared still shows it.
        let busy =
            (screen.line("localPairing.cameraBusy")
            ?? (model.scanSource?.interrupted == true ? CopyLine("localPairing.cameraBusy") : nil))
            .map { strings.string($0) }
        let h = windowHeight
        if scanWide {
            // A landscape phone: the camera takes the height beside the words, and the actions sit
            // in that column under them, so nothing falls below the fold.
            HStack(alignment: .top, spacing: style.space(.lg)) {
                ScanViewfinder(source: model.scanSource, label: label, side: max(160, h - 100), message: busy)
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    scanWords(screen, style)
                    actions(screen, .scan)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            // Portrait: the camera is as tall as the room that is left, so the actions stay in view.
            if let body = screen.line("localPairing.scanBody") { KitText(body, .body) }
            ScanViewfinder(
                source: model.scanSource, label: label,
                side: min(min(360, max(200, h - 420)), max(160, (window.width == 0 ? 390 : window.width) - 48)),
                message: busy
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
        let gone = model.state.expired == true
        if gone {
            // Expired says its piece in the title: the dead stage stays, muted, and the actions are Show a new code and Cancel.
            if state == .showQr, qrTwoColumns {
                // The same two columns as the live view, and the buttons in the start column.
                HStack(alignment: .top, spacing: style.space(.xl)) {
                    actions(screen, state).frame(maxWidth: .infinity, alignment: .leading)
                    qrCard(screen, size: qrSide(style), dimmed: true)
                }
            } else if state == .showQr {
                qrCard(screen, size: qrSide(style), dimmed: true).frame(maxWidth: .infinity)
            } else {
                codeTile(screen, opening, style).opacity(0.5)
            }
        } else if state == .showQr {
            let card = qrCard(screen, size: qrSide(style), dimmed: gone)
            if qrTwoColumns {
                // A laptop-sized window: the words and the buttons at the start, the card at the end.
                HStack(alignment: .center, spacing: style.space(.xl)) {
                    VStack(alignment: .leading, spacing: style.space(.md)) {
                        qrWords(screen, style)
                        actions(screen, state)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    card
                }
            } else {
                if let body = screen.line("localPairing.qrBody") { KitText(body, .body) }
                if layout.noticeBeforeQr { showNotice(screen, style) }
                card.frame(maxWidth: .infinity)
                timeRow(screen, false, style)
                if !layout.noticeBeforeQr { showNotice(screen, style) }
                waitingRow(screen, false, style)
            }
        } else {
            if let body = screen.line("localPairing.showBody") { KitText(body, .body) }
            codeTile(screen, opening, style)
            timeRow(screen, opening, style)
            showNotice(screen, style)
            waitingRow(screen, opening, style)
        }
    }

    /// The QR view's words in the two-column form: the line, the time, the notice, the waiting row.
    @ViewBuilder private func qrWords(
        _ screen: KitScreen<LocalPairingState>, _ style: KitResolvedStyle
    ) -> some View {
        if let body = screen.line("localPairing.qrBody") { KitText(body, .body) }
        timeRow(screen, false, style)
        showNotice(screen, style)
        waitingRow(screen, false, style)
    }

    /// The QR's side: as large as the window leaves room for, never under 192 pt (12 rem).
    private func qrSide(_ style: KitResolvedStyle) -> CGFloat {
        let w = window.width == 0 ? 390 : window.width
        if qrTwoColumns { return max(192, min(windowHeight - 140, 320)) }
        return max(192, min(w - 2 * style.space(.lg), windowHeight - 380, 320))
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

    /// The QR view's card: the plain QR, in one place so the Light Card can replace it. A window that ran out fades the
    /// dark modules toward the paper (so the dead code does not scan) and dims the card.
    private func qrCard(_ screen: KitScreen<LocalPairingState>, size: CGFloat, dimmed: Bool) -> some View {
        Group {
            if let text = model.qr {
                ExpiredFadeQR(text: text, label: strings.string("a11y.qrPairing"), faded: dimmed)
                    .frame(width: size, height: size)
                    .accessibilityFocused($focus, equals: .card)
            } else {
                RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.0001))
                    .frame(width: size, height: size).accessibilityHidden(true)
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
            .fixedSize(horizontal: false, vertical: true)
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
            case .opening:
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.cancel() } }
                // The link's place is held while the window opens, so nothing moves when it arrives.
                link(CopyLine("localPairing.toQr")) {}.hidden().accessibilityHidden(true)
            case .show, .showQr:
                if model.state.expired == true {
                    KitButton(
                        line: screen.lineOrKey("localPairing.showNew"), kind: .primary,
                        busy: model.state.busy == .newCode
                    ) { Task { await model.showNew() } }
                }
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.cancel() } }
                if model.state.expired != true {
                    if state == .show {
                        link(screen.lineOrKey("localPairing.toQr")) { model.showQr() }
                    } else {
                        link(screen.lineOrKey("localPairing.toCode")) { model.showCode() }
                    }
                }
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
            // Only a change in the source is copied to the model: a view that appears must not wipe the
            // state it was given.
            .onChange(of: model.scanSource?.interrupted) { _, busy in
                if let busy { model.setCameraBusy(busy) }
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

/// The pairing QR, or its dead twin: after the window ran out the code is blurred past reading (more than 1.5 module widths),
/// its ink fades to 15 % of the paper contrast and the card dims to 35 % on the stage's own night ground, so the result is the
/// same over either page and a barcode reader finds nothing (UI-KITS 4.9). Internal so a test can decode both.
struct ExpiredFadeQR: View {
    let text: String
    let label: String
    let faded: Bool

    /// The night stage the dimmed card sits on (`LIGHT_CARD` ground).
    static let stage = Color(.sRGB, red: 5 / 255, green: 6 / 255, blue: 13 / 255, opacity: 1)

    var body: some View {
        if faded {
            GeometryReader { geo in
                // 37 modules with the quiet zone is the largest code the kit draws at this size: 1.5 widths and a margin.
                let blur = geo.size.width / 37 * 2
                ZStack {
                    Self.stage
                    PolarisQRCode(text, accessibilityLabel: label)
                        .blur(radius: blur)
                        .brightness(0.85)
                        .opacity(0.35)
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        } else {
            PolarisQRCode(text, accessibilityLabel: label)
        }
    }
}
