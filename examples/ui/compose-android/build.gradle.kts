// The Compose Android UI kit sample (UK-09b.2, docs/design/UI-KITS.md 6.1): a runnable app over the kit
// (:ui, android target) on Tidewater fixtures, or live over PolarisKeyAndroid with the intent extra pkey.live.
//
//   ./gradlew :sample-compose-android:assembleDebug                installable debug APK
//   ./gradlew :sample-compose-android:installDebug                 on a running emulator or device
//   ./gradlew :sample-compose-android:testDirectDebugUnitTest      the smoke test (Robolectric)
//   ./gradlew :sample-compose-android:connectedDirectDebugAndroidTest  the launch smoke on an emulator
//
// Live values come from Gradle properties (-Ppkey.product=, -Ppkey.baseUrl=, -Ppkey.trust=k1=<key>,
// -Ppkey.releaseKeys=), baked into BuildConfig; nothing secret is involved.
//
// Not published. It exists with :ui (an Android SDK and no pkey.jvmOnly), like :godot.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val jvmTarget: String = libs.versions.jvmTarget.get()

fun buildConfigString(property: String, default: String = ""): String =
    "\"" + (providers.gradleProperty(property).orNull ?: default).replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "im.plrs.key.samples.composeandroid"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        applicationId = "im.plrs.key.samples.composeandroid"
        minSdk = libs.versions.androidMinSdk.get().toInt()
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "PKEY_PRODUCT", buildConfigString("pkey.product"))
        buildConfigField("String", "PKEY_BASE_URL", buildConfigString("pkey.baseUrl", "https://key.plrs.im"))
        buildConfigField("String", "PKEY_TRUST", buildConfigString("pkey.trust"))
        buildConfigField("String", "PKEY_RELEASE_KEYS", buildConfigString("pkey.releaseKeys"))
    }

    // :android is flavoured; a sample needs one.
    flavorDimensions += "channel"
    productFlavors { create("direct") { dimension = "channel" } }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            all {
                it.maxHeapSize = "2g"
                it.testLogging {
                    events("failed")
                    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                }
            }
        }
    }

    // The fixtures' test-fixtures jars (ScriptedTransport, TestSigner) carry licence files that collide.
    packaging { resources.excludes += "META-INF/{AL2.0,LGPL2.1,LICENSE*,DEPENDENCIES}" }
}

kotlin { jvmToolchain(jvmTarget.toInt()) }

dependencies {
    implementation(project(":ui"))
    implementation(project(":sdk"))
    implementation(project(":android"))
    // The fixtures' scripted transport and signer: the sample's server is a ScriptedTransport (no live Worker).
    implementation(testFixtures(project(":core")))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.androidx.activity.compose)
    // Navigation lives in the host, never in the kit (UK-09b.3): kit screens are destinations here.
    implementation(libs.androidx.navigation.compose)

    debugImplementation(libs.compose.ui.test.manifest)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(platform(libs.compose.bom))
    // Compose test brings Espresso 3.5, which calls InputManager.getInstance (gone on API 34+).
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.compose.ui.test.junit4)
}
