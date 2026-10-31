// polaris-key-games (im.plrs.key:polaris-key-games): Play Games Services v2 sign-in for the Kotlin SDK
// (I-45.5; WIRE-CONTRACT-V5 section 12.11.7). It asks Play Games for a server auth code
// (`GamesSignInClient.requestServerSideAccess`) and hands it to `identity.autoSignIn()` as a
// `PlatformIdentityProvider` of kind `pgs`. The code is a secret: it is never logged or put in a message.
//
// Opt-in and its own artifact, so only a game that signs in through Play Games links the Play Games
// SDK: it depends on :identity (and through it :core) and on play-services-games-v2, never on
// :sdk, :platform or :android (checkModuleBoundaries). Published to build/repo only.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.games"
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

base { archivesName.set("polaris-key-games") }

dependencies {
    api(project(":identity"))
    api(libs.play.games)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(libs.junit)
    testImplementation(kotlin("test"))
    testImplementation(libs.kotlinx.coroutines.core)
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("games") {
                from(components["release"])
                groupId = project.group.toString()
                artifactId = "polaris-key-games"
                version = project.version.toString()
                pom {
                    name.set("Polaris Key Play Games")
                    description.set("Play Games Services v2 sign-in for Polaris Key: the server auth code as the platform identity of automatic sign-in.")
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
