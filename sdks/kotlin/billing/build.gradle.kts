// polaris-key-billing (im.plrs.key:polaris-key-billing): Play Billing for the Kotlin SDK's
// commerce (SP-K05; notes/SDK-PARITY-PASS.md §3.9). One call buys a store product and turns it into a
// licence flag: the licence's purchase binding as Play's obfuscatedAccountId, the purchase claimed with
// the Worker, acknowledged only after the claim answered ok, then a sync. Restore and the renewals
// listener claim what Play already holds.
//
// Its own artifact so that only apps that sell through Play link Play Billing: it depends on :sdk
// (and through it :core) and on com.android.billingclient, never on :platform or :android
// (checkModuleBoundaries). A direct build simply does not add it. Published to build/repo only.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.billing"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.androidMinSdk.get().toInt()
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            all {
                it.testLogging {
                    events("failed")
                    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                }
            }
        }
    }

    publishing {
        singleVariant("release") { withSourcesJar() }
    }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
    explicitApi()
}

base { archivesName.set("polaris-key-billing") }

dependencies {
    api(project(":sdk"))
    api(libs.play.billing)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    testImplementation(testFixtures(project(":core")))
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("billing") {
                from(components["release"])
                groupId = project.group.toString()
                artifactId = "polaris-key-billing"
                version = project.version.toString()
                pom {
                    name.set("Polaris Key Play Billing")
                    description.set("One-call Play Billing purchases and restores that become Polaris Key licence flags.")
                    url.set("https://github.com/vladzaharia/polaris-key")
                    licenses {
                        license {
                            name.set("MIT License")
                            url.set("https://opensource.org/licenses/MIT")
                        }
                    }
                    scm { url.set("https://github.com/vladzaharia/polaris-key") }
                }
            }
        }
    }
}

publishing {
    repositories {
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repo"))
        }
    }
}
