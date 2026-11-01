// polaris-key-server-ktor (proposed coordinates im.plrs.key:polaris-key-server-ktor): the Ktor
// plugin of the framework drop-ins (SP-57): a Ktor `Authentication` provider plus route plugins over
// :server. Ktor is an `api` dependency here because the plugin's types are Ktor's.
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

base { archivesName.set("polaris-key-server-ktor") }

dependencies {
    api(project(":server"))
    api(libs.ktor.server.core)
    api(libs.ktor.server.auth)
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.server.test.host)
    testImplementation(libs.ktor.server.status.pages)
    testImplementation("org.slf4j:slf4j-nop:2.0.20")
}

publishing {
    publications {
        create<MavenPublication>("serverKtor") {
            from(components["java"])
            artifactId = "polaris-key-server-ktor"
            pom {
                name.set("Polaris Key server for Ktor")
                description.set("The Ktor plugin of the Polaris Key server drop-ins: authenticate and gate routes with the app's signed licence document.")
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
