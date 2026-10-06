// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui.brand

import androidx.compose.ui.graphics.Color

/** A corner radius: fixed dp, or a capsule (half the control's height; M3 `full`). */
public sealed interface KitRadius {
    public data class Fixed(val dp: Float) : KitRadius

    public data object Capsule : KitRadius
}

/** One role of a platform type scale (sp; letter spacing in em). */
public data class KitTypeRole(
    val size: Float,
    val lineHeight: Float,
    val weight: Int,
    val tracking: Float,
    /** Set in the kit mono (JetBrains Mono) rather than Rubik. */
    val mono: Boolean,
)

/**
 * The UI-kit tokens (docs/design/UI-KITS.md §2.1) for the Compose kits: Android, and the desktop
 * variants Compose Desktop renders. Read them as `PolarisKitTokens.Android.controlHeight`,
 * `PolarisKitTokens.Android.Typography.title`, `PolarisKitTokens.Dark.dangerSolid`.
 */
public object PolarisKitTokens {
    /** The concentric rule: an inner radius is the outer radius less the inset, never below this. */
    public const val CONCENTRIC_MIN: Float = 8.0f

    /** The inner radius of a surface of radius [outer] inset by [inset]. */
    public fun concentricRadius(outer: Float, inset: Float): Float = maxOf(CONCENTRIC_MIN, outer - inset)

    /** Motion durations (ms), distances (dp) and measures (notes/S-23 §5). */
    public object Motion {
        public const val micro: Int = 80
        public const val fast: Int = 120
        public const val base: Int = 200
        public const val moderate: Int = 260
        public const val slow: Int = 320
        public const val deliberate: Int = 480
        public const val shimmer: Int = 1600
        public const val distanceXs: Float = 2.0f
        public const val distanceSm: Float = 4.0f
        public const val distanceMd: Float = 8.0f
        public const val distanceLg: Float = 12.0f
        public const val distanceXl: Float = 24.0f
        public const val pressScale: Float = 0.98f
    }

    public object Dark {
        /** The 1 dp inner top edge on raised surfaces and primaries (white at [highlightAlpha]). */
        public val highlight: Color = Color(0xFFFFFFFF)
        public const val highlightAlpha: Float = 0.05f
        /** The danger fill behind white labels (the accent resolver's white-first rule). */
        public val dangerSolid: Color = Color(0xFFDB3A2B)
        public val dangerOn: Color = Color(0xFFFFFFFF)
        /** The colour a scrim dims with; each platform sets its opacity. */
        public val scrimColor: Color = Color(0xFF020408)
    }

    public object Light {
        /** The 1 dp inner top edge on raised surfaces and primaries (white at [highlightAlpha]). */
        public val highlight: Color = Color(0xFFFFFFFF)
        public const val highlightAlpha: Float = 0.9f
        /** The danger fill behind white labels (the accent resolver's white-first rule). */
        public val dangerSolid: Color = Color(0xFFBE2323)
        public val dangerOn: Color = Color(0xFFFFFFFF)
        /** The colour a scrim dims with; each platform sets its opacity. */
        public val scrimColor: Color = Color(0xFF060912)
    }

    /** Android (dp, sp). */
    public object Android {
        public const val controlHeight: Float = 56.0f
        public val radiusControl: KitRadius = KitRadius.Capsule
        public const val radiusSheet: Float = 28.0f
        public const val radiusListOuter: Float = 24.0f
        public const val radiusListInner: Float = 6.0f
        public const val cardPad: Float = 24.0f
        public const val focusSystem: Boolean = false
        public const val focusWidth: Float = 2.0f
        public const val focusOffset: Float = 0.0f
        public const val focusInner: Float = 0.0f
        public const val focusGlow: Float = 0.0f
        public const val hasScrim: Boolean = true
        public const val scrimDarkOpacity: Float = 0.6f
        public const val scrimDarkBlur: Float = 0.0f
        public const val scrimLightOpacity: Float = 0.32f
        public const val scrimLightBlur: Float = 0.0f

        /** The type scale (sp). Weights are 400, 500 and 600 only. */
        public object Typography {
            public val display: KitTypeRole = KitTypeRole(size = 36.0f, lineHeight = 44.0f, weight = 600, tracking = 0.0f, mono = false)
            public val title: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 36.0f, weight = 600, tracking = 0.0f, mono = false)
            public val body: KitTypeRole = KitTypeRole(size = 16.0f, lineHeight = 24.0f, weight = 400, tracking = 0.0f, mono = false)
            public val label: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 500, tracking = 0.0f, mono = false)
            public val button: KitTypeRole = KitTypeRole(size = 16.0f, lineHeight = 24.0f, weight = 500, tracking = 0.0f, mono = false)
            public val meta: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 400, tracking = 0.0f, mono = false)
            public val footnote: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 400, tracking = 0.0f, mono = false)
            public val code: KitTypeRole = KitTypeRole(size = 32.0f, lineHeight = 40.0f, weight = 500, tracking = 0.06f, mono = true)
        }
    }

    /** Windows 11, for Compose Desktop (effective pixels). */
    public object Windows {
        public const val controlHeight: Float = 32.0f
        public val radiusControl: KitRadius = KitRadius.Fixed(4.0f)
        public const val radiusOverlay: Float = 8.0f
        public const val cardPad: Float = 24.0f
        public const val focusSystem: Boolean = false
        public const val focusWidth: Float = 2.0f
        public const val focusOffset: Float = 0.0f
        public const val focusInner: Float = 1.0f
        public const val focusGlow: Float = 0.0f
        public const val hasScrim: Boolean = true
        public const val scrimDarkOpacity: Float = 0.3f
        public const val scrimDarkBlur: Float = 0.0f
        public const val scrimLightOpacity: Float = 0.3f
        public const val scrimLightBlur: Float = 0.0f

        /** The type scale (sp). Weights are 400, 500 and 600 only. */
        public object Typography {
            public val display: KitTypeRole = KitTypeRole(size = 40.0f, lineHeight = 52.0f, weight = 600, tracking = 0.0f, mono = false)
            public val title: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 36.0f, weight = 600, tracking = 0.0f, mono = false)
            public val body: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 400, tracking = 0.0f, mono = false)
            public val label: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 500, tracking = 0.0f, mono = false)
            public val button: KitTypeRole = KitTypeRole(size = 14.0f, lineHeight = 20.0f, weight = 500, tracking = 0.0f, mono = false)
            public val meta: KitTypeRole = KitTypeRole(size = 12.0f, lineHeight = 16.0f, weight = 400, tracking = 0.0f, mono = false)
            public val footnote: KitTypeRole = KitTypeRole(size = 12.0f, lineHeight = 16.0f, weight = 400, tracking = 0.0f, mono = false)
            public val code: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 36.0f, weight = 500, tracking = 0.06f, mono = true)
        }
    }

    /** GNOME, for Compose Desktop on Linux (logical pixels). */
    public object Gnome {
        public const val controlHeight: Float = 34.0f
        public val radiusControl: KitRadius = KitRadius.Fixed(8.0f)
        public const val radiusDialog: Float = 14.0f
        public const val cardPad: Float = 24.0f
        public const val focusSystem: Boolean = false
        public const val focusWidth: Float = 2.0f
        public const val focusOffset: Float = -2.0f
        public const val focusInner: Float = 0.0f
        public const val focusGlow: Float = 0.0f
        public const val hasScrim: Boolean = true
        public const val scrimDarkOpacity: Float = 0.35f
        public const val scrimDarkBlur: Float = 0.0f
        public const val scrimLightOpacity: Float = 0.12f
        public const val scrimLightBlur: Float = 0.0f

        /** The type scale (sp). Weights are 400, 500 and 600 only. */
        public object Typography {
            public val display: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 34.0f, weight = 600, tracking = 0.0f, mono = false)
            public val title: KitTypeRole = KitTypeRole(size = 22.0f, lineHeight = 28.0f, weight = 600, tracking = 0.0f, mono = false)
            public val body: KitTypeRole = KitTypeRole(size = 15.0f, lineHeight = 21.0f, weight = 400, tracking = 0.0f, mono = false)
            public val label: KitTypeRole = KitTypeRole(size = 15.0f, lineHeight = 21.0f, weight = 500, tracking = 0.0f, mono = false)
            public val button: KitTypeRole = KitTypeRole(size = 15.0f, lineHeight = 21.0f, weight = 500, tracking = 0.0f, mono = false)
            public val meta: KitTypeRole = KitTypeRole(size = 13.0f, lineHeight = 18.0f, weight = 400, tracking = 0.0f, mono = false)
            public val footnote: KitTypeRole = KitTypeRole(size = 13.0f, lineHeight = 18.0f, weight = 400, tracking = 0.0f, mono = false)
            public val code: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 34.0f, weight = 500, tracking = 0.06f, mono = true)
        }
    }

    /** macOS, for Compose Desktop (points). */
    public object MacOS {
        public const val controlHeight: Float = 28.0f
        public const val controlHeightHero: Float = 36.0f
        public val radiusControl: KitRadius = KitRadius.Capsule
        public const val radiusForm: Float = 10.0f
        public const val radiusSheet: Float = 18.0f
        public const val cardPad: Float = 24.0f
        public const val cardPadCompact: Float = 22.0f
        public const val focusSystem: Boolean = true
        public const val focusWidth: Float = 0.0f
        public const val focusOffset: Float = 0.0f
        public const val focusInner: Float = 0.0f
        public const val focusGlow: Float = 0.0f
        public const val hasScrim: Boolean = false
        public const val scrimDarkOpacity: Float = 0.0f
        public const val scrimDarkBlur: Float = 0.0f
        public const val scrimLightOpacity: Float = 0.0f
        public const val scrimLightBlur: Float = 0.0f

        /** The type scale (sp). Weights are 400, 500 and 600 only. */
        public object Typography {
            public val display: KitTypeRole = KitTypeRole(size = 26.0f, lineHeight = 32.0f, weight = 600, tracking = 0.0f, mono = false)
            public val title: KitTypeRole = KitTypeRole(size = 22.0f, lineHeight = 28.0f, weight = 600, tracking = 0.0f, mono = false)
            public val body: KitTypeRole = KitTypeRole(size = 13.0f, lineHeight = 16.0f, weight = 400, tracking = 0.0f, mono = false)
            public val label: KitTypeRole = KitTypeRole(size = 13.0f, lineHeight = 16.0f, weight = 500, tracking = 0.0f, mono = false)
            public val button: KitTypeRole = KitTypeRole(size = 13.0f, lineHeight = 16.0f, weight = 500, tracking = 0.0f, mono = false)
            public val meta: KitTypeRole = KitTypeRole(size = 12.0f, lineHeight = 15.0f, weight = 400, tracking = 0.0f, mono = false)
            public val footnote: KitTypeRole = KitTypeRole(size = 12.0f, lineHeight = 15.0f, weight = 400, tracking = 0.0f, mono = false)
            public val code: KitTypeRole = KitTypeRole(size = 28.0f, lineHeight = 34.0f, weight = 600, tracking = 0.06f, mono = true)
        }
    }
}
