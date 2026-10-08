// polaris-key-sdk (proposed coordinates im.plrs.key:polaris-key-sdk): The umbrella client, PolarisKeyClient, re-exporting :core and every service module (P6-07).
// A plain Kotlin/JVM library with NO Android dependency, depending on :core and the service modules only
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

base { archivesName.set("polaris-key-sdk") }

dependencies {
    api(project(":core"))
    api(project(":license"))
    api(project(":config"))
    api(project(":identity"))
    api(project(":release"))
    api(project(":update"))
    api(project(":packs"))
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

publishing {
    publications {
        create<MavenPublication>("sdk") {
            from(components["java"])
            artifactId = "polaris-key-sdk"
            pom {
                name.set("Polaris Key sdk (Kotlin)")
                description.set("The umbrella client, PolarisKeyClient, re-exporting :core and every service module for the Polaris Key Kotlin SDK.")
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
