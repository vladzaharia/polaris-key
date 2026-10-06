// @pkey-feature ui.kit
// The accent resolver (docs/design/UI-KITS.md §3.3), a step-for-step port of
// packages/brand/src/accent.ts. AccentResolverTests holds it to the shared vectors
// (AccentVectors.generated.swift, from packages/brand/fixtures/accent-vectors.json): change the
// algorithm only together with every port.
//
//   PolarisAccent.derive(rgba:)        the input colour from a product icon when it supplies none
//   PolarisAccent.resolve(_:dark:)     solid, on, fg, subtle and focus for one colour scheme

import Foundation

/// The product accent resolver shared by every Polaris Key UI kit.
public enum PolarisAccent {
    /// The label a solid fill takes.
    public enum Label: Sendable, Equatable {
        case white
        case ink
    }

    /// One colour resolved for one scheme. Every value is a lower-case `#rrggbb`.
    public struct Resolved: Sendable, Equatable {
        /// Fills and indicators: at least 3:1 on every surface of the scheme.
        public let solid: String
        /// The label on `solid`: white unless the accent is light; the same in both schemes.
        public let on: String
        /// Text and links: at least 4.5:1 on every surface of the scheme.
        public let fg: String
        /// The tinted fill for selected rows.
        public let subtle: String
        /// The focus ring: `fg` in dark schemes, `solid` in light ones.
        public let focus: String
    }

    public static let white = "#ffffff"
    public static let ink = "#060912"

    static let text = 4.5
    static let ui = 3.0
    static let whiteShift = 0.08
    static let fgDarkL = 0.78
    static let fgLightL = 0.52
    static let steps = 32
    static let opaqueAlpha = 128
    static let greyChroma = 0.04
    static let hueBin = 30.0
    static let minShare = 0.08
    static let derivedL = (0.45, 0.6)
    static let subtleAlphaDark = 0.12
    static let subtleAlphaLight = 0.1

    /// The scheme's surfaces, in the resolver's order: page, raised, overlay, sunken.
    public static func surfaces(dark: Bool) -> [String] {
        (dark ? PolarisKit.Dark.accentSurfaces : PolarisKit.Light.accentSurfaces).map { color in
            hexString(color.hex)
        }
    }

    /// Resolve any input colour (`#rgb` or `#rrggbb`) for one scheme; nil for anything else.
    public static func resolve(_ hex: String, dark: Bool) -> Resolved? {
        guard let input = normalize(hex) else { return nil }
        let label = label(for: input)
        let solid = solid(input, dark: dark, label: label)
        let fg = fg(input, dark: dark)
        let alpha = dark ? subtleAlphaDark : subtleAlphaLight
        return Resolved(
            solid: solid,
            on: label == .white ? white : ink,
            fg: fg,
            subtle: mixOver(solid, alpha: alpha, over: surfaces(dark: dark)[0]),
            focus: dark ? fg : solid)
    }

    /// White when darkening by at most 0.08 reaches 4.5:1 against white; ink otherwise.
    public static func label(for hex: String) -> Label {
        let base = hexToOklch(hex)
        let shifted = at(base, base.l - whiteShift)
        return contrast(white, shifted) >= text ? .white : .ink
    }

    /// `solid` for a colour, a scheme and a label (the danger solid passes `.white`).
    public static func solid(_ hex: String, dark: Bool, label: Label) -> String {
        let base = hexToOklch(hex)
        let grounds = surfaces(dark: dark)
        let onUi: (String) -> Bool = { h in grounds.allSatisfy { contrast(h, $0) >= ui } }
        if label == .white {
            let solid = moveUntil(base, -1) { contrast(white, $0) >= text }
            return dark && !onUi(solid) ? moveUntil(hexToOklch(solid), 1, onUi) : solid
        }
        let solid = moveUntil(base, 1) { contrast(ink, $0) >= text }
        return !dark && !onUi(solid) ? moveUntil(hexToOklch(solid), -1, onUi) : solid
    }

    /// `fg` for a colour in a scheme: text that clears 4.5:1 on every surface.
    public static func fg(_ hex: String, dark: Bool) -> String {
        let base = hexToOklch(hex)
        let grounds = surfaces(dark: dark)
        let readable: (String) -> Bool = { h in grounds.allSatisfy { contrast(h, $0) >= text } }
        if dark {
            return moveUntil(Oklch(l: max(base.l, fgDarkL), c: base.c, h: base.h), 1, readable)
        }
        return moveUntil(Oklch(l: min(base.l, fgLightL), c: base.c, h: base.h), -1, readable)
    }

    /// The input colour for a product without one, from its icon's RGBA bytes (row-major, 4 per
    /// pixel): the mean of the most saturated 30° hue cluster covering at least 8 % of the opaque
    /// pixels, at an accent lightness; nil for a near-greyscale or empty icon (the kit uses ink).
    public static func derive(rgba: [UInt8]) -> String? {
        let count = Int(360 / hueBin)
        var n = [Int](repeating: 0, count: count)
        var sumL = [Double](repeating: 0, count: count)
        var sumA = [Double](repeating: 0, count: count)
        var sumB = [Double](repeating: 0, count: count)
        var sumC = [Double](repeating: 0, count: count)
        var opaque = 0
        var i = 0
        while i + 3 < rgba.count {
            defer { i += 4 }
            if Int(rgba[i + 3]) < opaqueAlpha { continue }
            opaque += 1
            let lab = rgbToOklab(
                Rgb(r: Double(rgba[i]) / 255, g: Double(rgba[i + 1]) / 255, b: Double(rgba[i + 2]) / 255))
            let lch = oklabToOklch(lab)
            if lch.c < greyChroma { continue }
            let k = min(count - 1, Int((lch.h / hueBin).rounded(.down)))
            n[k] += 1
            sumL[k] += lab.l
            sumA[k] += lab.a
            sumB[k] += lab.b
            sumC[k] += lch.c
        }
        if opaque == 0 { return nil }
        var best = -1
        for k in 0..<count {
            if Double(n[k]) < minShare * Double(opaque) { continue }
            if best < 0 {
                best = k
                continue
            }
            let chroma = sumC[k] / Double(n[k])
            let bestChroma = sumC[best] / Double(n[best])
            if chroma > bestChroma || (chroma == bestChroma && n[k] > n[best]) { best = k }
        }
        if best < 0 { return nil }
        let total = Double(n[best])
        let mean = oklabToOklch(Oklab(l: sumL[best] / total, a: sumA[best] / total, b: sumB[best] / total))
        return oklchToHex(Oklch(l: min(derivedL.1, max(derivedL.0, mean.l)), c: mean.c, h: mean.h))
    }

    // MARK: - Search

    static func at(_ base: Oklch, _ l: Double) -> String {
        oklchToHex(Oklch(l: min(1, max(0, l)), c: base.c, h: base.h))
    }

    static func moveUntil(_ base: Oklch, _ dir: Double, _ ok: (String) -> Bool) -> String {
        let start = at(base, base.l)
        if ok(start) { return start }
        var lo = 0.0
        var hi = dir < 0 ? base.l : 1 - base.l
        if !ok(at(base, base.l + dir * hi)) { return at(base, base.l + dir * hi) }
        for _ in 0..<steps {
            let mid = (lo + hi) / 2
            if ok(at(base, base.l + dir * mid)) { hi = mid } else { lo = mid }
        }
        return at(base, base.l + dir * hi)
    }

    // MARK: - Colour science (packages/brand/src/color.ts)

    struct Rgb { var r: Double, g: Double, b: Double }
    struct Oklab { var l: Double, a: Double, b: Double }
    struct Oklch { var l: Double, c: Double, h: Double }

    static func normalize(_ hex: String) -> String? {
        guard let rgb = parseHex(hex) else { return nil }
        return toHex(rgb)
    }

    static func parseHex(_ hex: String) -> Rgb? {
        guard hex.hasPrefix("#") else { return nil }
        var digits = String(hex.dropFirst()).lowercased()
        guard digits.count == 3 || digits.count == 6,
            digits.allSatisfy({ $0.isHexDigit })
        else { return nil }
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        guard let v = UInt32(digits, radix: 16) else { return nil }
        return Rgb(
            r: Double((v >> 16) & 0xFF) / 255, g: Double((v >> 8) & 0xFF) / 255, b: Double(v & 0xFF) / 255)
    }

    static func hexString(_ v: UInt32) -> String {
        let s = String(v, radix: 16)
        return "#" + String(repeating: "0", count: max(0, 6 - s.count)) + s
    }

    static func toHex(_ rgb: Rgb) -> String {
        func ch(_ v: Double) -> UInt32 { UInt32((min(1, max(0, v)) * 255).rounded(.toNearestOrAwayFromZero)) }
        return hexString((ch(rgb.r) << 16) | (ch(rgb.g) << 8) | ch(rgb.b))
    }

    static func toLinear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }

    static func fromLinear(_ v: Double) -> Double { v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1 / 2.4) - 0.055 }

    static func rgbToOklab(_ c: Rgb) -> Oklab {
        let lr = toLinear(c.r)
        let lg = toLinear(c.g)
        let lb = toLinear(c.b)
        let l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
        let m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
        let s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
        return Oklab(
            l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
            a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
    }

    static func oklabToRgb(_ c: Oklab) -> Rgb {
        let l = pow(c.l + 0.3963377774 * c.a + 0.2158037573 * c.b, 3)
        let m = pow(c.l - 0.1055613458 * c.a - 0.0638541728 * c.b, 3)
        let s = pow(c.l - 0.0894841775 * c.a - 1.291485548 * c.b, 3)
        return Rgb(
            r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
    }

    static func oklabToOklch(_ c: Oklab) -> Oklch {
        var h = atan2(c.b, c.a) * 180 / Double.pi
        if h < 0 { h += 360 }
        return Oklch(l: c.l, c: hypot(c.a, c.b), h: h)
    }

    static func oklchToOklab(_ c: Oklch) -> Oklab {
        let rad = c.h * Double.pi / 180
        return Oklab(l: c.l, a: c.c * cos(rad), b: c.c * sin(rad))
    }

    static func hexToOklch(_ hex: String) -> Oklch {
        oklabToOklch(rgbToOklab(parseHex(hex) ?? Rgb(r: 0, g: 0, b: 0)))
    }

    static func inGamut(_ c: Rgb) -> Bool {
        let eps = 1e-6
        return [c.r, c.g, c.b].allSatisfy { $0 >= -eps && $0 <= 1 + eps }
    }

    static func oklchToHex(_ color: Oklch) -> String {
        var rgb = oklabToRgb(oklchToOklab(color))
        if !inGamut(rgb) {
            var lo = 0.0
            var hi = color.c
            while hi - lo > 1e-5 {
                let mid = (lo + hi) / 2
                if inGamut(oklabToRgb(oklchToOklab(Oklch(l: color.l, c: mid, h: color.h)))) {
                    lo = mid
                } else {
                    hi = mid
                }
            }
            rgb = oklabToRgb(oklchToOklab(Oklch(l: color.l, c: lo, h: color.h)))
        }
        return toHex(rgb)
    }

    static func luminance(_ hex: String) -> Double {
        let c = parseHex(hex) ?? Rgb(r: 0, g: 0, b: 0)
        return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
    }

    static func contrast(_ a: String, _ b: String) -> Double {
        let la = luminance(a)
        let lb = luminance(b)
        return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
    }

    static func mixOver(_ fg: String, alpha: Double, over bg: String) -> String {
        let f = parseHex(fg) ?? Rgb(r: 0, g: 0, b: 0)
        let b = parseHex(bg) ?? Rgb(r: 0, g: 0, b: 0)
        return toHex(
            Rgb(
                r: f.r * alpha + b.r * (1 - alpha), g: f.g * alpha + b.g * (1 - alpha),
                b: f.b * alpha + b.b * (1 - alpha)))
    }
}
