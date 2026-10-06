plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.roborazzi) apply false
}

allprojects {
    group = "im.plrs.key"
    version = "0.1.0"
}

// :platform publishes one coordinate per flavour (polaris-key-platform-play, -direct; P6-09), and a
// consumer that is itself published (the Godot binding, P6-10) declares that coordinate so its POM
// names the right flavour. Inside this build the coordinate IS the :platform project; variant-aware
// matching picks the flavour from the consumer's `channel` attribute.
if (findProject(":platform") != null) {
    allprojects {
        configurations.configureEach {
            resolutionStrategy.dependencySubstitution {
                for (flavour in listOf("play", "direct")) {
                    substitute(module("im.plrs.key:polaris-key-platform-$flavour"))
                        .using(project(":platform"))
                        .because("polaris-key-platform-$flavour is published from :platform in this build")
                }
            }
        }
    }
}

// The module boundaries (P6-05): :core and the JVM service modules are plain JVM libraries with no
// Android dependency; each service module (:license, :config, :identity, :release, :update, :packs) depends on
// :core only, never on a sibling, and :sdk is the one place they meet (P6-07). :platform is
// standalone (the Godot binding links it alone), so it never depends on :core. The one module
// allowed to see both core and platform is :android (P6-12), and it is a leaf: no module but the
// :boundary probe depends on it. `./gradlew checkModuleBoundaries` fails on any edge that breaks
// this; the kotlin and android CI jobs run it.
val jvmModules = listOf(":core", ":license", ":config", ":identity", ":release", ":update", ":packs", ":sdk")
val serviceModules = listOf(":license", ":config", ":identity", ":release", ":update", ":packs")
val checkModuleBoundaries by tasks.registering {
    group = "verification"
    description = "Fails when a JVM module reaches Android, a service module reaches a sibling, :platform reaches an SDK module, or a module other than :android sees both :core and :platform."
    val jvmProjects = jvmModules.map { project(it) }
    val serviceProjects = serviceModules.map { project(it) }
    val platformProject = findProject(":platform")
    val uiProject = findProject(":ui")
    val billingProject = findProject(":billing")
    val androidProject = findProject(":android")
    val everyProject = rootProject.subprojects.toList()
    doLast {
        val problems = mutableListOf<String>()
        val forbiddenPlugins = listOf("com.android.library", "com.android.application")
        val androidGroup = Regex("^(androidx\\..*|com\\.android\\..*|com\\.google\\.android\\..*)$")
        for (p in jvmProjects) {
            for (id in forbiddenPlugins) {
                if (p.plugins.hasPlugin(id)) problems += "${p.path} applies $id"
            }
            for (name in listOf("compileClasspath", "runtimeClasspath")) {
                val config = p.configurations.getByName(name)
                for (artifact in config.resolvedConfiguration.resolvedArtifacts) {
                    val group = artifact.moduleVersion.id.group
                    if (androidGroup.matches(group)) {
                        problems += "${p.path} $name contains ${artifact.moduleVersion.id}"
                    }
                }
            }
            p.file("src").walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach {
                it.readLines().forEachIndexed { i, line ->
                    if (Regex("^import\\s+(android|androidx)\\.").containsMatchIn(line.trim())) {
                        problems += "${it.relativeTo(rootDir)}:${i + 1} imports Android: ${line.trim()}"
                    }
                }
            }
        }
        // A service module sees :core and nothing else of the SDK, on every configuration.
        for (p in serviceProjects) {
            for (config in p.configurations) {
                for (dep in config.dependencies.withType(ProjectDependency::class.java)) {
                    if (dep.name == p.name || dep.name == "core") continue
                    problems += "${p.path} ${config.name} depends on project :${dep.name}"
                }
            }
        }
        if (platformProject != null) {
            for (config in platformProject.configurations) {
                for (dep in config.dependencies.withType(ProjectDependency::class.java)) {
                    // AGP wires a module's own test configurations to the module itself.
                    if (dep.name == platformProject.name) continue
                    problems += ":platform ${config.name} depends on project :${dep.name}"
                }
            }
        }
        // :ui (P6-11) renders SDK state: it sees :sdk (and through it :core, :update, :packs), never
        // the Android platform backend or its glue.
        // :ui (P6-11) and :billing (SP-K05) render or drive SDK state: they see :sdk, never the
        // Android platform backend or its glue.
        for (p in listOfNotNull(uiProject, billingProject)) {
            val forbidden = setOf("platform", "android", "godot", "boundary", "conformance")
            for (config in p.configurations) {
                for (dep in config.dependencies.withType(ProjectDependency::class.java)) {
                    if (dep.name in forbidden) problems += "${p.path} ${config.name} depends on project :${dep.name}"
                }
            }
        }
        // P6-12: only :android sees both the SDK core and :platform. Every project's resolvable
        // classpaths are walked (project components, and the platform's published coordinates, which
        // resolve to :platform in this build); a module reaching both, other than :android, fails.
        // And :android is a leaf: no module but the :boundary probe declares a dependency on it.
        if (platformProject != null) {
            val platformCoordinates = Regex("^polaris-key-platform-(play|direct)$")
            for (p in everyProject) {
                if (p == androidProject || p == platformProject) continue
                var seesCore = false
                var seesPlatform = false
                for (config in p.configurations.filter { it.isCanBeResolved && it.name.endsWith("Classpath") && !it.name.contains("UnitTest") && !it.name.contains("AndroidTest") }) {
                    val result = try {
                        config.incoming.resolutionResult.allComponents
                    } catch (e: Exception) {
                        continue
                    }
                    for (c in result) {
                        val id = c.id
                        if (id is org.gradle.api.artifacts.component.ProjectComponentIdentifier && id.build.isCurrentBuild) {
                            if (id.projectPath == ":core") seesCore = true
                            if (id.projectPath == ":platform") seesPlatform = true
                        }
                        if (id is org.gradle.api.artifacts.component.ModuleComponentIdentifier && id.group == "im.plrs.key") {
                            if (id.module == "polaris-key-core") seesCore = true
                            if (platformCoordinates.matches(id.module)) seesPlatform = true
                        }
                    }
                }
                if (seesCore && seesPlatform && p.path != ":boundary") {
                    problems += "${p.path} sees both :core and :platform (only :android may)"
                }
            }
            if (androidProject != null) {
                for (p in everyProject) {
                    if (p == androidProject || p.path == ":boundary") continue
                    for (config in p.configurations) {
                        for (dep in config.dependencies.withType(ProjectDependency::class.java)) {
                            if (dep.name == androidProject.name) problems += "${p.path} ${config.name} depends on :android (a leaf)"
                        }
                    }
                }
            }
        }
        if (problems.isNotEmpty()) {
            throw GradleException("module boundary violations:\n  " + problems.joinToString("\n  "))
        }
        logger.lifecycle(
            "module boundaries hold: no JVM module has an Android dependency; each service module sees :core only" +
                (if (platformProject != null) "; :platform depends on no SDK module" else
                    " (:platform not included in this build)") +
                (if (uiProject != null) "; :ui reaches neither :platform nor :android" else "") +
                (if (androidProject != null) "; only :android sees both :core and :platform, and nothing depends on it" else ""),
        )
    }
}
