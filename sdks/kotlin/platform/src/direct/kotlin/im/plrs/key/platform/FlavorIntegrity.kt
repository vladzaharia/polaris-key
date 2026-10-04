package im.plrs.key.platform

import android.content.Context

/** The `direct` flavour has no Play Core: Integrity answers Unsupported("outlet"). */
internal object FlavorIntegrity {
    fun create(@Suppress("UNUSED_PARAMETER") context: Context): PlatformIntegrity =
        PlatformIntegrity.unsupported(PlatformIntegrity.REASON_OUTLET)
}
