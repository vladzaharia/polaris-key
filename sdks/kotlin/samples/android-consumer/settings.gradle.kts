// The Android consumer app (SP-50): a separate build that consumes the Kotlin SDK as an app does,
// from its PUBLISHED coordinates, so the documented artifact set is proven as it ships: no exclude,
// no app R8 rule, no workaround in app code. Its instrumented tests are the emulator lane.
//
//   ../../gradlew publishAllPublicationsToLocalRepository          (in sdks/kotlin: build/repo)
//   ../../gradlew -p samples/android-consumer assembleDebug assembleRelease
//   ../../gradlew -p samples/android-consumer connectedLeanDebugAndroidTest   (an emulator or device)
//
// Two toolchains, picked with -Ppkey.toolchain:
//   documented (default)  AGP 8.6.1, Kotlin 2.1.21, Gradle 8.11.1 (this wrapper), compileSdk 36:
//                         Godot 4.7.2's Android template and the README's install line
//   latest                AGP 9.4.1 (its built-in Kotlin), Kotlin 2.4.20, Gradle 9.7.1, compileSdk 37
// -Ppkey.repo (default ../../build/repo) and -Ppkey.version (default this build's) pick the feed.
pluginManagement {
    val latest = providers.gradleProperty("pkey.toolchain").orNull == "latest"
    val agp = if (latest) "9.4.1" else "8.6.1"
    val kotlin = if (latest) "2.4.20" else "2.1.21"
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version agp
        id("org.jetbrains.kotlin.android") version kotlin
        id("org.jetbrains.kotlin.plugin.compose") version kotlin
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // The README's shape: the im.plrs.key group from the Polaris Key feed alone (here, the
        // local publication standing in for it).
        exclusiveContent {
            forRepository {
                maven { url = uri(providers.gradleProperty("pkey.repo").orElse(settingsDir.resolve("../../build/repo").absolutePath).get()) }
            }
            filter { includeGroupAndSubgroups("im.plrs.key") }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "polaris-key-android-consumer"
include(":app")
