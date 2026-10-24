// The Compose desktop UI kit sample (UK-10.10, docs/design/UI-KITS.md 6.1): a runnable JVM app over the
// kit's real windows (:ui, desktop target) on Tidewater fixtures, or `--live` over PolarisKeyDesktop.
//
//   ./gradlew :sample-compose-desktop:run                          the fixtures, the whole walk
//   ./gradlew :sample-compose-desktop:run --args="--state update --scheme dark --preset native"
//   ./gradlew :sample-compose-desktop:smoke                        reach the gate on fixtures, exit 0
//   ./gradlew :sample-compose-desktop:shots -Pshots=<dir>          window-only PNGs of the walk, then exit
//
// Not published. It exists with :ui (an Android SDK and no pkey.jvmOnly), like :godot.

import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.compose.multiplatform)
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
}

dependencies {
    implementation(project(":ui"))
    implementation(project(":sdk"))
    implementation(project(":desktop"))
    // The fixtures' scripted transport and signer: the sample's server is a ScriptedTransport (no live Worker).
    implementation(testFixtures(project(":core")))
    implementation(compose.desktop.currentOs)
}

compose.desktop {
    application {
        mainClass = "im.plrs.key.samples.composedesktop.MainKt"
        // macOS screen readers reach the window through the Java Access Bridge, which a jlink'd runtime lacks.
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "Tidewater Studio"
            packageVersion = "1.0.0"
            modules("jdk.accessibility")
        }
    }
}

// Both tasks run the app with a flag and fail on a non-zero exit, so CI can call them.
tasks.register<JavaExec>("smoke") {
    group = "verification"
    description = "Starts the sample on the fixtures, reaches the gate and exits 0."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("im.plrs.key.samples.composedesktop.MainKt")
    args("--smoke")
}

tasks.register<JavaExec>("shots") {
    group = "verification"
    description = "Writes a window-only PNG per window of the walk to -Pshots=<dir>, then exits."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("im.plrs.key.samples.composedesktop.MainKt")
    val dir = providers.gradleProperty("shots").orNull
    doFirst { require(dir != null) { "pass -Pshots=<dir>" } }
    if (dir != null) args("--shots", dir)
    // Extra flags: -Pextra="--scheme dark --preset native --platform windows --size 900x640".
    providers.gradleProperty("extra").orNull?.let { args(it.split(" ").filter(String::isNotBlank)) }
}
