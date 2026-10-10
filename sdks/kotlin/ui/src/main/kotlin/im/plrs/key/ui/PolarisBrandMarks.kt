// The launch kit's artwork as Compose: the Pinned K (the branded logo) and the "Powered by Polaris
// Key" badge. Both draw the kit SVGs, reduced to groups and filled paths by `pnpm gen brand`
// (PolarisBrandMarkData in PolarisBrandTokens.generated.kt), so the marks are never redrawn by
// hand. "Dark" artwork is FOR dark grounds; each picks its variant from the resolved theme.

package im.plrs.key.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import im.plrs.key.ui.brand.BrandVector
import im.plrs.key.ui.brand.BrandVectorNode
import im.plrs.key.ui.brand.PolarisBrandMarkData
import im.plrs.key.ui.brand.PolarisBrandTokens

/** A generated kit vector as an [ImageVector] of [name]. */
public fun BrandVector.toImageVector(name: String): ImageVector {
    val builder = ImageVector.Builder(
        name = name,
        defaultWidth = width.dp,
        defaultHeight = height.dp,
        viewportWidth = width,
        viewportHeight = height,
    )
    fun add(nodes: List<BrandVectorNode>, inherited: androidx.compose.ui.graphics.Color?) {
        for (node in nodes) {
            when (node) {
                is BrandVectorNode.Group -> {
                    builder.addGroup(
                        translationX = node.translateX,
                        translationY = node.translateY,
                        scaleX = node.scaleX,
                        scaleY = node.scaleY,
                    )
                    add(node.children, node.fill ?: inherited)
                    builder.clearGroup()
                }
                is BrandVectorNode.Path -> {
                    val fill = node.fill ?: inherited
                    builder.addPath(
                        pathData = PathParser().parsePathString(node.pathData).toNodes(),
                        fill = fill?.let { SolidColor(it) },
                    )
                }
            }
        }
    }
    add(nodes, null)
    return builder.build()
}

private val pinnedKDark by lazy { PolarisBrandMarkData.pinnedKDark.toImageVector("PinnedKDark") }
private val pinnedKLight by lazy { PolarisBrandMarkData.pinnedKLight.toImageVector("PinnedKLight") }
private val badgeDark by lazy { PolarisBrandMarkData.poweredByCompactDark.toImageVector("PoweredByDark") }
private val badgeLight by lazy { PolarisBrandMarkData.poweredByCompactLight.toImageVector("PoweredByLight") }

/**
 * The Pinned K, the platform mark, in its display cut and without a terminal bit: SDK UI is a core
 * surface, and the default mark carries no bit (BRAND.md §6, §7.1). [size] is raised into the
 * display range (above [PolarisBrandTokens.SERVICE_MAX]): the optical cut is chosen by displayed
 * size, never by scaling the display drawing down into the service or favicon range.
 *
 * @param contentDescription "Polaris Key" by default; null makes the mark decorative.
 */
@Composable
public fun PolarisMark(
    modifier: Modifier = Modifier,
    size: Dp = 56.dp,
    contentDescription: String? = PolarisTheme.copy.polarisKeyMark,
) {
    val vector = if (PolarisTheme.current.dark) pinnedKDark else pinnedKLight
    val shown = maxOf(size, (PolarisBrandTokens.SERVICE_MAX + 1).dp)
    Image(
        painter = rememberVectorPainter(vector),
        contentDescription = contentDescription,
        modifier = modifier.size(shown),
    )
}

/**
 * The "Powered by Polaris Key" badge (compact layout, transparent treatment): the kit artwork,
 * padding included, never cropped and never below the kit minimum ([PolarisBrandTokens.badgeMinCompact]);
 * a smaller [width] is raised to it. Shown by the kit only when `PolarisTheme(showPoweredBy = true)`.
 */
@Composable
public fun PolarisPoweredByBadge(modifier: Modifier = Modifier, width: Dp? = null) {
    val min = PolarisBrandTokens.badgeMinCompact
    val shownWidth = maxOf(width ?: min.width.dp, min.width.dp)
    val shownHeight = shownWidth * (min.height / min.width)
    val vector = if (PolarisTheme.current.dark) badgeDark else badgeLight
    val label = PolarisTheme.copy.poweredBy
    Image(
        painter = rememberVectorPainter(vector),
        contentDescription = null,
        modifier = modifier
            .width(shownWidth)
            .height(shownHeight)
            .semantics {
                contentDescription = label
                role = Role.Image
            },
    )
}
