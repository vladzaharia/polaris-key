#!/usr/bin/env bash
# Gradle 9.x against the Maven feed (F-07), through exclusiveContent. See jvm/gradle.bash.
exec bash "$(dirname "$0")/jvm/gradle.bash" "${GRADLE9_IMAGE:-gradle:9-jdk21}"
