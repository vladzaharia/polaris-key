// @pkey-feature ui.gate ui.activate
// The gate's own screens (UI-KITS §4.1, §4.3): Boot, Welcome, StatusScreen, GraceBanner and the
// toast. Each takes the core's `KitScreen` for its component and the actions it can run, so the
// drop-in and a host's own composition draw the same states with the same copy.

import PolarisKeyUICore
import SwiftUI

// MARK: - Boot

/// First paint while the license check or the boot stages run: the product's icon and, after the
/// 250 ms grace, a muted label over a skeleton of the screen to come with the 2 px shimmer (DL7;
/// static under Reduce Motion). Never a part-filled bar for a stage.
public struct BootView: View {
    let line: CopyLine
    let boot: KitScreen<BootScreenState>?
    var onDownload: () -> Void
    var onNotNow: () -> Void
    var onContinueOffline: () -> Void
    var onTryAgain: () -> Void
    var onUpdate: () -> Void

    public init(screen: KitScreen<GateState>) {
        line = screen.copy.first ?? CopyLine("gate.checking")
        boot = nil
        onDownload = {}
        onNotNow = {}
        onContinueOffline = {}
        onTryAgain = {}
        onUpdate = {}
    }

    /// The stage machine's view; the handlers are the host's answers to a stop state.
    public init(
        boot: KitScreen<BootScreenState>,
        onDownload: @escaping () -> Void = {}, onNotNow: @escaping () -> Void = {},
        onContinueOffline: @escaping () -> Void = {}, onTryAgain: @escaping () -> Void = {},
        onUpdate: @escaping () -> Void = {}
    ) {
        line = boot.copy.first ?? CopyLine("boot.starting")
        self.boot = boot
        self.onDownload = onDownload
        self.onNotNow = onNotNow
        self.onContinueOffline = onContinueOffline
        self.onTryAgain = onTryAgain
        self.onUpdate = onUpdate
    }

    @State private var shown = false

    public var body: some View {
        switch boot?.state {
        case .consent?, .offline?, .blocked?, .declined?, .error?:
            if let boot { BootStop(boot: boot, actions: actions) }
        default:
            waiting
        }
    }

    private var actions: BootStopActions {
        BootStopActions(
            download: onDownload, notNow: onNotNow, continueOffline: onContinueOffline,
            tryAgain: onTryAgain, update: onUpdate)
    }

    private var waiting: some View {
        kitStyle { style in
            KitScreenScaffold(hero: true, header: false) {
                EmptyView()
            } content: {
                BootSkeleton(line: line, shown: shown)
            } actions: {
                EmptyView()
            }
            .overlay(alignment: .top) {
                if shown {
                    BootShimmer(
                        model: BootSkeletonModel(reduceMotion: style.reduceMotion),
                        color: style.palette.textStrong)
                }
            }
            .task {
                try? await Task.sleep(nanoseconds: BootSkeletonModel.grace)
                shown = true
            }
        }
    }
}

/// What a boot stop can do; the host's closures.
struct BootStopActions {
    var download: () -> Void
    var notNow: () -> Void
    var continueOffline: () -> Void
    var tryAgain: () -> Void
    var update: () -> Void
}

/// The stage machine's stops (UI-KITS §4.1 Boot): consent (metered download), offline, blocked,
/// declined and error. Each names the state in the title, says what it means in a sentence and
/// gives the next step as the one primary.
struct BootStop: View {
    let boot: KitScreen<BootScreenState>
    let actions: BootStopActions

    var body: some View {
        let title = boot.copy.first { $0.key.hasSuffix(".title") }
        let message = boot.copy.first {
            $0.key.hasSuffix(".body") || $0.key.hasSuffix(".message")
                || $0.key == "boot.offline.playable" || $0.key == "boot.consent.bodyMetered"
        }
        KitScreenScaffold(hero: true, header: false) {
            if let title {
                KitText(title, .title, color: .strong, alignment: .center)
                    .accessibilityAddTraits(.isHeader)
            }
        } content: {
            if let message { KitText(message, .body, color: .default, alignment: .center) }
        } actions: {
            KitActionStack {
                switch boot.state {
                case .consent:
                    primary("boot.consent.download", actions.download)
                    secondary("common.notNow", actions.notNow)
                case .offline:
                    if boot.shows("boot.continueOffline") {
                        primary("boot.continueOffline", actions.continueOffline)
                        secondary("common.tryAgain", actions.tryAgain)
                    } else {
                        primary("common.tryAgain", actions.tryAgain)
                    }
                case .blocked:
                    primary("status.update", actions.update)
                default:
                    primary("common.tryAgain", actions.tryAgain)
                }
            }
        }
    }

    private func primary(_ key: String, _ action: @escaping () -> Void) -> some View {
        KitButton(line: boot.lineOrKey(key), kind: .primary, action: action)
            .keyboardShortcut(.defaultAction)
    }

    private func secondary(_ key: String, _ action: @escaping () -> Void) -> some View {
        KitButton(line: boot.lineOrKey(key), kind: .secondary, action: action)
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
                    screen.line("common.welcomeNoProductTitle") ?? screen.lineOrKey("welcome.title"),
                    .display, color: .strong, alignment: .center
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
                    ?? screen.line("welcome.ledeSignInOnly") ?? screen.line("common.signInToContinue")
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
            } else if screen.state == .capabilityLimited,
                screen.shows("welcome.ledeSignInOnly") || screen.shows("common.signInToContinue")
            {
                KitButton(line: CopyLine("welcome.signIn"), kind: .primary, action: onSignIn)
                    .keyboardShortcut(.defaultAction)
            } else if screen.state == .capabilityLimited {
                inlineActions()
            }
        } footer: {
            let extras = Self.extras.compactMap { screen.line($0) }
            if !extras.isEmpty {
                // 20 pt under the buttons (§4.3): the act stack's 16 plus 4.
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
                .padding(.top, 4)
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
    /// The lines drawn: the state's, or the boot error's own sentence (DL7: a failed start says
    /// what failed, never an icon and a button alone).
    let lines: [CopyLine]

    public init(
        screen: KitScreen<StatusScreenState>, available: Set<String>,
        onFix: @escaping (String) -> Void, onTryAgain: @escaping () -> Void
    ) {
        self.screen = screen
        self.lines = screen.copy
        self.available = available
        self.onFix = onFix
        self.onTryAgain = onTryAgain
    }

    /// Whether a status title already names the product ("Update to keep using {product}"), so
    /// the name is not set twice (DL5).
    static func titleNamesProduct(_ title: CopyLine?) -> Bool {
        title.map { KitCopy.bundled.argumentNames($0.key).contains("product") } ?? false
    }

    /// A failed start: `lines` are the gate's error state (its title) and Try again is the one
    /// primary.
    public init(errorLines lines: [CopyLine], onTryAgain: @escaping () -> Void) {
        self.screen = .hidden
        self.lines = lines
        self.available = []
        self.onFix = { _ in }
        self.onTryAgain = onTryAgain
    }

    private var fixes: [CopyLine] {
        [
            "welcome.signIn", "signin.key.differentKey", "status.renew", "status.update",
            "status.switchChannel", "status.useAnotherLicense", "status.contact",
        ]
        .compactMap { screen.line($0) }
        .filter { available.contains($0.key) }
    }

    public var body: some View {
        let title = lines.first { $0.key.hasSuffix(".title") }
        let message = lines.first { $0.key.hasSuffix(".message") }
        let allowed = lines.first { $0.key.hasPrefix("status.allowed") }
        // DL5: the name appears once, in the title when the title names the product, else under
        // the icon.
        KitScreenScaffold(hero: true, header: false, heroName: !Self.titleNamesProduct(title)) {
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
                        glyph: line.key == "status.renew" ? PolarisKitGlyph.newWindow : nil
                    ) { onFix(line.key) }
                }
                // Try again when there is no fix the host can run (version too new lists it): an
                // expired license offers Renew and Use another license, never Try again.
                if fixes.isEmpty && screen.state != .expired {
                    KitButton(
                        line: CopyLine("common.tryAgain"),
                        kind: .primary,
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
                KitBanner {
                    Image(systemName: "wifi.exclamationmark")
                        .foregroundStyle(style.palette.warning)
                        .accessibilityHidden(true)
                } text: {
                    KitText(lead, .label, color: .strong)
                    if let deadline = screen.line("grace.deadline") {
                        KitText(deadline, .footnote, color: .muted)
                    }
                } actions: {
                    KitButton(
                        line: CopyLine("common.reconnect"), kind: .primary, fullWidth: false,
                        compact: true, action: onReconnect)
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
            #if compiler(>=6.2)
            content.glassEffect(.regular, in: shape)
            #endif
        } else if style.reduceTransparency {
            content.background(shape.fill(style.palette.raised))
                .overlay(shape.strokeBorder(style.palette.border, lineWidth: 1))
        } else {
            content.background(shape.fill(.regularMaterial))
        }
    }
}

// MARK: - Toast

/// A toast (UI-KITS §4.1 Toast): one line, full width at the bottom on a phone, with a draining
/// ring for its 6 s. An error toast never goes away by itself (it is never the only record of the
/// error); every other tone calls `onDismiss` after 6 s.
public struct ToastView: View {
    let text: String
    var tone: StatusPill.Tone = .neutral
    var onDismiss: (() -> Void)?

    /// How long a non-error toast stays.
    public static let lifetime: Double = 6

    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var draining = false

    public init(text: String, tone: StatusPill.Tone = .neutral, onDismiss: (() -> Void)? = nil) {
        self.text = text
        self.tone = tone
        self.onDismiss = onDismiss
    }

    /// An error stays until the person dismisses it.
    static func persists(_ tone: StatusPill.Tone) -> Bool { tone == .danger }

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.xs)) {
                switch tone {
                case .success:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(style.palette.success).accessibilityHidden(true)
                case .warning:
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(style.palette.warning).accessibilityHidden(true)
                case .danger:
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger).accessibilityHidden(true)
                case .neutral:
                    EmptyView()
                }
                Text(text)
                    .font(style.font(.label))
                    .foregroundStyle(style.palette.textStrong)
                    .fixedSize(horizontal: false, vertical: true)
                if sizeClass == .compact { Spacer(minLength: 0) }
                if !Self.persists(tone), onDismiss != nil {
                    Circle()
                        .trim(from: 0, to: draining ? 0 : 1)
                        .stroke(
                            style.palette.textMuted,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                        .frame(width: 16, height: 16)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, style.space(.md))
            .padding(.vertical, style.space(.sm))
            .frame(maxWidth: sizeClass == .compact ? .infinity : nil)
            .modifier(KitFloatingSurface(style: style))
            .padding(.horizontal, sizeClass == .compact ? style.space(.md) : 0)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
            .task {
                guard !Self.persists(tone), let onDismiss else { return }
                if !style.reduceMotion {
                    withAnimation(.linear(duration: Self.lifetime)) { draining = true }
                }
                try? await Task.sleep(nanoseconds: UInt64(Self.lifetime * 1_000_000_000))
                if !Task.isCancelled { onDismiss() }
            }
        }
    }
}

/// The gate's toast: the model's line in the user's language, with the tone its kind has.
struct GateToastView: View {
    let toast: KitGateToast
    var onDismiss: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        ToastView(
            text: strings.string(toast.line), tone: toast.kind == .update ? .neutral : .success,
            onDismiss: onDismiss)
    }
}

/// The floating surface of the compact update progress row.
struct KitFloatingProgressSurface: ViewModifier {
    func body(content: Content) -> some View {
        KitStyleReader { style in
            content.modifier(KitFloatingSurface(style: style))
        }
        .padding(.horizontal)
    }
}
