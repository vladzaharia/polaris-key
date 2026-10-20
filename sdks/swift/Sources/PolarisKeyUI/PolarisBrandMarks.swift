// The launch kit's artwork, as SwiftUI views: the Pinned K (for a host's own about or credits
// screen; kit screens lead with the product and show no mark, UI-KITS §1.6) and the Polaris Locker
// "Powered by" attribution. The Pinned K renders the kit's own PNG, bundled unchanged in
// `Resources/Brand/` (tools/sync-brand-assets.sh copies it; BrandThemeTests checks the bytes). The
// Locker micro mark and badge are the Locker kit's own vector artwork (BrandMarks.generated.swift,
// written by `pnpm gen brand`), so they are never redrawn. "dark" artwork is FOR dark grounds: each
// view picks its variant from the `colorScheme` environment.

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

/// The Polaris Locker "Powered by" badge (the kit's `powered-by` label, transparent treatment), for
/// a product's own surfaces: its about or credits screen. Polaris Key's own surfaces never show it
/// (BRAND.md §7.2). Key's "Powered by" badges are platform references and are not offered here.
///
/// The badge is the kit artwork on its 320 × 104 canvas, padding included (never cropped), and
/// never narrower than 320 points: a smaller `width` is raised to it. Where 320 points are not
/// free, use `PolarisPoweredByAttribution`, which falls back to the line.
public struct PolarisPoweredByBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    private let size: CGSize

    /// - Parameter width: the displayed width in points; nil, or anything below 320, renders at 320.
    ///   The height follows the artwork's aspect ratio.
    nonisolated public init(width: CGFloat? = nil) {
        self.size = PolarisPoweredByBadge.size(width: width)
    }

    /// The rendered size for a requested width: 320 × 104, or the requested width at the artwork's
    /// aspect ratio when that is larger.
    nonisolated public static func size(width: CGFloat?) -> CGSize {
        let minimum = CGSize(width: PolarisBrand.badgeMin.width, height: PolarisBrand.badgeMin.height)
        guard let width, width > minimum.width else {
            #if DEBUG
                if let width, width < minimum.width {
                    Logger(subsystem: "PolarisKeyUI", category: "brand").warning(
                        "Powered-by badge width \(Double(width)) is below the minimum \(Double(minimum.width)); rendering at the minimum"
                    )
                }
            #endif
            return minimum
        }
        return CGSize(width: width, height: width * minimum.height / minimum.width)
    }

    public var body: some View {
        BrandVectorView(
            vector: colorScheme == .light
                ? PolarisBrandMarkData.lockerPoweredByLight : PolarisBrandMarkData.lockerPoweredByDark
        )
        .frame(width: size.width, height: size.height)
        .accessibilityElement()
        .accessibilityLabel(PolarisBrand.poweredByPhrase)
        .accessibilityAddTraits(.isImage)
    }
}

/// The Locker micro mark at `PolarisBrand.poweredByMarkSize` points, decorative.
struct PolarisLockerMicroMark: View {
    @Environment(\.colorScheme) private var colorScheme
    /// The kit's scheme (`style.dark`); nil follows the environment.
    var dark: Bool?
    /// 16 points at the default text size, growing with Dynamic Type (the em rule, UI-KITS §1.6).
    @ScaledMetric(relativeTo: .footnote) private var side = PolarisBrand.poweredByMarkSize

    var body: some View {
        BrandVectorView(
            vector: (dark ?? (colorScheme == .dark))
                ? PolarisBrandMarkData.lockerMicroDark : PolarisBrandMarkData.lockerMicroLight
        )
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

/// How the attribution is drawn when a product opts in.
public enum PolarisPoweredByStyle: String, Sendable, Equatable {
    /// `<Locker micro mark, 16 pt> Powered by Polaris Locker` in live text.
    case line
    /// The 320 × 104 badge where 320 points are free, else the line.
    case badge
}

/// The attribution (UI-KITS §1.6) for an about or credits screen: the line, or the badge where 320
/// points are free and the line where they are not. The line's text is `text`, the catalog's
/// "Powered by Polaris Locker", in the kit's subtle text colour.
public struct PolarisPoweredByAttribution: View {
    private let style: PolarisPoweredByStyle
    private let text: String

    public init(style: PolarisPoweredByStyle = .line, text: String = PolarisBrand.poweredByPhrase) {
        self.style = style
        self.text = text
    }

    public var body: some View {
        switch style {
        case .line:
            line
        case .badge:
            ViewThatFits(in: .horizontal) {
                PolarisPoweredByBadge()
                line
            }
        }
    }

    @Environment(\.colorScheme) private var colorScheme

    private var line: some View {
        HStack(spacing: 6) {
            PolarisLockerMicroMark()
            Text(text).font(.footnote)
                .foregroundStyle(
                    (colorScheme == .dark ? PolarisBrand.Dark.textSubtle : PolarisBrand.Light.textSubtle).color)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Which attribution a product opts in to. The legacy gate never draws it (UI-KITS §1.6: only on
/// account, settings, about and credits screens); place `PolarisPoweredByAttribution(style:)` there.
/// `.line` is the default; the badge is opt-in.
public struct PolarisPoweredBy: Sendable, Equatable {
    public var style: PolarisPoweredByStyle

    public init(style: PolarisPoweredByStyle = .line) {
        self.style = style
    }
}
