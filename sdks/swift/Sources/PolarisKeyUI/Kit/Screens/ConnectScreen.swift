// @pkey-feature connect.links connect.transfer
// LinkPairing and TransferOffer (CC-19.10; both are presented in a sheet (Mac: `.sheet`, iPhone:
// `.sheet` or `.fullScreenCover`), never inline in a page: the views assume a presentation that
// closes them, and keep drawing their last state while it does; the reference is the React kit after its built UX review,
// packages/sdk-react/src/kit/connect.tsx, and ui-core's models/connect.ts). Every line is a catalog
// key the state machine names (States/ConnectFamily.swift). Rules kept:
//   - the code is what both people compare: drawn as served, spelled out for VoiceOver, and kept on
//     screen through `confirm`; the categories that would be shared come before "Codes match", in
//     reading order too, and the actions flow after the content (never docked over it);
//   - no state confirms by default: VoiceOver and keyboard focus rest on the heading, and Codes match
//     and Accept are filled but are not the Mac's Return key (consent is a deliberate press);
//   - the other device's label is worded as reported by the device, in isolated text, and an absent
//     label says so; a contact's file name is clamped to three lines, the middle elided;
//   - Escape declines a code and closes a window, and closes a finished screen; on a transfer in
//     flight it does nothing, because Cancel stops it;
//   - a state change is announced once, after focus moves to the heading;
//   - "Pairing is off" explains before Done, and Done leaves; "Try again" is not offered the lead
//     when the reason is full (Done leads).

import PolarisKeyUICore
import SwiftUI

private enum ConnectFocus: Hashable { case heading }

/// Says `text` once, after the heading read has finished.
@MainActor func announce(_ text: String) {
    Task { @MainActor in
        try? await Task.sleep(nanoseconds: 400_000_000)
        var said = AttributedString(text)
        said.accessibilitySpeechAnnouncementPriority = .high
        AccessibilityNotification.Announcement(said).post()
    }
}

/// A row of pills that wraps onto further rows (the categories).
struct KitWrap: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // Asked for its ideal size it answers with the widest pill, not one endless row: placed narrower it
        // wraps, and a height for one row would let the second row spill onto what follows.
        if let width = proposal.width, width.isFinite { return arrange(width, subviews).size }
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        return arrange(widest, subviews).size
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        let placed = arrange(bounds.width, subviews)
        for (index, origin) in placed.origins.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                proposal: ProposedViewSize(width: bounds.width, height: nil))
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + rowHeight), origins)
    }
}

/// The glyph beside a result title: never colour alone.
struct ResultMark: View {
    enum Kind { case success, danger }
    let kind: Kind

    var body: some View {
        kitStyle { style in
            Image(systemName: kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(style.font(.display))
                .foregroundStyle(kind == .success ? style.palette.success : style.palette.danger)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - LinkPairing

public struct LinkPairingView: View {
    let model: LinkPairingModel
    /// The name each category goes by on screen, by id; an id without one is drawn as words.
    let categoryLabels: [String: String]
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var focus: ConnectFocus?
    @State private var last: KitScreen<LinkPairingState>?

    public init(model: LinkPairingModel, categoryLabels: [String: String] = [:]) {
        self.model = model
        self.categoryLabels = categoryLabels
    }

    public var body: some View {
        // While the sheet closes the model's screen is already empty: keep drawing the last state.
        let live = model.screen
        let screen = live.state != nil ? live : (last ?? live)
        if let state = screen.state {
            KitScreenScaffold(header: true, dockActions: false) {
                heading(screen, state)
            } content: {
                content(screen, state)
            } actions: {
                actions(screen, state)
            }
            .onChange(of: live.stateName, initial: true) { _, _ in
                if live.state != nil { last = live }
            }
            .onAppear { focus = .heading }
            .onChange(of: screen.stateName) { _, _ in
                focus = .heading
                if let line = announcement(screen, state) { announce(strings.string(line)) }
            }
            .interactiveDismissDisabled(state == .confirm)
            .background(escapeCloses(state))
            // A swipe-down must not leave the window open for the other person.
            .onDisappear { Task { await model.cancel() } }
        }
    }

    /// Escape closes a finished screen (the Mac's sheet has no other key for it). The other states
    /// answer Escape through their own Cancel or Not a match.
    @ViewBuilder private func escapeCloses(_ state: LinkPairingState) -> some View {
        if state == .linked || state == .failed || state == .unavailable {
            Button("") { Task { await model.finish() } }
                .keyboardShortcut(.cancelAction)
                .focusable(false)
                .opacity(0).frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    /// What a change of state says beyond the heading: the code to compare, the outcome.
    private func announcement(_ screen: KitScreen<LinkPairingState>, _ state: LinkPairingState)
        -> CopyLine?
    {
        switch state {
        case .code:
            guard let code = model.link?.code else { return nil }
            return CopyLine("a11y.linkCode", ["code": .text(code.map(String.init).joined(separator: " "))])
        case .linked: return screen.line("linkPairing.linkedWith") ?? screen.line("linkPairing.linkedBody")
        case .failed: return screen.copy.dropFirst().first
        default: return nil
        }
    }

    private func heading(_ screen: KitScreen<LinkPairingState>, _ state: LinkPairingState) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                if state == .linked { ResultMark(kind: .success) }
                if state == .failed { ResultMark(kind: .danger) }
                KitText(screen.copy.first ?? CopyLine("linkPairing.title"), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focus, equals: .heading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: Content

    @ViewBuilder private func content(
        _ screen: KitScreen<LinkPairingState>, _ state: LinkPairingState
    ) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .open:
                    if let body = screen.line("linkPairing.openBody") { KitText(body, .body) }
                    if let searching = screen.line("linkPairing.searching") {
                        waiting(searching, announced: true)
                    }
                case .code:
                    if let body = screen.line("linkPairing.codeBody") { KitText(body, .body) }
                    codeBlock(screen)
                    shares(screen)
                case .confirm:
                    codeBlock(screen)
                    shares(screen)
                    // The wait, in a status region beside the dot; the title above is what focus reads.
                    if let wait = screen.line("linkPairing.waiting") {
                        waiting(wait, announced: false).padding(.top, style.space(.xs))
                    }
                case .linked:
                    // Who was paired comes first: the label is the device's own word, so it is the person's
                    // last look at which device they trusted.
                    if let who = screen.line("linkPairing.linkedWith") ?? screen.line("linkPairing.linkedBody") {
                        KitText(who, .body)
                    }
                    shares(screen)
                case .failed:
                    if let reason = screen.copy.dropFirst().first { KitText(reason, .body) }
                case .unavailable:
                    // The explanation comes before Done, on screen and in reading order.
                    if let message = screen.line("core.codes.connect_links_disabled.message") {
                        KitText(message, .body)
                    }
                }
            }
        }
    }

    /// The pulsing wait. Reduce Motion holds it still (ProgressView does).
    private func waiting(_ line: CopyLine, announced: Bool) -> some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                ProgressView().controlSize(.small).accessibilityHidden(true)
                KitText(line, .body, color: .muted)
            }
            // After Codes match the title says the wait, so the line is for the eye only.
            .accessibilityElement(children: announced ? .ignore : .combine)
            .accessibilityLabel(Text(announced ? strings.string(line) : ""))
            .accessibilityHidden(!announced)
            .accessibilityAddTraits(announced ? .updatesFrequently : [])
        }
    }

    /// The code and the line that says which device reported it, kept through `confirm`.
    @ViewBuilder private func codeBlock(_ screen: KitScreen<LinkPairingState>) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                if let code = model.link?.code {
                    Text(code)
                        .font(style.codeFont(size: CodeDisplay.size))
                        .tracking(CodeDisplay.size * CodeDisplay.tracking)
                        .foregroundStyle(style.palette.textStrong)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .accessibilityLabel(
                            Text(
                                strings.string(
                                    "a11y.linkCode",
                                    ["code": .text(code.map(String.init).joined(separator: " "))]))
                        )
                        .padding(.horizontal, style.space(.md))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, style.space(.md))
                        .background(
                            RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                                .fill(style.palette.sunken)
                        )
                }
                if let reported = screen.line("linkPairing.reported")
                    ?? screen.line("linkPairing.reportedUnnamed")
                {
                    // The label is text the other device chose: isolated, and never bold as a name.
                    KitText(reported, .body, color: .strong)
                }
            }
        }
    }

    /// What each of you shares: the categories before the choice, or that nothing is shared yet.
    @ViewBuilder private func shares(_ screen: KitScreen<LinkPairingState>) -> some View {
        kitStyle { style in
            if let head = screen.line("linkPairing.shares") {
                VStack(alignment: .leading, spacing: style.space(.xs)) {
                    KitText(head, .label, color: .default)
                        .accessibilityAddTraits(.isHeader)
                    KitWrap(spacing: style.space(.xs)) {
                        ForEach(model.link?.categories ?? [], id: \.self) { id in
                            Text(categoryLabels[id] ?? kitCategoryFallback(id))
                                .font(style.font(.body))
                                .foregroundStyle(style.palette.textStrong)
                                .padding(.horizontal, style.space(.sm))
                                .padding(.vertical, style.space(.xxs))
                                .frame(minHeight: 32)
                                .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
                                .environment(\.layoutDirection, .leftToRight)
                        }
                    }
                }
                // One stop: the heading and the categories read together.
                .accessibilityElement(children: .combine)
            } else if let none = screen.line("linkPairing.sharesNone") {
                KitText(none, .body)
            }
        }
    }

    // MARK: Actions

    @ViewBuilder private func actions(
        _ screen: KitScreen<LinkPairingState>, _ state: LinkPairingState
    ) -> some View {
        KitActionStack {
            switch state {
            case .open, .confirm:
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { Task { await model.finish() } }
            case .code:
                // Filled but not the Return key: a stray Return never links.
                KitButton(
                    line: CopyLine("linkPairing.confirm"), kind: .primary, returnKey: false
                ) { Task { await model.confirm() } }
                KitButton(line: CopyLine("linkPairing.decline"), kind: .quiet) { Task { await model.decline() } }
                    .keyboardShortcut(.cancelAction)
            case .linked, .unavailable:
                KitButton(line: CopyLine("common.done"), kind: .primary) { Task { await model.finish() } }
            case .failed:
                // "Full" cannot succeed until a pairing is removed: Done leads, Try again stays.
                let full = model.link?.reason == .full
                if full {
                    KitButton(line: CopyLine("common.done"), kind: .primary) { Task { await model.finish() } }
                }
                KitButton(line: CopyLine("common.tryAgain"), kind: full ? .secondary : .primary) {
                    Task { await model.start() }
                }
                if !full {
                    KitButton(line: CopyLine("common.done"), kind: .quiet) { Task { await model.finish() } }
                }
            }
        }
    }
}

// MARK: - TransferOffer

public struct TransferOfferView: View {
    let model: TransferOfferModel
    @Environment(\.polarisKeyStrings) private var strings
    @AccessibilityFocusState private var focus: ConnectFocus?
    @State private var last: KitScreen<TransferOfferState>?

    public init(model: TransferOfferModel) { self.model = model }

    public var body: some View {
        let live = model.screen
        let screen = live.state != nil ? live : (last ?? live)
        if let state = screen.state {
            KitScreenScaffold(header: true, dockActions: false) {
                heading(screen, state)
            } content: {
                content(screen, state)
            } actions: {
                actions(state)
            }
            .onChange(of: live.stateName, initial: true) { _, _ in
                if live.state != nil { last = live }
            }
            .onAppear { focus = .heading }
            .onChange(of: screen.stateName) { _, _ in
                focus = .heading
                if state == .done || state == .failed, let title = screen.copy.first {
                    announce(strings.string(title))
                }
            }
            .interactiveDismissDisabled(state == .receiving)
            .background(escapeCloses(state))
            // A swipe-down answers or closes the offer, so the next one is not left waiting behind it.
            .onDisappear {
                switch model.offer.step {
                case .ask: Task { await model.decline() }
                case .done, .failed: model.close()
                case .receiving: break
                }
            }
        }
    }

    /// Escape closes a finished transfer.
    @ViewBuilder private func escapeCloses(_ state: TransferOfferState) -> some View {
        if state == .done || state == .failed {
            Button("") { model.close() }
                .keyboardShortcut(.cancelAction)
                .focusable(false)
                .opacity(0).frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    private func heading(_ screen: KitScreen<TransferOfferState>, _ state: TransferOfferState)
        -> some View
    {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                if state == .done { ResultMark(kind: .success) }
                if state == .failed { ResultMark(kind: .danger) }
                if let title = screen.copy.first {
                    KitText(title, .title, color: .strong)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($focus, equals: .heading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder private func content(
        _ screen: KitScreen<TransferOfferState>, _ state: TransferOfferState
    ) -> some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                switch state {
                case .ask:
                    if let body = screen.line("transferOffer.askBody") { KitText(body, .body) }
                    // The title carries a shortened name; the whole one is on its own row.
                    offerRow(style)
                case .receiving:
                    // What was accepted stays on screen, with a bar that moves until bytes are counted.
                    offerRow(style)
                    IndeterminateBar()
                        // The title ("Receiving holiday.zip") says it, once; the 4 pt bar is not a target.
                        .accessibilityHidden(true)
                case .done:
                    EmptyView()
                case .failed:
                    if let body = screen.line("transferOffer.failedBody") { KitText(body, .body) }
                }
            }
        }
    }

    /// The name the contact chose, clamped to three lines with the middle elided, then size and type.
    private func offerRow(_ style: KitResolvedStyle) -> AnyView {
        let offer = model.offer
        // A nameless offer shows its type once, as the lead line, not again among the facts.
        let nameless = offer.name.isEmpty && !(offer.type ?? "").isEmpty
        let lead = nameless ? (offer.type ?? "") : offer.name
        let facts = [offer.size.map { KitFormat.bytes($0) } ?? "", nameless ? "" : (offer.type ?? "")]
            .filter { !$0.isEmpty }
        guard !lead.isEmpty || !facts.isEmpty else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(alignment: .leading, spacing: style.space(.xxs)) {
                if !lead.isEmpty {
                    Text(verbatim: lead)
                        .font(style.font(.body))
                        .foregroundStyle(style.palette.textStrong)
                        .lineLimit(3)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !facts.isEmpty {
                    Text(verbatim: facts.joined(separator: " · "))
                        .font(style.font(.meta))
                        .foregroundStyle(style.palette.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(style.space(.md))
            .background(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .fill(style.palette.sunken)
            )
            .accessibilityElement(children: .combine))
    }

    @ViewBuilder private func actions(_ state: TransferOfferState) -> some View {
        KitActionStack {
            switch state {
            case .ask:
                // Consent is a deliberate press: Accept is filled but never the Return key.
                KitButton(line: CopyLine("transferOffer.accept"), kind: .primary, returnKey: false) {
                    Task { await model.accept() }
                }
                KitButton(line: CopyLine("transferOffer.decline"), kind: .quiet) {
                    Task { await model.decline() }
                }
                .keyboardShortcut(.cancelAction)
            case .receiving:
                // Cancel stops the transfer, so Escape does not.
                KitButton(line: CopyLine("common.cancel"), kind: .quiet, escapes: false) {
                    Task { await model.cancel() }
                }
            case .done, .failed:
                KitButton(line: CopyLine("common.done"), kind: .primary) { model.close() }
            }
        }
    }
}
