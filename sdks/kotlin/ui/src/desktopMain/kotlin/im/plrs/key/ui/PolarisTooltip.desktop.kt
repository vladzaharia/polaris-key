package im.plrs.key.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.TooltipArea
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal actual fun PolarisTooltip(text: String, content: @Composable () -> Unit) {
    TooltipArea(
        tooltip = {
            Text(
                text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.inverseOnSurface,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.inverseSurface, polarisRadiusShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        },
        content = content,
    )
}
