// @pkey-feature ui.kit
// The product a kit screen leads with (docs/design/UI-KITS.md §1.2: the product is the hero).
//
// Identity resolves in the §1.2 order, field by field:
//
//   1. the integrator's theme: `PolarisCopy.productName` (when set) and `PolarisTheme.logo`;
//   2. the product's presentation (discovery `core.presentation`): name, developer, accent and the
//      icon verified by its sha256. The SDK's accessor arrives with HA-13; until then the
//      environment value below is the seam it plugs into, and it is empty unless a host sets it;
//   3. the app bundle: `CFBundleDisplayName` / `CFBundleName` and the app's icon;
//   4. with no icon at all, a monogram tile: the product's initial on a neutral sunken surface.
//
// It never falls back to a Polaris Key mark (UI-KITS §1.6): kit screens show the product, not us.

import CoreGraphics
import Foundation
import ImageIO
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// The product's registered presentation, as the SDK reads it from discovery (`core.presentation`,
/// WIRE-CONTRACT-V4 §5.5): name, developer, accent per scheme and the verified icon bytes.
///
/// The kit reads it from the environment (`.polarisKeyPresentation(_:)`). The SDK's accessor fills
/// it once HA-13 lands; an integrator's theme always wins over it.
public struct PolarisProductPresentation: Sendable, Equatable {
    public var name: String?
    public var developerName: String?
    /// `#rrggbb`; used in the light scheme, and in the dark one when `accentDark` is nil.
    public var accent: String?
    /// `#rrggbb` for the dark scheme.
    public var accentDark: String?
    /// The icon's bytes (PNG, JPEG, WebP, …), already verified against its sha256.
    public var iconData: Data?

    public init(
        name: String? = nil, developerName: String? = nil, accent: String? = nil,
        accentDark: String? = nil, iconData: Data? = nil
    ) {
        self.name = name
        self.developerName = developerName
        self.accent = accent
        self.accentDark = accentDark
        self.iconData = iconData
    }

    /// The accent input for `scheme`: `accentDark` in the dark scheme when set, else `accent`.
    public func accent(for scheme: ColorScheme) -> String? {
        scheme == .dark ? (accentDark ?? accent) : accent
    }
}

private struct PolarisPresentationKey: EnvironmentKey {
    static let defaultValue: PolarisProductPresentation? = nil
}

extension EnvironmentValues {
    /// The product's presentation for this subtree, or nil (the default) when the SDK has none.
    public var polarisKeyPresentation: PolarisProductPresentation? {
        get { self[PolarisPresentationKey.self] }
        set { self[PolarisPresentationKey.self] = newValue }
    }
}

extension View {
    /// Give every PolarisKeyUI view in this subtree the product's presentation: its name, developer
    /// and icon head the screens, and its accent colours them under `.polarisKey` branding. The
    /// integrator's theme still wins field by field.
    public func polarisKeyPresentation(_ presentation: PolarisProductPresentation?) -> some View {
        environment(\.polarisKeyPresentation, presentation)
    }
}

/// The product as one screen shows it.
struct PolarisProductIdentity {
    enum Icon {
        /// The integrator's own logo view.
        case custom(@Sendable () -> AnyView)
        /// A bitmap icon. `masked` clips it to the app-icon shape (a square icon from the
        /// presentation or an iOS bundle); a macOS bundle icon already carries its shape.
        case image(CGImage, masked: Bool)
        /// No icon anywhere: the product's initial on a neutral tile.
        case monogram(String)
    }

    var name: String
    var developer: String?
    var icon: Icon

    /// The app bundle's half of the identity.
    struct Bundled {
        var name: String?
        var icon: CGImage?
        var iconIsMasked: Bool

        /// The running app's name and icon, read once.
        @MainActor static let main: Bundled = {
            let info = Bundle.main.infoDictionary ?? [:]
            // `object(forInfoDictionaryKey:)` returns the localized value (InfoPlist.strings) when
            // the app has one; the raw dictionary would show the development-language name.
            func bundleString(_ key: String) -> String? {
                (Bundle.main.object(forInfoDictionaryKey: key) as? String)
                    .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            }
            let name = bundleString("CFBundleDisplayName") ?? bundleString("CFBundleName")
            return Bundled(name: name, icon: appIcon(info), iconIsMasked: iconIsMaskedOnPlatform)
        }()

        static let none = Bundled(name: nil, icon: nil, iconIsMasked: false)

        #if os(macOS)
            static let iconIsMaskedOnPlatform = true
        #else
            static let iconIsMaskedOnPlatform = false
        #endif

        @MainActor private static func appIcon(_ info: [String: Any]) -> CGImage? {
            #if os(macOS)
                // Only an app that declares an icon: the generic app glyph is worse than the
                // monogram.
                guard info["CFBundleIconFile"] != nil || info["CFBundleIconName"] != nil else {
                    return nil
                }
                var rect = CGRect(x: 0, y: 0, width: 256, height: 256)
                return NSApplication.shared.applicationIconImage?
                    .cgImage(forProposedRect: &rect, context: nil, hints: nil)
            #elseif canImport(UIKit)
                let icons = info["CFBundleIcons"] as? [String: Any]
                let primary = icons?["CFBundlePrimaryIcon"] as? [String: Any]
                let candidates =
                    ((primary?["CFBundleIconFiles"] as? [String]) ?? []).reversed()
                    + [primary?["CFBundleIconName"] as? String].compactMap { $0 }
                for name in candidates {
                    if let image = UIImage(named: name)?.cgImage { return image }
                }
                return nil
            #else
                return nil
            #endif
        }
    }

    /// The name `PolarisCopy` uses when the integrator gives none.
    static let defaultProductName = PolarisCopy().productName

    /// Resolve the identity in the UI-KITS §1.2 order (see the file header).
    @MainActor static func resolve(
        theme: PolarisTheme, presentation: PolarisProductPresentation?,
        bundle: Bundled? = nil
    ) -> PolarisProductIdentity {
        let bundle = bundle ?? .main
        let integratorName = theme.copy.productName
        let name =
            integratorName != defaultProductName
            ? integratorName
            : (nonEmpty(presentation?.name) ?? nonEmpty(bundle.name) ?? integratorName)
        let icon: Icon
        if let logo = theme.logoOverride {
            icon = .custom(logo)
        } else if let data = presentation?.iconData, let image = IconCache.image(for: data) {
            icon = .image(image, masked: true)
        } else if let image = bundle.icon {
            icon = .image(image, masked: bundle.iconIsMasked)
        } else {
            icon = .monogram(monogram(for: name))
        }
        return PolarisProductIdentity(
            name: name, developer: nonEmpty(presentation?.developerName), icon: icon)
    }

    /// The first letter of the product's name, upper-cased for the tile.
    static func monogram(for name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return "?"
        }
        return String(first).localizedUppercase
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    /// Decoded presentation icons, so a re-render does not decode again.
    @MainActor enum IconCache {
        private static var images: [Data: CGImage] = [:]

        static func image(for data: Data) -> CGImage? {
            if let hit = images[data] { return hit }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else { return nil }
            if images.count > 4 { images.removeAll() }
            images[data] = image
            return image
        }
    }
}

/// The product's icon at one size: the integrator's logo, the bitmap icon, or the monogram tile.
struct PolarisProductIcon: View {
    let identity: PolarisProductIdentity
    let size: CGFloat
    let style: PolarisKitStyle

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        Group {
            switch identity.icon {
            case .custom(let logo):
                logo().frame(width: size, height: size)
            case .image(let image, let masked):
                let picture = Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: size, height: size)
                if masked {
                    picture.clipShape(shape)
                        .overlay(shape.strokeBorder(style.palette.borderSubtle, lineWidth: 0.5))
                } else {
                    picture
                }
            case .monogram(let letter):
                // An OPAQUE tile, grouped before any shadow, so a drop shadow never shows through
                // as a grey smudge behind the letter.
                shape.fill(style.palette.raised)
                    .overlay(shape.strokeBorder(style.palette.borderSubtle, lineWidth: 1))
                    .overlay(
                        Text(letter)
                            .font(style.typography.fixedFont(size: size * 0.46, bold: true))
                            .foregroundStyle(style.palette.textStrong)
                    )
                    .frame(width: size, height: size)
                    .compositingGroup()
            }
        }
        .accessibilityHidden(true)
    }
}

/// The product header on a focused step (UI-KITS §1.2): the icon beside the product's name in the
/// strong text colour, the strongest line in the header. In the split the pane carries the icon, so
/// the header is the name alone (`showsIcon: false`).
struct PolarisProductHeader: View {
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle
    var alignment: HorizontalAlignment = .center
    var showsIcon = true

    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 32

    var body: some View {
        HStack(spacing: PolarisSpace.xs) {
            if showsIcon {
                PolarisProductIcon(identity: identity, size: min(iconSize, 48), style: style)
            }
            Text(identity.name)
                .font(style.font(.label))
                .foregroundStyle(style.palette.textStrong)
                .lineLimit(2)
                .multilineTextAlignment(alignment == .leading ? .leading : .center)
        }
        .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .center)
        .accessibilityElement(children: .combine)
    }
}
