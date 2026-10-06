// The JVM CLI sample (SP-K14, notes/SDK-PARITY-PASS.md §5.7 SP-D02): a runnable command-line app over
// polaris-key-sdk alone. `./gradlew :sample-cli:run --args="status"` with PKEY_PRODUCT, PKEY_BASE_URL
// and PKEY_TRUST (the product's pinned keys, as `pkey sdk --lang kotlin` or the console prints them).
// Not published; built and tested with the JVM modules so it cannot rot.

plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
}

application {
    mainClass.set("im.plrs.key.samples.cli.MainKt")
}

dependencies {
    implementation(project(":sdk"))
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
}

tasks.withType<Test>().configureEach {
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
