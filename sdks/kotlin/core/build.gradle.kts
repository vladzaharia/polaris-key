// polaris-key-core (proposed coordinates im.plrs.key:polaris-key-core): the cross-service core of
// the Kotlin SDK (P6-06), the analogue of Swift's PolarisKeyCore. A plain Kotlin/JVM library with
// NO Android dependency (checkModuleBoundaries), so the same JAR runs on Android API 24+ and on a
// JVM desktop, with Java 17 bytecode.
//
// Ed25519 has two backends behind one port: the JCA (`Signature.getInstance("Ed25519")`, JDK 15+
// and Android API 33+) and Tink below that. Tink is compileOnly here: a JVM desktop always has
// the JCA, and the Android glue (P6-12) brings tink-android for API 24–32.
//
// maven-publish writes to build/repo ONLY (unsigned, no remote repository): Kotlin artifacts
// reach adopters through Polaris Key's own Maven feed (F-07, F-10) and nowhere else.
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

base { archivesName.set("polaris-key-core") }

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    compileOnly(libs.tink)

    testImplementation(libs.junit)
    testImplementation(libs.tink)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

publishing {
    publications {
        create<MavenPublication>("core") {
            from(components["java"])
            artifactId = "polaris-key-core"
            pom {
                name.set("Polaris Key core (Kotlin)")
                description.set(
                    "JWS and Ed25519 verification, the trust set, the verified cache, discovery, " +
                        "sync and the boot stage machine for the Polaris Key Kotlin SDK.",
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

tasks.withType<Test>().configureEach {
    systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
    systemProperty("pkey.sourceRoot", projectDir.resolve("src/main/kotlin").canonicalPath)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
