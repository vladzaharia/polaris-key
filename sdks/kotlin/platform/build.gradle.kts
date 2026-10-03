// polaris-key-platform (proposed coordinates im.plrs.key:polaris-key-platform). Two flavours, and
// the flavour is a POLICY boundary (Play forbids self-update and REQUEST_INSTALL_PACKAGES in Play
// builds):
//   play    install source, Keystore, Play In-App Updates, Play Asset Delivery. No PackageInstaller
//           session code, no install permission.
//   direct  install source, Keystore, verified PackageInstaller self-update. No Play Core.
// Pure Kotlin: no NDK, no .so files (a later zstd-jni must be 16 KB page aligned, notes/E4 §2.1).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "im.plrs.key.platform"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    flavorDimensions += "channel"
    productFlavors {
        create("play") { dimension = "channel" }
        create("direct") { dimension = "channel" }
    }

    buildFeatures { buildConfig = true }

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

    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

kotlin {
    jvmToolchain(17)
    explicitApi()
}

base { archivesName.set("polaris-key-platform") }

dependencies {
    "playApi"(libs.play.app.update)
    "playApi"(libs.play.asset.delivery)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}
