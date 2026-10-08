// The consumer app: the documented Android artifact set (polaris-key-sdk, polaris-key-android-direct,
// polaris-key-ui, polaris-key-billing) exactly as an app declares it. Two flavours:
//
//   lean   that set and nothing else: its APKs must carry no native library (no libzstd-jni)
//   packs  the same plus the opt-in pack decoder, polaris-key-zstd: its APKs carry zstd-jni's
//          16 KB-aligned Android natives (the AAR variant, never the desktop JAR)
//
// release is minified with only AGP's default rules file: the SDK's own consumer rules must be enough.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val latest = providers.gradleProperty("pkey.toolchain").orNull == "latest"
if (!latest) apply(plugin = "org.jetbrains.kotlin.android")

val kotlinVersion = if (latest) "2.4.20" else "2.1.21"
val repo = file(providers.gradleProperty("pkey.repo").orElse(rootDir.resolve("../../build/repo").absolutePath).get())
// The version the feed holds: -Ppkey.version, else the one version published to the repository.
val pkey: String = providers.gradleProperty("pkey.version").orNull
    ?: repo.resolve("im/plrs/key/polaris-key-sdk").listFiles { f -> f.isDirectory }?.singleOrNull()?.name
    ?: error("no single polaris-key-sdk version in $repo: run publishAllPublicationsToLocalRepository, or pass -Ppkey.version")

android {
    namespace = "im.plrs.key.samples.consumer"
    compileSdk = if (latest) 37 else 36

    defaultConfig {
        applicationId = "im.plrs.key.samples.consumer"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "packs"
    productFlavors {
        create("lean") { dimension = "packs" }
        create("packs") { dimension = "packs" }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.withType<KotlinJvmCompile>().configureEach { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }

dependencies {
    // The documented set, with no exclude.
    implementation("im.plrs.key:polaris-key-sdk:$pkey")
    implementation("im.plrs.key:polaris-key-android-direct:$pkey")
    implementation("im.plrs.key:polaris-key-ui:$pkey")
    implementation("im.plrs.key:polaris-key-billing:$pkey")
    // Packs' native decoder, opt-in.
    "packsImplementation"("im.plrs.key:polaris-key-zstd:$pkey")

    implementation(platform(if (latest) "androidx.compose:compose-bom:2026.09.00" else "androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.compose.material3:material3")
    implementation(if (latest) "androidx.activity:activity-compose:1.13.0" else "androidx.activity:activity-compose:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    // The on-device tests sign their own documents (Tink's pure-Java Ed25519) and enumerate the
    // client's suspend API (kotlin-reflect, off the main thread only).
    androidTestImplementation("com.google.crypto.tink:tink-android:1.17.0")
    androidTestImplementation("org.jetbrains.kotlin:kotlin-reflect:$kotlinVersion")
}
