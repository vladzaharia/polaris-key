package im.plrs.key.platform

import android.content.Context
import im.plrs.key.platform.play.BlockStoreBackup

/** The `play` flavour: Block Store. */
internal object FlavorBackup {
    fun create(context: Context): PlatformBackup = BlockStoreBackup(context.applicationContext)
}
