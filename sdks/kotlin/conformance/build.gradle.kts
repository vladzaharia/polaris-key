// The Kotlin conformance runner (P6-06): internal, test-only, never published. It reads
// conformance/corpus/v2/ and conformance/transcripts/ IN PLACE (no mirror) from the repository
// root and drives :core and, through the umbrella PolarisKeyClient (:sdk, P6-07), every service
// module through the cases and transcripts they own; later slices add theirs to the same runner.
//
// Every Ed25519 verdict is reached twice: `test` runs the suite on the JCA backend and depends on
// `testTink`, the same suite with the Tink backend forced, so the two can never disagree. Every
// suite extends ConformanceSuite, whose @BeforeClass installs the backend this task names and
// checks it, so no suite can run on whatever backend an earlier one left behind.
//
// SP-41: `liveDevTest` is the one suite that talks to a server. LiveDevTest drives the generated
// quickstart config, the SDK's own client and its real OkHttp transport against a running `pkey dev`
// (first activation, every refusal the seven seeded keys give, a config change event, a device-code
// sign-in, an update decision). The CI lane starts the server and names it in the environment:
//
//   PKEY_DEV_BASE_URL  the server's origin
//   PKEY_DEV_CONFIG    the PolarisConfig.kt that `pkey sdk --lang kotlin --dev --url <origin> --write`
//                      wrote for it; it is compiled into the test sources, so the suite applies the
//                      quickstart exactly as an app does (any --package works)
//   PKEY_DEV_APPROVE   packages/cli/scripts/dev-approve.mjs: the browser side of a device-code sign-in
//
// It is not part of `test` or `testTink`: those run without a server, and a second pass of the same
// suite would only compete with the first for the server's key seats. Without the variables the
// suite skips, except on CI (`CI=true`), where a lane that forgot them must fail, not pass by skipping.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
}

// The live suite's class, kept out of `test` and `testTink` and run alone by `liveDevTest`.
val liveDevSuite = "im.plrs.key.conformance.LiveDevTest"

// The generated quickstart config rides into the test sources only when a lane names one.
val liveDevConfig = providers.environmentVariable("PKEY_DEV_CONFIG").orNull?.trim()?.takeIf { it.isNotEmpty() }?.let(::File)
if (liveDevConfig != null) {
    val stagePkeyDevConfig = tasks.register<Sync>("stagePkeyDevConfig") {
        description = "Copies PKEY_DEV_CONFIG, the PolarisConfig.kt `pkey sdk` generated, into the test sources."
        from(liveDevConfig)
        into(layout.buildDirectory.dir("generated/pkey-dev/kotlin"))
        doFirst {
            require(liveDevConfig.isAbsolute && liveDevConfig.isFile) {
                "PKEY_DEV_CONFIG must be the absolute path of a generated PolarisConfig.kt; got $liveDevConfig"
            }
        }
    }
    kotlin.sourceSets.named("test") { kotlin.srcDir(stagePkeyDevConfig) }
}

dependencies {
    testImplementation(project(":sdk"))
    // The pack corpus decodes zstd: the opt-in decoder (SP-50), as an app that uses packs adds it.
    testImplementation(project(":zstd"))
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
    filter { excludeTestsMatching(liveDevSuite) }
}

tasks.named<Test>("test") {
    systemProperty("pkey.ed25519", "jca")
    filter { excludeTestsMatching(liveDevSuite) }
    dependsOn(testTink)
}

val liveDevTest by tasks.registering(Test::class) {
    description = "The generated quickstart config, the SDK client and its real transport against a running `pkey dev`."
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    filter { includeTestsMatching(liveDevSuite) }
    // One backend is enough: the server's signatures are the same bytes on either.
    systemProperty("pkey.ed25519", "jca")
    systemProperty("pkey.liveDev.require", providers.environmentVariable("CI").orNull == "true")
    // A running server is not an input Gradle can see: never up to date, never from the build cache.
    doNotTrackState("the suite runs against a live server")
    testLogging { events("passed", "skipped", "failed") }
}
