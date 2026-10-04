plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
}

allprojects {
    group = "im.plrs.key"
    version = "0.1.0"
}

// The module boundaries (P6-05): :core is a plain JVM library with no Android dependency, and
// :platform is standalone (the Godot binding links it alone), so it never depends on :core. The
// one module allowed to see both is :android (P6-12). `./gradlew checkModuleBoundaries` fails on
// any edge that breaks this; the kotlin and android CI jobs run it.
val checkModuleBoundaries by tasks.registering {
    group = "verification"
    description = "Fails when :core reaches Android or :platform reaches an SDK module."
    val coreProject = project(":core")
    val platformProject = findProject(":platform")
    doLast {
        val problems = mutableListOf<String>()
        val forbiddenPlugins = listOf("com.android.library", "com.android.application")
        for (id in forbiddenPlugins) {
            if (coreProject.plugins.hasPlugin(id)) problems += ":core applies $id"
        }
        val androidGroup = Regex("^(androidx\\..*|com\\.android\\..*|com\\.google\\.android\\..*)$")
        for (name in listOf("compileClasspath", "runtimeClasspath")) {
            val config = coreProject.configurations.getByName(name)
            for (artifact in config.resolvedConfiguration.resolvedArtifacts) {
                val group = artifact.moduleVersion.id.group
                if (androidGroup.matches(group)) {
                    problems += ":core $name contains ${artifact.moduleVersion.id}"
                }
            }
        }
        coreProject.file("src").walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach {
            it.readLines().forEachIndexed { i, line ->
                if (Regex("^import\\s+(android|androidx)\\.").containsMatchIn(line.trim())) {
                    problems += "${it.relativeTo(rootDir)}:${i + 1} imports Android: ${line.trim()}"
                }
            }
        }
        if (platformProject != null) {
            for (config in platformProject.configurations) {
                for (dep in config.dependencies.withType(ProjectDependency::class.java)) {
                    problems += ":platform ${config.name} depends on project :${dep.name}"
                }
            }
        }
        if (problems.isNotEmpty()) {
            throw GradleException("module boundary violations:\n  " + problems.joinToString("\n  "))
        }
        logger.lifecycle(
            "module boundaries hold: :core has no Android dependency" +
                (if (platformProject != null) "; :platform depends on no SDK module" else
                    " (:platform not included in this build)"),
        )
    }
}
