// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.
//
// The accent resolver's shared vectors (packages/brand/fixtures/accent-vectors.json) as Kotlin
// literals for AccentResolverTest.

@file:Suppress("MaxLineLength")

package im.plrs.key.ui.brand

internal data class DeriveVector(val name: String, val pixels: List<IntArray>, val expect: String?)

internal data class ResolveVector(
    val name: String,
    val input: String,
    val dark: Boolean,
    val solid: String,
    val on: String,
    val fg: String,
    val subtle: String,
    val focus: String,
)

internal data class DangerVector(val dark: Boolean, val input: String, val solid: String)

internal object AccentVectors {
    val derive: List<DeriveVector> = listOf(
        DeriveVector("tidewater", listOf(intArrayOf(11, 58, 72, 255, 2600), intArrayOf(95, 227, 207, 255, 700), intArrayOf(146, 198, 194, 255, 700), intArrayOf(245, 211, 138, 255, 150), intArrayOf(0, 0, 0, 0, 96)), "#369186"),
        DeriveVector("drift-kart", listOf(intArrayOf(255, 90, 44, 255, 2900), intArrayOf(26, 11, 6, 255, 700), intArrayOf(255, 243, 232, 255, 300)), "#e03d00"),
        DeriveVector("greyscale", listOf(intArrayOf(32, 32, 32, 255, 3000), intArrayOf(224, 224, 224, 255, 1000)), null),
        DeriveVector("small-accent", listOf(intArrayOf(48, 48, 52, 255, 3800), intArrayOf(224, 32, 32, 255, 300)), null),
        DeriveVector("translucent-ignored", listOf(intArrayOf(122, 47, 255, 100, 3000), intArrayOf(46, 160, 79, 255, 1000)), "#239848"),
        DeriveVector("two-clusters", listOf(intArrayOf(74, 90, 122, 255, 3600), intArrayOf(255, 212, 0, 255, 400)), "#987e00"),
        DeriveVector("empty", listOf(intArrayOf(0, 0, 0, 0, 64)), null),
    )

    val resolve: List<ResolveVector> = listOf(
        ResolveVector("tidewater", "#369186", true, "#26847a", "#ffffff", "#72cabe", "#0a181e", "#72cabe"),
        ResolveVector("tidewater", "#369186", false, "#26847a", "#ffffff", "#14796f", "#e1ecf2", "#26847a"),
        ResolveVector("core-violet-dark", "#9a5cff", true, "#9051f3", "#ffffff", "#c0a6ff", "#17122d", "#c0a6ff"),
        ResolveVector("core-violet-dark", "#9a5cff", false, "#9051f3", "#ffffff", "#7b36da", "#ece7fe", "#9051f3"),
        ResolveVector("core-violet-light", "#7a2fff", true, "#7a2fff", "#ffffff", "#b7aaff", "#140e2e", "#b7aaff"),
        ResolveVector("core-violet-light", "#7a2fff", false, "#7a2fff", "#ffffff", "#7321f6", "#eae4ff", "#7a2fff"),
        ResolveVector("drift-kart", "#ff6a3d", true, "#ff6a3d", "#060912", "#ff987a", "#241517", "#ff987a"),
        ResolveVector("drift-kart", "#ff6a3d", false, "#ec592a", "#060912", "#b73500", "#f5e8ea", "#ec592a"),
        ResolveVector("light-teal", "#5fe3cf", true, "#5fe3cf", "#060912", "#5fe3cf", "#112329", "#5fe3cf"),
        ResolveVector("light-teal", "#5fe3cf", false, "#009a8a", "#060912", "#007a6d", "#ddeff3", "#009a8a"),
        ResolveVector("yellow", "#ffd400", true, "#ffd400", "#060912", "#ffd400", "#242110", "#ffd400"),
        ResolveVector("yellow", "#ffd400", false, "#a38700", "#060912", "#7d6700", "#eeede6", "#a38700"),
        ResolveVector("blue", "#0050ff", true, "#0050ff", "#ffffff", "#92b7ff", "#05122e", "#92b7ff"),
        ResolveVector("blue", "#0050ff", false, "#0050ff", "#ffffff", "#004ffc", "#dde7ff", "#0050ff"),
        ResolveVector("pink", "#e91e63", true, "#e61860", "#ffffff", "#ff92a5", "#210b1b", "#ff92a5"),
        ResolveVector("pink", "#e91e63", false, "#e61860", "#ffffff", "#c2004e", "#f4e2ef", "#e61860"),
        ResolveVector("green", "#00a86b", true, "#00a86b", "#060912", "#4fd494", "#051c1d", "#4fd494"),
        ResolveVector("green", "#00a86b", false, "#009d64", "#060912", "#007c4e", "#ddeff0", "#009d64"),
        ResolveVector("navy", "#1b1f3b", true, "#5b6282", "#ffffff", "#adb5da", "#10141f", "#adb5da"),
        ResolveVector("navy", "#1b1f3b", false, "#1b1f3b", "#ffffff", "#1b1f3b", "#e0e2eb", "#1b1f3b"),
        ResolveVector("grey", "#808080", true, "#777676", "#ffffff", "#b7b7b7", "#14161e", "#b7b7b7"),
        ResolveVector("grey", "#808080", false, "#777676", "#ffffff", "#696969", "#e9ebf1", "#777676"),
        ResolveVector("black", "#000000", true, "#646464", "#ffffff", "#b7b7b7", "#11141c", "#b7b7b7"),
        ResolveVector("black", "#000000", false, "#000000", "#ffffff", "#000000", "#dddfe6", "#000000"),
        ResolveVector("white", "#ffffff", true, "#ffffff", "#060912", "#ffffff", "#24272e", "#ffffff"),
        ResolveVector("white", "#ffffff", false, "#8a8989", "#060912", "#696969", "#ebedf3", "#8a8989"),
        ResolveVector("short-hex", "#f60", true, "#ff6600", "#060912", "#ff996d", "#241410", "#ff996d"),
        ResolveVector("short-hex", "#f60", false, "#e95d00", "#060912", "#ad4300", "#f5e9e6", "#e95d00"),
    )

    val danger: List<DangerVector> = listOf(
        DangerVector(true, "#f2513f", "#db3a2b"),
        DangerVector(false, "#be2323", "#be2323"),
    )
}
