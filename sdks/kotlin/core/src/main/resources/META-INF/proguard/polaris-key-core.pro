# polaris-key-core's consumer rules (SP-50), applied by R8 to any app that minifies.
#
# :core links two libraries compileOnly and loads each only when it is present:
#   java-keyring  the JVM desktop OS keyring (KeyringStore); never on Android
#   Tink          the Ed25519 backend Android prefers (polaris-key-android-* brings tink-android)
# A minified app without one must still build: its absence is a runtime answer, not a link error.
-dontwarn com.github.javakeyring.**
-dontwarn com.google.crypto.tink.**
