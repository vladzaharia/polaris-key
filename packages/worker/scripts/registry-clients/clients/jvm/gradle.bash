#!/usr/bin/env bash
# Gradle against the Maven feed (F-07, plans/F-01.md §6.8), in a container: the official image
# named by $1, with host networking so it reaches the harness's Worker on 127.0.0.1.
#
# The consumer routes `im.plrs.fixture` to the feed ONLY (`exclusiveContent`, the
# dependency-confusion guard the setup page recommends) and resolves, in one build:
#   - an exact version, whose files must match the feed's own .sha256 sidecars;
#   - a dynamic version (`1.+`) and `latest.release`, which must never pick the yanked 1.1.0;
#   - a range only the yanked version and 1.0.0 satisfy, which must pick 1.0.0;
#   - the yanked version pinned exactly, which must still resolve (pinned builds keep working);
#   - the `.module` (Gradle module metadata) path: the fixture POM carries Gradle's marker, so
#     Gradle reads the variants from `demo-<v>.module` and fails if it is not served.
# REGISTRY and OWNER come from run.mjs.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
image="$1"
feed="$REGISTRY/maven/$OWNER/"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/settings.gradle.kts" <<'KTS'
rootProject.name = "feed-consumer"
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    url = uri(System.getenv("FEED"))
                    isAllowInsecureProtocol = true // the harness's Worker is plain HTTP on loopback
                }
            }
            filter { includeGroupAndSubgroups("im.plrs.fixture") }
        }
    }
}
KTS
cat > "$work/build.gradle.kts" <<'KTS'
import java.security.MessageDigest
import org.gradle.api.artifacts.result.ResolvedDependencyResult

val notations = listOf(
    "pinned" to "im.plrs.fixture:demo:1.0.0",
    "dynamic" to "im.plrs.fixture:demo:1.+",
    "latestRelease" to "im.plrs.fixture:demo:latest.release",
    "range" to "im.plrs.fixture:demo:[1.0,1.1.99]",
    "yankedPinned" to "im.plrs.fixture:demo:1.1.0",
    "yankedOnlyRange" to "im.plrs.fixture:demo:[1.1,1.1.99]",
)

fun sha256(f: File): String =
    MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }

tasks.register("feed") {
    doLast {
        for ((label, notation) in notations) {
            val conf = project.configurations.detachedConfiguration(project.dependencies.create(notation))
            conf.isTransitive = false
            conf.attributes {
                attribute(Usage.USAGE_ATTRIBUTE, project.objects.named(Usage::class.java, Usage.JAVA_RUNTIME))
            }
            val dep = conf.incoming.resolutionResult.root.dependencies.firstOrNull()
            if (dep is ResolvedDependencyResult) {
                val files = conf.incoming.artifactView { lenient(false) }.files.files
                val sums = files.joinToString(" ") { "${it.name}=${sha256(it)}" }
                println("FEED $label RESOLVED ${dep.selected.moduleVersion?.version} $sums")
            } else {
                println("FEED $label UNRESOLVED")
            }
        }
    }
}
KTS

out="$work/out.txt"
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/work \
  -e JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true \
  -e GRADLE_USER_HOME=/work/.gradle -e FEED="$feed" -v "$work:/work" -w /work "$image" \
  gradle --no-daemon --no-configuration-cache -q feed | tee "$out"

fail=0
expect() { # expect <label> <RESOLVED version | UNRESOLVED>
  local line
  line="$(grep "^FEED $1 " "$out" || true)"
  if [[ "$line" == "FEED $1 $2"* ]]; then echo "ok   $1 → $2"; else echo "FAIL $1: want $2, got: $line"; fail=1; fi
}
expect pinned "RESOLVED 1.0.0"
expect dynamic "RESOLVED 1.2.0-beta.1"
expect latestRelease "RESOLVED 1.0.0"
expect range "RESOLVED 1.0.0"
expect yankedPinned "RESOLVED 1.1.0"
expect yankedOnlyRange "UNRESOLVED"

# Integrity: what Gradle downloaded is what the feed's sidecars say.
for pair in $(grep '^FEED pinned RESOLVED' "$out" | cut -d' ' -f5-); do
  name="${pair%%=*}"
  sum="${pair#*=}"
  want="$(curl -fsS "${feed}im/plrs/fixture/demo/1.0.0/$name.sha256")"
  if [ "$sum" = "$want" ]; then echo "ok   $name sha256 matches the sidecar"; else echo "FAIL $name: $sum != $want"; fail=1; fi
done
grep -q '^FEED pinned RESOLVED 1.0.0 demo-1.0.0.jar=' "$out" || { echo "FAIL pinned: no jar"; fail=1; }
exit "$fail"
