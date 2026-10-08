// polaris-key-ui (im.plrs.key:polaris-key-ui): the Kotlin SDK's Jetpack Compose UI kit (P6-11).
// Material 3 screens over the SDK's state: the boot shell (PolarisBoot), the gate, activation,
// sign-in with a QR code, settings, devices, the update banner and prompt, and pack progress.
//
// Neutral by default: with PolarisBranding.None every colour, shape and text style comes from the
// host app's MaterialTheme. PolarisBranding.PolarisKey is the one switch to the Polaris Key look
// (the generated PolarisBrandTokens, Rubik under the OFL, the bit-less Pinned K); the "Powered by
// Polaris Key" badge is a separate switch, off by default.
//
// Depends on :sdk (and through it :core, :update and :packs) for state types and on Compose. It
// renders state and never calls the network itself, and it never depends on :platform or :android
// (checkModuleBoundaries). Published to the local build/repo only, like every Kotlin module.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.roborazzi)
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.ui"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.androidMinSdk.get().toInt()
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            all {
                it.systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
                // Robolectric's native graphics render the snapshots (Roborazzi); the JVM needs room.
                it.maxHeapSize = "3g"
                it.testLogging {
                    events("failed")
                    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                }
            }
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        // The kit ships English only, and a partial translation is supported by design: an app's
        // values-<locale> overrides the names it translates and the rest keep the English (the
        // debug-only values-fr fixture proves it). So MissingTranslation is never a defect here,
        // and without this lintDebug, which `./gradlew build` runs, fails on that fixture (P6-05).
        disable += "MissingTranslation"
    }

    publishing {
        singleVariant("release") { withSourcesJar() }
    }
}

// The Compose tests host their content in ComponentActivity, which only the debug manifest declares
// (ui-test-manifest is debugImplementation), and the Roborazzi references are recorded on debug.
// The release unit-test variant would only fail to launch that activity, so it is not created and
// `./gradlew build` runs the suite once, on debug (P6-05).
androidComponents {
    // enableUnitTest is AGP 8.6's API (the template's version); its AGP 9 replacement is not in 8.6.
    beforeVariants(selector().withBuildType("release")) { it.enableUnitTest = false }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
    explicitApi()
}

base { archivesName.set("polaris-key-ui") }

// The committed reference images live beside the tests, so a review sees them in the diff.
roborazzi {
    outputDir.set(file("src/test/snapshots"))
}

dependencies {
    api(project(":sdk"))
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.foundation)
    api(libs.compose.material3)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.zxing.core)
    implementation(libs.androidx.lifecycle.viewmodel)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.androidx.activity.compose)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
    testImplementation(libs.kotlinx.coroutines.test)
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("ui") {
                from(components["release"])
                groupId = project.group.toString()
                artifactId = "polaris-key-ui"
                version = project.version.toString()
                pom {
                    name.set("Polaris Key UI (Jetpack Compose)")
                    description.set(
                        "The Polaris Key Kotlin SDK's Jetpack Compose UI kit: boot shell, gate, activation, sign-in with QR, " +
                            "settings, devices, update banner and prompt, pack progress. Neutral Material 3 by default; " +
                            "Polaris Key branding is opt-in.",
                    )
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
