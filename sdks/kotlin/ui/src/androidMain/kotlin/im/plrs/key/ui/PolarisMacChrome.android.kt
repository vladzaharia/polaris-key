// The Android actuals of the Mac chrome's platform edges (UK-10.7): Android has no Mac chrome, so the
// facts are the defaults and the prompt's dialog keeps the properties it always had.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.window.DialogProperties

@Composable
internal actual fun rememberMacDesktopFacts(): PolarisHostFacts = PolarisHostFacts()

internal actual fun polarisPromptDialogProperties(dismissible: Boolean, scrim: Boolean): DialogProperties =
    DialogProperties(dismissOnBackPress = dismissible, dismissOnClickOutside = dismissible, usePlatformDefaultWidth = false)
