# polaris-key-platform: the install-status receiver is reached by its manifest name.
-keep class im.plrs.key.platform.direct.InstallStatusReceiver
# Credential Manager (play flavour): the googleid and androidx.credentials AARs ship their own
# consumer rules; the CustomCredential type string is matched by value, so nothing to keep here.
