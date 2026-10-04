// polaris-key-platform: the Kotlin SDK's Android platform module (P5-06, moved into the SDK
// structure by P6-09). Two flavours, and the flavour is a POLICY boundary (Play forbids self-update
// and REQUEST_INSTALL_PACKAGES in Play builds):
//   play    install source, Keystore, Play In-App Updates, Play Asset Delivery, the standard Play
//           Integrity API (P6-02). No PackageInstaller session code, no install permission.
//   direct  install source, Keystore, verified PackageInstaller self-update; Integrity answers
//           Unsupported("outlet"). No Play Core.
// STANDALONE: it depends on no other SDK module (checkStandalone below enforces it), so the Godot
// Android binding, and later Unity and MAUI, link it alone, as Godot on iOS links only Swift's
// PolarisKeyPlatform. A convenience that wants :core belongs in :android (P6-12), never here.
// Pure Kotlin: no NDK, no .so files (a later zstd-jni must be 16 KB page aligned, notes/E4 §2.1).
//
// Published per flavour as im.plrs.key:polaris-key-platform-play and
// im.plrs.key:polaris-key-platform-direct (each with its own POM, sources jar and Gradle module
// metadata), to the local repository sdks/kotlin/build/repo only. No signing and no Maven Central:
// the Polaris Key Maven feed carries the artifacts later (F-07, F-10).
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ModuleComponentSelector
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentSelector
import org.gradle.api.artifacts.result.ResolvedComponentResult
import org.gradle.api.artifacts.result.ResolvedDependencyResult
import org.gradle.api.artifacts.result.UnresolvedDependencyResult

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

val jvmTarget: String = libs.versions.jvmTarget.get()

android {
    namespace = "im.plrs.key.platform"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.androidMinSdk.get().toInt()
        consumerProguardFiles("consumer-rules.pro")
    }

    flavorDimensions += "channel"
    productFlavors {
        create("play") { dimension = "channel" }
        create("direct") { dimension = "channel" }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTarget)
        targetCompatibility = JavaVersion.toVersion(jvmTarget)
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
    }

    publishing {
        singleVariant("playRelease") { withSourcesJar() }
        singleVariant("directRelease") { withSourcesJar() }
    }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
    explicitApi()
}

base { archivesName.set("polaris-key-platform") }

dependencies {
    "playApi"(libs.play.app.update)
    "playApi"(libs.play.asset.delivery)
    "playApi"(libs.play.integrity)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}

// ── Publication ──────────────────────────────────────────────────────────────────────────────
val flavourDescriptions = mapOf(
    "play" to "install source, Android Keystore, Play In-App Updates, Play Asset Delivery and the standard Play Integrity API",
    "direct" to "install source, Android Keystore and the verified PackageInstaller self-update (no Play Core)",
)

afterEvaluate {
    publishing {
        publications {
            for ((flavour, what) in flavourDescriptions) {
                create<MavenPublication>(flavour) {
                    from(components["${flavour}Release"])
                    groupId = project.group.toString()
                    artifactId = "polaris-key-platform-$flavour"
                    version = project.version.toString()
                    pom {
                        name.set("Polaris Key platform ($flavour)")
                        description.set("The Polaris Key Android platform module, $flavour flavour: $what.")
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
        // The only repository: a directory under the build (publishAllPublicationsToLocalRepository).
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repo"))
        }
    }
}

// ── Standalone check ─────────────────────────────────────────────────────────────────────────
// Every compile and runtime classpath of every variant resolves to no project dependency and no
// im.plrs.key module. Part of `check`; the android CI job runs it by name.
val sdkGroup: String = project.group.toString()
val standaloneClasspaths: List<String> = listOf("play", "direct").flatMap { f ->
    listOf("Debug", "Release").flatMap { b -> listOf("${f}${b}CompileClasspath", "${f}${b}RuntimeClasspath") }
}

val checkStandalone by tasks.registering {
    group = "verification"
    description = "Fails if :platform depends on any other SDK module (a project or an im.plrs.key module)."
    val roots = standaloneClasspaths.map { name ->
        name to configurations.named(name).flatMap { it.incoming.resolutionResult.rootComponent }
    }
    inputs.property("classpaths", standaloneClasspaths)
    doLast {
        val offenders = mutableListOf<String>()
        for ((name, rootProvider) in roots) {
            val root = rootProvider.get()
            val seen = mutableSetOf<ResolvedComponentResult>()
            val queue = ArrayDeque(listOf(root))
            while (queue.isNotEmpty()) {
                val c = queue.removeFirst()
                if (!seen.add(c)) continue
                val id = c.id
                if (c !== root) {
                    if (id is ProjectComponentIdentifier) offenders += "$name: project ${id.projectPath}"
                    if (id is ModuleComponentIdentifier && id.group == sdkGroup) offenders += "$name: ${id.group}:${id.module}"
                }
                for (d in c.dependencies) {
                    when (d) {
                        is ResolvedDependencyResult -> queue.add(d.selected)
                        // An unresolvable request is still a declared dependency.
                        is UnresolvedDependencyResult -> when (val r = d.requested) {
                            is ProjectComponentSelector -> offenders += "$name: project ${r.projectPath} (unresolved)"
                            is ModuleComponentSelector -> if (r.group == sdkGroup) offenders += "$name: ${r.group}:${r.module} (unresolved)"
                        }
                    }
                }
            }
        }
        if (offenders.isNotEmpty()) {
            throw GradleException("polaris-key-platform must stay standalone:\n  " + offenders.joinToString("\n  "))
        }
        logger.lifecycle("checkStandalone: ${roots.size} classpaths resolved, no SDK module")
    }
}

tasks.named("check") { dependsOn(checkStandalone) }
