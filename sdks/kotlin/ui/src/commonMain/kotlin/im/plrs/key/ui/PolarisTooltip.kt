// A hover tooltip for an icon-only control: the desktop shows [text] after a short hover; Android draws none (touch has no hover).

package im.plrs.key.ui

import androidx.compose.runtime.Composable

@Suppress("ktlint:standard:function-naming", "FunctionNaming")
@Composable
internal expect fun PolarisTooltip(text: String, content: @Composable () -> Unit)
