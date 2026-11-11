plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.compose.multiplatform) apply false
    alias(libs.plugins.roborazzi) apply false
}

allprojects {
    group = "im.plrs.key"
    version = "0.1.0"
}

// Every test JVM runs in one locale and zone, so a test never depends on the machine it runs on (a
// Roborazzi render, a worded date, a number format). A test that wants another passes it explicitly.
subprojects {
    tasks.withType<Test>().configureEach {
        systemProperty("user.language", "en")
        systemProperty("user.country", "US")
        systemProperty("user.timezone", "UTC")
    }
}

// Flavour dedupe for CI (-Ppkey.directFlavourOnly=true): the play flavour runs every test, the
// direct flavour runs only src/testDirect plus the shared src/test classes listed in
// tools/flavour-tests.txt, the ones that branch on the flavour or build the flavour's own classes.
// Every other shared test is flavour-neutral and would repeat the play run. checkFlavourTests (below)
// fails when a shared test touches the flavour and is not on that list, so the direct run cannot drop
// coverage unnoticed. Without the property the direct flavour runs everything, as before.
val flavourTestList = layout.projectDirectory.file("tools/flavour-tests.txt")
val flavourModuleDirs = listOf("platform", "android", "../godot/native/android")

fun testClassName(f: File): String {
    val pkg = f.useLines { lines -> lines.firstNotNullOfOrNull { Regex("^package\\s+([\\w.]+)").find(it)?.groupValues?.get(1) } }
    return (if (pkg == null) "" else "$pkg.") + f.nameWithoutExtension
}

fun testClassNames(dir: File): List<String> =
    if (!dir.isDirectory) emptyList() else dir.walkTopDown().filter { it.isFile && it.extension == "kt" }.map(::testClassName).toList()

val directFlavourOnly = providers.gradleProperty("pkey.directFlavourOnly").map { it == "true" }.orElse(false)
subprojects {
    tasks.withType<Test>().matching { it.name == "testDirectDebugUnitTest" && projectDir.relativeTo(rootDir).path in flavourModuleDirs }.configureEach {
        if (directFlavourOnly.get()) {
            val shared = providers.fileContents(flavourTestList).asText.get().lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
            val own = testClassNames(projectDir.resolve("src/testDirect"))
            filter {
                isFailOnNoMatchingTests = false
                // An empty include list would run everything; this pattern matches nothing.
                includeTestsMatching("no.such.Class")
                (shared + own).forEach { includeTestsMatching(it) }
            }
        }
    }
}

val flavourSensitive = Regex(
    "PolarisKeyPlatform\\.(flavor|isPlay|isDirect)|PolarisKeyAndroid\\.flavor|BuildConfig\\.FLAVOR|FlavorAndroid|FLAVOR_(PLAY|DIRECT)" +
        "|\\bCommands\\(|(PlatformIntegrity|PlatformIdentity|PlatformBackup)\\.create\\(|\\.playPacks\\(",
)
tasks.register("checkFlavourTests") {
    group = "verification"
    description = "Fails when a shared test (src/test of :platform, :android, :godot) touches the flavour and is not in tools/flavour-tests.txt, or the list names a class that is gone or no longer flavour-sensitive."
    val testDirs = flavourModuleDirs.map { layout.projectDirectory.dir("$it/src/test").asFile }
    val listFile = flavourTestList.asFile
    val sensitiveRe = flavourSensitive
    inputs.files(listFile)
    testDirs.forEach { inputs.dir(it).optional() }
    doLast {
        // Self-contained: a task action may not hold references to script-level functions or values.
        fun className(f: File): String {
            val pkg = f.useLines { lines -> lines.firstNotNullOfOrNull { Regex("^package\\s+([\\w.]+)").find(it)?.groupValues?.get(1) } }
            return (if (pkg == null) "" else "$pkg.") + f.nameWithoutExtension
        }
        val listed = listFile.readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toSet()
        val sensitive = mutableSetOf<String>()
        val present = mutableSetOf<String>()
        for (dir in testDirs) {
            for (f in dir.walkTopDown().filter { it.isFile && it.extension == "kt" }) {
                val name = className(f)
                present += name
                if (sensitiveRe.containsMatchIn(f.readText())) sensitive += name
            }
        }
        val problems = mutableListOf<String>()
        (sensitive - listed).sorted().forEach { problems += "$it touches the flavour but is not in tools/flavour-tests.txt (the direct flavour would skip it)" }
        (listed - present).sorted().forEach { problems += "tools/flavour-tests.txt names $it, which no shared test defines" }
        (listed - sensitive).intersect(present).sorted().forEach { problems += "tools/flavour-tests.txt names $it, which no longer touches the flavour" }
        if (problems.isNotEmpty()) throw GradleException("flavour test list out of date:\n  " + problems.joinToString("\n  "))
        logger.lifecycle("checkFlavourTests: ${listed.size} shared tests run in both flavours")
    }
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
val jvmModules = listOf(":core", ":license", ":config", ":identity", ":release", ":update", ":packs", ":sdk", ":desktop", ":zstd", ":ui-core", ":server", ":server-ktor", ":spring-boot-starter")
val serviceModules = listOf(":license", ":config", ":identity", ":release", ":update", ":packs")
val checkModuleBoundaries = tasks.register("checkModuleBoundaries") {
    group = "verification"
    description = "Fails when a JVM module reaches Android, a service module reaches a sibling, :platform reaches an SDK module, or a module other than :android sees both :core and :platform."
    val jvmProjects = jvmModules.map { project(it) }
    val serviceProjects = serviceModules.map { project(it) }
    val platformProject = findProject(":platform")
    val uiProject = findProject(":ui")
    val billingProject = findProject(":billing")
    val gamesProject = findProject(":games")
    val androidProject = findProject(":android")
    val everyProject = rootProject.subprojects.toList()
    // The one task that is not configuration-cache compatible: its action walks every project's
    // plugins, configurations and resolved classpaths, which are live Project state the cache cannot
    // store. Requesting it makes Gradle skip the cache for that build; the rest stay cacheable.
    notCompatibleWithConfigurationCache("walks every project's configurations and resolved classpaths at execution time")
    // Resolved from the root project over project dependencies (variant-aware), never through another
    // project's own configuration: under org.gradle.parallel that needs the owner's lock.
    val boundaryConfigs = listOf("api" to Usage.JAVA_API, "runtime" to Usage.JAVA_RUNTIME).map { (label, usage) ->
        label to configurations.detachedConfiguration().also { c ->
            jvmModules.forEach { c.dependencies.add(dependencies.project(mapOf("path" to it))) }
            c.isCanBeConsumed = false
            c.attributes.attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage::class.java, usage))
        }
    }
    doLast {
        val problems = mutableListOf<String>()
        val forbiddenPlugins = listOf("com.android.library", "com.android.application")
        val androidGroup = Regex("^(androidx\\..*|com\\.android\\..*|com\\.google\\.android\\..*)$")
        for ((label, config) in boundaryConfigs) {
            for (component in config.incoming.resolutionResult.allComponents) {
                val id = component.moduleVersion ?: continue
                if (androidGroup.matches(id.group)) problems += "the JVM modules' $label classpath contains $id"
            }
        }
        for (p in jvmProjects) {
            for (id in forbiddenPlugins) {
                if (p.plugins.hasPlugin(id)) problems += "${p.path} applies $id"
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
        for (p in listOfNotNull(uiProject, billingProject, gamesProject)) {
            val forbidden = setOf("platform", "android", "godot", "boundary", "conformance") + if (p == gamesProject) setOf("sdk") else emptySet()
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
                        if (id is org.gradle.api.artifacts.component.ProjectComponentIdentifier && id.build.buildPath == ":") {
                            if (id.projectPath == ":core") seesCore = true
                            if (id.projectPath == ":platform") seesPlatform = true
                        }
                        if (id is org.gradle.api.artifacts.component.ModuleComponentIdentifier && id.group == "im.plrs.key") {
                            if (id.module == "polaris-key-core") seesCore = true
                            if (platformCoordinates.matches(id.module)) seesPlatform = true
                        }
                    }
                }
                if (seesCore && seesPlatform && p.path != ":boundary" && p.path != ":docs-snippets-android" && p.path != ":sample-compose-android") {
                    problems += "${p.path} sees both :core and :platform (only :android may)"
                }
            }
            if (androidProject != null) {
                for (p in everyProject) {
                    if (p == androidProject || p.path == ":boundary" || p.path == ":docs-snippets-android" || p.path == ":sample-compose-android") continue
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
