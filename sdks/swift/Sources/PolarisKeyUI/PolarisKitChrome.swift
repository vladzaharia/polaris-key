// Shared building blocks for the kit's components: the theme resolution, the parts every page
// draws (heading, actions, the user code, the countdown, copy controls; the page itself is in
// PolarisKitLayout.swift), and a QR code from CoreImage for TV screens.
//
// Defaults are native and neutral (system fonts, the host's tint, system colours); the Polaris
// Key branding is opt-in through `PolarisTheme` or `.polarisKeyBranding(.polarisKey)`, and the
// "Powered by" badge is off unless the theme asks for it.

import CoreImage
import CoreImage.CIFilterBuiltins
import PolarisKeyCore
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// The resolved look for one render: palette, type and tint under the environment's branding and
/// the product's presentation.
struct PolarisKitStyle {
    let theme: PolarisTheme
    let branding: PolarisBranding
    let scheme: ColorScheme
    let palette: PolarisPalette
    let typography: PolarisTypography
    let tint: Color?

    init(
        theme: PolarisTheme, scheme: ColorScheme, branding: PolarisBranding,
        presentation: PolarisProductPresentation? = nil
    ) {
        self.theme = theme
        self.branding = theme.resolvedBranding(branding)
        self.scheme = scheme
        self.palette = theme.resolvedPalette(
            for: scheme, branding: branding, presentation: presentation)
        self.typography = theme.resolvedTypography(branding: branding)
        self.tint = theme.setsTint(branding: branding) ? palette.accent : nil
    }

    /// Whether the kit imposes a tint at all (false natively, where the host tint leads).
    var setsTint: Bool { tint != nil }

    /// The colour for accent-coloured TEXT and glyphs (Cancel, Paste, Copy link, the countdown
    /// ring, copy controls): `accentText` when the kit sets a tint, so these clear 4.5:1 on the
    /// page; nil natively, where the host tint flows through. Never the solid fill accent, which is
    /// reserved for prominent button fills.
    var textTint: Color? { setsTint ? palette.accentText : nil }

    /// A shape style for `textTint`, falling back to the environment tint natively.
    var textTintStyle: AnyShapeStyle { textTint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.tint) }

    /// The text roles kit surfaces use beyond the gate's public `PolarisTypography.Role`.
    enum TextRole {
        /// Headings (`.title2`, bold face).
        case title
        /// The lede under a heading (`.subheadline` on iOS, `.body` on macOS).
        case subtitle
        /// Body copy (`.body`).
        case body
        /// The product's name beside its icon, and button labels (`.body`, weight 500).
        case label
        /// The product's name in the identity pane (`.title2`, bold face).
        case paneTitle
        /// The gate's Welcome title: larger on macOS (26 pt) than a page title (SIGN-IN.md / the
        /// UI-KITS macOS row).
        case welcomeTitle
        /// Supporting lines: the countdown, "check the code" (`.footnote` on iOS, `.callout` on
        /// macOS, where the footnote style is 10 pt).
        case meta
        /// Small print (`.caption`).
        case caption
    }

    /// The monospaced face at a fixed size: JetBrains Mono under `.brand`, SF Mono under `.system`,
    /// the product's own mono under `.custom`. Used for the user code, the license key and the
    /// offline request code.
    /// The mono face scaling with Dynamic Type from `.body` (key and request code text).
    var monoBody: Font { typography.monoBodyFont() }

    func monoFont(size: CGFloat) -> Font {
        typography.monoFont(size: size)
    }

    func font(_ role: TextRole) -> Font {
        switch role {
        case .title:
            #if os(macOS)
                // The macOS title2 is 17 pt; a page title takes the 22 pt title row.
                return typography.font(style: .title, emphasis: .bold)
            #else
                return typography.font(.title)
            #endif
        case .welcomeTitle:
            #if os(macOS)
                return typography.font(style: .largeTitle, emphasis: .bold)
            #else
                return typography.font(.title)
            #endif
        case .subtitle:
            #if os(macOS)
                // The macOS subheadline is 11 pt, smaller than the supporting lines; a lede is
                // body copy there (KitTokens.MacOS: body 13, meta 12).
                return typography.font(style: .body, emphasis: .regular)
            #else
                return typography.font(.subtitle)
            #endif
        case .body: return typography.font(.body)
        case .caption: return typography.font(.caption)
        case .label: return typography.font(style: .body, emphasis: .medium)
        case .paneTitle: return typography.font(style: .title2, emphasis: .bold)
        case .meta:
            #if os(macOS)
                return typography.font(style: .callout, emphasis: .regular)
            #else
                return typography.font(style: .footnote, emphasis: .regular)
            #endif
        }
    }

    /// The sunken fill under the monogram tile: the brand's sunken surface, or the system's
    /// tertiary fill natively.
    var sunken: AnyShapeStyle {
        if theme.palette != nil { return AnyShapeStyle(palette.textStrong.opacity(0.06)) }
        switch branding {
        case .polarisKey:
            let sunken =
                scheme == .light ? PolarisBrand.Light.surfaceSunken : PolarisBrand.Dark.surfaceSunken
            return AnyShapeStyle(sunken.color)
        case .native:
            return AnyShapeStyle(.fill.tertiary)
        }
    }

    /// The fill for an output tile (the user code, the offline request code): one step ABOVE the
    /// page in dark (the sunken surface is 1.03:1 on the page), the sunken surface in light. Always
    /// carries a `borderSubtle` stroke so its edge is visible. Natively, a quiet system fill.
    var tileFill: AnyShapeStyle {
        if theme.palette != nil { return AnyShapeStyle(palette.textStrong.opacity(0.06)) }
        switch branding {
        case .polarisKey:
            let token =
                scheme == .light ? PolarisBrand.Light.surfaceSunken : PolarisBrand.Dark.surfaceRaised
            return AnyShapeStyle(token.color)
        case .native:
            return AnyShapeStyle(.fill.quaternary)
        }
    }

    /// The quiet ground for the split's icon pane under the native preset: one step quieter than
    /// the form side, and never brighter than it.
    var paneGround: Color {
        #if os(macOS)
            return Color(nsColor: .underPageBackgroundColor)
        #else
            return Color(uiColor: .secondarySystemBackground)
        #endif
    }
}

/// The heading of a kit page: the product header (the app header persists, SIGN-IN.md §3.17), an
/// optional status glyph, and the title. In the split the icon pane carries the icon, so the header
/// row is the product name alone. When the page is compressed the header and title are capped at
/// accessibility1 and the name is kept to two lines, so the essential act still fits.
struct PolarisPageHeading: View {
    let title: String
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle
    let layout: PolarisKitLayout
    /// A status glyph (expired, failed, signed in) drawn under the product header.
    var symbol: String? = nil
    var symbolTint: Color? = nil

    @Environment(\.polarisPageFit) private var fit

    var body: some View {
        VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.s) {
            PolarisProductHeader(
                identity: identity, style: style, alignment: layout.horizontalAlignment,
                showsIcon: layout != .split)
            if let symbol {
                Image(systemName: symbol)
                    .font(.largeTitle).imageScale(.large)
                    .foregroundStyle(symbolTint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.tint))
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(style.font(.title)).foregroundStyle(style.palette.textStrong)
                .multilineTextAlignment(layout.textAlignment)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
        .modifier(PolarisCompressedType(compressed: fit.compressed))
    }
}

/// Cap the type at accessibility1 on a compressed page, so the heading cannot push the act off. One
/// modifier either way (never a conditional wrapper), so the view structure below it is identical
/// whether the page is compressed or not.
struct PolarisCompressedType: ViewModifier {
    let compressed: Bool
    func body(content: Content) -> some View {
        content.dynamicTypeSize(
            ...(compressed ? DynamicTypeSize.accessibility1 : DynamicTypeSize.accessibility5))
    }
}

/// Secondary copy under a page heading, aligned for the layout.
struct PolarisPageText: View {
    let text: Text
    let style: PolarisKitStyle
    let layout: PolarisKitLayout
    var role: PolarisKitStyle.TextRole = .subtitle

    var body: some View {
        text
            .font(style.font(role))
            .foregroundStyle(style.palette.textMuted)
            .multilineTextAlignment(layout.textAlignment)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
    }
}

/// A page's actions. On iOS, full-width buttons stacked with the primary on top. On macOS, the
/// dialog idiom: one row, an optional leading button (offline's Paste), then the secondary and the
/// primary at the trailing end, with Cancel immediately left of the default (Return and Escape),
/// stacking only when the row cannot fit. Every label goes through one role, so the Polaris preset
/// is Rubik and the native preset keeps the system's own prominent weight.
struct PolarisPageActions: View {
    let primaryTitle: String
    let primary: () -> Void
    var secondaryTitle: String? = nil
    var secondary: (() -> Void)? = nil
    /// An extra action at the leading edge of the macOS row (offline's Paste). It joins the stack
    /// as a second secondary on iOS.
    var leadingTitle: String? = nil
    var leading: (() -> Void)? = nil
    let layout: PolarisKitLayout
    let style: PolarisKitStyle
    var primaryDisabled = false
    /// Whether the secondary dismisses (Escape triggers it); false for a second way forward.
    var secondaryCancels = true
    /// A busy label shown in place of the primary's title while it works.
    var primaryBusy: String? = nil

    var body: some View {
        #if os(macOS)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: PolarisSpace.s) {
                    leadingButton(fullWidth: false)
                    Spacer(minLength: 0)
                    secondaryButton(fullWidth: false)
                    primaryButton(fullWidth: false)
                }
                .frame(maxWidth: .infinity)
                stacked
            }
        #else
            stacked
        #endif
    }

    private var stacked: some View {
        VStack(spacing: PolarisSpace.s) {
            primaryButton(fullWidth: true)
            leadingButton(fullWidth: true)
            secondaryButton(fullWidth: true)
        }
    }

    private func primaryButton(fullWidth: Bool) -> some View {
        Button(action: primary) {
            label(primaryBusy ?? primaryTitle, busy: primaryBusy != nil, fullWidth: fullWidth)
        }
        .polarisPrimaryButton()
        .modifier(PolarisButtonSkin(style: style, prominent: true))
        .keyboardShortcut(.defaultAction)
        .disabled(primaryDisabled)
        .polarisLayoutProbe(.primaryAction)
    }

    @ViewBuilder private func secondaryButton(fullWidth: Bool) -> some View {
        if let secondaryTitle, let secondary {
            Button(action: secondary) {
                label(secondaryTitle, busy: false, fullWidth: fullWidth)
            }
            .polarisSecondaryButton()
            .modifier(KitTint(color: style.textTint))
            .modifier(PolarisButtonSkin(style: style, prominent: false))
            .modifier(CancelShortcut(active: secondaryCancels))
            .polarisLayoutProbe(.secondaryAction)
        }
    }

    @ViewBuilder private func leadingButton(fullWidth: Bool) -> some View {
        if let leadingTitle, let leading {
            Button(action: leading) {
                label(leadingTitle, busy: false, fullWidth: fullWidth)
            }
            .polarisSecondaryButton()
            .modifier(KitTint(color: style.textTint))
            .modifier(PolarisButtonSkin(style: style, prominent: false))
            .polarisLayoutProbe(.leadingAction)
        }
    }

    @ViewBuilder private func label(_ title: String, busy: Bool, fullWidth: Bool) -> some View {
        HStack(spacing: PolarisSpace.xs) {
            if busy { ProgressView().controlSize(.small) }
            Text(title)
        }
        .modifier(PolarisButtonFont(style: style))
        .frame(maxWidth: fullWidth ? .infinity : nil)
    }
}

/// One label font for every kit button: Rubik `.label` under the Polaris preset, and no override
/// natively, so the system's own prominent weight applies.
struct PolarisButtonFont: ViewModifier {
    let style: PolarisKitStyle
    func body(content: Content) -> some View {
        if style.branding == .polarisKey {
            content.font(style.font(.label))
        } else {
            content
        }
    }
}

/// Draws a kit button with the resolved accent when the kit sets a tint (the Polaris preset or an
/// integrator accent), because the system's tinted styles do not reach 4.5:1 everywhere (a tinted
/// prominent button on macOS renders lighter than its tint; a bordered one's text sits on a
/// tinted fill). Prominent: a capsule filled with `accent` and labelled `onAccent`. Secondary: a
/// capsule outline and label in `accentText`, which clears 4.5:1 on the page. Natively nothing
/// changes: the system styles carry the host's tint.
struct PolarisButtonSkin: ViewModifier {
    let style: PolarisKitStyle
    let prominent: Bool

    func body(content: Content) -> some View {
        if style.setsTint {
            content.buttonStyle(
                PolarisSkinStyle(
                    prominent: prominent, fill: style.palette.accent, on: style.palette.onAccent,
                    text: style.palette.accentText))
        } else if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

struct PolarisSkinStyle: ButtonStyle {
    let prominent: Bool
    let fill: Color
    let on: Color
    let text: Color

    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled

    private var vertical: CGFloat {
        switch controlSize {
        case .extraLarge: return 18
        case .large: return 14
        case .regular: return 10
        default: return 6
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(prominent ? on : text)
            .padding(.vertical, vertical)
            .padding(.horizontal, 16)
            .background {
                if prominent {
                    Capsule().fill(fill)
                } else {
                    // Clipped to the capsule: an unclipped stroke left a stray bar at each end.
                    Capsule().strokeBorder(text, lineWidth: 1.5).clipShape(Capsule())
                }
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .contentShape(Capsule())
    }
}

/// Escape for a control that dismisses.
struct CancelShortcut: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active { content.keyboardShortcut(.cancelAction) } else { content }
    }
}

/// A copy control: a ghost icon (or a quiet titled button) that confirms with a check for two
/// seconds and announces the copy to VoiceOver. Accent-coloured text uses `textTint`, so it clears
/// 4.5:1; natively the host tint flows through.
struct PolarisCopyButton: View {
    /// What lands on the pasteboard.
    let value: String
    /// The control's accessible name ("Copy code", "Copy link").
    let title: String
    let copiedTitle: String
    var showsTitle = false
    var systemImage = "doc.on.doc"
    let style: PolarisKitStyle
    /// The icon-only control's square side.
    var iconSide: CGFloat = 28

    @State private var copied = false

    var body: some View {
        Button {
            PolarisPasteboard.copy(value)
            copied = true
            PolarisAccessibility.announce(copiedTitle)
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                copied = false
            }
        } label: {
            if showsTitle {
                Label(
                    copied ? copiedTitle : title,
                    systemImage: copied ? "checkmark" : systemImage)
            } else {
                Image(systemName: copied ? "checkmark" : systemImage)
                    .font(.system(size: iconSide * 0.62))
                    .frame(width: iconSide, height: iconSide)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.borderless)
        .font(style.font(.meta))
        .foregroundStyle(style.textTintStyle)
        .accessibilityLabel(copied ? copiedTitle : title)
        .help(title)
    }
}

/// The device-code countdown: a determinate ring that empties as the code ages, and "Code expires
/// in 4:12" in tabular digits; VoiceOver hears the time as a spoken duration.
struct PolarisCountdown: View {
    let expiresAt: Int
    let lifetime: Int
    let label: String
    let style: PolarisKitStyle

    @ScaledMetric(relativeTo: .footnote) private var ring: CGFloat = 14

    private static let spoken: DateComponentsFormatter = {
        let f = DateComponentsFormatter()
        f.allowedUnits = [.minute, .second]
        f.unitsStyle = .full
        return f
    }()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, expiresAt - Int(context.date.timeIntervalSince1970))
            let fraction = lifetime > 0 ? min(1, Double(left) / Double(lifetime)) : 0
            HStack(spacing: PolarisSpace.xs) {
                ZStack {
                    Circle().stroke(style.palette.borderSubtle, lineWidth: 2)
                    Circle()
                        .trim(from: 0, to: fraction)
                        .stroke(style.textTintStyle, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: ring, height: ring)
                .accessibilityHidden(true)
                Text("\(label) \(left / 60):\(String(format: "%02d", left % 60))")
                    .font(style.font(.meta).monospacedDigit())
                    .foregroundStyle(style.palette.textMuted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "\(label) \(Self.spoken.string(from: Double(left)) ?? "\(left) seconds")")
        }
    }
}

/// The user code at hero size, mono, on a bordered output tile so it reads as output, not a field.
/// At standard sizes it is one line (it shrinks rather than wrap) with a space the width of the
/// inline Copy balancing it. At accessibility sizes the inline Copy is dropped (a labelled Copy
/// code control joins the countdown row), the code takes the full tile width with tighter tracking,
/// and it wraps at the hyphen into groups rather than shrink below the surrounding text.
struct PolarisUserCode: View {
    let code: String
    let style: PolarisKitStyle
    let copy: PolarisKitCopy

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    #if os(macOS)
        @ScaledMetric(relativeTo: .title) private var size: CGFloat = 30
    #else
        @ScaledMetric(relativeTo: .title) private var size: CGFloat = 34
    #endif
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 28

    private var isAX: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        let points = min(size, isAX ? 72 : 56)
        let side = min(control, 36)
        HStack(spacing: PolarisSpace.xs) {
            if !isAX {
                Color.clear.frame(width: side, height: 1).accessibilityHidden(true)
            }
            Text(code)
                .font(style.monoFont(size: points))
                .tracking(points * (isAX ? 0.02 : 0.06))
                .foregroundStyle(style.palette.textStrong)
                .lineLimit(isAX ? 2 : 1)
                .minimumScaleFactor(isAX ? 0.5 : 0.4)
                // The height is never squeezed: a squeezed page would otherwise scale the code
                // down (the scale factor answers any shortfall), so only width can shrink it.
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .accessibilityLabel(
                    "\(copy.codeLabel): \(code.map(String.init).joined(separator: " "))")
                .polarisLayoutProbe(.code)
                .frame(maxWidth: .infinity)
            if !isAX {
                PolarisCopyButton(
                    value: code, title: copy.copyCodeLabel, copiedTitle: copy.copiedLabel,
                    style: style, iconSide: side)
            }
        }
        .padding(.vertical, PolarisSpace.s)
        .padding(.horizontal, PolarisSpace.s)
        .background(style.tileFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(style.palette.borderSubtle, lineWidth: 1))
    }
}

/// Post a VoiceOver announcement, on either platform.
enum PolarisAccessibility {
    @MainActor static func announce(_ message: String) {
        #if canImport(UIKit)
            UIAccessibility.post(notification: .announcement, argument: message)
        #elseif canImport(AppKit)
            if let app = NSApp {
                NSAccessibility.post(
                    element: app, notification: .announcementRequested,
                    userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.high.rawValue])
            }
        #endif
    }
}

/// An inline error line in the danger colour.
struct PolarisErrorLine: View {
    let message: String
    let theme: PolarisTheme
    var alignment: TextAlignment = .center

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding

    var body: some View {
        let style = PolarisKitStyle(theme: theme, scheme: colorScheme, branding: branding)
        Label {
            Text(message).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill").accessibilityHidden(true)
        }
        .font(style.font(.caption)).foregroundStyle(style.palette.danger)
        .multilineTextAlignment(alignment)
    }
}

/// `.tint(color)` when given, otherwise the host's tint flows through.
struct KitTint: ViewModifier {
    let color: Color?
    func body(content: Content) -> some View {
        if let color { content.tint(color) } else { content }
    }
}

extension View {
    /// The kit's primary and secondary buttons are large. The button STYLE comes from
    /// `PolarisButtonSkin`, which must be the only `buttonStyle` on the button (the innermost style
    /// wins, so a system style applied before the skin would hide it).
    func polarisPrimaryButton() -> some View { self.controlSize(.large) }
    func polarisSecondaryButton() -> some View { self.controlSize(.large) }
}

/// A QR code for `text`, drawn by CoreImage's generator (no dependency), crisp at any size.
public struct PolarisQRCode: View {
    public let text: String
    public var accessibilityLabel: String

    public init(_ text: String, accessibilityLabel: String = "QR code") {
        self.text = text
        self.accessibilityLabel = accessibilityLabel
    }

    public var body: some View {
        if let image = PolarisQRCode.cgImage(for: text) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(PolarisSpace.s)
                .background(RoundedRectangle(cornerRadius: PolarisSpace.s).fill(Color.white))
                .accessibilityElement()
                .accessibilityLabel(accessibilityLabel)
                .accessibilityAddTraits(.isImage)
        }
    }

    /// The QR code's modules as a `CGImage`, scaled up by an integer factor so the bitmap is large
    /// enough to stay crisp whatever interpolation the drawn size applies, or nil when `text`
    /// cannot be encoded. Medium error correction.
    public static func cgImage(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // The generator emits one pixel per module; scale so the smallest TV/pane draw (about 200
        // pt at 3x) is covered without resampling blur.
        let modules = max(output.extent.width, 1)
        let scale = max(1, (720 / modules).rounded(.up))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext(options: [.useSoftwareRenderer: true])
            .createCGImage(scaled, from: scaled.extent)
    }
}
