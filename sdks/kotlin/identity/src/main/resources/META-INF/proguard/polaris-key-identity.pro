# polaris-key-identity's consumer rules, applied by R8 to any app that minifies.
#
# DesktopBrowser (the opener for the native sign-in redirect on a desktop JVM) reaches the default
# browser through java.awt, which Android does not have. Every use sits inside a block that catches
# Throwable and answers "no browser here", so the missing classes are a runtime answer, not a link error.
-dontwarn java.awt.Desktop
-dontwarn java.awt.Desktop$Action
-dontwarn java.awt.GraphicsEnvironment
