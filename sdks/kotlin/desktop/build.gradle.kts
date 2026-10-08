// polaris-key-desktop (im.plrs.key:polaris-key-desktop): the JVM desktop start (SP-50). It holds
// PolarisKeyDesktop (the keyring store, the desktop install driver, the default update slots and the
// boot guard) and brings java-keyring at runtime, so a desktop app gets the OS keyring from one
// dependency line. java-keyring pulls in JNA, which is why it is not in polaris-key-sdk: an Android
// app never carries it. A plain Kotlin/JVM library over :sdk (checkModuleBoundaries).
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

base { archivesName.set("polaris-key-desktop") }

dependencies {
    api(project(":sdk"))
    // The OS keyring (Keychain, Credential Manager, Secret Service or KWallet) through JNA.
    runtimeOnly(libs.java.keyring)
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

publishing {
    publications {
        create<MavenPublication>("desktop") {
            from(components["java"])
            artifactId = "polaris-key-desktop"
            pom {
                name.set("Polaris Key desktop (Kotlin)")
                description.set(
                    "The JVM desktop start for the Polaris Key Kotlin SDK: PolarisKeyDesktop with the OS keyring (java-keyring), " +
                        "the desktop install driver and the boot guard.",
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
    inputs.property("pkeyKeyringTests", providers.environmentVariable("PKEY_KEYRING_TESTS").orElse(""))
    systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
