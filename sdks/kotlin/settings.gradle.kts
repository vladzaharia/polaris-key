// The Polaris Key Kotlin build (P5-06, P6-06). The module map for the whole Kotlin SDK (P6-05):
//
//   JVM libraries (plain Kotlin JARs, usable unchanged on Android API 24+ and a JVM desktop):
//     :core         polaris-key-core: JWS + Ed25519 verification, the signed-document types, the
//                   trust set, the verified cache and clock floor, transport, discovery, sync,
//                   capabilities, the boot stage machine and the generated constants (P6-06)
//     :license :config :identity :release      (P6-07)
//     :update :packs                            (P6-08)
//     :sdk          the umbrella client          (P6-07)
//   Android libraries:
//     :platform     polaris-key-platform, the shared Android backend (install source, Keystore,
//                   and per flavour Play In-App Updates + Play Asset Delivery, or PackageInstaller
//                   self-update). STANDALONE: it depends on no other SDK module, so the Godot
//                   binding links it alone (P5-06, P6-09)
//     :android      the only module that sees both :core and :platform (P6-12)
//     :ui           the Compose UI kit (P6-11)
//     :godot        the Godot Android plugin (v2) binding :platform, kept with the Godot SDK in
//                   sdks/godot/native/android (singleton PolarisKeyAndroid)
//   Build-only:
//     :conformance  the corpus and HTTP-transcript runner (tests only, never published)
//     :boundary     an empty app per flavour whose release APK proves the flavour boundary
//                   (tools/check_flavours.sh)
//
// The Android modules need an Android SDK. They are included when one is configured
// (ANDROID_HOME, ANDROID_SDK_ROOT or local.properties sdk.dir) and `-Ppkey.jvmOnly=true` is not
// set, so the JVM modules build and test on a machine with only a JDK (the `kotlin` CI job).
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

include(":core")
include(":conformance")

val jvmOnly = providers.gradleProperty("pkey.jvmOnly").orNull == "true"
val localSdkDir =
    file("local.properties").takeIf { it.isFile }?.readLines()?.any {
        it.trim().startsWith("sdk.dir=")
    } == true
val androidSdk =
    localSdkDir ||
        !providers.environmentVariable("ANDROID_HOME").orNull.isNullOrBlank() ||
        !providers.environmentVariable("ANDROID_SDK_ROOT").orNull.isNullOrBlank()

if (!jvmOnly && androidSdk) {
    include(":platform")
    include(":godot")
    project(":godot").projectDir = file("../godot/native/android")
    include(":boundary")
}
