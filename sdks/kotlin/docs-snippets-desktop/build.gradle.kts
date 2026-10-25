// The docs snippet lane for the Compose Desktop blocks: every ```kotlin desktop block on a covered docs page is
// compiled here against the desktop artifact set (polaris-key-sdk, polaris-key-desktop, polaris-key-ui's
// desktop target), as a Compose Desktop app declares it. Included only when :ui is, which needs an Android SDK.
// No sources are committed; not published.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.compose.multiplatform)
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
    sourceSets.main { kotlin.srcDir(layout.buildDirectory.dir("snippets/src")) }
}

dependencies {
    implementation(project(":sdk"))
    implementation(project(":desktop"))
    implementation(project(":ui"))
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
}
