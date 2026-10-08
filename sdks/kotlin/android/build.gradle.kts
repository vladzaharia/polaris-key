// polaris-key-android: the Kotlin SDK's Android glue (P6-12), the ONLY module that sees both the
// SDK (:sdk, and through it :core and every service module) and :platform. It closes the rows that
// need an Android edge on top of the JVM modules:
//
//   core.store            AndroidKeystoreStore: the token and the device id wrapped by :platform's
//                         SecureStore (an AndroidKeyStore AES-256-GCM key), the verified cache in a
//                         file; migration from a FileStore, `keyring-error` on a failed Keystore call
//   devices.fingerprint   AndroidFingerprintSource: the app-scoped ANDROID_ID (else a random anchor
//   devices.facts         kept in the Keystore), Build.MODEL and the RAM bucket; AndroidDeviceFactsSource:
//                         Build facts and package-manager probes of the product's declared packages
//   outlet.detect         AndroidOutletSignalReader over :platform's InstallSource
//   update.driver         play: PlayInstallDriver (In-App Updates); direct: DirectInstallDriver (the
//                         verified APK through a PackageInstaller session). The play build carries no
//                         installer code (tools/check_flavours.sh reads the :boundary APKs)
//   packs.transport.play  play: PlayPackTransport (Play Asset Delivery baselines, re-read every
//                         launch, never persisted); direct: the typed `outlet` N/A
//
// PolarisKeyAndroid.client(context, …) wires all of it into the umbrella PolarisKeyClient.
//
// A LEAF: nothing in this build depends on it except :boundary (checkModuleBoundaries). It links
// tink-android (:core's Tink backend, preferred on Android: SP-50 chooses Ed25519 by a known-answer
// test, and Android 16's JCA answers wrongly). zstd is not linked: an app that uses packs adds
// polaris-key-zstd (SP-50), whose Android variant is zstd-jni's 16 KB-aligned AAR.
//
// Published per flavour as im.plrs.key:polaris-key-android-play and -direct to the local
// repository sdks/kotlin/build/repo only (no signing, no Maven Central).

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()
val flavours = listOf("play", "direct")

android {
    namespace = "im.plrs.key.android"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.androidMinSdk.get().toInt()
    }

    flavorDimensions += "channel"
    productFlavors {
        for (f in flavours) create(f) { dimension = "channel" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            all { test ->
                test.systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
                test.testLogging {
                    events("failed")
                    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                }
            }
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
    }

    publishing {
        for (f in flavours) singleVariant("${f}Release") { withSourcesJar() }
    }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
    explicitApi()
}

base { archivesName.set("polaris-key-android") }

dependencies {
    // SP-50: no exclude. :packs links zstd-jni compileOnly, so the SDK carries no native library; an
    // app that uses packs adds polaris-key-zstd, whose Android variant is zstd-jni's AAR.
    api(project(":sdk"))
    // :platform by its published per-flavour coordinate, as the Godot binding does (P6-09, P6-10):
    // the play variant links polaris-key-platform-play (and through its `api`, Play Core), the
    // direct variant polaris-key-platform-direct, and the POMs name exactly that. Inside this build
    // both resolve to the :platform project (sdks/kotlin/build.gradle.kts).
    for (f in flavours) "${f}Api"("${project.group}:polaris-key-platform-$f:${project.version}")
    // tink-android's androidx.annotation-jvm 1.8 duplicates the androidx.annotation 1.3 Play Core
    // brings (the same classes, class-retention annotations only): Play Core's copy serves both.
    implementation(libs.tink.android) { exclude(group = "androidx.annotation", module = "annotation-jvm") }
    implementation(libs.okhttp)

    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

afterEvaluate {
    publishing {
        publications {
            for (f in flavours) {
                create<MavenPublication>(f) {
                    from(components["${f}Release"])
                    groupId = project.group.toString()
                    artifactId = "polaris-key-android-$f"
                    version = project.version.toString()
                    pom {
                        name.set("Polaris Key Android ($f)")
                        description.set("The Polaris Key Kotlin SDK's Android glue, $f flavour: the Keystore store, device inputs, outlet readers, the install driver and the pack transport.")
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
}

publishing {
    repositories {
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repo"))
        }
    }
}
