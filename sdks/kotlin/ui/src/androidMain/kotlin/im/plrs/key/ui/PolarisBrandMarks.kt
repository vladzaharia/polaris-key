// The launch kit's artwork as Compose: the Pinned K (the branded logo) and the Polaris Locker
// "Powered by" attribution (the micro mark in the line, the 320 x 104 badge). All draw the kit SVGs, reduced to groups and filled paths by `pnpm gen brand`
// (PolarisBrandMarkData in PolarisBrandTokens.generated.kt), so the marks are never redrawn by
// hand. "Dark" artwork is FOR dark grounds; each picks its variant from the resolved theme.

package im.plrs.key.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
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
private val badgeDark by lazy { PolarisBrandMarkData.lockerPoweredByDark.toImageVector("PoweredByDark") }
private val badgeLight by lazy { PolarisBrandMarkData.lockerPoweredByLight.toImageVector("PoweredByLight") }
private val microDark by lazy { PolarisBrandMarkData.lockerMicroDark.toImageVector("LockerMicroDark") }
private val microLight by lazy { PolarisBrandMarkData.lockerMicroLight.toImageVector("LockerMicroLight") }

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
 * The Polaris Locker "Powered by" badge (the kit's `powered-by` label, transparent treatment): the
 * kit artwork on its 320 x 104 canvas, padding included, never cropped and never narrower than
 * [PolarisBrandTokens.badgeMin]; a smaller [width] is raised to it. Key's own badges are platform
 * references and are not offered here. The kit shows it through [PolarisPoweredBy] only when
 * `PolarisTheme(showPoweredBy = true)`.
 */
@Composable
public fun PolarisPoweredByBadge(modifier: Modifier = Modifier, width: Dp? = null) {
    val min = PolarisBrandTokens.badgeMin
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

/**
 * The Powered-by line (UI-KITS.md section 1.6): the Locker micro mark at 16 dp and the phrase in
 * live text, in the subtle text colour.
 */
@Composable
public fun PolarisPoweredByLine(modifier: Modifier = Modifier) {
    val vector = if (PolarisTheme.current.dark) microDark else microLight
    val label = PolarisTheme.copy.poweredBy
    Row(
        // One node named by the phrase, like the badge: the mark is decorative and the text is not read twice.
        modifier = modifier.clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painter = rememberVectorPainter(vector),
            contentDescription = null,
            modifier = Modifier.size(PolarisBrandTokens.POWERED_BY_MARK_SIZE.dp),
        )
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The attribution the kit's screens show: the line, or, for [PolarisPoweredByStyle.Badge], the badge
 * where 320 dp are free and the line where they are not (UI-KITS.md section 1.6).
 */
@Composable
public fun PolarisPoweredBy(modifier: Modifier = Modifier) {
    when (PolarisTheme.current.poweredByStyle) {
        PolarisPoweredByStyle.Line -> PolarisPoweredByLine(modifier)
        PolarisPoweredByStyle.Badge -> BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
            if (maxWidth >= PolarisBrandTokens.badgeMin.width.dp) {
                PolarisPoweredByBadge()
            } else {
                PolarisPoweredByLine()
            }
        }
    }
}
