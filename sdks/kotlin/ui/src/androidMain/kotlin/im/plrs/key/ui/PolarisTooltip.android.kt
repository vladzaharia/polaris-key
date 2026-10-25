package im.plrs.key.ui

import androidx.compose.runtime.Composable

@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal actual fun PolarisTooltip(text: String, content: @Composable () -> Unit) = content()
