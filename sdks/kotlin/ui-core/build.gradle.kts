// polaris-key-ui-core (im.plrs.key:polaris-key-ui-core): the Compose-free presentation and
// state-holder layer for the Kotlin UI kits. It runs on Android API 24+ and a JVM desktop without
// bringing Compose, AndroidX, fonts or QR encoding onto the host's classpath.
plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()

kotlin {
    jvmToolchain(jvmTarget.toInt())
    explicitApi()
}

java { withSourcesJar() }

base { archivesName.set("polaris-key-ui-core") }

dependencies {
    // The state holders adapt the umbrella SDK only. They never reach Android glue or :platform.
    api(project(":sdk"))
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)

    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalPath

tasks.withType<Test>().configureEach {
    // UIMatrixPresentationTest replays conformance/corpus/v2/ui-matrix.json in place; declaring it
    // an input keeps a changed corpus from reusing a build-cache result.
    systemProperty("pkey.repoRoot", repoRoot)
    inputs.file("$repoRoot/conformance/corpus/v2/ui-matrix.json").withPropertyName("uiMatrix")
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

publishing {
    publications {
        create<MavenPublication>("uiCore") {
            from(components["java"])
            artifactId = "polaris-key-ui-core"
            pom {
                name.set("Polaris Key UI core (Kotlin)")
                description.set(
                    "Compose-free state holders and presentation models for Polaris Key Kotlin UI kits.",
                )
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
