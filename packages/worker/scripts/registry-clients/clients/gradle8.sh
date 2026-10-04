#!/usr/bin/env bash
# Gradle 8.x against the Maven feed (F-07), through exclusiveContent. See jvm/gradle.bash.
exec bash "$(dirname "$0")/jvm/gradle.bash" "${GRADLE8_IMAGE:-gradle:8-jdk21}"
