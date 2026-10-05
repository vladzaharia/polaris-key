#!/usr/bin/env bash
# crane (go-containerregistry) against the OCI feed (F-08): list the tags, resolve the channel
# tags, pull both platforms of the multi-arch image, validate every blob's digest and every
# layer's diff_id, and refuse the yanked tag.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
need crane
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# F-21: against an authenticated feed, log in with the registry token (a throwaway docker config).
if [ -n "${REGISTRY_AUTH:-}" ]; then
  export DOCKER_CONFIG="$tmp/docker"
  mkdir -p "$DOCKER_CONFIG"
  if crane auth login "$HOSTPORT" -u __token__ -p "$PKEY_REGISTRY_TOKEN" >/dev/null 2>&1; then
    ok "crane auth login with the registry token"
  else bad "crane auth login"; fi
fi

if [ "$(crane ls --insecure "$REF" | paste -sd, -)" = "0.8.0,1.0.0,1.1.0-beta.1,beta,latest" ]; then
  ok "crane ls"
else bad "crane ls"; fi
if [ "$(crane digest --insecure "$REF:latest")" = "$(crane digest --insecure "$REF:1.0.0")" ]; then
  ok "crane digest: latest = 1.0.0"
else bad "crane digest"; fi
for platform in linux/amd64 linux/arm64; do
  if crane pull --insecure --platform "$platform" "$REF:latest" "$tmp/img.tar"; then
    ok "crane pull --platform $platform"
  else bad "crane pull --platform $platform"; fi
done
for tag in latest 1.1.0-beta.1 0.8.0; do
  if crane validate --insecure --remote "$REF:$tag" >/dev/null; then ok "crane validate $tag"; else bad "crane validate $tag"; fi
done
if crane digest --insecure "$REF:0.9.0" >/dev/null 2>&1; then bad "the yanked 0.9.0 resolved"; else ok "the yanked 0.9.0 is refused"; fi
exit "$fail"
