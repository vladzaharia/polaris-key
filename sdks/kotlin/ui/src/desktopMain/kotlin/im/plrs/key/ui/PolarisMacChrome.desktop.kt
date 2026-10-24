// The desktop actuals of the Mac chrome's platform edges (UK-10.7).

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.DialogProperties

/** The UK-10.4 reads, but only on macOS: the one variant whose theme reads a fact (Increase Contrast). */
@Composable
internal actual fun rememberMacDesktopFacts(): PolarisHostFacts =
    if (autoPlatformVariant() == PolarisPlatformVariant.MacOS) rememberPolarisHostFacts() else PolarisHostFacts()

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
internal actual fun polarisPromptDialogProperties(dismissible: Boolean, scrim: Boolean): DialogProperties =
    DialogProperties(
        dismissOnBackPress = dismissible,
        dismissOnClickOutside = dismissible,
        usePlatformDefaultWidth = false,
        scrimColor = if (scrim) Color.Black.copy(alpha = 0.6f) else Color.Transparent, // polaris-lint: allow-colour (the desktop dialog's own default scrim)
    )
