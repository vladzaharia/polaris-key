// `PolarisSignIn` — device-code sign-in (RFC 8628; notes/SDK-PARITY-PASS.md §3.12, §3.18): the
// page to visit, the user code with Copy, a countdown, Copy link, "Open browser" and Cancel, and
// the optional "Is this you?" confirmation with the attach opt-in (P1-07). A QR code of the
// pre-filled URL shows on TV screens only (SIGN-IN.md D-67).
//
// States: starting, waiting (pending / slow down), confirm, ready (+identity), expired, failed.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import SwiftUI

/// The device-code flow as observable state.
@MainActor
@Observable
public final class PolarisSignInModel {
    public enum Phase: Equatable {
        case idle
        case starting
        case waiting(SignInPrompt)
        case confirm(SignInPrompt, identity: SignInIdentity, attachable: Bool)
        case ready(SignInReady)
        case expired
        case failed(code: String, message: String)
    }

    public let client: PolarisKeyClient
    /// Hold the flow at the signed-in identity ("Is this you?") before completing.
    public var confirmIdentity: Bool
    public var deviceName: String?
    public private(set) var phase: Phase = .idle
    private var task: Task<Void, Never>?

    public init(client: PolarisKeyClient, confirmIdentity: Bool = false, deviceName: String? = nil) {
        self.client = client
        self.confirmIdentity = confirmIdentity
        self.deviceName = deviceName
    }

    /// Begin (or restart) the flow.
    public func start() {
        task?.cancel()
        phase = .starting
        let client = self.client
        let confirm = confirmIdentity
        let name = deviceName
        task = Task { [weak self] in
            do {
                let prompt = try await client.identity.beginSignIn(deviceName: name)
                self?.phase = .waiting(prompt)
                let result = try await client.identity.waitForSignIn(
                    prompt, confirmIdentity: confirm)
                self?.settle(result, prompt: prompt)
            } catch is CancellationError {
            } catch let e as PolarisError {
                self?.phase = .failed(code: e.code, message: ErrorCopy.message(e.code))
            } catch {
                self?.phase = .failed(code: ErrorCode.signInFailed, message: "\(error)")
            }
        }
    }

    /// The player accepted the identity a confirm showed.
    public func accept(attachLicense: Bool) {
        guard case .confirm(let prompt, _, let attachable) = phase else { return }
        let client = self.client
        task?.cancel()
        task = Task { [weak self] in
            do {
                let result = try await client.identity.acceptSignIn(
                    prompt, attachLicense: attachLicense && attachable)
                self?.settle(result, prompt: prompt)
            } catch is CancellationError {
            } catch let e as PolarisError {
                self?.phase = .failed(code: e.code, message: ErrorCopy.message(e.code))
            } catch {
                self?.phase = .failed(code: ErrorCode.signInFailed, message: "\(error)")
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        phase = .idle
    }

    private func settle(_ result: SignInResult, prompt: SignInPrompt) {
        switch result {
        case .ready(let ready): phase = .ready(ready)
        case .confirm(let identity, let attachable):
            phase = .confirm(prompt, identity: identity, attachable: attachable)
        case .expired: phase = .expired
        case .error:
            phase = .failed(
                code: ErrorCode.signInDenied, message: ErrorCopy.message(ErrorCode.signInDenied))
        }
    }

    /// The prompt being shown, if any.
    public var prompt: SignInPrompt? {
        switch phase {
        case .waiting(let p), .confirm(let p, _, _): return p
        default: return nil
        }
    }
}

/// The sign-in screen. `onFinish` runs once the flow settles as signed in, or on Cancel.
public struct PolarisSignIn: View {
    @State private var model: PolarisSignInModel
    private let theme: PolarisTheme
    private let onFinish: (Bool) -> Void
    @State private var attach = true
    @Environment(\.openURL) private var openURL

    public init(
        client: PolarisKeyClient, theme: PolarisTheme = PolarisTheme(),
        confirmIdentity: Bool = false, onFinish: @escaping (Bool) -> Void = { _ in }
    ) {
        _model = State(
            initialValue: PolarisSignInModel(client: client, confirmIdentity: confirmIdentity))
        self.theme = theme
        self.onFinish = onFinish
    }

    public init(
        model: PolarisSignInModel, theme: PolarisTheme = PolarisTheme(),
        onFinish: @escaping (Bool) -> Void = { _ in }
    ) {
        _model = State(initialValue: model)
        self.theme = theme
        self.onFinish = onFinish
    }

    private var copy: PolarisKitCopy { theme.copy.kit }

    public var body: some View {
        PolarisSignInSurface(
            phase: model.phase, theme: theme, attach: $attach,
            onOpen: { url in openURL(url) },
            onAccept: { model.accept(attachLicense: attach) },
            onRetry: { model.start() },
            onCancel: {
                model.cancel()
                onFinish(false)
            }
        )
        .task { if case .idle = model.phase { model.start() } }
        .onChange(of: model.phase) { _, phase in
            if case .ready = phase { onFinish(true) }
        }
        .onDisappear { model.cancel() }
    }
}

/// The sign-in screen for one phase, without a live client (previews and render tests).
///
/// The code view (SIGN-IN.md §3.17, D-67; UI-KITS §4.3) leads with the product, says where to go
/// ("On any phone or computer, go to key.plrs.im/device and enter this code."), shows the user code
/// at hero size with Copy, the countdown and Copy link, then Open browser and Cancel. It lays out
/// for the space it gets (`PolarisAdaptivePage`): one column on a phone in portrait, the code and
/// actions beside the instructions in landscape and short windows, and the split Welcome on iPad
/// and roomy Mac windows. The QR code is for TV screens only: on the phone or Mac that shows it, a QR
/// cannot be scanned by the device it is on.
struct PolarisSignInSurface: View {
    let phase: PolarisSignInModel.Phase
    let theme: PolarisTheme
    @Binding var attach: Bool
    let onOpen: (URL) -> Void
    let onAccept: () -> Void
    let onRetry: () -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding
    @Environment(\.polarisKeyPresentation) private var presentation
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var copy: PolarisKitCopy { theme.copy.kit }
    private var isAX: Bool { dynamicTypeSize.isAccessibilitySize }

    /// Whether the code view shows a QR code: on TV screens only (SIGN-IN.md D-67).
    static var showsQRCode: Bool { PolarisManagePresentation.current == .qr }

    var body: some View {
        let style = PolarisKitStyle(
            theme: theme, scheme: colorScheme, branding: branding, presentation: presentation)
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        PolarisAdaptivePage(style: style, identity: identity) { layout in
            heading(style: style, identity: identity, layout: layout)
        } detail: { layout in
            detail(style: style, layout: layout)
        } act: { layout in
            act(style: style, layout: layout)
        }
        .modifier(KitTint(color: style.tint))
    }

    // ── heading ──

    @ViewBuilder private func heading(
        style: PolarisKitStyle, identity: PolarisProductIdentity, layout: PolarisKitLayout
    ) -> some View {
        switch phase {
        case .idle, .starting:
            PolarisPageHeading(
                title: copy.signInTitle, identity: identity, style: style, layout: layout)
        case .waiting:
            PolarisPageHeading(
                title: Self.showsQRCode ? copy.signInTitle : copy.signInCodeTitle,
                identity: identity, style: style, layout: layout)
        case .confirm:
            PolarisPageHeading(
                title: copy.confirmTitle, identity: identity, style: style, layout: layout,
                symbol: "person.crop.circle.badge.checkmark")
        case .ready:
            PolarisPageHeading(
                title: copy.signedInAs, identity: identity, style: style, layout: layout,
                symbol: "checkmark.circle.fill")
        case .expired:
            PolarisPageHeading(
                title: copy.signInExpiredTitle, identity: identity, style: style,
                layout: layout, symbol: "clock.badge.exclamationmark",
                symbolTint: style.palette.warning)
        case .failed(let code, _):
            PolarisPageHeading(
                title: ErrorCopy.title(code), identity: identity, style: style, layout: layout,
                symbol: "exclamationmark.triangle.fill", symbolTint: style.palette.danger)
        }
    }

    // ── detail ──

    @ViewBuilder private func detail(style: PolarisKitStyle, layout: PolarisKitLayout)
        -> some View
    {
        switch phase {
        case .idle, .starting:
            EmptyView()
        case .waiting(let prompt):
            if Self.showsQRCode {
                PolarisPageText(text: Text(copy.signInSubtitle), style: style, layout: layout)
            } else {
                // The instruction is essential, so it stays before the code even when compressed.
                // "Check the code there matches this one." sits directly under the code row (in the
                // act), not here.
                PolarisPageLede(
                    template: copy.signInCodeBody, page: Self.displayURL(prompt.verificationUri),
                    style: style, layout: layout)
            }
        case .confirm(_, let identity, _):
            PolarisPageText(
                text: Text(Self.identityLines(identity)), style: style, layout: layout)
        case .ready(let ready):
            PolarisPageText(
                text: Text(Self.identityLines(ready.identity)), style: style, layout: layout)
        case .expired:
            PolarisPageText(text: Text(copy.signInExpiredBody), style: style, layout: layout)
        case .failed(_, let message):
            PolarisErrorLine(message: message, theme: theme, alignment: layout.textAlignment)
                .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
        }
    }

    // ── act ──

    @ViewBuilder private func act(style: PolarisKitStyle, layout: PolarisKitLayout) -> some View
    {
        switch phase {
        case .idle, .starting:
            VStack(spacing: PolarisSpace.m) {
                ProgressView().accessibilityLabel(copy.startingSignIn)
                // Cancel is always reachable (Escape in the macOS sheet), so sign-in is never a
                // dead end while beginSignIn runs.
                Button(copy.cancelButton, action: onCancel)
                    .polarisSecondaryButton()
                    .modifier(KitTint(color: style.textTint))
                    .modifier(PolarisButtonFont(style: style))
                    .keyboardShortcut(.cancelAction)
                    .frame(maxWidth: layout == .column ? .infinity : nil)
            }
        case .waiting(let prompt):
            waiting(prompt, style: style, layout: layout)
        case .confirm(_, _, let attachable):
            VStack(spacing: PolarisSpace.m) {
                if attachable {
                    Toggle(copy.attachFreeLicense, isOn: $attach)
                        .font(style.font(.body))
                }
                PolarisPageActions(
                    primaryTitle: copy.confirmContinue, primary: onAccept,
                    secondaryTitle: copy.cancelButton, secondary: onCancel, layout: layout,
                    style: style)
            }
        case .ready:
            EmptyView()
        case .expired, .failed:
            PolarisPageActions(
                primaryTitle: copy.tryAgainButton, primary: onRetry,
                secondaryTitle: copy.cancelButton, secondary: onCancel, layout: layout, style: style)
        }
    }

    @ViewBuilder private func waiting(
        _ prompt: SignInPrompt, style: PolarisKitStyle, layout: PolarisKitLayout
    ) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = Int(context.date.timeIntervalSince1970) >= prompt.expiresAt
            VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.l) {
                VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.s) {
                    if Self.showsQRCode {
                        PolarisQRCode(
                            prompt.verificationUriComplete, accessibilityLabel: copy.signInQRLabel
                        )
                        .frame(maxWidth: 200, maxHeight: 200)
                    }
                    PolarisUserCode(code: prompt.userCode, style: style, copy: copy)
                    codeRow(prompt, style: style, layout: layout)
                    // The match check sits directly under the code row (SIGN-IN.md §3.17).
                    PolarisPageText(
                        text: Text(copy.signInCodeCheck), style: style, layout: layout, role: .meta)
                }
                if expired {
                    // The code has run out: offer Try again rather than leave Open browser live.
                    PolarisPageActions(
                        primaryTitle: copy.tryAgainButton, primary: onRetry,
                        secondaryTitle: copy.cancelButton, secondary: onCancel, layout: layout,
                        style: style)
                } else if let url = URL(string: prompt.verificationUriComplete) {
                    PolarisPageActions(
                        primaryTitle: copy.openBrowserButton, primary: { onOpen(url) },
                        secondaryTitle: copy.cancelButton, secondary: onCancel, layout: layout,
                        style: style)
                } else {
                    PolarisPageActions(
                        primaryTitle: copy.cancelButton, primary: onCancel, layout: layout,
                        style: style)
                }
            }
        }
    }

    /// The countdown and Copy link (and, at accessibility sizes, a labelled Copy code), on one row
    /// that stacks when it does not fit, aligned for the arrangement.
    @ViewBuilder private func codeRow(
        _ prompt: SignInPrompt, style: PolarisKitStyle, layout: PolarisKitLayout
    ) -> some View {
        let countdown = PolarisCountdown(
            expiresAt: prompt.expiresAt, lifetime: prompt.expiresIn, label: copy.codeExpiresIn,
            style: style)
        VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.xs) {
            if isAX {
                PolarisCopyButton(
                    value: prompt.userCode, title: copy.copyCodeLabel, copiedTitle: copy.copiedLabel,
                    showsTitle: true, systemImage: "doc.on.doc", style: style)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: PolarisSpace.m) {
                    countdown
                    Spacer(minLength: 0)
                    copyLink(prompt, style: style)
                }
                VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.xs) {
                    countdown
                    copyLink(prompt, style: style)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
        .padding(.horizontal, PolarisSpace.xxs)
    }

    @ViewBuilder private func copyLink(_ prompt: SignInPrompt, style: PolarisKitStyle)
        -> some View
    {
        PolarisCopyButton(
            value: prompt.verificationUri, title: copy.copyLinkButton,
            copiedTitle: copy.copiedLabel, showsTitle: true, systemImage: "link", style: style)
    }

    // ── copy helpers ──

    /// The verification page as people type it: no scheme, no trailing slash.
    static func displayURL(_ uri: String) -> String {
        var page = uri
        for scheme in ["https://", "http://"] where page.lowercased().hasPrefix(scheme) {
            page = String(page.dropFirst(scheme.count))
        }
        while page.hasSuffix("/") { page.removeLast() }
        return page
    }

    static func identityLines(_ identity: SignInIdentity?) -> String {
        [identity?.name, identity?.email].compactMap { $0 }.joined(separator: "\n")
    }
}

/// The device-code lede. The verification page is rendered strong and never breaks or hyphenates:
/// a word joiner glues every character of the page token, so it moves to its own line whole rather
/// than split. When even one line of the token does not fit the column, the catalog sentence is
/// split at its `%@` — the prose, then the page alone on one line (shrinking, never cut), then the
/// rest — so it is still the catalog string verbatim.
struct PolarisPageLede: View {
    let template: String
    let page: String
    let style: PolarisKitStyle
    let layout: PolarisKitLayout

    @State private var tokenWidth: CGFloat = 0
    @State private var available: CGFloat = 0

    private var parts: [String] { template.components(separatedBy: "%@") }

    /// The page with a word joiner between every character, so it never breaks internally.
    private var glued: String {
        page.map(String.init).joined(separator: "\u{2060}")
    }

    var body: some View {
        let fitsInline = tokenWidth <= 0 || available <= 0 || tokenWidth <= available
        Group {
            if parts.count == 2, !fitsInline {
                split
            } else {
                PolarisPageText(text: inline, style: style, layout: layout)
            }
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
        .background(widthProbe)
        .background(tokenProbe)
    }

    private var inline: Text {
        guard parts.count == 2 else { return Text(template) }
        var url = AttributedString(glued)
        url.inlinePresentationIntent = .stronglyEmphasized
        url.foregroundColor = style.palette.textStrong
        return Text(AttributedString(parts[0]) + url + AttributedString(parts[1]))
    }

    @ViewBuilder private var split: some View {
        VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.xxs) {
            if let before = parts.first, !before.trimmingCharacters(in: .whitespaces).isEmpty {
                PolarisPageText(text: Text(before.trimmingCharacters(in: .whitespaces)), style: style, layout: layout)
            }
            Text(page)
                .font(style.font(.subtitle).weight(.semibold))
                .foregroundStyle(style.palette.textStrong)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .textSelection(.enabled)
            if parts.count == 2, !parts[1].trimmingCharacters(in: .whitespaces).isEmpty {
                PolarisPageText(text: Text(parts[1].trimmingCharacters(in: .whitespaces)), style: style, layout: layout)
            }
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
    }

    private var widthProbe: some View {
        GeometryReader { g in
            Color.clear
                .onAppear { available = g.size.width }
                .onChange(of: g.size.width) { _, w in available = w }
        }
    }

    private var tokenProbe: some View {
        Text(page)
            .font(style.font(.subtitle).weight(.semibold))
            .fixedSize()
            .hidden()
            .background(
                GeometryReader { g in
                    Color.clear
                        .onAppear { tokenWidth = g.size.width }
                        .onChange(of: g.size.width) { _, w in tokenWidth = w }
                }
            )
            .accessibilityHidden(true)
    }
}
