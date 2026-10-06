#!/usr/bin/env bash
# The OCI distribution-spec conformance suite, push workflow (F-23), against a declared, empty
# repository, authenticating with the publish token. Built from distribution-spec v1.1.1 with
# `go` unless OCI_CONFORMANCE names a built binary. Content management (delete) stays off: the
# registry never deletes.
set -euo pipefail
. "$(dirname "$0")/oci-push.inc"
bin="${OCI_CONFORMANCE:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -z "$bin" ]; then
  need go
  git clone -q --depth 1 --branch v1.1.1 https://github.com/opencontainers/distribution-spec.git "$work/ds"
  (cd "$work/ds/conformance" && go test -c -o "$work/conformance.test")
  bin="$work/conformance.test"
fi
mkdir -p "$work/report"
OCI_ROOT_URL="$REGISTRY" OCI_NAMESPACE="$OWNER/tools/conformance" \
  OCI_CROSSMOUNT_NAMESPACE="$OWNER/tools/conformance-mount" \
  OCI_USERNAME=__token__ OCI_PASSWORD="$PKEY_REGISTRY_PUSH_TOKEN" \
  OCI_TEST_PUSH=1 OCI_HIDE_SKIPPED_WORKFLOWS=1 OCI_REPORT_DIR="$work/report" "$bin"
