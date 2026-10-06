#!/usr/bin/env bash
# Gradle `maven-publish` into the Maven feed (F-22), in the official Gradle container (as
# jvm/gradle.bash): a `java-library` publishes im.plrs.fixture:published-gradle 1.0.0 (jar, POM,
# Gradle module metadata, checksums, then maven-metadata.xml), and a second build resolves it back
# through exclusiveContent. REGISTRY, OWNER and PKEY_REGISTRY_PUBLISH_TOKEN come from run.mjs.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${PKEY_REGISTRY_PUBLISH_TOKEN:?run.mjs mints the publish token}"
image="${GRADLE_IMAGE:-gradle:9-jdk21}"
feed="$REGISTRY/maven/$OWNER/"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/lib/src/main/java/im/plrs/fixture" "$work/app"
cat > "$work/lib/settings.gradle.kts" <<'KTS'
rootProject.name = "published-gradle"
KTS
cat > "$work/lib/build.gradle.kts" <<'KTS'
plugins { `java-library`; `maven-publish` }
group = "im.plrs.fixture"
version = "1.0.0"
publishing {
    publications { create<MavenPublication>("lib") { from(components["java"]) } }
    repositories {
        maven {
            name = "polarisKey"
            url = uri(System.getenv("FEED"))
            isAllowInsecureProtocol = true // the harness's Worker is plain HTTP on loopback
            credentials {
                username = "__token__"
                password = System.getenv("PKEY_REGISTRY_PUBLISH_TOKEN")
            }
        }
    }
}
KTS
printf 'package im.plrs.fixture;\npublic final class Published { public static String version() { return "1.0.0"; } }\n' \
  > "$work/lib/src/main/java/im/plrs/fixture/Published.java"
cat > "$work/app/settings.gradle.kts" <<'KTS'
rootProject.name = "consumer"
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    url = uri(System.getenv("FEED"))
                    isAllowInsecureProtocol = true
                    credentials {
                        username = "__token__"
                        password = System.getenv("READ_TOKEN")
                    }
                }
            }
            filter { includeGroup("im.plrs.fixture") }
        }
    }
}
KTS
cat > "$work/app/build.gradle.kts" <<'KTS'
plugins { java }
dependencies { implementation("im.plrs.fixture:published-gradle:1.0.0") }
tasks.register("resolved") {
    doLast { configurations["runtimeClasspath"].files.forEach { println("RESOLVED " + it.name) } }
}
KTS
run_gradle() { # run_gradle <dir> <task>
  docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/work -e GRADLE_USER_HOME=/work/.gradle \
    -e FEED="$feed" -e PKEY_REGISTRY_PUBLISH_TOKEN -e READ_TOKEN="${PKEY_REGISTRY_TOKEN:-$PKEY_REGISTRY_PUBLISH_TOKEN}" \
    -e JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true -v "$work:/work" -w "/work/$1" "$image" \
    gradle -q --no-daemon "$2"
}
fail=0
if run_gradle lib publish >"$work/publish.log" 2>&1; then echo "ok   gradle publish"
else tail -30 "$work/publish.log"; echo "FAIL gradle publish"; fail=1; fi
if run_gradle app resolved >"$work/resolve.log" 2>&1 && grep -q "RESOLVED published-gradle-1.0.0.jar" "$work/resolve.log"; then
  echo "ok   the published version resolves through exclusiveContent"
else tail -30 "$work/resolve.log"; echo "FAIL the published version did not resolve"; fail=1; fi
exit "$fail"
