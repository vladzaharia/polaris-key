plugins {
    id("com.android.application") apply false
    // Declared on every toolchain (so its classes are on the build classpath); :app applies it only
    // on the documented one, since AGP 9 compiles Kotlin itself.
    id("org.jetbrains.kotlin.android") apply false
    id("org.jetbrains.kotlin.plugin.compose") apply false
}
