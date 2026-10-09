// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui.brand

import androidx.compose.ui.graphics.Color

/**
 * One section's accent in one theme: [solid] for indicators and fills, [fg] for text, [on] for
 * text on a solid fill, [subtle] for a tinted surface, [bit] for the K's terminal bit (null on
 * core: the platform draws no bit).
 */
public data class BrandAccent(
    val solid: Color,
    val fg: Color,
    val on: Color,
    val subtle: Color,
    val bit: Color?,
)

/** A size in dp (CSS-pixel equivalents). */
public data class BrandSize(val width: Float, val height: Float)

/** A kit SVG reduced to groups and filled paths, in its own coordinate space. */
public data class BrandVector(val width: Float, val height: Float, val nodes: List<BrandVectorNode>)

/** One node of a [BrandVector]. */
public sealed interface BrandVectorNode {
    /** A group: translate, then scale (the SVG order), and a fill its paths inherit. */
    public data class Group(
        val translateX: Float,
        val translateY: Float,
        val scaleX: Float,
        val scaleY: Float,
        val fill: Color?,
        val children: List<BrandVectorNode>,
    ) : BrandVectorNode

    /** A filled path in SVG path syntax; a null fill inherits the group's. */
    public data class Path(val fill: Color?, val pathData: String) : BrandVectorNode
}

/** Polaris Key brand tokens (@polaris-key/brand). Dark is the default theme. */
public object PolarisBrandTokens {
    /** Kit primitives, verbatim (kit/08-developer/tokens.json). */
    public object Kit {
        public val violetDark: Color = Color(0xFF9A5CFF)
        public val violetLight: Color = Color(0xFF7A2FFF)
        public val goldDark: Color = Color(0xFFFFC24D)
        public val goldLight: Color = Color(0xFFD07A00)
        public val pageDark: Color = Color(0xFF060912)
        public val pageLight: Color = Color(0xFFF6F8FF)
        public val starDark: Color = Color(0xFFFFFFFF)
        public val starLight: Color = Color(0xFF7A2FFF)
        public val mutedDark: Color = Color(0xFFDBE4FF)
        public val mutedLight: Color = Color(0xFF48536B)
    }

    /** Optical cuts by displayed (dp) size, never pixel density. */
    public const val FAVICON_BELOW: Float = 24.0f
    public const val SERVICE_MAX: Float = 32.0f
    public const val GOLD_MINIMUM_GLYPH: Float = 48.0f
    public const val CLEAR_SPACE_RATIO: Float = 0.25f
    public const val POWERED_BY_PHRASE: String = "Powered by Polaris Key"

    /** "Powered by" badge minimum sizes in dp: never render smaller. */
    public val badgeMinHorizontal: BrandSize = BrandSize(376.0f, 144.0f)
    public val badgeMinCompact: BrandSize = BrandSize(232.0f, 88.0f)
    public val badgeMinStacked: BrandSize = BrandSize(288.0f, 336.0f)

    /** Corner radii in dp (controls use md, cards lg, the badge frame xl). */
    public object Radius {
        public const val none: Float = 0.0f
        public const val xs: Float = 2.0f
        public const val sm: Float = 4.0f
        public const val md: Float = 6.0f
        public const val lg: Float = 10.0f
        public const val xl: Float = 18.0f
    }

    /** Motion durations in milliseconds. */
    public object Duration {
        public const val instant: Int = 0
        public const val micro: Int = 80
        public const val fast: Int = 120
        public const val base: Int = 200
        public const val moderate: Int = 260
        public const val slow: Int = 320
        public const val deliberate: Int = 480
        public const val shimmer: Int = 1600
    }

    /** Section ids: core plus every service slug. */
    public val serviceIds: List<String> = listOf("core", "license", "config", "release", "distribution", "update", "identity", "sync")

    /** The dark theme (default). */
    public object Dark {
        public val surfacePage: Color = Color(0xFF060912)
        public val surfaceRaised: Color = Color(0xFF0D111B)
        public val surfaceOverlay: Color = Color(0xFF121722)
        public val surfaceSunken: Color = Color(0xFF020408)
        public val textStrong: Color = Color(0xFFFFFFFF)
        public val textDefault: Color = Color(0xFFDBE4FF)
        public val textMuted: Color = Color(0xFFB5BED3)
        public val textSubtle: Color = Color(0xFF969EB2)
        public val textOnAccent: Color = Color(0xFF060912)
        public val borderSubtle: Color = Color(0xFF212633)
        public val borderStrong: Color = Color(0xFF61697B)
        public val focus: Color = Color(0xFF9A5CFF)
        public val action: Color = Color(0xFFF6F8FF)
        public val actionOn: Color = Color(0xFF060912)
        public val stateCoreRing: Color = Color(0xFF9A5CFF)
        public val stateCoreSelectedFill: Color = Color(0xFF18132E)
        public val stateCoreHoverTint: Color = Color(0xFF100F23)
        public val stateCoreCheckedFill: Color = Color(0xFF9A5CFF)
        public val stateCoreCheckedOn: Color = Color(0xFF060912)
        public val stateCoreCheckedEdge: Color = Color(0xFF9A5CFF)
        public val stateCoreContextEdge: Color = Color(0xFF9A5CFF)
        public val stateLicenseRing: Color = Color(0xFFC6E940)
        public val stateLicenseSelectedFill: Color = Color(0xFF1D2418)
        public val stateLicenseHoverTint: Color = Color(0xFF131915)
        public val stateLicenseCheckedFill: Color = Color(0xFFC6E940)
        public val stateLicenseCheckedOn: Color = Color(0xFF060912)
        public val stateLicenseCheckedEdge: Color = Color(0xFFC6E940)
        public val stateLicenseContextEdge: Color = Color(0xFFC6E940)
        public val stateConfigRing: Color = Color(0xFFFAC700)
        public val stateConfigSelectedFill: Color = Color(0xFF232010)
        public val stateConfigHoverTint: Color = Color(0xFF171611)
        public val stateConfigCheckedFill: Color = Color(0xFFFAC700)
        public val stateConfigCheckedOn: Color = Color(0xFF060912)
        public val stateConfigCheckedEdge: Color = Color(0xFFFAC700)
        public val stateConfigContextEdge: Color = Color(0xFFFAC700)
        public val stateReleaseRing: Color = Color(0xFF00DBFD)
        public val stateReleaseSelectedFill: Color = Color(0xFF05222E)
        public val stateReleaseHoverTint: Color = Color(0xFF061822)
        public val stateReleaseCheckedFill: Color = Color(0xFF00DBFD)
        public val stateReleaseCheckedOn: Color = Color(0xFF060912)
        public val stateReleaseCheckedEdge: Color = Color(0xFF00DBFD)
        public val stateReleaseContextEdge: Color = Color(0xFF00DBFD)
        public val stateDistributionRing: Color = Color(0xFF39D075)
        public val stateDistributionSelectedFill: Color = Color(0xFF0C211E)
        public val stateDistributionHoverTint: Color = Color(0xFF0A1719)
        public val stateDistributionCheckedFill: Color = Color(0xFF39D075)
        public val stateDistributionCheckedOn: Color = Color(0xFF060912)
        public val stateDistributionCheckedEdge: Color = Color(0xFF39D075)
        public val stateDistributionContextEdge: Color = Color(0xFF39D075)
        public val stateUpdateRing: Color = Color(0xFFFE8001)
        public val stateUpdateSelectedFill: Color = Color(0xFF241710)
        public val stateUpdateHoverTint: Color = Color(0xFF171111)
        public val stateUpdateCheckedFill: Color = Color(0xFFFE8001)
        public val stateUpdateCheckedOn: Color = Color(0xFF060912)
        public val stateUpdateCheckedEdge: Color = Color(0xFFFE8001)
        public val stateUpdateContextEdge: Color = Color(0xFFFE8001)
        public val stateIdentityRing: Color = Color(0xFFD77DF2)
        public val stateIdentitySelectedFill: Color = Color(0xFF1F172D)
        public val stateIdentityHoverTint: Color = Color(0xFF151122)
        public val stateIdentityCheckedFill: Color = Color(0xFFD77DF2)
        public val stateIdentityCheckedOn: Color = Color(0xFF060912)
        public val stateIdentityCheckedEdge: Color = Color(0xFFD77DF2)
        public val stateIdentityContextEdge: Color = Color(0xFFD77DF2)
        public val stateSyncRing: Color = Color(0xFF14F8E1)
        public val stateSyncSelectedFill: Color = Color(0xFF08262B)
        public val stateSyncHoverTint: Color = Color(0xFF071A20)
        public val stateSyncCheckedFill: Color = Color(0xFF14F8E1)
        public val stateSyncCheckedOn: Color = Color(0xFF060912)
        public val stateSyncCheckedEdge: Color = Color(0xFF14F8E1)
        public val stateSyncContextEdge: Color = Color(0xFF14F8E1)
        public val success: Color = Color(0xFF56D57B)
        public val successOn: Color = Color(0xFF060912)
        public val successBorder: Color = Color(0xFF3B9555)
        public val successSubtle: Color = Color(0xFF10211F)
        public val warning: Color = Color(0xFFC38D18)
        public val warningOn: Color = Color(0xFF060912)
        public val warningBorder: Color = Color(0xFF896100)
        public val warningSubtle: Color = Color(0xFF1D1913)
        public val danger: Color = Color(0xFFF2513F)
        public val dangerOn: Color = Color(0xFF060912)
        public val dangerBorder: Color = Color(0xFFC83B2C)
        public val dangerSubtle: Color = Color(0xFF221217)
        public val info: Color = Color(0xFFB688FE)
        public val infoOn: Color = Color(0xFF060912)
        public val infoBorder: Color = Color(0xFF8F54DC)
        public val infoSubtle: Color = Color(0xFF1B182E)
        public val signed: Color = Color(0xFFFFC24D)
        public val signedOn: Color = Color(0xFF060912)
        public val signedBorder: Color = Color(0xFFBA882E)
        public val signedSubtle: Color = Color(0xFF241F19)
        public val signedMark: Color = Color(0xFFFFC24D)
        public val brandViolet: Color = Color(0xFF9A5CFF)
        public val brandStar: Color = Color(0xFFFFFFFF)
        public val brandGold: Color = Color(0xFFFFC24D)
    }

    /** The light theme. */
    public object Light {
        public val surfacePage: Color = Color(0xFFF6F8FF)
        public val surfaceRaised: Color = Color(0xFFFFFFFF)
        public val surfaceOverlay: Color = Color(0xFFFFFFFF)
        public val surfaceSunken: Color = Color(0xFFEBEEF8)
        public val textStrong: Color = Color(0xFF060912)
        public val textDefault: Color = Color(0xFF262D40)
        public val textMuted: Color = Color(0xFF48536B)
        public val textSubtle: Color = Color(0xFF5D667B)
        public val textOnAccent: Color = Color(0xFFFFFFFF)
        public val borderSubtle: Color = Color(0xFFDADEE9)
        public val borderStrong: Color = Color(0xFF7E8699)
        public val focus: Color = Color(0xFF7A2FFF)
        public val action: Color = Color(0xFF060912)
        public val actionOn: Color = Color(0xFFFFFFFF)
        public val stateCoreRing: Color = Color(0xFF7A2FFF)
        public val stateCoreSelectedFill: Color = Color(0xFFEAE4FF)
        public val stateCoreHoverTint: Color = Color(0xFFEFECFF)
        public val stateCoreCheckedFill: Color = Color(0xFF7A2FFF)
        public val stateCoreCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateCoreCheckedEdge: Color = Color(0xFF7A2FFF)
        public val stateCoreContextEdge: Color = Color(0xFF7A2FFF)
        public val stateLicenseRing: Color = Color(0xFF556E00)
        public val stateLicenseSelectedFill: Color = Color(0xFFE8EDE6)
        public val stateLicenseHoverTint: Color = Color(0xFFEEF1F0)
        public val stateLicenseCheckedFill: Color = Color(0xFF6D8600)
        public val stateLicenseCheckedOn: Color = Color(0xFF060912)
        public val stateLicenseCheckedEdge: Color = Color(0xFF556E00)
        public val stateLicenseContextEdge: Color = Color(0xFF556E00)
        public val stateConfigRing: Color = Color(0xFF866500)
        public val stateConfigSelectedFill: Color = Color(0xFFEBEAE6)
        public val stateConfigHoverTint: Color = Color(0xFFF0EFF0)
        public val stateConfigCheckedFill: Color = Color(0xFF8B6902)
        public val stateConfigCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateConfigCheckedEdge: Color = Color(0xFF866500)
        public val stateConfigContextEdge: Color = Color(0xFF866500)
        public val stateReleaseRing: Color = Color(0xFF007487)
        public val stateReleaseSelectedFill: Color = Color(0xFFDDEDF6)
        public val stateReleaseHoverTint: Color = Color(0xFFE7F2F9)
        public val stateReleaseCheckedFill: Color = Color(0xFF008CA3)
        public val stateReleaseCheckedOn: Color = Color(0xFF060912)
        public val stateReleaseCheckedEdge: Color = Color(0xFF007487)
        public val stateReleaseContextEdge: Color = Color(0xFF007487)
        public val stateDistributionRing: Color = Color(0xFF05773B)
        public val stateDistributionSelectedFill: Color = Color(0xFFDEEBEB)
        public val stateDistributionHoverTint: Color = Color(0xFFE8F0F3)
        public val stateDistributionCheckedFill: Color = Color(0xFF05773B)
        public val stateDistributionCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateDistributionCheckedEdge: Color = Color(0xFF05773B)
        public val stateDistributionContextEdge: Color = Color(0xFF05773B)
        public val stateUpdateRing: Color = Color(0xFFAA5000)
        public val stateUpdateSelectedFill: Color = Color(0xFFF0E8E6)
        public val stateUpdateHoverTint: Color = Color(0xFFF2EEF0)
        public val stateUpdateCheckedFill: Color = Color(0xFFB95800)
        public val stateUpdateCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateUpdateCheckedEdge: Color = Color(0xFFAA5000)
        public val stateUpdateContextEdge: Color = Color(0xFFAA5000)
        public val stateIdentityRing: Color = Color(0xFF9E34AE)
        public val stateIdentitySelectedFill: Color = Color(0xFFEDE4F7)
        public val stateIdentityHoverTint: Color = Color(0xFFF1ECFA)
        public val stateIdentityCheckedFill: Color = Color(0xFF9E34AE)
        public val stateIdentityCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateIdentityCheckedEdge: Color = Color(0xFF9E34AE)
        public val stateIdentityContextEdge: Color = Color(0xFF9E34AE)
        public val stateSyncRing: Color = Color(0xFF086260)
        public val stateSyncSelectedFill: Color = Color(0xFFDEE9EF)
        public val stateSyncHoverTint: Color = Color(0xFFE8EFF5)
        public val stateSyncCheckedFill: Color = Color(0xFF086260)
        public val stateSyncCheckedOn: Color = Color(0xFFFFFFFF)
        public val stateSyncCheckedEdge: Color = Color(0xFF086260)
        public val stateSyncContextEdge: Color = Color(0xFF086260)
        public val success: Color = Color(0xFF167337)
        public val successOn: Color = Color(0xFFFFFFFF)
        public val successBorder: Color = Color(0xFF348F4F)
        public val successSubtle: Color = Color(0xFFE0EBEB)
        public val warning: Color = Color(0xFF814D00)
        public val warningOn: Color = Color(0xFFFFFFFF)
        public val warningBorder: Color = Color(0xFF9D6726)
        public val warningSubtle: Color = Color(0xFFEAE7E6)
        public val danger: Color = Color(0xFFBE2323)
        public val dangerOn: Color = Color(0xFFFFFFFF)
        public val dangerBorder: Color = Color(0xFFDB423C)
        public val dangerSubtle: Color = Color(0xFFF0E3E9)
        public val info: Color = Color(0xFF7A2FFF)
        public val infoOn: Color = Color(0xFFFFFFFF)
        public val infoBorder: Color = Color(0xFF8E66F1)
        public val infoSubtle: Color = Color(0xFFEAE4FF)
        public val signed: Color = Color(0xFFC47300)
        public val signedOn: Color = Color(0xFF060912)
        public val signedBorder: Color = Color(0xFFBF7101)
        public val signedSubtle: Color = Color(0xFFF1EBE6)
        public val signedMark: Color = Color(0xFFD07A00)
        public val brandViolet: Color = Color(0xFF7A2FFF)
        public val brandStar: Color = Color(0xFF7A2FFF)
        public val brandGold: Color = Color(0xFFD07A00)
    }

    private val accentsDark: Map<String, BrandAccent> = mapOf(
        "core" to BrandAccent(solid = Color(0xFF9A5CFF), fg = Color(0xFF9A5CFF), on = Color(0xFF060912), subtle = Color(0xFF18132E), bit = null),
        "license" to BrandAccent(solid = Color(0xFFC6E940), fg = Color(0xFFC6E940), on = Color(0xFF060912), subtle = Color(0xFF1D2418), bit = Color(0xFFC6E940)),
        "config" to BrandAccent(solid = Color(0xFFFAC700), fg = Color(0xFFFAC700), on = Color(0xFF060912), subtle = Color(0xFF232010), bit = Color(0xFFFAC700)),
        "release" to BrandAccent(solid = Color(0xFF00DBFD), fg = Color(0xFF00DBFD), on = Color(0xFF060912), subtle = Color(0xFF05222E), bit = Color(0xFF00DBFD)),
        "distribution" to BrandAccent(solid = Color(0xFF39D075), fg = Color(0xFF39D075), on = Color(0xFF060912), subtle = Color(0xFF0C211E), bit = Color(0xFF39D075)),
        "update" to BrandAccent(solid = Color(0xFFFE8001), fg = Color(0xFFFE8001), on = Color(0xFF060912), subtle = Color(0xFF241710), bit = Color(0xFFFE8001)),
        "identity" to BrandAccent(solid = Color(0xFFD77DF2), fg = Color(0xFFD77DF2), on = Color(0xFF060912), subtle = Color(0xFF1F172D), bit = Color(0xFFD77DF2)),
        "sync" to BrandAccent(solid = Color(0xFF14F8E1), fg = Color(0xFF14F8E1), on = Color(0xFF060912), subtle = Color(0xFF08262B), bit = Color(0xFF14F8E1)),
    )

    private val accentsLight: Map<String, BrandAccent> = mapOf(
        "core" to BrandAccent(solid = Color(0xFF7A2FFF), fg = Color(0xFF7A2FFF), on = Color(0xFFFFFFFF), subtle = Color(0xFFEAE4FF), bit = null),
        "license" to BrandAccent(solid = Color(0xFF6D8600), fg = Color(0xFF556E00), on = Color(0xFF060912), subtle = Color(0xFFE8EDE6), bit = Color(0xFF6D8600)),
        "config" to BrandAccent(solid = Color(0xFF8B6902), fg = Color(0xFF866500), on = Color(0xFFFFFFFF), subtle = Color(0xFFEBEAE6), bit = Color(0xFF8B6902)),
        "release" to BrandAccent(solid = Color(0xFF008CA3), fg = Color(0xFF007487), on = Color(0xFF060912), subtle = Color(0xFFDDEDF6), bit = Color(0xFF008CA3)),
        "distribution" to BrandAccent(solid = Color(0xFF05773B), fg = Color(0xFF05773B), on = Color(0xFFFFFFFF), subtle = Color(0xFFDEEBEB), bit = Color(0xFF05773B)),
        "update" to BrandAccent(solid = Color(0xFFB95800), fg = Color(0xFFAA5000), on = Color(0xFFFFFFFF), subtle = Color(0xFFF0E8E6), bit = Color(0xFFB95800)),
        "identity" to BrandAccent(solid = Color(0xFF9E34AE), fg = Color(0xFF9E34AE), on = Color(0xFFFFFFFF), subtle = Color(0xFFEDE4F7), bit = Color(0xFF9E34AE)),
        "sync" to BrandAccent(solid = Color(0xFF086260), fg = Color(0xFF086260), on = Color(0xFFFFFFFF), subtle = Color(0xFFDEE9EF), bit = Color(0xFF086260)),
    )

    /** A section's accent. Unknown ids answer the core (platform) violet. */
    public fun accent(service: String, dark: Boolean = true): BrandAccent {
        val table = if (dark) accentsDark else accentsLight
        return table[service] ?: table.getValue("core")
    }

    /** Which optical cut a mark displayed at [size] dp uses. */
    public fun opticalCut(size: Float): String = when {
        size < FAVICON_BELOW -> "favicon"
        size <= SERVICE_MAX -> "service"
        else -> "display"
    }
}

/** The kit artwork the Compose kit draws when Polaris Key branding is on. */
public object PolarisBrandMarkData {
    /** The Pinned K, display cut, for dark grounds; no terminal bit. kit/01-marks/key/svg/key-display-dark.svg. */
    public val pinnedKDark: BrandVector = BrandVector(
        width = 96.0f,
        height = 96.0f,
        nodes = listOf(
            BrandVectorNode.Group(
                translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                children = listOf(
                    BrandVectorNode.Path(fill = Color(0xFF9A5CFF), pathData = "M14 15.6 L35.6 5 Q37 4.3 37 6 L37 76 L14 87 Q13 87.5 13 86 L13 18 Q13 16.3 14 15.6 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF9A5CFF), pathData = "M41 44 L57 44 Q58 44 59 45 L81 67 Q82 68 81 69 L68 82 Q67 83 66 82 L41 57 Q40 56 40 55 L40 45 Q40 44 41 44 Z"),
                    BrandVectorNode.Path(fill = Color(0xFFFFFFFF), pathData = "M64 6 L70 18 L82 24 L70 30 L64 42 L58 30 L46 24 L58 18 Z"),
                ),
            ),
        ),
    )

    /** The Pinned K, display cut, for light grounds; no terminal bit. kit/01-marks/key/svg/key-display-light.svg. */
    public val pinnedKLight: BrandVector = BrandVector(
        width = 96.0f,
        height = 96.0f,
        nodes = listOf(
            BrandVectorNode.Group(
                translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                children = listOf(
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M14 15.6 L35.6 5 Q37 4.3 37 6 L37 76 L14 87 Q13 87.5 13 86 L13 18 Q13 16.3 14 15.6 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M41 44 L57 44 Q58 44 59 45 L81 67 Q82 68 81 69 L68 82 Q67 83 66 82 L41 57 Q40 56 40 55 L40 45 Q40 44 41 44 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M64 6 L70 18 L82 24 L70 30 L64 42 L58 30 L46 24 L58 18 Z"),
                ),
            ),
        ),
    )

    /** The compact "Powered by Polaris Key" badge, transparent treatment, for dark grounds. kit/03-powered-by/transparent/powered-by-compact-dark.svg. */
    public val poweredByCompactDark: BrandVector = BrandVector(
        width = 232.0f,
        height = 88.0f,
        nodes = listOf(
            BrandVectorNode.Group(
                translateX = 16.0f, translateY = 28.0f, scaleX = 1.3333333333333333f, scaleY = 1.3333333333333333f, fill = null,
                children = listOf(
                    BrandVectorNode.Path(fill = Color(0xFF9A5CFF), pathData = "M3 4 L9 1 L9 19 L3 22 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF9A5CFF), pathData = "M11 12 L15 12 L21 18 L18 21 L11 14 Z"),
                    BrandVectorNode.Path(fill = Color(0xFFFFFFFF), pathData = "M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"),
                ),
            ),
            BrandVectorNode.Group(
                translateX = 62.0f, translateY = 35.0f, scaleX = 0.012f, scaleY = -0.012f, fill = Color(0xFFDBE4FF),
                children = listOf(
                    BrandVectorNode.Group(
                        translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M606 488Q606 418 573.5 369.0Q541 320 486.5 296.0Q432 272 365 272H181V27Q181 16 173.0 8.0Q165 0 154 0H113Q102 0 94.0 8.0Q86 16 86 27V673Q86 684 94.0 692.0Q102 700 113 700H365Q469 700 537.5 646.0Q606 592 606 488ZM360 362Q433 362 472.0 393.5Q511 425 511 488Q511 610 360 610H181V362Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 640.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M527 259Q527 235 525 213Q516 111 454.5 50.5Q393 -10 288 -10Q183 -10 121.5 50.5Q60 111 51 213Q50 224 50 259Q50 296 51 307Q59 409 121.0 469.5Q183 530 288 530Q393 530 455.0 469.5Q517 409 525 307Q527 285 527 259ZM288 444Q221 444 184.5 405.0Q148 366 142 302Q141 290 141 259Q141 229 142 218Q148 154 184.5 115.0Q221 76 288 76Q355 76 391.5 115.0Q428 154 434 218Q436 240 436 259Q436 278 434 302Q428 366 391.5 405.0Q355 444 288 444Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1217.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M676 496Q685 520 710 520H743Q753 520 760.0 513.0Q767 506 767 496L766 488L613 28Q604 0 583 0H552Q540 0 533.0 7.5Q526 15 521 28L402 360L283 28Q278 15 271.0 7.5Q264 0 252 0H221Q200 0 191 28L38 488L37 496Q37 506 44.0 513.0Q51 520 61 520H94Q119 520 128 496L240 162L360 496Q369 520 391 520H413Q435 520 444 496L564 162Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2021.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M511 277V250Q511 239 503.0 231.0Q495 223 484 223H140V217Q142 151 180.5 113.5Q219 76 280 76Q330 76 357.5 89.0Q385 102 407 126Q415 134 421.5 137.0Q428 140 439 140H469Q481 140 489.0 132.0Q497 124 496 113Q492 86 466.5 57.5Q441 29 393.5 9.5Q346 -10 280 -10Q216 -10 166.0 19.5Q116 49 86.5 101.0Q57 153 51 218Q49 248 49 264Q49 280 51 310Q57 372 86.5 422.0Q116 472 165.5 501.0Q215 530 280 530Q387 530 449.0 462.0Q511 394 511 277ZM421 307V310Q421 371 382.5 407.5Q344 444 280 444Q222 444 181.5 407.0Q141 370 140 310V307Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2578.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M366 493V461Q366 450 358.0 442.0Q350 434 339 434H281Q225 434 195.5 404.5Q166 375 166 319V27Q166 16 158.0 8.0Q150 0 139 0H102Q91 0 83.0 8.0Q75 16 75 27V493Q75 504 83.0 512.0Q91 520 102 520H139Q150 520 158.0 512.0Q166 504 166 493V462Q186 492 214.0 506.0Q242 520 287 520H339Q350 520 358.0 512.0Q366 504 366 493Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2956.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M511 277V250Q511 239 503.0 231.0Q495 223 484 223H140V217Q142 151 180.5 113.5Q219 76 280 76Q330 76 357.5 89.0Q385 102 407 126Q415 134 421.5 137.0Q428 140 439 140H469Q481 140 489.0 132.0Q497 124 496 113Q492 86 466.5 57.5Q441 29 393.5 9.5Q346 -10 280 -10Q216 -10 166.0 19.5Q116 49 86.5 101.0Q57 153 51 218Q49 248 49 264Q49 280 51 310Q57 372 86.5 422.0Q116 472 165.5 501.0Q215 530 280 530Q387 530 449.0 462.0Q511 394 511 277ZM421 307V310Q421 371 382.5 407.5Q344 444 280 444Q222 444 181.5 407.0Q141 370 140 310V307Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3513.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M432 683Q432 694 440.0 702.0Q448 710 459 710H496Q507 710 515.0 702.0Q523 694 523 683V27Q523 16 515.0 8.0Q507 0 496 0H459Q448 0 440.0 8.0Q432 16 432 27V58Q381 -10 277 -10Q215 -10 164.5 19.0Q114 48 83.5 102.0Q53 156 50 228L49 261L50 293Q53 365 83.5 418.5Q114 472 164.0 501.0Q214 530 277 530Q333 530 371.5 510.5Q410 491 432 462ZM287 444Q222 444 183.5 402.0Q145 360 141 288L140 260L141 232Q145 160 183.5 118.0Q222 76 287 76Q349 76 389.0 114.5Q429 153 432 217Q433 227 433 257Q433 286 432 296Q429 366 390.0 405.0Q351 444 287 444Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4111.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = ""),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4355.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M549 261Q549 238 548 228Q545 156 514.5 102.0Q484 48 433.5 19.0Q383 -10 321 -10Q217 -10 166 58V27Q166 16 158.0 8.0Q150 0 139 0H102Q91 0 83.0 8.0Q75 16 75 27V683Q75 694 83.0 702.0Q91 710 102 710H139Q150 710 158.0 702.0Q166 694 166 683V462Q188 491 226.5 510.5Q265 530 321 530Q384 530 434.0 501.0Q484 472 514.5 418.5Q545 365 548 293Q549 283 549 261ZM457 232Q458 242 458 260Q458 345 419.5 394.5Q381 444 311 444Q248 444 210.0 405.0Q172 366 166 296Q165 286 165 257Q165 227 166 217Q171 152 210.5 114.0Q250 76 311 76Q376 76 414.0 117.5Q452 159 457 232Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4953.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M199 -190H158Q148 -190 141.0 -183.0Q134 -176 134 -166Q134 -162 135 -159L231 50L33 489Q32 492 32 496Q32 506 39.0 513.0Q46 520 56 520H97Q117 520 126 496L280 156L436 496Q445 520 465 520H506Q516 520 523.0 513.0Q530 506 530 496Q530 492 529 489L228 -166Q219 -190 199 -190Z"),
                        ),
                    ),
                ),
            ),
            BrandVectorNode.Group(
                translateX = 62.0f, translateY = 60.0f, scaleX = 0.024f, scaleY = -0.024f, fill = Color(0xFFFFFFFF),
                children = listOf(
                    BrandVectorNode.Group(
                        translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M660 466Q660 351 586.5 291.0Q513 231 383 231H255V27Q255 16 247.0 8.0Q239 0 228 0H97Q86 0 78.0 8.0Q70 16 70 27V673Q70 684 78.0 692.0Q86 700 97 700H383Q513 700 586.5 640.5Q660 581 660 466ZM378 387Q422 387 448.5 406.5Q475 426 475 466Q475 506 448.5 525.5Q422 545 378 545H255V387Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 686.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M308 -10Q229 -10 168.0 21.0Q107 52 73.0 104.5Q39 157 36 221L35 260L36 298Q38 362 72.0 415.0Q106 468 167.5 499.0Q229 530 308 530Q387 530 448.5 499.0Q510 468 544.0 415.0Q578 362 580 298Q581 288 581 260Q581 231 580 221Q577 157 543.0 104.5Q509 52 448.0 21.0Q387 -10 308 -10ZM400 226Q402 246 402 260Q402 274 400 294Q397 332 372.5 353.5Q348 375 308 375Q268 375 243.5 353.5Q219 332 216 294Q215 284 215 260Q215 236 216 226Q219 188 243.5 166.5Q268 145 308 145Q348 145 372.5 166.5Q397 188 400 226Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1302.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M211 0H85Q74 0 66.0 8.0Q58 16 58 27V683Q58 694 66.0 702.0Q74 710 85 710H211Q222 710 230.0 702.0Q238 694 238 683V27Q238 16 230.0 8.0Q222 0 211 0Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1598.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M356 340Q356 395 298 395Q265 395 244 377Q236 369 228.0 367.0Q220 365 208 365H81Q71 365 64.5 371.0Q58 377 59 387Q62 418 93.5 451.5Q125 485 179.0 507.5Q233 530 298 530Q417 530 476.5 476.0Q536 422 536 330V27Q536 16 528.0 8.0Q520 0 509 0H383Q372 0 364.0 8.0Q356 16 356 27V55Q330 23 294.0 6.5Q258 -10 203 -10Q119 -10 71.5 34.0Q24 78 24 148Q24 215 76.0 258.0Q128 301 239 320ZM264 207Q236 202 220.0 189.5Q204 177 204 159Q204 125 252 125Q296 125 326.0 153.0Q356 181 356 221Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2187.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M448 493V392Q448 381 440.0 373.0Q432 365 421 365H330Q285 365 261.5 341.5Q238 318 238 273V27Q238 16 230.0 8.0Q222 0 211 0H85Q74 0 66.0 8.0Q58 16 58 27V493Q58 504 66.0 512.0Q74 520 85 520H201Q212 520 220.0 512.0Q228 504 228 493V470Q280 520 361 520H421Q432 520 440.0 512.0Q448 504 448 493Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2646.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M211 575H85Q74 575 66.0 583.0Q58 591 58 602V703Q58 714 66.0 722.0Q74 730 85 730H211Q222 730 230.0 722.0Q238 714 238 703V602Q238 591 230.0 583.0Q222 575 211 575ZM211 0H85Q74 0 66.0 8.0Q58 16 58 27V493Q58 504 66.0 512.0Q74 520 85 520H211Q222 520 230.0 512.0Q238 504 238 493V27Q238 16 230.0 8.0Q222 0 211 0Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2942.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M40 369Q40 414 69.5 450.5Q99 487 152.5 508.5Q206 530 274 530Q341 530 395.5 509.5Q450 489 482.0 457.0Q514 425 517 390Q518 379 509.5 371.0Q501 363 490 363H371Q360 363 345 374Q332 384 317.0 389.5Q302 395 274 395Q250 395 235.0 388.0Q220 381 220 367Q220 355 225.5 349.0Q231 343 245.5 340.0Q260 337 296 332L358 322Q445 308 488.5 262.5Q532 217 532 154Q532 109 501.5 71.5Q471 34 413.5 12.0Q356 -10 278 -10Q203 -10 147.5 11.5Q92 33 62.5 66.0Q33 99 30 133Q29 144 37.5 152.0Q46 160 57 160H181Q188 160 192.5 157.5Q197 155 203 149Q215 138 230.0 131.5Q245 125 278 125Q309 125 330.5 133.5Q352 142 352 156Q352 172 336.5 177.5Q321 183 270 191L198 203Q122 217 81.0 259.5Q40 302 40 369Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3504.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = ""),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3716.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M666 22Q666 13 659.5 6.5Q653 0 644 0H485Q472 0 463.0 5.5Q454 11 444 23L255 261V27Q255 16 247.0 8.0Q239 0 228 0H97Q86 0 78.0 8.0Q70 16 70 27V673Q70 684 78.0 692.0Q86 700 97 700H228Q239 700 247.0 692.0Q255 684 255 673V462L431 678Q439 688 447.0 694.0Q455 700 471 700H627Q636 700 642.5 693.5Q649 687 649 678Q649 672 646 667L399 365L663 33Q666 29 666 22Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4389.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M304 125Q332 125 350.0 131.0Q368 137 381 148Q392 157 397.0 159.5Q402 162 414 162H544Q554 162 560.0 156.0Q566 150 566 140Q566 120 536.0 83.5Q506 47 447.0 18.5Q388 -10 304 -10Q175 -10 104.5 61.5Q34 133 34 260Q34 339 65.5 400.0Q97 461 158.0 495.5Q219 530 304 530Q397 530 457.5 490.5Q518 451 546.0 388.5Q574 326 574 258V230Q574 219 566.0 211.0Q558 203 547 203H214Q214 161 241.0 143.0Q268 125 304 125ZM394 314Q390 348 366.5 371.5Q343 395 304 395Q265 395 241.5 371.5Q218 348 214 314Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4996.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M300 -190H169Q159 -190 152.0 -183.0Q145 -176 145 -166Q145 -162 146 -159L222 20L20 489Q19 492 19 496Q19 506 26.0 513.0Q33 520 43 520H174Q194 520 203 496L314 236L424 496Q433 520 453 520H585Q595 520 602.0 513.0Q609 506 609 496Q609 492 608 489L329 -166Q320 -190 300 -190Z"),
                        ),
                    ),
                ),
            ),
        ),
    )

    /** The compact "Powered by Polaris Key" badge, transparent treatment, for light grounds. kit/03-powered-by/transparent/powered-by-compact-light.svg. */
    public val poweredByCompactLight: BrandVector = BrandVector(
        width = 232.0f,
        height = 88.0f,
        nodes = listOf(
            BrandVectorNode.Group(
                translateX = 16.0f, translateY = 28.0f, scaleX = 1.3333333333333333f, scaleY = 1.3333333333333333f, fill = null,
                children = listOf(
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M3 4 L9 1 L9 19 L3 22 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M11 12 L15 12 L21 18 L18 21 L11 14 Z"),
                    BrandVectorNode.Path(fill = Color(0xFF7A2FFF), pathData = "M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"),
                ),
            ),
            BrandVectorNode.Group(
                translateX = 62.0f, translateY = 35.0f, scaleX = 0.012f, scaleY = -0.012f, fill = Color(0xFF48536B),
                children = listOf(
                    BrandVectorNode.Group(
                        translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M606 488Q606 418 573.5 369.0Q541 320 486.5 296.0Q432 272 365 272H181V27Q181 16 173.0 8.0Q165 0 154 0H113Q102 0 94.0 8.0Q86 16 86 27V673Q86 684 94.0 692.0Q102 700 113 700H365Q469 700 537.5 646.0Q606 592 606 488ZM360 362Q433 362 472.0 393.5Q511 425 511 488Q511 610 360 610H181V362Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 640.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M527 259Q527 235 525 213Q516 111 454.5 50.5Q393 -10 288 -10Q183 -10 121.5 50.5Q60 111 51 213Q50 224 50 259Q50 296 51 307Q59 409 121.0 469.5Q183 530 288 530Q393 530 455.0 469.5Q517 409 525 307Q527 285 527 259ZM288 444Q221 444 184.5 405.0Q148 366 142 302Q141 290 141 259Q141 229 142 218Q148 154 184.5 115.0Q221 76 288 76Q355 76 391.5 115.0Q428 154 434 218Q436 240 436 259Q436 278 434 302Q428 366 391.5 405.0Q355 444 288 444Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1217.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M676 496Q685 520 710 520H743Q753 520 760.0 513.0Q767 506 767 496L766 488L613 28Q604 0 583 0H552Q540 0 533.0 7.5Q526 15 521 28L402 360L283 28Q278 15 271.0 7.5Q264 0 252 0H221Q200 0 191 28L38 488L37 496Q37 506 44.0 513.0Q51 520 61 520H94Q119 520 128 496L240 162L360 496Q369 520 391 520H413Q435 520 444 496L564 162Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2021.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M511 277V250Q511 239 503.0 231.0Q495 223 484 223H140V217Q142 151 180.5 113.5Q219 76 280 76Q330 76 357.5 89.0Q385 102 407 126Q415 134 421.5 137.0Q428 140 439 140H469Q481 140 489.0 132.0Q497 124 496 113Q492 86 466.5 57.5Q441 29 393.5 9.5Q346 -10 280 -10Q216 -10 166.0 19.5Q116 49 86.5 101.0Q57 153 51 218Q49 248 49 264Q49 280 51 310Q57 372 86.5 422.0Q116 472 165.5 501.0Q215 530 280 530Q387 530 449.0 462.0Q511 394 511 277ZM421 307V310Q421 371 382.5 407.5Q344 444 280 444Q222 444 181.5 407.0Q141 370 140 310V307Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2578.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M366 493V461Q366 450 358.0 442.0Q350 434 339 434H281Q225 434 195.5 404.5Q166 375 166 319V27Q166 16 158.0 8.0Q150 0 139 0H102Q91 0 83.0 8.0Q75 16 75 27V493Q75 504 83.0 512.0Q91 520 102 520H139Q150 520 158.0 512.0Q166 504 166 493V462Q186 492 214.0 506.0Q242 520 287 520H339Q350 520 358.0 512.0Q366 504 366 493Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2956.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M511 277V250Q511 239 503.0 231.0Q495 223 484 223H140V217Q142 151 180.5 113.5Q219 76 280 76Q330 76 357.5 89.0Q385 102 407 126Q415 134 421.5 137.0Q428 140 439 140H469Q481 140 489.0 132.0Q497 124 496 113Q492 86 466.5 57.5Q441 29 393.5 9.5Q346 -10 280 -10Q216 -10 166.0 19.5Q116 49 86.5 101.0Q57 153 51 218Q49 248 49 264Q49 280 51 310Q57 372 86.5 422.0Q116 472 165.5 501.0Q215 530 280 530Q387 530 449.0 462.0Q511 394 511 277ZM421 307V310Q421 371 382.5 407.5Q344 444 280 444Q222 444 181.5 407.0Q141 370 140 310V307Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3513.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M432 683Q432 694 440.0 702.0Q448 710 459 710H496Q507 710 515.0 702.0Q523 694 523 683V27Q523 16 515.0 8.0Q507 0 496 0H459Q448 0 440.0 8.0Q432 16 432 27V58Q381 -10 277 -10Q215 -10 164.5 19.0Q114 48 83.5 102.0Q53 156 50 228L49 261L50 293Q53 365 83.5 418.5Q114 472 164.0 501.0Q214 530 277 530Q333 530 371.5 510.5Q410 491 432 462ZM287 444Q222 444 183.5 402.0Q145 360 141 288L140 260L141 232Q145 160 183.5 118.0Q222 76 287 76Q349 76 389.0 114.5Q429 153 432 217Q433 227 433 257Q433 286 432 296Q429 366 390.0 405.0Q351 444 287 444Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4111.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = ""),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4355.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M549 261Q549 238 548 228Q545 156 514.5 102.0Q484 48 433.5 19.0Q383 -10 321 -10Q217 -10 166 58V27Q166 16 158.0 8.0Q150 0 139 0H102Q91 0 83.0 8.0Q75 16 75 27V683Q75 694 83.0 702.0Q91 710 102 710H139Q150 710 158.0 702.0Q166 694 166 683V462Q188 491 226.5 510.5Q265 530 321 530Q384 530 434.0 501.0Q484 472 514.5 418.5Q545 365 548 293Q549 283 549 261ZM457 232Q458 242 458 260Q458 345 419.5 394.5Q381 444 311 444Q248 444 210.0 405.0Q172 366 166 296Q165 286 165 257Q165 227 166 217Q171 152 210.5 114.0Q250 76 311 76Q376 76 414.0 117.5Q452 159 457 232Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4953.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M199 -190H158Q148 -190 141.0 -183.0Q134 -176 134 -166Q134 -162 135 -159L231 50L33 489Q32 492 32 496Q32 506 39.0 513.0Q46 520 56 520H97Q117 520 126 496L280 156L436 496Q445 520 465 520H506Q516 520 523.0 513.0Q530 506 530 496Q530 492 529 489L228 -166Q219 -190 199 -190Z"),
                        ),
                    ),
                ),
            ),
            BrandVectorNode.Group(
                translateX = 62.0f, translateY = 60.0f, scaleX = 0.024f, scaleY = -0.024f, fill = Color(0xFF060912),
                children = listOf(
                    BrandVectorNode.Group(
                        translateX = 0.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M660 466Q660 351 586.5 291.0Q513 231 383 231H255V27Q255 16 247.0 8.0Q239 0 228 0H97Q86 0 78.0 8.0Q70 16 70 27V673Q70 684 78.0 692.0Q86 700 97 700H383Q513 700 586.5 640.5Q660 581 660 466ZM378 387Q422 387 448.5 406.5Q475 426 475 466Q475 506 448.5 525.5Q422 545 378 545H255V387Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 686.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M308 -10Q229 -10 168.0 21.0Q107 52 73.0 104.5Q39 157 36 221L35 260L36 298Q38 362 72.0 415.0Q106 468 167.5 499.0Q229 530 308 530Q387 530 448.5 499.0Q510 468 544.0 415.0Q578 362 580 298Q581 288 581 260Q581 231 580 221Q577 157 543.0 104.5Q509 52 448.0 21.0Q387 -10 308 -10ZM400 226Q402 246 402 260Q402 274 400 294Q397 332 372.5 353.5Q348 375 308 375Q268 375 243.5 353.5Q219 332 216 294Q215 284 215 260Q215 236 216 226Q219 188 243.5 166.5Q268 145 308 145Q348 145 372.5 166.5Q397 188 400 226Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1302.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M211 0H85Q74 0 66.0 8.0Q58 16 58 27V683Q58 694 66.0 702.0Q74 710 85 710H211Q222 710 230.0 702.0Q238 694 238 683V27Q238 16 230.0 8.0Q222 0 211 0Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 1598.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M356 340Q356 395 298 395Q265 395 244 377Q236 369 228.0 367.0Q220 365 208 365H81Q71 365 64.5 371.0Q58 377 59 387Q62 418 93.5 451.5Q125 485 179.0 507.5Q233 530 298 530Q417 530 476.5 476.0Q536 422 536 330V27Q536 16 528.0 8.0Q520 0 509 0H383Q372 0 364.0 8.0Q356 16 356 27V55Q330 23 294.0 6.5Q258 -10 203 -10Q119 -10 71.5 34.0Q24 78 24 148Q24 215 76.0 258.0Q128 301 239 320ZM264 207Q236 202 220.0 189.5Q204 177 204 159Q204 125 252 125Q296 125 326.0 153.0Q356 181 356 221Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2187.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M448 493V392Q448 381 440.0 373.0Q432 365 421 365H330Q285 365 261.5 341.5Q238 318 238 273V27Q238 16 230.0 8.0Q222 0 211 0H85Q74 0 66.0 8.0Q58 16 58 27V493Q58 504 66.0 512.0Q74 520 85 520H201Q212 520 220.0 512.0Q228 504 228 493V470Q280 520 361 520H421Q432 520 440.0 512.0Q448 504 448 493Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2646.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M211 575H85Q74 575 66.0 583.0Q58 591 58 602V703Q58 714 66.0 722.0Q74 730 85 730H211Q222 730 230.0 722.0Q238 714 238 703V602Q238 591 230.0 583.0Q222 575 211 575ZM211 0H85Q74 0 66.0 8.0Q58 16 58 27V493Q58 504 66.0 512.0Q74 520 85 520H211Q222 520 230.0 512.0Q238 504 238 493V27Q238 16 230.0 8.0Q222 0 211 0Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 2942.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M40 369Q40 414 69.5 450.5Q99 487 152.5 508.5Q206 530 274 530Q341 530 395.5 509.5Q450 489 482.0 457.0Q514 425 517 390Q518 379 509.5 371.0Q501 363 490 363H371Q360 363 345 374Q332 384 317.0 389.5Q302 395 274 395Q250 395 235.0 388.0Q220 381 220 367Q220 355 225.5 349.0Q231 343 245.5 340.0Q260 337 296 332L358 322Q445 308 488.5 262.5Q532 217 532 154Q532 109 501.5 71.5Q471 34 413.5 12.0Q356 -10 278 -10Q203 -10 147.5 11.5Q92 33 62.5 66.0Q33 99 30 133Q29 144 37.5 152.0Q46 160 57 160H181Q188 160 192.5 157.5Q197 155 203 149Q215 138 230.0 131.5Q245 125 278 125Q309 125 330.5 133.5Q352 142 352 156Q352 172 336.5 177.5Q321 183 270 191L198 203Q122 217 81.0 259.5Q40 302 40 369Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3504.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = ""),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 3716.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M666 22Q666 13 659.5 6.5Q653 0 644 0H485Q472 0 463.0 5.5Q454 11 444 23L255 261V27Q255 16 247.0 8.0Q239 0 228 0H97Q86 0 78.0 8.0Q70 16 70 27V673Q70 684 78.0 692.0Q86 700 97 700H228Q239 700 247.0 692.0Q255 684 255 673V462L431 678Q439 688 447.0 694.0Q455 700 471 700H627Q636 700 642.5 693.5Q649 687 649 678Q649 672 646 667L399 365L663 33Q666 29 666 22Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4389.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M304 125Q332 125 350.0 131.0Q368 137 381 148Q392 157 397.0 159.5Q402 162 414 162H544Q554 162 560.0 156.0Q566 150 566 140Q566 120 536.0 83.5Q506 47 447.0 18.5Q388 -10 304 -10Q175 -10 104.5 61.5Q34 133 34 260Q34 339 65.5 400.0Q97 461 158.0 495.5Q219 530 304 530Q397 530 457.5 490.5Q518 451 546.0 388.5Q574 326 574 258V230Q574 219 566.0 211.0Q558 203 547 203H214Q214 161 241.0 143.0Q268 125 304 125ZM394 314Q390 348 366.5 371.5Q343 395 304 395Q265 395 241.5 371.5Q218 348 214 314Z"),
                        ),
                    ),
                    BrandVectorNode.Group(
                        translateX = 4996.0f, translateY = 0.0f, scaleX = 1.0f, scaleY = 1.0f, fill = null,
                        children = listOf(
                            BrandVectorNode.Path(fill = null, pathData = "M300 -190H169Q159 -190 152.0 -183.0Q145 -176 145 -166Q145 -162 146 -159L222 20L20 489Q19 492 19 496Q19 506 26.0 513.0Q33 520 43 520H174Q194 520 203 496L314 236L424 496Q433 520 453 520H585Q595 520 602.0 513.0Q609 506 609 496Q609 492 608 489L329 -166Q320 -190 300 -190Z"),
                        ),
                    ),
                ),
            ),
        ),
    )
}
