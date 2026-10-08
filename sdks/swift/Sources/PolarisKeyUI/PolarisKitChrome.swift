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
        /// Supporting lines: the countdown, "check the code" (`.footnote` on iOS, `.callout` on
        /// macOS, where the footnote style is 10 pt).
        case meta
        /// Small print (`.caption`).
        case caption
    }

    func font(_ role: TextRole) -> Font {
        switch role {
        case .title: return typography.font(.title)
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

    /// The sunken fill under the user code and the monogram tile: the brand's sunken surface, or
    /// the system's tertiary fill natively.
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
}

/// The heading of a kit page: the product header (icon and name; the split's identity pane shows
/// them instead), an optional status glyph, and the title.
struct PolarisPageHeading: View {
    let title: String
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle
    let layout: PolarisKitLayout
    /// A status glyph (expired, failed, signed in) drawn in place of the product header.
    var symbol: String? = nil
    var symbolTint: Color? = nil

    var body: some View {
        VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.s) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.largeTitle).imageScale(.large)
                    .foregroundStyle(symbolTint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.tint))
                    .accessibilityHidden(true)
            } else if layout != .split {
                PolarisProductHeader(
                    identity: identity, style: style, alignment: layout.horizontalAlignment)
            }
            Text(title)
                .font(style.font(.title)).foregroundStyle(style.palette.textStrong)
                .multilineTextAlignment(layout.textAlignment)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
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
/// dialog idiom: one row, Cancel before the primary, the primary on Return and Cancel on Escape,
/// stacking only when the row cannot fit.
struct PolarisPageActions: View {
    let primaryTitle: String
    let primary: () -> Void
    var secondaryTitle: String? = nil
    var secondary: (() -> Void)? = nil
    let layout: PolarisKitLayout
    var primaryDisabled = false
    /// Whether the secondary dismisses (Escape triggers it); false for a second way forward.
    var secondaryCancels = true

    var body: some View {
        #if os(macOS)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: PolarisSpace.s) {
                    if layout != .column { Spacer(minLength: 0) }
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
            secondaryButton(fullWidth: true)
        }
    }

    private func primaryButton(fullWidth: Bool) -> some View {
        Button(action: primary) {
            Text(primaryTitle).frame(maxWidth: fullWidth ? .infinity : nil)
        }
        .polarisPrimaryButton()
        .keyboardShortcut(.defaultAction)
        .disabled(primaryDisabled)
        .polarisLayoutProbe(.primaryAction)
    }

    @ViewBuilder private func secondaryButton(fullWidth: Bool) -> some View {
        if let secondaryTitle, let secondary {
            Button(action: secondary) {
                Text(secondaryTitle).frame(maxWidth: fullWidth ? .infinity : nil)
            }
            .polarisSecondaryButton()
            .modifier(CancelShortcut(active: secondaryCancels))
        }
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
/// seconds.
struct PolarisCopyButton: View {
    /// What lands on the pasteboard.
    let value: String
    /// The control's name ("Copy", "Copy link").
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
        .foregroundStyle(style.tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.tint))
        .accessibilityLabel(copied ? copiedTitle : title)
        .help(title)
    }
}

/// The device-code countdown: a determinate ring that empties as the code ages, and "Code expires
/// in 4:12" in tabular digits.
struct PolarisCountdown: View {
    let expiresAt: Int
    let lifetime: Int
    let label: String
    let style: PolarisKitStyle

    @ScaledMetric(relativeTo: .footnote) private var ring: CGFloat = 14

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, expiresAt - Int(context.date.timeIntervalSince1970))
            let fraction = lifetime > 0 ? min(1, Double(left) / Double(lifetime)) : 0
            HStack(spacing: PolarisSpace.xs) {
                ZStack {
                    Circle().stroke(style.palette.borderSubtle, lineWidth: 2)
                    Circle()
                        .trim(from: 0, to: fraction)
                        .stroke(
                            style.tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.tint),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: ring, height: ring)
                .accessibilityHidden(true)
                Text("\(label) \(left / 60):\(String(format: "%02d", left % 60))")
                    .font(style.font(.meta).monospacedDigit())
                    .foregroundStyle(style.palette.textMuted)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// The user code at hero size: mono, one line (it shrinks rather than wrap or truncate), on a
/// borderless sunken fill so it reads as output, not as a field, with a ghost Copy at the inline
/// end. The code is centred on the fill: a space the width of Copy balances it on the other side.
struct PolarisUserCode: View {
    let code: String
    let style: PolarisKitStyle
    let copy: PolarisKitCopy

    #if os(macOS)
        @ScaledMetric(relativeTo: .title) private var size: CGFloat = 30
    #else
        @ScaledMetric(relativeTo: .title) private var size: CGFloat = 34
    #endif
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 28

    var body: some View {
        let points = min(size, 56)
        let side = min(control, 36)
        HStack(spacing: PolarisSpace.xs) {
            Color.clear.frame(width: side, height: 1).accessibilityHidden(true)
            Text(code)
                .font(.system(size: points, weight: .medium, design: .monospaced))
                .tracking(points * 0.06)
                .foregroundStyle(style.palette.textStrong)
                .lineLimit(1)
                .minimumScaleFactor(0.4)
                .textSelection(.enabled)
                .accessibilityLabel(
                    "\(copy.codeLabel): \(code.map(String.init).joined(separator: " "))")
                .polarisLayoutProbe(.code)
                .frame(maxWidth: .infinity)
            PolarisCopyButton(
                value: code, title: copy.copyButton, copiedTitle: copy.copiedLabel, style: style,
                iconSide: side)
        }
        .padding(.vertical, PolarisSpace.s)
        .padding(.horizontal, PolarisSpace.s)
        .background(style.sunken, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
    /// The kit's primary (prominent, large) button look, in the system's own shape.
    func polarisPrimaryButton() -> some View {
        self.buttonStyle(.borderedProminent)
            .controlSize(.large)
    }

    /// The kit's secondary (bordered, large) button look, in the system's own shape.
    func polarisSecondaryButton() -> some View {
        self.buttonStyle(.bordered)
            .controlSize(.large)
    }
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

    /// The QR code's modules as a `CGImage` (one pixel per module), or nil when `text` cannot be
    /// encoded. Medium error correction.
    public static func cgImage(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext(options: [.useSoftwareRenderer: true])
            .createCGImage(output, from: output.extent)
    }
}
