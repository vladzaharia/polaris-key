#!/usr/bin/env bash
# crane (go-containerregistry) push against the OCI feed (F-23): push a version built from a
# layer tarball (streamed PATCH), copy a multi-arch image index in by digest and tag, validate
# both remotely, and refuse a channel tag.
set -euo pipefail
. "$(dirname "$0")/oci-push.inc"
need crane
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export DOCKER_CONFIG="$work/docker"
mkdir -p "$DOCKER_CONFIG"
REPO2="$HOSTPORT/$OWNER/tools/pushed-crane"
if crane auth login "$HOSTPORT" -u __token__ -p "$PKEY_REGISTRY_PUSH_TOKEN" >/dev/null 2>&1; then
  ok "crane auth login with the publish token"
else bad "crane auth login"; fi

# A 6 MiB layer: above R2's part floor, so the upload's part fitting runs for real.
mkdir -p "$work/root"
head -c 6291456 /dev/urandom >"$work/root/blob.bin"
tar -C "$work/root" -cf "$work/layer.tar" blob.bin
if crane append --insecure -f "$work/layer.tar" -t "$REPO2:2.0.0" >/dev/null; then ok "crane append (push) :2.0.0"; else bad "crane append :2.0.0"; fi
if crane validate --insecure --remote "$REPO2:2.0.0" >/dev/null; then ok "crane validate the pushed version"; else bad "crane validate :2.0.0"; fi
# A multi-arch index: the seeded 1.0.0 from tools/smoke, copied under a new version.
if crane copy --insecure "$REF:1.0.0" "$REPO2:3.0.0" >/dev/null; then ok "crane copy a multi-arch index"; else bad "crane copy"; fi
for platform in linux/amd64 linux/arm64; do
  if crane validate --insecure --remote --platform "$platform" "$REPO2:3.0.0" >/dev/null 2>&1 || crane manifest --insecure --platform "$platform" "$REPO2:3.0.0" >/dev/null; then
    ok "crane reads $platform of the copied index"
  else bad "crane $platform of the copied index"; fi
done
if [ "$(crane digest --insecure "$REPO2:3.0.0")" = "$(crane digest --insecure "$REF:1.0.0")" ]; then ok "the copied index keeps its digest"; else bad "the copied index changed digest"; fi
if crane tag --insecure "$REPO2:2.0.0" beta >/dev/null 2>&1; then bad "crane tag beta was accepted"; else ok "a channel tag (beta) is refused"; fi
exit "$fail"
