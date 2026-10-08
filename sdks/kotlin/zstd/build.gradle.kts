// polaris-key-zstd (im.plrs.key:polaris-key-zstd): the native zstd decoder the pack engine uses, as an
// opt-in (SP-50). :packs links zstd-jni compileOnly, so an app that does not add this artifact
// carries no native library at all (an APK without packs has no libzstd-jni) and `supports()` answers
// the registry's `dependency` N/A for packs.apply.delta. Adding it is one line on every platform:
//
//     implementation("im.plrs.key:polaris-key-zstd:<version>")
//
// The artifact holds no code. Its Gradle module metadata carries one variant per JVM environment
// (`org.gradle.jvm.environment`, which the Android Gradle Plugin requests as `android`):
//
//   standard-jvm   com.github.luben:zstd-jni:<zstdJni>          the JAR with the desktop natives
//   android        com.github.luben:zstd-jni:<zstdJniAndroid>@aar  the Android AAR, 16 KB page aligned
//
// so no consumer needs an exclude: Gradle picks the AAR for an Android build and the JAR for a JVM
// one. The Android AAR stays at 1.5.7-12 because every AAR from 1.5.7-13 on declares minCompileSdk 37
// (gradle/libs.versions.toml). The POM, for Maven, names the JAR. Published to build/repo only.
plugins {
    `java-library`
    `maven-publish`
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.jvmTarget.get().toInt())) }
}

base { archivesName.set("polaris-key-zstd") }

val jvmEnvironment = TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE
val kotlinPlatform = Attribute.of("org.jetbrains.kotlin.platform.type", String::class.java)

dependencies {
    // The JVM variant (the java component's own apiElements / runtimeElements).
    runtimeOnly(libs.zstd.jni)
}

configurations.named("apiElements") { attributes.attribute(jvmEnvironment, objects.named(TargetJvmEnvironment.STANDARD_JVM)) }
configurations.named("runtimeElements") { attributes.attribute(jvmEnvironment, objects.named(TargetJvmEnvironment.STANDARD_JVM)) }

// The Android variant: the same (empty) jar, depending on zstd-jni's AAR.
val androidZstd: Configuration by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = false
}
dependencies {
    androidZstd(libs.zstd.jni.android) {
        artifact {
            name = "zstd-jni"
            type = "aar"
            extension = "aar"
        }
    }
}

fun androidVariant(name: String, usage: String) = configurations.create(name) {
    isCanBeConsumed = true
    isCanBeResolved = false
    if (usage == Usage.JAVA_RUNTIME) extendsFrom(androidZstd)
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(usage))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
        attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
        attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
        attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, libs.versions.jvmTarget.get().toInt())
        attribute(jvmEnvironment, objects.named(TargetJvmEnvironment.ANDROID))
        attribute(kotlinPlatform, "androidJvm")
    }
    outgoing.artifact(tasks.named("jar"))
}

val androidApiElements = androidVariant("androidApiElements", Usage.JAVA_API)
val androidRuntimeElements = androidVariant("androidRuntimeElements", Usage.JAVA_RUNTIME)

val javaComponent = components["java"] as AdhocComponentWithVariants
// For Gradle the variants pick the artifact; for Maven the POM's JAR is the dependency and the AAR
// is listed optional (Maven ignores it).
javaComponent.addVariantsFromConfiguration(androidApiElements) { mapToOptional() }
javaComponent.addVariantsFromConfiguration(androidRuntimeElements) { mapToOptional() }

publishing {
    publications {
        create<MavenPublication>("zstd") {
            from(components["java"])
            artifactId = "polaris-key-zstd"
            suppressPomMetadataWarningsFor("androidApiElements")
            suppressPomMetadataWarningsFor("androidRuntimeElements")
            pom {
                name.set("Polaris Key zstd (Kotlin)")
                description.set(
                    "The native zstd decoder for the Polaris Key pack engine: zstd-jni's JAR on a JVM, its 16 KB-aligned AAR on Android.",
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
