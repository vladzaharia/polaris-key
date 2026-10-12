// The docs snippet lane (SP-45b): every ```kotlin block on a covered docs page is written to
// build/snippets/src by packages/docs/test/snippets/nativeLanes.ts and compiled here against the
// documented JVM artifact set (polaris-key-sdk, polaris-key-desktop, polaris-key-zstd), exactly as
// a desktop or CLI app declares it. No sources are committed; not published.
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
    implementation(project(":zstd"))
    // The Compose Desktop recipe (build/sdks/kotlin/your-own-ui, "Compose Desktop").
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
}
