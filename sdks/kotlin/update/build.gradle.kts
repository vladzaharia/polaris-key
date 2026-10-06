// polaris-key-update (proposed coordinates im.plrs.key:polaris-key-update): the update client (P6-08):
// update.check, the signed channel feed and update.decide over :core's feed, record and content
// decisions, the boot guard, and the InstallDriver port that P6-12 implements on Android; UK-40 adds
// the JVM desktop driver (DesktopInstallDriver over OkHttpArtifactFetch) and the default slots
// (DirUpdateSlots, FileBootGuardStore).
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

base { archivesName.set("polaris-key-update") }

dependencies {
    api(project(":core"))
    // UK-40: the desktop install driver's verified download (OkHttpArtifactFetch); :core's transport
    // client, so Android and the JVM already carry it.
    implementation(libs.okhttp)
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

publishing {
    publications {
        create<MavenPublication>("update") {
            from(components["java"])
            artifactId = "polaris-key-update"
            pom {
                name.set("Polaris Key update (Kotlin)")
                description.set("The update client: the version check, the signed channel feed, the update decision, the boot guard and the install-driver port for the Polaris Key Kotlin SDK.")
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
