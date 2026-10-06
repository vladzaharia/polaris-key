#!/usr/bin/env bash
# `mvn deploy:deploy-file` into the Maven feed (F-22), then the published artifact resolved back with
# checksum policy `fail`, in the official Maven container (as maven.sh). The deploy PUTs the jar,
# the POM, their checksum sidecars and, last, maven-metadata.xml, which publishes the version.
# Then: a second deploy of the same version is refused; a deploy without credentials is refused.
# REGISTRY, OWNER and PKEY_REGISTRY_PUBLISH_TOKEN come from run.mjs.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${PKEY_REGISTRY_PUBLISH_TOKEN:?run.mjs mints the publish token}"
image="${MAVEN_IMAGE:-maven:3.9-eclipse-temurin-21}"
feed="$REGISTRY/maven/$OWNER/"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
read_token="${PKEY_REGISTRY_TOKEN:-$PKEY_REGISTRY_PUBLISH_TOKEN}"
cat > "$work/settings.xml" <<XML
<settings>
  <servers>
    <server><id>polaris-key</id><username>__token__</username><password>$PKEY_REGISTRY_PUBLISH_TOKEN</password></server>
    <server><id>polaris-key-read</id><username>__token__</username><password>$read_token</password></server>
  </servers>
</settings>
XML
cat > "$work/consumer.xml" <<POM
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId><artifactId>consumer</artifactId><version>1</version><packaging>pom</packaging>
  <repositories><repository><id>polaris-key-read</id><url>$feed</url>
    <releases><checksumPolicy>fail</checksumPolicy></releases><snapshots><enabled>false</enabled></snapshots>
  </repository></repositories>
  <dependencies><dependency><groupId>im.plrs.fixture</groupId><artifactId>published</artifactId><version>1.0.0</version></dependency></dependencies>
</project>
POM
cat > "$work/run.sh" <<SH
set -u
mkdir -p /work/src/p && echo "maven-publish fixture" > /work/src/p/README.txt
(cd /work/src && jar cf /work/published-1.0.0.jar p) 2>/dev/null || (cd /work/src && zip -qr /work/published-1.0.0.jar p)
deploy() { mvn -B -q -s /work/settings.xml -Dmaven.repo.local=/work/repo deploy:deploy-file \
  -Durl=$feed -DrepositoryId=\$1 -Dfile=/work/published-1.0.0.jar \
  -DgroupId=im.plrs.fixture -DartifactId=published -Dversion=1.0.0 -Dpackaging=jar; }
deploy polaris-key > /work/deploy.log 2>&1 && echo "MVN deploy OK" || echo "MVN deploy FAILED"
deploy polaris-key > /work/again.log 2>&1 && echo "MVN again OK" || echo "MVN again FAILED"
deploy nobody > /work/anon.log 2>&1 && echo "MVN anon OK" || echo "MVN anon FAILED"
rm -rf /work/repo/im
mvn -B -q -C -s /work/settings.xml -Dmaven.repo.local=/work/repo -f /work/consumer.xml \
  dependency:list -DoutputFile=/work/list.txt > /work/resolve.log 2>&1 && echo "MVN resolve OK" || echo "MVN resolve FAILED"
SH
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/work \
  -e JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true \
  -e MAVEN_CONFIG=/work/.m2 -v "$work:/work" -w /work "$image" bash /work/run.sh | tee "$work/out.txt"
fail=0
want() { if grep -q "^MVN $1 $2" "$work/out.txt"; then echo "ok   $1 → $2"; else echo "FAIL $1: want $2"; tail -30 "$work/$1.log" 2>/dev/null || true; fail=1; fi; }
want deploy OK
want again FAILED
want anon FAILED
want resolve OK
exit "$fail"
