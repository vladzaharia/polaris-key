// Whether the kit wears the Polaris Key brand. The default is `.native`: system fonts, the host
// app's tint and system colours, with no Polaris Key branding at all. An integrator opts in to the
// Polaris Key look (the generated `PolarisBrand` tokens, bundled Rubik, the core violet or the
// product presentation's accent) with one modifier:
//
//     PolarisLoginView(model: gate) { MyRoot() }
//         .polarisKeyBranding(.polarisKey)
//
// or per gate with `PolarisTheme(branding: .polarisKey)`. The "Powered by Polaris Key" badge is a
// separate opt-in (`PolarisTheme(poweredBy:)`) and is off in both modes.

import SwiftUI

/// The look the kit renders in.
public enum PolarisBranding: String, Sendable, Equatable, CaseIterable {
    /// Native and neutral (the default): system fonts, the app's tint, system colours.
    case native
    /// The Polaris Key design system: brand palette (dark or light), Rubik, and the product's
    /// accent when its presentation has one. Kit screens still lead with the product, never a
    /// Polaris Key mark (UI-KITS §1.6).
    case polarisKey
}

private struct PolarisBrandingKey: EnvironmentKey {
    static let defaultValue = PolarisBranding.native
}

extension EnvironmentValues {
    /// The kit's branding for this subtree: `.native` unless a `.polarisKeyBranding(_:)` above
    /// sets it.
    public var polarisKeyBranding: PolarisBranding {
        get { self[PolarisBrandingKey.self] }
        set { self[PolarisBrandingKey.self] = newValue }
    }
}

extension View {
    /// Render every PolarisKeyUI view in this subtree with `branding`. `.polarisKey` opts in to the
    /// Polaris Key brand; `.native` (the default) keeps the system look.
    public func polarisKeyBranding(_ branding: PolarisBranding) -> some View {
        environment(\.polarisKeyBranding, branding)
    }
}
