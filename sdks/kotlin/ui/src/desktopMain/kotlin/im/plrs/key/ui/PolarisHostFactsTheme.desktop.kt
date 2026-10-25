// The desktop actual of the host-facts seam: one process-wide read, done before the first
// composition uses it. The readers of PolarisHostFacts.desktop.kt run in parallel under their own
// 500 ms cap, so the first frame waits at most that long, once; a later call is a field read.

package im.plrs.key.ui

import androidx.compose.runtime.Composable
import kotlinx.coroutines.runBlocking

private val lock = Any()

@Volatile
private var cached: PolarisHostFacts? = null

/** The process's facts for [variant], read on first use (blocking, capped) and shared after. */
internal fun desktopHostFactsOnce(
    variant: PolarisPlatformVariant,
    read: suspend (PolarisPlatformVariant) -> PolarisHostFacts = { readHostFacts(it) },
): PolarisHostFacts =
    cached ?: synchronized(lock) { cached ?: runBlocking { read(variant) }.also { cached = it } }

@Composable
internal actual fun rememberDesktopHostFacts(): PolarisHostFacts? = desktopHostFactsOnce(autoPlatformVariant())
