#!/usr/bin/env bash
# Maven 3.9 against the Maven feed (F-07, plans/F-01.md §6.8), in the official container with
# host networking (IPv4 only: some Docker hosts forward loopback for IPv4 sockets alone), with checksum policy `fail` (`-C` and the repository's own policy), so every
# file must arrive with a matching sidecar. One consumer POM, resolved once per version spec:
#   - the exact version, whose jar must match the feed's .sha256 sidecar;
#   - RELEASE (the `stable` channel head, `<release>`) → 1.0.0, never the yanked 1.1.0;
#   - LATEST (the newest listed version, `<latest>`) → 1.2.0-beta.1;
#   - a range only 1.0.0 and the yanked 1.1.0 satisfy → 1.0.0;
#   - a range only the yanked version satisfies → resolution fails;
#   - the yanked version pinned exactly → still resolves.
# Maven Central stays configured for Maven's own plugins only; nothing is ever published.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
image="${MAVEN_IMAGE:-maven:3.9-eclipse-temurin-21}"
feed="$REGISTRY/maven/$OWNER/"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/pom.xml" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>feed-consumer</artifactId>
  <version>1</version>
  <packaging>pom</packaging>
  <repositories>
    <repository>
      <id>polaris-key-fixture</id>
      <url>$feed</url>
      <releases><checksumPolicy>fail</checksumPolicy></releases>
      <snapshots><enabled>false</enabled></snapshots>
    </repository>
  </repositories>
  <dependencies>
    <dependency>
      <groupId>im.plrs.fixture</groupId>
      <artifactId>demo</artifactId>
      <version>\${demo.version}</version>
    </dependency>
  </dependencies>
</project>
POM

# Everything that touches the local repository runs inside one container: on some Docker hosts a
# directory tree the host rewrites under a bind mount cannot be extended from the container.
cat > "$work/specs.sh" <<'SH'
set -u
# Maven's plugins land in /work/base on the first run; each spec then resolves against a copy
# of it without the fixture's files, so the version it picks comes from the feed's metadata.
mkdir -p /work/base
for entry in "pinned 1.0.0" "release RELEASE" "latest LATEST" "range [1.0,1.1.99]" \
             "yankedOnlyRange [1.1,1.1.99]" "yankedPinned 1.1.0"; do
  label="${entry%% *}"
  spec="${entry#* }"
  rm -rf /work/repo && cp -a /work/base /work/repo && rm -rf /work/repo/im
  if mvn -B -q -C -Dmaven.repo.local=/work/repo "-Ddemo.version=$spec" \
      dependency:list "-DoutputFile=/work/list-$label.txt" -DexcludeTransitive=true \
      > "/work/log-$label.txt" 2>&1; then
    v="$(grep -o 'im.plrs.fixture:demo:jar:[^:]*' "/work/list-$label.txt" | head -1 | cut -d: -f4)"
    jar="/work/repo/im/plrs/fixture/demo/$v/demo-$v.jar"
    echo "MVN $label RESOLVED $v $(sha256sum "$jar" | cut -d' ' -f1)"
  else
    echo "MVN $label FAILED"
  fi
  # Keep the plugins the first run downloaded.
  if [ "$label" = pinned ]; then rm -rf /work/base && cp -a /work/repo /work/base; fi
done
SH

# As the invoking user (so the host can remove what it writes), with a home of its own.
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/work \
  -e JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true \
  -e MAVEN_CONFIG=/work/.m2 -v "$work:/work" -w /work "$image" \
  bash /work/specs.sh | tee "$work/out.txt"

fail=0
expect() { # expect <label> <RESOLVED version | FAILED>
  local line
  line="$(grep "^MVN $1 " "$work/out.txt" || true)"
  if [[ "$line" == "MVN $1 $2"* ]]; then echo "ok   $1 → $2"
  else
    echo "FAIL $1: want $2, got: $line"
    tail -30 "$work/log-$1.txt" 2>/dev/null || true
    fail=1
  fi
}
expect pinned "RESOLVED 1.0.0"
expect release "RESOLVED 1.0.0"
expect latest "RESOLVED 1.2.0-beta.1"
expect range "RESOLVED 1.0.0"
expect yankedPinned "RESOLVED 1.1.0"
expect yankedOnlyRange "FAILED"
# A range only the yanked version satisfies fails for want of a version, not for anything else.
grep -q "No versions available for im.plrs.fixture:demo:jar:\[1.1,1.1.99\]" \
  "$work/log-yankedOnlyRange.txt" ||
  { echo "FAIL yankedOnlyRange failed for another reason"; tail -30 "$work/log-yankedOnlyRange.txt"; fail=1; }

# Integrity: the jar Maven verified (checksum policy fail) is the one the feed's sidecar names.
sum="$(grep '^MVN pinned RESOLVED' "$work/out.txt" | cut -d' ' -f5)"
want="$(curl -fsS "${feed}im/plrs/fixture/demo/1.0.0/demo-1.0.0.jar.sha256")"
if [ -n "$sum" ] && [ "$sum" = "$want" ]; then echo "ok   demo-1.0.0.jar sha256 matches the sidecar"
else echo "FAIL demo-1.0.0.jar: $sum != $want"; fail=1; fi
exit "$fail"
