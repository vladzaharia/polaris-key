// The Godot Android plugin (v2), Engine singleton PolarisKeyAndroid: a thin JSON layer over the
// Kotlin SDK's platform module and NOTHING else from the SDK (P5-06, rebuilt by P6-10). Godot keeps
// verification, the licence client, the updater and the pack engine in its shared GDScript core,
// as on every other target; this mirrors Godot on iOS, which links only Swift's PolarisKeyPlatform.
// Built from sdks/kotlin as the `:godot` project:   (cd sdks/kotlin && ./gradlew :godot:assembleRelease)
//
// Flavours match the platform module's: a Godot export ships polaris-key-platform-<flavour> and
// this AAR of the SAME flavour (addons/polaris_key/native/android_export.gd picks them per preset).
// Godot is compileOnly: the export template provides it. Needs Godot 4.2+ with the Gradle build.
//
// Published per flavour as im.plrs.key:polaris-key-godot-play and im.plrs.key:polaris-key-godot-direct,
// each POM depending on im.plrs.key:polaris-key-platform-<same flavour>, to the local repository
// sdks/kotlin/build/repo only (no signing, no Maven Central; the Godot addon itself ships on its feed,
// F-09). `checkPlatformOnly` (part of `check`) fails when any SDK module but :platform enters the graph.
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
val flavours = listOf("play", "direct")

android {
    namespace = "im.plrs.key.godot"
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
        }
    }

    publishing {
        for (f in flavours) singleVariant("${f}Release") { withSourcesJar() }
    }
}

kotlin {
    jvmToolchain(jvmTarget.toInt())
}

base { archivesName.set("polaris-key-godot") }

dependencies {
    // The ONLY SDK dependency, by its published per-flavour coordinate (P6-09): the play variant
    // links im.plrs.key:polaris-key-platform-play (and through its `api`, Play Core), the direct
    // variant polaris-key-platform-direct. Inside this build both resolve to the :platform project
    // (sdks/kotlin/build.gradle.kts); the coordinates are what the published POMs and module
    // metadata name.
    for (f in flavours) "${f}Implementation"("${project.group}:polaris-key-platform-$f:${project.version}")
    compileOnly(libs.godot)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}

// Inside this build polaris-key-platform-<flavour> IS the :platform project: the root build file
// substitutes it for every project (this one and :boundary, which links this AAR), and variant-aware
// matching picks the flavour. Gradle 8.11 cannot map one project dependency to two publications of
// different coordinates when it writes a POM, so the dependency is declared by coordinate.

// ── Publication ──────────────────────────────────────────────────────────────────────────────
// Each POM (and the Gradle module metadata) names im.plrs.key:polaris-key-platform-<same flavour>,
// never a flavour-less polaris-key-platform (tools/check_publication.sh checks it).
afterEvaluate {
    publishing {
        publications {
            for (f in flavours) {
                create<MavenPublication>(f) {
                    from(components["${f}Release"])
                    groupId = project.group.toString()
                    artifactId = "polaris-key-godot-$f"
                    version = project.version.toString()
                    pom {
                        name.set("Polaris Key Godot Android binding ($f)")
                        description.set(
                            "The Godot Android plugin (v2) PolarisKeyAndroid over polaris-key-platform-$f; " +
                                "the Godot SDK's GDScript core does verification, licensing, updates and packs.",
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
}

publishing {
    repositories {
        // The only repository: a directory under the Kotlin build (publishAllPublicationsToLocalRepository).
        maven {
            name = "local"
            url = uri(rootProject.layout.buildDirectory.dir("repo"))
        }
    }
}

// ── Platform-only check ──────────────────────────────────────────────────────────────────────
// Every compile and runtime classpath of every variant must reach :platform and no other SDK
// module: no other project, and no im.plrs.key module (resolved or not) except
// polaris-key-platform-<flavour>. So no :core, :license, :update, :packs or :sdk class can enter the
// Godot AAR's graph and a Godot game never carries a second verifier. Part of `check`; the android
// CI job runs it by name.
val sdkGroup: String = project.group.toString()
val platformOnlyClasspaths: List<String> = flavours.flatMap { f ->
    listOf("Debug", "Release").flatMap { b -> listOf("${f}${b}CompileClasspath", "${f}${b}RuntimeClasspath") }
}

val checkPlatformOnly by tasks.registering {
    group = "verification"
    description = "Fails unless :godot's SDK dependencies are exactly :platform (no other project or im.plrs.key module)."
    val roots = platformOnlyClasspaths.map { name ->
        name to configurations.named(name).flatMap { it.incoming.resolutionResult.rootComponent }
    }
    inputs.property("classpaths", platformOnlyClasspaths)
    doLast {
        val problems = mutableListOf<String>()
        for ((name, rootProvider) in roots) {
            val root = rootProvider.get()
            val seen = mutableSetOf<ResolvedComponentResult>()
            val queue = ArrayDeque(listOf(root))
            var platformSeen = false
            while (queue.isNotEmpty()) {
                val c = queue.removeFirst()
                if (!seen.add(c)) continue
                val id = c.id
                if (c !== root) {
                    when {
                        id is ProjectComponentIdentifier && id.projectPath == ":platform" -> platformSeen = true
                        id is ProjectComponentIdentifier -> problems += "$name: project ${id.projectPath}"
                        id is ModuleComponentIdentifier && id.group == sdkGroup &&
                            id.module.startsWith("polaris-key-platform-") -> platformSeen = true
                        id is ModuleComponentIdentifier && id.group == sdkGroup -> problems += "$name: ${id.group}:${id.module}"
                    }
                }
                for (d in c.dependencies) {
                    when (d) {
                        is ResolvedDependencyResult -> queue.add(d.selected)
                        // An unresolvable request is still a declared dependency.
                        is UnresolvedDependencyResult -> when (val r = d.requested) {
                            is ProjectComponentSelector -> problems += "$name: project ${r.projectPath} (unresolved)"
                            is ModuleComponentSelector -> if (r.group == sdkGroup) problems += "$name: ${r.group}:${r.module} (unresolved)"
                        }
                    }
                }
            }
            if (!platformSeen) problems += "$name: does not reach :platform"
        }
        if (problems.isNotEmpty()) {
            throw GradleException("polaris-key-godot must depend on :platform and no other SDK module:\n  " + problems.joinToString("\n  "))
        }
        logger.lifecycle("checkPlatformOnly: ${roots.size} classpaths resolved, :platform is the only SDK module")
    }
}

tasks.named("check") { dependsOn(checkPlatformOnly) }
