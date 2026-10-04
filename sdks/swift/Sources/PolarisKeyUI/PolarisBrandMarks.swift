// The launch kit's artwork, as SwiftUI views: the Pinned K (the gate's default logo) and the
// "Powered by Polaris Key" badge. Both render the kit's own PNGs, bundled unchanged in
// `Resources/Brand/` (tools/sync-brand-assets.sh copies them; BrandThemeTests checks the bytes), so
// the marks are never redrawn. "dark" artwork is FOR dark grounds: each view picks its variant from
// the `colorScheme` environment.

import Foundation
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

#if DEBUG
    import os
#endif

/// A bundled brand resource by its path under `Resources/Brand/` (for example
/// `"fonts/OFL.txt"`), or nil when it is missing.
func brandResourceURL(_ relativePath: String) -> URL? {
    let url = URL(fileURLWithPath: relativePath)
    let directory = url.deletingLastPathComponent().relativePath
    return Bundle.module.url(
        forResource: url.deletingPathExtension().lastPathComponent,
        withExtension: url.pathExtension,
        subdirectory: directory == "." ? "Brand" : "Brand/\(directory)")
}

/// A bundled kit PNG as a SwiftUI `Image`, or nil when the resource is missing.
func brandImage(_ path: String) -> Image? {
    guard let url = brandResourceURL(path + ".png") else { return nil }
    #if canImport(UIKit)
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        return Image(uiImage: image)
    #elseif canImport(AppKit)
        guard let image = NSImage(contentsOf: url) else { return nil }
        return Image(nsImage: image)
    #else
        return nil
    #endif
}

/// The Pinned K, the platform mark, in its display cut and without a terminal bit: SDK UI is a core
/// surface, and the default mark carries no bit (BRAND.md §6, §7.1).
///
/// Only the display cut is bundled, so `size` is raised to the display range (more than
/// `PolarisBrand.serviceMax` points): the optical cut is chosen by displayed size, never by
/// scaling a larger drawing down into the service or favicon range.
public struct PolarisMark: View {
    @Environment(\.colorScheme) private var colorScheme
    private let size: CGFloat
    private let label: String?

    /// - Parameters:
    ///   - size: the displayed glyph size in points (at least 33; 48 by default).
    ///   - accessibilityLabel: "Polaris Key" by default. Pass nil when an adjacent visible label
    ///     already names it, which makes the mark decorative.
    nonisolated public init(size: CGFloat = 48, accessibilityLabel: String? = "Polaris Key") {
        self.size = PolarisMark.displaySize(size)
        self.label = accessibilityLabel
    }

    /// The displayed size after the display-cut floor.
    nonisolated public static func displaySize(_ requested: CGFloat) -> CGFloat {
        max(requested, CGFloat(PolarisBrand.serviceMax) + 1)
    }

    public var body: some View {
        let view = Group {
            if let image = brandImage(
                "marks/key-\(colorScheme == .light ? "light" : "dark")-192")
            {
                image.resizable().interpolation(.high).scaledToFit()
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
        if let label {
            view.accessibilityElement().accessibilityLabel(label)
                .accessibilityAddTraits(.isImage)
        } else {
            view.accessibilityHidden(true)
        }
    }
}

/// The "Powered by Polaris Key" badge, for a product's own surfaces: its about or credits screen,
/// its licence or account screen. Polaris Key's own surfaces never show it (BRAND.md §7.2).
///
/// The badge is the kit artwork, padding included (never cropped), and never smaller than the kit
/// minimum for its layout: a smaller `width` is raised to the minimum.
public struct PolarisPoweredByBadge: View {
    /// The kit's badge layouts: compact for app UI, horizontal for footers and credits, stacked for
    /// square placements.
    public enum Layout: String, Sendable, CaseIterable {
        case compact, horizontal, stacked

        /// The kit minimum, in points.
        public var minimumSize: CGSize {
            let m: (width: Double, height: Double)
            switch self {
            case .compact: m = PolarisBrand.badgeMinCompact
            case .horizontal: m = PolarisBrand.badgeMinHorizontal
            case .stacked: m = PolarisBrand.badgeMinStacked
            }
            return CGSize(width: m.width, height: m.height)
        }
    }

    /// Transparent and outline need a clean ground of matching contrast; sticker carries its own
    /// plate, for busy imagery.
    public enum Treatment: String, Sendable, CaseIterable {
        case transparent, outline, sticker
    }

    @Environment(\.colorScheme) private var colorScheme
    private let layout: Layout
    private let treatment: Treatment
    private let size: CGSize

    /// - Parameter width: the displayed width in points; nil, or anything below the minimum,
    ///   renders at the kit minimum. The height follows the artwork's aspect ratio.
    nonisolated public init(
        layout: Layout = .compact, treatment: Treatment = .transparent, width: CGFloat? = nil
    ) {
        self.layout = layout
        self.treatment = treatment
        self.size = PolarisPoweredByBadge.size(layout: layout, width: width)
    }

    /// The rendered size for a requested width: the minimum, or the requested width at the
    /// artwork's aspect ratio when that is larger.
    nonisolated public static func size(layout: Layout, width: CGFloat?) -> CGSize {
        let minimum = layout.minimumSize
        guard let width, width > minimum.width else {
            #if DEBUG
                if let width, width < minimum.width {
                    Logger(subsystem: "PolarisKeyUI", category: "brand").warning(
                        "Powered-by badge width \(Double(width)) is below the \(layout.rawValue) minimum \(Double(minimum.width)); rendering at the minimum"
                    )
                }
            #endif
            return minimum
        }
        return CGSize(width: width, height: width * minimum.height / minimum.width)
    }

    public var body: some View {
        let variant = colorScheme == .light ? "light" : "dark"
        if let image = brandImage("powered-by/\(treatment.rawValue)/\(layout.rawValue)-\(variant)") {
            image.resizable().interpolation(.high)
                .frame(width: size.width, height: size.height)
                .accessibilityElement()
                .accessibilityLabel(PolarisBrand.poweredByPhrase)
                .accessibilityAddTraits(.isImage)
        } else {
            Text(PolarisBrand.poweredByPhrase)
                .frame(width: size.width, height: size.height)
        }
    }
}

/// Which "Powered by" badge the gate shows under its activation card, when a product opts in.
public struct PolarisPoweredBy: Sendable, Equatable {
    public var layout: PolarisPoweredByBadge.Layout
    public var treatment: PolarisPoweredByBadge.Treatment

    public init(
        layout: PolarisPoweredByBadge.Layout = .compact,
        treatment: PolarisPoweredByBadge.Treatment = .transparent
    ) {
        self.layout = layout
        self.treatment = treatment
    }
}
