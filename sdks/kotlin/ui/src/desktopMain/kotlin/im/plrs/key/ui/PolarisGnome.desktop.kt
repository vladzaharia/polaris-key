// The desktop actual of the GNOME host facts (UK-10.6): the readers of PolarisHostFacts.desktop.kt
// run once per process, so every PolarisTheme call shares one read.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

private var shared by mutableStateOf<PolarisHostFacts?>(null)
private var requested = false

@Composable
internal actual fun rememberDesktopHostFacts(): PolarisHostFacts? {
    LaunchedEffect(Unit) {
        if (!requested) {
            requested = true
            shared = readHostFacts(autoPlatformVariant())
        }
    }
    return shared
}
