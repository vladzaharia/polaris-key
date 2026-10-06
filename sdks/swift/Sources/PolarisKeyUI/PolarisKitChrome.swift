// Shared building blocks for the kit's components: the centred card every full-screen component
// uses (the same geometry as the gate), the theme resolution, and a QR code from CoreImage.
//
// Defaults are native and neutral (system fonts, the host's tint, system colours); the Polaris
// Key branding is opt-in through `PolarisTheme` or `.polarisKeyBranding(.polarisKey)`, and the
// "Powered by" badge is off unless the theme asks for it.

import CoreImage
import CoreImage.CIFilterBuiltins
import PolarisKeyCore
import SwiftUI

/// The resolved look for one render: palette, type and tint under the environment's branding.
struct PolarisKitStyle {
    let theme: PolarisTheme
    let palette: PolarisPalette
    let typography: PolarisTypography
    let tint: Color?

    init(theme: PolarisTheme, scheme: ColorScheme, branding: PolarisBranding) {
        self.theme = theme
        self.palette = theme.resolvedPalette(for: scheme, branding: branding)
        self.typography = theme.resolvedTypography(branding: branding)
        self.tint = theme.setsTint(branding: branding) ? palette.accent : nil
    }

    func font(_ role: PolarisTypography.Role) -> Font { typography.font(role) }
}

/// A card centred on the page at the gate's comfortable width, scrolling when Dynamic Type makes
/// it taller than the screen.
struct PolarisCard<Content: View>: View {
    let theme: PolarisTheme
    var maxWidth: CGFloat = PolarisGateLayout.cardMaxWidth
    var fillsPage = true
    @ViewBuilder let content: () -> Content

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding
    @ScaledMetric(relativeTo: .body) private var scaledPadding: CGFloat = 24

    var body: some View {
        let style = PolarisKitStyle(theme: theme, scheme: colorScheme, branding: branding)
        let shape = RoundedRectangle(cornerRadius: PolarisGateLayout.cardRadius, style: .continuous)
        let card = VStack(spacing: 20) { content() }
            .padding(min(scaledPadding, PolarisGateLayout.cardPaddingMax))
            .frame(maxWidth: maxWidth)
            .background(shape.fill(style.palette.raised))
            .overlay(shape.strokeBorder(style.palette.borderSubtle, lineWidth: 1))
            .modifier(KitTint(color: style.tint))
        if fillsPage {
            GeometryReader { proxy in
                ScrollView(.vertical) {
                    card
                        .padding(.horizontal, PolarisGateLayout.pagePadding)
                        .padding(.vertical, 32)
                        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .background(style.palette.page.ignoresSafeArea())
        } else {
            card
        }
    }
}

/// A heading and an optional subtitle, centred, read by VoiceOver as one element.
struct PolarisHeading: View {
    let title: String
    var subtitle: String?
    var symbol: String?
    let theme: PolarisTheme

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding

    var body: some View {
        let style = PolarisKitStyle(theme: theme, scheme: colorScheme, branding: branding)
        VStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.largeTitle).imageScale(.large)
                    .foregroundStyle(.tint)
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(style.font(.title)).foregroundStyle(style.palette.textStrong)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(style.font(.subtitle)).foregroundStyle(style.palette.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// An inline error line in the danger colour.
struct PolarisErrorLine: View {
    let message: String
    let theme: PolarisTheme

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
        .multilineTextAlignment(.center)
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
    /// The kit's primary (prominent, full-width, large) button look.
    func polarisPrimaryButton() -> some View {
        self.buttonStyle(.borderedProminent)
            .controlSize(.large)
            .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
    }

    /// The kit's secondary (bordered, full-width, large) button look.
    func polarisSecondaryButton() -> some View {
        self.buttonStyle(.bordered)
            .controlSize(.large)
            .buttonBorderShape(.roundedRectangle(radius: PolarisGateLayout.controlRadius))
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
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
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
