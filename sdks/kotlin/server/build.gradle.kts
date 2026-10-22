// polaris-key-server (proposed coordinates im.plrs.key:polaris-key-server): the server core of the
// framework drop-ins (SP-57, WIRE-CONTRACT-V4 §14). It decides a request to a product backend from the
// app's signed licence document, offline: the six-step verdict, the problem body and the trust
// refresh. A plain Kotlin/JVM library with no framework and no Android dependency, over :core only,
// so each framework adapter (:server-ktor, :spring-boot-starter) stays thin.
//
// The eight copy locales are the repository's conformance/parity/copy.<locale>.json files, copied
// into the JAR at build time (the one source; nothing is written by hand).
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

base { archivesName.set("polaris-key-server") }

dependencies {
    api(project(":core"))
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

val copyLocales = tasks.register<Copy>("copyLocales") {
    description = "Copies conformance/parity/copy.<locale>.json into the JAR."
    from(rootProject.projectDir.resolve("../../conformance/parity")) {
        include("copy.*.json")
        exclude("copy.schema.json")
    }
    into(layout.buildDirectory.dir("generated/resources/copy/im/plrs/key/server/copy"))
}
sourceSets.main { resources.srcDir(layout.buildDirectory.dir("generated/resources/copy")) }
tasks.named("processResources") { dependsOn(copyLocales) }
tasks.named("sourcesJar") { dependsOn(copyLocales) }

publishing {
    publications {
        create<MavenPublication>("server") {
            from(components["java"])
            artifactId = "polaris-key-server"
            pom {
                name.set("Polaris Key server (Kotlin)")
                description.set("Gate a server route with the app's signed licence document, verified offline: the framework-free core of the Polaris Key server drop-ins.")
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
