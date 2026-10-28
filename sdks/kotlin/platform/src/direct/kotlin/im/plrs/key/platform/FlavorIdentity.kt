package im.plrs.key.platform

/** The `direct` flavour has no Credential Manager: platform identity answers Unavailable("outlet"). */
internal object FlavorIdentity {
    fun create(): PlatformIdentity = PlatformIdentity.unsupported(PlatformIdentity.REASON_OUTLET)
}
