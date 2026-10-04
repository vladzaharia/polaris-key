// The flavour-boundary probe (never published): an empty app per flavour that packages the
// platform AAR and the Godot binding exactly as an export does, and the Kotlin SDK's Android glue
// (:android, P6-12, with :sdk and every JVM module behind it) exactly as a native app does. tools/check_flavours.sh reads its
// release APKs: the play APK's merged manifest has no install permission and its dex no
// PackageInstaller session creation or commit and no direct-flavour class; the direct APK's dex has
// no Play Core and no play-flavour class.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.boundary"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        applicationId = "im.plrs.key.boundary"
        minSdk = libs.versions.androidMinSdk.get().toInt()
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
    }

    flavorDimensions += "channel"
    productFlavors {
        create("play") { dimension = "channel" }
        create("direct") { dimension = "channel" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Unsigned is enough for inspection; the debug key keeps assembleRelease self-contained.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
}

dependencies {
    implementation(project(":platform"))
    implementation(project(":godot"))
    implementation(project(":android"))
}
