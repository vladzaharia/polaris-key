// The theme's host facts on the desktop (UK-10.5): a host or test pin first, else the real reads of
// UK-10.4 -- but only on Windows for now, the one variant whose theme reads a fact (contrast).

package im.plrs.key.ui

import androidx.compose.runtime.Composable

@Composable
internal actual fun rememberThemeHostFacts(): PolarisHostFacts =
    LocalPolarisHostFacts.current
        ?: if (autoPlatformVariant() == PolarisPlatformVariant.Windows) rememberPolarisHostFacts() else PolarisHostFacts()
