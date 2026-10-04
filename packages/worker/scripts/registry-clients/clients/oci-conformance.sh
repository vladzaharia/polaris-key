#!/usr/bin/env bash
# The OCI distribution-spec conformance suite, pull workflow (F-08), against the seeded
# repository. The suite is a Go test binary: OCI_CONFORMANCE names a built one, else it is built
# here from distribution-spec v1.1.1 with `go`. Its pull setup (which pushes) is skipped by naming
# the seeded tag, manifest and blob, because the feed takes no pushes.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
bin="${OCI_CONFORMANCE:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -z "$bin" ]; then
  need go
  git clone -q --depth 1 --branch v1.1.1 https://github.com/opencontainers/distribution-spec.git "$work/ds"
  (cd "$work/ds/conformance" && go test -c -o "$work/conformance.test")
  bin="$work/conformance.test"
fi
manifest="$(digest_of 1.1.0-beta.1)"
blob="$(curl -fsS "$REGISTRY/v2/$NAME/manifests/1.1.0-beta.1" | json_field config.digest)"
mkdir -p "$work/report"
OCI_ROOT_URL="$REGISTRY" OCI_NAMESPACE="$NAME" OCI_TEST_PULL=1 \
  OCI_TAG_NAME=1.1.0-beta.1 OCI_MANIFEST_DIGEST="$manifest" OCI_BLOB_DIGEST="$blob" \
  OCI_HIDE_SKIPPED_WORKFLOWS=1 OCI_REPORT_DIR="$work/report" "$bin"
