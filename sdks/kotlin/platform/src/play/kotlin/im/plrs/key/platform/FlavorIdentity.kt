package im.plrs.key.platform

import im.plrs.key.platform.play.GoogleSignIn

/** The `play` flavour: Google ID through Credential Manager. */
internal object FlavorIdentity {
    fun create(): PlatformIdentity = GoogleSignIn()
}
