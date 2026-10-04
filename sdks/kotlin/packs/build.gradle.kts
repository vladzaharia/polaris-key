// polaris-key-packs (proposed coordinates im.plrs.key:polaris-key-packs): the pack engine (P6-08): pack
// records, revocations, delegation, the planner, the full, file, chunk and delta appliers, the
// install state over a PackStorage port (a directory implementation included), type handlers and
// provides, and the `packs` facet (PacksClient).
// A plain Kotlin/JVM library with NO Android dependency, depending on :core only
// (checkModuleBoundaries), so the same JAR runs on Android API 24+ and on a JVM desktop.
//
// maven-publish writes to build/repo ONLY (unsigned, no remote repository): Kotlin artifacts reach
// adopters through Polaris Key's own Maven feed (F-07, F-10) and nowhere else.
plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
    `maven-publish`
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
    explicitApi()
}

java {
    withSourcesJar()
}

base { archivesName.set("polaris-key-packs") }

dependencies {
    api(project(":core"))
    // zstd for deltas, chunks and zstd-coded objects (LibZstd, behind ZstdPort). On Android the
    // :android glue swaps in the AAR of the same version (16 KB aligned natives, P6-12).
    implementation(libs.zstd.jni)
    // The default pack object transport streams blobs through OkHttp (the HTTP client :core uses).
    implementation(libs.okhttp)
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

publishing {
    publications {
        create<MavenPublication>("packs") {
            from(components["java"])
            artifactId = "polaris-key-packs"
            pom {
                name.set("Polaris Key packs (Kotlin)")
                description.set("The pack engine: records, revocations, delegation, the planner, the appliers, the install state, type handlers and provides for the Polaris Key Kotlin SDK.")
                url.set("https://github.com/vladzaharia/polaris-key")
            }
        }
    }
    repositories {
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repo"))
        }
    }
}

tasks.withType<Test>().configureEach {
    systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
