// The Kotlin conformance runner (P6-06): internal, test-only, never published. It reads
// conformance/corpus/v2/ and conformance/transcripts/ IN PLACE (no mirror) from the repository
// root and drives :core and, through the umbrella PolarisKeyClient (:sdk, P6-07), every service
// module through the cases and transcripts they own; later slices add theirs to the same runner.
//
// Every Ed25519 verdict is reached twice: `test` runs the suite on the JCA backend and depends on
// `testTink`, the same suite with the Tink backend forced, so the two can never disagree. Every
// suite extends ConformanceSuite, whose @BeforeClass installs the backend this task names and
// checks it, so no suite can run on whatever backend an earlier one left behind.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
}

dependencies {
    testImplementation(project(":sdk"))
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
