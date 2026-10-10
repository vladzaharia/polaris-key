#!/usr/bin/env bash
# check-feed-download.sh: publish-package.yml's guard that the downloaded workflow artifact is whole.
# actions/download-artifact@v4 has been seen to stall, give up and exit 0 with an empty dist-feed.
# Needs DELIVERABLE, VERSION and SUBDIR (the artifact subdirectory, may be empty) in the environment;
# for a maven.<x> deliverable the POM polaris-key-<x>-<VERSION>.pom must be present, for any other
# one the directory must hold a file.
set -euo pipefail
dir="dist-feed/${SUBDIR:-}"
if [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f -print -quit)" ]; then
  echo "::error::$dir is missing or empty: the artifact download did not complete." >&2
  exit 1
fi
case "$DELIVERABLE" in
  maven.*)
    pom="polaris-key-${DELIVERABLE#maven.}-${VERSION}.pom"
    if [ -z "$(find "$dir" -type f -name "$pom" -print -quit)" ]; then
      echo "::error::$pom is not under $dir: the artifact download is incomplete." >&2
      exit 1
    fi
    ;;
esac
echo "$dir holds the artifact."
