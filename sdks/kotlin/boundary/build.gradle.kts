// The flavour-boundary probe (never published): an empty app per flavour that packages the
// platform AAR and the Godot binding exactly as an export does. tools/check_flavours.sh reads its
// release APKs: the play APK's merged manifest has no install permission and its dex no
// PackageInstaller session creation or commit and no direct-flavour class; the direct APK's dex has
// no Play Core and no play-flavour class.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "im.plrs.key.boundary"
    compileSdk = 36

    defaultConfig {
        applicationId = "im.plrs.key.boundary"
        minSdk = 24
        targetSdk = 36
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
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":platform"))
    implementation(project(":godot"))
}
