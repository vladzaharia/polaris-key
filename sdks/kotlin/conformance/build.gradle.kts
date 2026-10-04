// The Kotlin conformance runner (P6-06): internal, test-only, never published. It reads
// conformance/corpus/v2/ and conformance/transcripts/ IN PLACE (no mirror) from the repository
// root and drives :core through every case the core owns; later slices add their corpus files
// and transcripts to the same runner.
//
// Every Ed25519 verdict is reached twice: `test` runs the suite on the JCA backend and depends on
// `testTink`, the same suite with the Tink backend forced, so the two can never disagree.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation(project(":core"))
    testImplementation(libs.junit)
    testImplementation(libs.tink)
    testImplementation(libs.kotlinx.coroutines.test)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalPath

tasks.withType<Test>().configureEach {
    systemProperty("pkey.repoRoot", repoRoot)
    inputs.dir("$repoRoot/conformance/corpus/v2").withPropertyName("corpus").optional()
    inputs.dir("$repoRoot/conformance/transcripts").withPropertyName("transcripts").optional()
    inputs.file("$repoRoot/sdks/kotlin/parity.json").withPropertyName("manifest").optional()
    maxHeapSize = "1g"
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = true
    }
}

val testTink by tasks.registering(Test::class) {
    description = "The conformance suite with the Tink Ed25519 backend forced."
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    systemProperty("pkey.ed25519", "tink")
}

tasks.named<Test>("test") {
    systemProperty("pkey.ed25519", "jca")
    dependsOn(testTink)
}
