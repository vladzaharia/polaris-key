// The Godot Android plugin (v2) over polaris-key-platform (P5-06). Built from sdks/kotlin as the
// `:godot` project:   (cd sdks/kotlin && ./gradlew :godot:assembleRelease)
// Flavours match the platform AAR's: a Godot export ships the platform AAR and this AAR of the
// SAME flavour (addons/polaris_key/native/android_export.gd picks them per preset). Godot is
// compileOnly: the export template provides it. Needs Godot 4.2+ with the Gradle build enabled.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "im.plrs.key.godot"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    flavorDimensions += "channel"
    productFlavors {
        create("play") { dimension = "channel" }
        create("direct") { dimension = "channel" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
}

kotlin {
    jvmToolchain(17)
}

base { archivesName.set("polaris-key-godot") }

dependencies {
    implementation(project(":platform"))
    compileOnly(libs.godot)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}
