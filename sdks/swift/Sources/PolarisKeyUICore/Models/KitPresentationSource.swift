// The presentation seam (plans/HA-11.md Q7; UI-KITS §1.2 "one path for presentation").
//
// The kit reads the product's registered presentation (discovery `core.presentation`: name,
// developer, accents and the icon verified by its sha256) only through this source, which the SDK
// fills (HA-13). The kit never fetches discovery or the icon itself. This is HA-11's
// `{ current(); icon(px, scale); subscribe(fn) }` in the kit's own types; `SDKPresentationSource`
// is the thin adapter over PolarisKeyCore's `PresentationSource` (plans/HA-13.md D1), and a live
// `PolarisKeyGateModel` uses it by default, until UK-07 reads the core seam directly.

import Foundation
import PolarisKeyCore

/// The product's registered presentation (HA-12's member).
public struct KitProductPresentation: Sendable, Equatable, Hashable {
    public var name: String
    public var developerName: String?
    /// `#rrggbb`, for the light scheme (and the dark one when `accentDark` is nil).
    public var accent: String?
    /// `#rrggbb` for the dark scheme.
    public var accentDark: String?

    public init(
        name: String, developerName: String? = nil, accent: String? = nil,
        accentDark: String? = nil
    ) {
        self.name = name
        self.developerName = developerName
        self.accent = accent
        self.accentDark = accentDark
    }
}

/// Where the kit reads the product's presentation from. The SDK's accessor implements it (HA-13);
/// tests and previews pass a `StaticPresentationSource`.
public protocol KitPresentationSource: Sendable {
    /// The presentation discovery carried, or nil when it carries none.
    func current() -> KitProductPresentation?
    /// The verified icon's bytes for a `px`-point square at `scale`, or nil.
    func icon(px: Int, scale: Int) async -> Data?
    /// Call `onChange` whenever the presentation changes; the returned closure unsubscribes.
    func subscribe(_ onChange: @escaping @Sendable () -> Void) -> @Sendable () -> Void
}

/// A fixed presentation: previews, tests, and a host that knows its own.
public struct StaticPresentationSource: KitPresentationSource {
    public let presentation: KitProductPresentation?
    public let iconData: Data?

    public init(_ presentation: KitProductPresentation?, iconData: Data? = nil) {
        self.presentation = presentation
        self.iconData = iconData
    }

    public func current() -> KitProductPresentation? { presentation }
    public func icon(px: Int, scale: Int) async -> Data? { iconData }
    public func subscribe(_ onChange: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        {}
    }
}

/// The SDK's `PresentationSource` (`client.presentationSource`) as the kit's seam.
public struct SDKPresentationSource: KitPresentationSource {
    public let source: any PresentationSource

    public init(_ source: any PresentationSource) {
        self.source = source
    }

    public func current() -> KitProductPresentation? {
        source.current().map {
            KitProductPresentation(
                name: $0.name, developerName: $0.developerName, accent: $0.accent,
                accentDark: $0.accentDark)
        }
    }

    public func icon(px: Int, scale: Int) async -> Data? {
        await source.icon(px: Double(px), scale: Double(scale))
    }

    public func subscribe(_ onChange: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        source.subscribe { _ in onChange() }
    }
}
