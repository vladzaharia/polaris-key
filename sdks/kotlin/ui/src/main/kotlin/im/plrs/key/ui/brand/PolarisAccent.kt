// The accent resolver (docs/design/UI-KITS.md §3.3), a step-for-step port of
// packages/brand/src/accent.ts. AccentResolverTest holds it to the shared vectors
// (AccentVectors.generated.kt, from packages/brand/fixtures/accent-vectors.json): change the
// algorithm only together with every port.
//
//   PolarisAccent.derive(rgba)        the input colour from a product icon when it supplies none
//   PolarisAccent.resolve(hex, dark)  solid, on, fg, subtle and focus for one colour scheme
//
// Colours cross this API as lower-case "#rrggbb" strings; the kit turns them into Compose colours.

@file:Suppress("MagicNumber")

package im.plrs.key.ui.brand

import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** The product accent resolver shared by every Polaris Key UI kit. */
public object PolarisAccent {
    /** The label a solid fill takes. */
    public enum class Label { WHITE, INK }

    /** One colour resolved for one scheme; every value is a lower-case "#rrggbb". */
    public data class Resolved(
        /** Fills and indicators: at least 3:1 on every surface of the scheme. */
        val solid: String,
        /** The label on [solid]: white unless the accent is light; the same in both schemes. */
        val on: String,
        /** Text and links: at least 4.5:1 on every surface of the scheme. */
        val fg: String,
        /** The tinted fill for selected rows. */
        val subtle: String,
        /** The focus ring: [fg] in dark schemes, [solid] in light ones. */
        val focus: String,
    )

    // The resolver's two labels: white, and the brand ink (the kit's dark page ground).
    public const val WHITE: String = "#ffffff" // polaris-lint: allow-colour
    public const val INK: String = "#060912" // polaris-lint: allow-colour

    private const val TEXT = 4.5
    private const val UI = 3.0
    private const val WHITE_SHIFT = 0.08
    private const val FG_DARK_L = 0.78
    private const val FG_LIGHT_L = 0.52
    private const val STEPS = 32
    private const val OPAQUE_ALPHA = 128
    private const val GREY_CHROMA = 0.04
    private const val HUE_BIN = 30.0
    private const val MIN_SHARE = 0.08
    private const val DERIVED_L_MIN = 0.45
    private const val DERIVED_L_MAX = 0.6
    private const val SUBTLE_ALPHA_DARK = 0.12
    private const val SUBTLE_ALPHA_LIGHT = 0.1

    // The scheme's surfaces in the resolver's order (page, raised, overlay, sunken): the generated
    // palette, so a token change reaches the resolver.
    private val SURFACES_DARK: List<String> = with(PolarisBrandTokens.Dark) {
        listOf(surfacePage, surfaceRaised, surfaceOverlay, surfaceSunken).map(::hexOf)
    }
    private val SURFACES_LIGHT: List<String> = with(PolarisBrandTokens.Light) {
        listOf(surfacePage, surfaceRaised, surfaceOverlay, surfaceSunken).map(::hexOf)
    }

    /** The scheme's surfaces, in the resolver's order: page, raised, overlay, sunken. */
    public fun surfaces(dark: Boolean): List<String> = if (dark) SURFACES_DARK else SURFACES_LIGHT

    /** Resolve any input colour ("#rgb" or "#rrggbb") for one scheme; null for anything else. */
    public fun resolve(hex: String, dark: Boolean): Resolved? {
        val input = normalize(hex) ?: return null
        val label = label(input)
        val solid = solid(input, dark, label)
        val fg = fg(input, dark)
        return Resolved(
            solid = solid,
            on = if (label == Label.WHITE) WHITE else INK,
            fg = fg,
            subtle = mixOver(solid, if (dark) SUBTLE_ALPHA_DARK else SUBTLE_ALPHA_LIGHT, surfaces(dark)[0]),
            focus = if (dark) fg else solid,
        )
    }

    /** White when darkening by at most 0.08 reaches 4.5:1 against white; ink otherwise. */
    public fun label(hex: String): Label {
        val base = hexToOklch(hex)
        val shifted = at(base, base.l - WHITE_SHIFT)
        return if (contrast(WHITE, shifted) >= TEXT) Label.WHITE else Label.INK
    }

    /** `solid` for a colour, a scheme and a label (the danger solid passes [Label.WHITE]). */
    public fun solid(hex: String, dark: Boolean, label: Label): String {
        val base = hexToOklch(hex)
        val grounds = surfaces(dark)
        val onUi = { h: String -> grounds.all { contrast(h, it) >= UI } }
        if (label == Label.WHITE) {
            val solid = moveUntil(base, -1.0) { contrast(WHITE, it) >= TEXT }
            return if (dark && !onUi(solid)) moveUntil(hexToOklch(solid), 1.0, onUi) else solid
        }
        val solid = moveUntil(base, 1.0) { contrast(INK, it) >= TEXT }
        return if (!dark && !onUi(solid)) moveUntil(hexToOklch(solid), -1.0, onUi) else solid
    }

    /** `fg` for a colour in a scheme: text that clears 4.5:1 on every surface. */
    public fun fg(hex: String, dark: Boolean): String {
        val base = hexToOklch(hex)
        val grounds = surfaces(dark)
        val readable = { h: String -> grounds.all { contrast(h, it) >= TEXT } }
        return if (dark) {
            moveUntil(Oklch(max(base.l, FG_DARK_L), base.c, base.h), 1.0, readable)
        } else {
            moveUntil(Oklch(min(base.l, FG_LIGHT_L), base.c, base.h), -1.0, readable)
        }
    }

    /**
     * The input colour for a product without one, from its icon's RGBA bytes (row-major, 4 per
     * pixel): the mean of the most saturated 30° hue cluster covering at least 8 % of the opaque
     * pixels, at an accent lightness; null for a near-greyscale or empty icon (the kit uses ink).
     */
    public fun derive(rgba: ByteArray): String? {
        val count = (360 / HUE_BIN).toInt()
        val n = IntArray(count)
        val sumL = DoubleArray(count)
        val sumA = DoubleArray(count)
        val sumB = DoubleArray(count)
        val sumC = DoubleArray(count)
        var opaque = 0
        var i = 0
        while (i + 3 < rgba.size) {
            val a = rgba[i + 3].toInt() and 0xFF
            if (a >= OPAQUE_ALPHA) {
                opaque++
                val lab = rgbToOklab(
                    Rgb(
                        (rgba[i].toInt() and 0xFF) / 255.0,
                        (rgba[i + 1].toInt() and 0xFF) / 255.0,
                        (rgba[i + 2].toInt() and 0xFF) / 255.0,
                    ),
                )
                val lch = oklabToOklch(lab)
                if (lch.c >= GREY_CHROMA) {
                    val k = min(count - 1, floor(lch.h / HUE_BIN).toInt())
                    n[k]++
                    sumL[k] += lab.l
                    sumA[k] += lab.a
                    sumB[k] += lab.b
                    sumC[k] += lch.c
                }
            }
            i += 4
        }
        if (opaque == 0) return null
        var best = -1
        for (k in 0 until count) {
            if (n[k] < MIN_SHARE * opaque) continue
            if (best < 0) {
                best = k
                continue
            }
            val chroma = sumC[k] / n[k]
            val bestChroma = sumC[best] / n[best]
            if (chroma > bestChroma || (chroma == bestChroma && n[k] > n[best])) best = k
        }
        if (best < 0) return null
        val total = n[best].toDouble()
        val mean = oklabToOklch(Oklab(sumL[best] / total, sumA[best] / total, sumB[best] / total))
        return oklchToHex(Oklch(min(DERIVED_L_MAX, max(DERIVED_L_MIN, mean.l)), mean.c, mean.h))
    }

    // ── Search ───────────────────────────────────────────────────────────────────────────────

    private fun at(base: Oklch, l: Double): String = oklchToHex(Oklch(min(1.0, max(0.0, l)), base.c, base.h))

    private fun moveUntil(base: Oklch, dir: Double, ok: (String) -> Boolean): String {
        val start = at(base, base.l)
        if (ok(start)) return start
        var lo = 0.0
        var hi = if (dir < 0) base.l else 1 - base.l
        if (!ok(at(base, base.l + dir * hi))) return at(base, base.l + dir * hi)
        repeat(STEPS) {
            val mid = (lo + hi) / 2
            if (ok(at(base, base.l + dir * mid))) hi = mid else lo = mid
        }
        return at(base, base.l + dir * hi)
    }

    // ── Colour science (packages/brand/src/color.ts) ─────────────────────────────────────────

    private data class Rgb(val r: Double, val g: Double, val b: Double)

    private data class Oklab(val l: Double, val a: Double, val b: Double)

    private data class Oklch(val l: Double, val c: Double, val h: Double)

    private fun hexOf(color: androidx.compose.ui.graphics.Color): String {
        val argb = (color.value shr 32).toLong()
        return "#" + (argb and 0xFFFFFF).toString(16).padStart(6, '0')
    }

    private fun normalize(hex: String): String? = parseHex(hex)?.let(::toHex)

    private fun parseHex(hex: String): Rgb? {
        if (!hex.startsWith("#")) return null
        var digits = hex.substring(1).lowercase()
        if ((digits.length != 3 && digits.length != 6) || !digits.all { it in '0'..'9' || it in 'a'..'f' }) return null
        if (digits.length == 3) digits = digits.map { "$it$it" }.joinToString("")
        val v = digits.toInt(16)
        return Rgb(((v shr 16) and 0xFF) / 255.0, ((v shr 8) and 0xFF) / 255.0, (v and 0xFF) / 255.0)
    }

    private fun toHex(rgb: Rgb): String {
        fun ch(v: Double): Int = kotlin.math.floor(min(1.0, max(0.0, v)) * 255 + 0.5).toInt()
        val v = (ch(rgb.r) shl 16) or (ch(rgb.g) shl 8) or ch(rgb.b)
        return "#" + v.toString(16).padStart(6, '0')
    }

    private fun toLinear(v: Double): Double = if (v <= 0.04045) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)

    private fun fromLinear(v: Double): Double = if (v <= 0.0031308) v * 12.92 else 1.055 * v.pow(1 / 2.4) - 0.055

    private fun rgbToOklab(c: Rgb): Oklab {
        val lr = toLinear(c.r)
        val lg = toLinear(c.g)
        val lb = toLinear(c.b)
        val l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
        val m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
        val s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
        return Oklab(
            0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        )
    }

    private fun oklabToRgb(c: Oklab): Rgb {
        val l = (c.l + 0.3963377774 * c.a + 0.2158037573 * c.b).pow(3)
        val m = (c.l - 0.1055613458 * c.a - 0.0638541728 * c.b).pow(3)
        val s = (c.l - 0.0894841775 * c.a - 1.291485548 * c.b).pow(3)
        return Rgb(
            fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        )
    }

    private fun oklabToOklch(c: Oklab): Oklch {
        var h = atan2(c.b, c.a) * 180 / Math.PI
        if (h < 0) h += 360
        return Oklch(c.l, hypot(c.a, c.b), h)
    }

    private fun oklchToOklab(c: Oklch): Oklab {
        val rad = c.h * Math.PI / 180
        return Oklab(c.l, c.c * cos(rad), c.c * sin(rad))
    }

    private fun hexToOklch(hex: String): Oklch = oklabToOklch(rgbToOklab(parseHex(hex) ?: Rgb(0.0, 0.0, 0.0)))

    private fun inGamut(c: Rgb): Boolean {
        val eps = 1e-6
        return listOf(c.r, c.g, c.b).all { it >= -eps && it <= 1 + eps }
    }

    private fun oklchToHex(color: Oklch): String {
        var rgb = oklabToRgb(oklchToOklab(color))
        if (!inGamut(rgb)) {
            var lo = 0.0
            var hi = color.c
            while (hi - lo > 1e-5) {
                val mid = (lo + hi) / 2
                if (inGamut(oklabToRgb(oklchToOklab(Oklch(color.l, mid, color.h))))) lo = mid else hi = mid
            }
            rgb = oklabToRgb(oklchToOklab(Oklch(color.l, lo, color.h)))
        }
        return toHex(rgb)
    }

    private fun luminance(hex: String): Double {
        val c = parseHex(hex) ?: Rgb(0.0, 0.0, 0.0)
        return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
    }

    internal fun contrast(a: String, b: String): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return if (la > lb) (la + 0.05) / (lb + 0.05) else (lb + 0.05) / (la + 0.05)
    }

    private fun mixOver(fg: String, alpha: Double, bg: String): String {
        val f = parseHex(fg) ?: Rgb(0.0, 0.0, 0.0)
        val b = parseHex(bg) ?: Rgb(0.0, 0.0, 0.0)
        return toHex(Rgb(f.r * alpha + b.r * (1 - alpha), f.g * alpha + b.g * (1 - alpha), f.b * alpha + b.b * (1 - alpha)))
    }
}
