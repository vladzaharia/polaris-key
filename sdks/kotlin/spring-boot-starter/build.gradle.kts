// polaris-key-spring-boot-starter (proposed coordinates im.plrs.key:polaris-key-spring-boot-starter): the
// Spring Boot starter of the framework drop-ins (SP-61): auto-configuration from `polaris-key.*`
// properties, a Spring Security filter + AuthenticationProvider, per-route AuthorizationManagers, and
// the AuthenticationEntryPoint / AccessDeniedHandler that answer the localized problem body, over :server.
// Spring is `api` where its types are in the public surface, at the versions Boot 3.5 manages (the
// catalog); the tests run on Boot's own BOM.
//
// maven-publish writes to build/repo ONLY (unsigned, no remote repository): Kotlin artifacts reach
// adopters through Polaris Key's own Maven feed (F-07, F-10) and nowhere else.
plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
    `maven-publish`
}

kotlin {
    jvmToolchain(libs.versions.jvmTarget.get().toInt())
    explicitApi()
}

java {
    withSourcesJar()
}

base { archivesName.set("polaris-key-spring-boot-starter") }

dependencies {
    api(project(":server"))
    api(libs.spring.boot.autoconfigure)
    api(libs.spring.security.config)
    api(libs.spring.security.web)
    compileOnly(libs.spring.webmvc)
    compileOnly(libs.spring.test)
    compileOnly(libs.spring.boot.test)
    compileOnly(libs.jakarta.servlet.api)
    testImplementation(testFixtures(project(":core")))
    testImplementation(libs.junit)
    testImplementation(platform(libs.spring.boot.bom))
    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.spring.boot.starter.web)
    testImplementation(libs.spring.boot.starter.security)
    testImplementation(libs.spring.security.test)
}

publishing {
    publications {
        create<MavenPublication>("springBootStarter") {
            from(components["java"])
            artifactId = "polaris-key-spring-boot-starter"
            pom {
                name.set("Polaris Key Spring Boot starter")
                description.set("The Spring Boot starter of the Polaris Key server drop-ins: authenticate and gate routes with the app's signed licence document through Spring Security.")
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

tasks.withType<Test>().configureEach {
    systemProperty("pkey.repoRoot", rootProject.projectDir.resolve("../..").canonicalPath)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
