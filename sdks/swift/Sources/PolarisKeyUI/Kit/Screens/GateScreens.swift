// @pkey-feature ui.gate ui.activate
// The gate's own screens (UI-KITS §4.1, §4.3): Boot, Welcome, StatusScreen, GraceBanner and the
// toast. Each takes the core's `KitScreen` for its component and the actions it can run, so the
// drop-in and a host's own composition draw the same states with the same copy.

import PolarisKeyUICore
import SwiftUI

// MARK: - Boot

/// First paint while the license check or the boot stages run: the product's icon and, after the
/// 250 ms grace, a muted label with the platform's indicator. Never a part-filled bar for a stage.
public struct BootView: View {
    let line: CopyLine
    public init(screen: KitScreen<GateState>) {
        line = screen.copy.first ?? CopyLine("gate.checking")
    }

    public init(boot: KitScreen<BootScreenState>) {
        line = boot.copy.first ?? CopyLine("boot.starting")
    }

    public var body: some View {
        KitScreenScaffold(hero: true, header: false) {
            EmptyView()
        } content: {
            LoadingIndicator(line)
        } actions: {
            EmptyView()
        }
    }
}

// MARK: - Welcome

/// The gate's first screen (UI-KITS §4.3): the product as the hero, "Welcome to <Product>", "by
/// <Developer>", one lede, Sign in (primary) and Use a license key (secondary), and the extras as
/// one quiet row. When only one path exists, the lede says so and `content` carries that path.
public struct WelcomeView<Inline: View, InlineActions: View>: View {
    let screen: KitScreen<WelcomeState>
    var onSignIn: () -> Void
    var onUseKey: () -> Void
    var onExtra: (String) -> Void
    @ViewBuilder var inline: () -> Inline
    @ViewBuilder var inlineActions: () -> InlineActions

    @AccessibilityFocusState private var titleFocused: Bool

    /// `inline` and `inlineActions` carry the one path of a one-path product (the key field and
    /// Activate for a key-only product), under the lede and in the act's place.
    public init(
        screen: KitScreen<WelcomeState>, onSignIn: @escaping () -> Void,
        onUseKey: @escaping () -> Void, onExtra: @escaping (String) -> Void = { _ in },
        @ViewBuilder inline: @escaping () -> Inline,
        @ViewBuilder inlineActions: @escaping () -> InlineActions
    ) {
        self.screen = screen
        self.onSignIn = onSignIn
        self.onUseKey = onUseKey
        self.onExtra = onExtra
        self.inline = inline
        self.inlineActions = inlineActions
    }

    private static var extras: [String] {
        ["welcome.trial", "welcome.continueFree", "welcome.restore", "welcome.offline"]
    }

    public var body: some View {
        KitScreenScaffold(hero: true, header: false) {
            VStack(spacing: 6) {
                KitText(
                    screen.lineOrKey("welcome.title"), .display, color: .strong, alignment: .center
                )
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($titleFocused)
                if let by = screen.line("common.byDeveloper") {
                    KitText(by, .footnote, color: .subtle, alignment: .center)
                }
            }
        } content: {
            Group {
                if let lede = screen.line("welcome.lede") ?? screen.line("welcome.ledeKeyOnly")
                    ?? screen.line("welcome.ledeSignInOnly")
                {
                    KitText(lede, .body, color: .default, alignment: .center)
                }
                if screen.state == .capabilityLimited, screen.shows("welcome.ledeKeyOnly") {
                    inline()
                }
            }
        } actions: {
            if screen.state == .busy {
                KitButton(line: CopyLine("welcome.signIn"), kind: .primary, busy: true) {}
            } else if screen.state == .default {
                KitActionStack {
                    KitButton(
                        line: screen.lineOrKey("welcome.signIn"), kind: .primary, action: onSignIn
                    )
                    .keyboardShortcut(.defaultAction)
                    KitButton(
                        line: screen.lineOrKey("welcome.useKey"), kind: .secondary, action: onUseKey
                    )
                }
            } else if screen.state == .capabilityLimited, screen.shows("welcome.ledeSignInOnly") {
                KitButton(line: CopyLine("welcome.signIn"), kind: .primary, action: onSignIn)
                    .keyboardShortcut(.defaultAction)
            } else if screen.state == .capabilityLimited {
                inlineActions()
            }
        } footer: {
            let extras = Self.extras.compactMap { screen.line($0) }
            if !extras.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 20) {
                        ForEach(extras, id: \.key) { line in
                            KitButton(line: line, kind: .quiet, fullWidth: false) {
                                onExtra(line.key)
                            }
                        }
                    }
                    VStack(spacing: 4) {
                        ForEach(extras, id: \.key) { line in
                            KitButton(line: line, kind: .quiet, fullWidth: false) {
                                onExtra(line.key)
                            }
                        }
                    }
                }
            }
        }
    }
}

extension WelcomeView where Inline == EmptyView, InlineActions == EmptyView {
    /// Welcome with no inline path (a product with both sign-in and keys).
    public init(
        screen: KitScreen<WelcomeState>, onSignIn: @escaping () -> Void,
        onUseKey: @escaping () -> Void, onExtra: @escaping (String) -> Void = { _ in }
    ) {
        self.init(
            screen: screen, onSignIn: onSignIn, onUseKey: onUseKey, onExtra: onExtra,
            inline: { EmptyView() }, inlineActions: { EmptyView() })
    }
}

// MARK: - Status screens

/// A blocking state with its fix (UI-KITS §4.1 StatusScreen, DL6): the product identity, the state
/// named in the title, its sentence, the allowed versions where known, and the fix as the only
/// primary. A fix the kit cannot reach is named in words, and Try again stays.
public struct StatusScreenView: View {
    let screen: KitScreen<StatusScreenState>
    var onFix: (String) -> Void
    /// The fixes the host can run (`status.renew` needs a renewal page, `status.update` an update
    /// path); a missing one hides its button.
    var available: Set<String>
    var onTryAgain: () -> Void

    public init(
        screen: KitScreen<StatusScreenState>, available: Set<String>,
        onFix: @escaping (String) -> Void, onTryAgain: @escaping () -> Void
    ) {
        self.screen = screen
        self.available = available
        self.onFix = onFix
        self.onTryAgain = onTryAgain
    }

    private var fixes: [CopyLine] {
        [
            "signin.key.differentKey", "status.renew", "status.update", "status.switchChannel",
            "status.useAnotherLicense", "status.contact", "common.signOut",
        ]
        .compactMap { screen.line($0) }
        .filter { available.contains($0.key) }
    }

    public var body: some View {
        let title = screen.copy.first { $0.key.hasSuffix(".title") }
        let message = screen.copy.first { $0.key.hasSuffix(".message") }
        let allowed = screen.copy.first { $0.key.hasPrefix("status.allowed") }
        KitScreenScaffold(hero: true, header: false) {
            if let title {
                KitText(title, .title, color: .strong, alignment: .center)
                    .accessibilityAddTraits(.isHeader)
            }
        } content: {
            VStack(spacing: 8) {
                if let message { KitText(message, .body, color: .default, alignment: .center) }
                if let allowed { KitText(allowed, .meta, color: .subtle, alignment: .center) }
            }
        } actions: {
            KitActionStack {
                ForEach(Array(fixes.enumerated()), id: \.element.key) { index, line in
                    KitButton(
                        line: line, kind: index == 0 ? .primary : .secondary,
                        glyph: line.key == "status.renew" ? "arrow.up.right" : nil
                    ) { onFix(line.key) }
                }
                if fixes.isEmpty || !fixes.contains(where: { $0.key != "common.signOut" }) {
                    KitButton(
                        line: CopyLine("common.tryAgain"),
                        kind: fixes.isEmpty ? .primary : .secondary,
                        action: onTryAgain)
                }
            }
        }
    }
}

// MARK: - Grace banner

/// Offline grace over the running app (UI-KITS §4.1 GraceBanner): a glass banner above the bottom
/// safe area with the days left (never extended), Reconnect, and a dismissal for the session.
public struct GraceBannerView: View {
    let screen: KitScreen<GraceBannerState>
    var onReconnect: () -> Void
    var onDismiss: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<GraceBannerState>, onReconnect: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.screen = screen
        self.onReconnect = onReconnect
        self.onDismiss = onDismiss
    }

    public var body: some View {
        kitStyle { style in
            if let lead = screen.line("grace.daysLeft") ?? screen.line("grace.lastDay") {
                HStack(spacing: style.space(.sm)) {
                    Image(systemName: "wifi.exclamationmark")
                        .foregroundStyle(style.palette.warning)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        KitText(lead, .label, color: .strong)
                        if let deadline = screen.line("grace.deadline") {
                            KitText(deadline, .footnote, color: .muted)
                        }
                    }
                    Spacer(minLength: 0)
                    KitButton(
                        line: CopyLine("common.reconnect"), kind: .primary, fullWidth: false,
                        action: onReconnect
                    )
                    .fixedSize()
                    if screen.shows("common.dismiss") {
                        Button(action: onDismiss) {
                            Image(systemName: "xmark")
                                .font(style.font(.meta))
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(style.palette.textMuted)
                        .accessibilityLabel(strings.string("common.dismiss"))
                    }
                }
                .padding(.leading, style.space(.md))
                .padding(.trailing, style.space(.xs))
                .padding(.vertical, style.space(.xs))
                .modifier(KitFloatingSurface(style: style))
                .padding(.horizontal, style.space(.md))
                .padding(.bottom, style.space(.xs))
                .accessibilityElement(children: .contain)
            }
        }
    }
}

/// A floating surface: Liquid Glass on 26, the regular material on 18, opaque under Reduce
/// Transparency.
struct KitFloatingSurface: ViewModifier {
    let style: KitResolvedStyle

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        if style.usesGlass, #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else if style.reduceTransparency {
            content.background(shape.fill(style.palette.raised))
                .overlay(shape.strokeBorder(style.palette.border, lineWidth: 1))
        } else {
            content.background(shape.fill(.regularMaterial))
        }
    }
}

// MARK: - Toast

/// A toast (UI-KITS §4.1 Toast): one line, at the bottom on phones, gone after 6 s unless it is
/// an error (an error toast is never the only record of the error).
public struct ToastView: View {
    let text: String
    var tone: StatusPill.Tone = .neutral

    public init(text: String, tone: StatusPill.Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.xs)) {
                if tone == .success {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(style.palette.success)
                        .accessibilityHidden(true)
                }
                Text(text)
                    .font(style.font(.label))
                    .foregroundStyle(style.palette.textStrong)
            }
            .padding(.horizontal, style.space(.md))
            .padding(.vertical, style.space(.sm))
            .modifier(KitFloatingSurface(style: style))
            .accessibilityAddTraits(.isStaticText)
        }
    }
}
