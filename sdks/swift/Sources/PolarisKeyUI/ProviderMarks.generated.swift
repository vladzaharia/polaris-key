// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

/// The provider sign-in marks (docs/design/UI-KITS.md §3.6): the logo a "Continue with <provider>"
/// button carries and the fills and label colours the provider's branding rules require. Apple is
/// not here: the kit draws the system Sign in with Apple control. Colours are 0xRRGGBB; the
/// product accent never tints a provider mark.
public enum PolarisProviderMark {
    /// One drawing step of a mark's outline, in the mark's own grid, absolute coordinates.
    public enum Segment: Equatable, Sendable {
        case move(Double, Double)
        case line(Double, Double)
        /// Control point 1, control point 2, end point.
        case curve(Double, Double, Double, Double, Double, Double)
        case close
    }

    /// One filled outline of a mark.
    public struct Layer: Sendable {
        public let fill: UInt32
        public let segments: [Segment]
    }

    /// A provider button's colours; `border` nil draws none.
    public struct ButtonFill: Sendable {
        public let fill: UInt32
        public let border: UInt32?
        public let label: UInt32
    }

    /// The Google "G" grid (a square viewBox).
    public static let googleGrid: Double = 48

    /// The Google "G", in drawing order. Draw it unmodified: never recoloured, stretched or tinted.
    public static let googleG: [Layer] = [
        Layer(fill: 0xEA4335, segments: [.move(24, 9.5), .curve(27.54, 9.5, 30.71, 10.72, 33.21, 13.1), .line(40.06, 6.25), .curve(35.9, 2.38, 30.47, 0, 24, 0), .curve(14.62, 0, 6.51, 5.38, 2.56, 13.22), .line(10.54, 19.41), .curve(12.43, 13.72, 17.74, 9.5, 24, 9.5), .close]),
        Layer(fill: 0x4285F4, segments: [.move(46.98, 24.55), .curve(46.98, 22.98, 46.83, 21.46, 46.6, 20), .line(24, 20), .line(24, 29.02), .line(36.94, 29.02), .curve(36.36, 31.98, 34.68, 34.5, 32.16, 36.2), .line(39.89, 42.2), .curve(44.4, 38.02, 46.98, 31.84, 46.98, 24.55), .close]),
        Layer(fill: 0xFBBC05, segments: [.move(10.53, 28.59), .curve(10.05, 27.14, 9.77, 25.6, 9.77, 24), .curve(9.77, 22.4, 10.04, 20.86, 10.53, 19.41), .line(2.55, 13.22), .curve(0.92, 16.46, 0, 20.12, 0, 24), .curve(0, 27.88, 0.92, 31.54, 2.56, 34.78), .line(10.53, 28.59), .close]),
        Layer(fill: 0x34A853, segments: [.move(24, 48), .curve(30.48, 48, 35.93, 45.87, 39.89, 42.19), .line(32.16, 36.19), .curve(30.01, 37.64, 27.24, 38.49, 24, 38.49), .curve(17.74, 38.49, 12.43, 34.27, 10.53, 28.58), .line(2.55, 34.77), .curve(6.51, 42.62, 14.62, 48, 24, 48), .close]),
    ]

    public static let googleLight = ButtonFill(fill: 0xFFFFFF, border: 0x747775, label: 0x1F1F1F)
    public static let googleDark = ButtonFill(fill: 0x131314, border: 0x8E918F, label: 0xE3E3E3)
    public static let googleNeutral = ButtonFill(fill: 0xF2F2F2, border: nil, label: 0x1F1F1F)

    /// The fill each colour scheme uses by default.
    public static func googleButton(dark: Bool) -> ButtonFill { dark ? googleDark : googleLight }

    /// The G's height as a fraction of the button's height.
    public static let googleGHeightRatio: Double = 0.5
    /// The gap between the G and the label, in points.
    public static let googleGLabelGap: Double = 10
    /// The kit-copy key of the label ("Continue with {provider}", provider "Google").
    public static let googleLabelCopyKey = "signin.provider.continue"
}
