// The docs snippet lane for the Android blocks (SP-45b): every ```kotlin android block on a covered
// docs page is compiled here against the documented Android artifact set (polaris-key-sdk,
// polaris-key-android, polaris-key-ui, polaris-key-billing). Included only when an Android SDK is
// configured, like the modules it depends on. No sources are committed; not published.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.docs.snippets"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig { minSdk = libs.versions.androidMinSdk.get().toInt() }

    flavorDimensions += "channel"
    productFlavors { create("direct") { dimension = "channel" } }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    sourceSets.getByName("main").java.srcDir(layout.buildDirectory.dir("snippets/src"))
}

kotlin { jvmToolchain(jvmTarget.toInt()) }

dependencies {
    implementation(project(":sdk"))
    implementation(project(":android"))
    implementation(project(":ui"))
    implementation(project(":billing"))
    implementation(project(":zstd"))
}
