// The Kotlin live-peer driver (CC-29X.2): a JVM main() over :sdk's local links, behind the JSON-lines
// contract in tools/live-peer/README.md. Not published, and not part of any SDK artifact. The harness
// runs `build/install/live-peer/bin/live-peer` (`./gradlew :live-peer:installDist`).
plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
}

application {
    applicationName = "live-peer"
    mainClass.set("im.plrs.key.livepeer.MainKt")
}

dependencies {
    implementation(project(":sdk"))
}
