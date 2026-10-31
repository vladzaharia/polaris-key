package im.plrs.key.platform

import android.content.Context

/** The `direct` flavour has no Block Store: platform backup answers Unavailable("outlet"). */
internal object FlavorBackup {
    @Suppress("UNUSED_PARAMETER")
    fun create(context: Context): PlatformBackup = PlatformBackup.unsupported(PlatformBackup.REASON_OUTLET)
}
