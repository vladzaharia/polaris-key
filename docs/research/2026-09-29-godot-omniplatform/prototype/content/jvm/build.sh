#!/bin/bash
# Fetches the JVM runner's two libraries from Maven Central (SHA-256 checked) and compiles Runner.java.
# usage: jvm/build.sh      (needs JDK 21: javac and java on PATH)
# Outputs (git-ignored): jvm/lib/{zstd-jni,gson}.jar and jvm/out/*.class.
set -euo pipefail
J=$(cd "$(dirname "$0")" && pwd)
M=https://repo1.maven.org/maven2
mkdir -p "$J/lib" "$J/out"
fetch() { # <file> <url> <sha256>
  [ -f "$J/lib/$1" ] || curl -sSfL -o "$J/lib/$1" "$2"
  echo "$3  $J/lib/$1" | sha256sum -c -
}
fetch zstd-jni.jar $M/com/github/luben/zstd-jni/1.5.7-20/zstd-jni-1.5.7-20.jar \
  b9995fa20dce1007b8c4bead9532776088a44be0a228a2fa71da8d8ce70d797e
fetch gson.jar $M/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar \
  2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f
javac -cp "$J/lib/*" -d "$J/out" "$J/Runner.java"
echo "built; run: java -Xmx4g -cp \"$J/lib/*:$J/out\" Runner <vector-dir> [bench]"
