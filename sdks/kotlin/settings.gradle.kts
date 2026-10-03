// The Polaris Key Kotlin build (P5-06). One published module now:
//   :platform  polaris-key-platform, the shared Android backend (install source, Keystore, and per
//              flavour Play In-App Updates + Play Asset Delivery, or PackageInstaller self-update)
// and two build-only modules:
//   :godot     the Godot Android plugin (v2) binding it, kept with the Godot SDK in
//              sdks/godot/native/android (singleton PolarisKeyAndroid)
//   :boundary  an empty app per flavour whose release APK proves the flavour boundary
//              (tools/check_flavours.sh): no install permission or session commit in `play`, no
//              Play Core in `direct`
// P6-05 grows the Kotlin SDK proper (core, licence, config, corpus runner) beside :platform.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "polaris-key-kotlin"

include(":platform")
include(":godot")
project(":godot").projectDir = file("../godot/native/android")
include(":boundary")
