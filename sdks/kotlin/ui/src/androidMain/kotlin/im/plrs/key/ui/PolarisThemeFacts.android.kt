// The theme's host facts on Android (UK-10.5): a pinned value for a test, else the defaults. Android
// has no contrast theme the kit draws differently.

package im.plrs.key.ui

import androidx.compose.runtime.Composable

@Composable
internal actual fun rememberThemeHostFacts(): PolarisHostFacts = LocalPolarisHostFacts.current ?: PolarisHostFacts()
