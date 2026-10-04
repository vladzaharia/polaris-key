package im.plrs.key.platform

import android.content.Context
import im.plrs.key.platform.play.PlayIntegrity
import im.plrs.key.platform.play.PlayPlatformIntegrity

/** The `play` flavour: Integrity over Play's StandardIntegrityManager. */
internal object FlavorIntegrity {
    fun create(context: Context): PlatformIntegrity = PlayPlatformIntegrity { PlayIntegrity(context) }
}
