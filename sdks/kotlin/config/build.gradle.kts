// polaris-key-config (proposed coordinates im.plrs.key:polaris-key-config): The config service: layered resolution, the user-visible list, secrets, the catalog fetch and edge-mint (P6-07).
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

base { archivesName.set("polaris-key-config") }

dependencies {
    api(project(":core"))
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

publishing {
    publications {
        create<MavenPublication>("config") {
            from(components["java"])
            artifactId = "polaris-key-config"
            pom {
                name.set("Polaris Key config (Kotlin)")
                description.set("The config service: layered resolution, the user-visible list, secrets, the catalog fetch and edge-mint for the Polaris Key Kotlin SDK.")
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
