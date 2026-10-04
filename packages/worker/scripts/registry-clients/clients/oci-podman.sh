#!/usr/bin/env bash
# podman pull against the OCI feed (F-08): both platforms of the multi-arch `latest`, the beta
# channel tag, and the yanked tag refused. A throwaway image store keeps the runner's clean.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
need podman
store="$(mktemp -d)"
p() { podman --root "$store/root" --runroot "$store/run" "$@"; }
trap 'p rmi -af >/dev/null 2>&1 || true; rm -rf "$store" 2>/dev/null || true' EXIT
# F-21: against an authenticated feed, log in with the registry token (a throwaway auth file).
if [ -n "${REGISTRY_AUTH:-}" ]; then
  export REGISTRY_AUTH_FILE="$store/auth.json"
  if echo "$PKEY_REGISTRY_TOKEN" | p login --tls-verify=false -u __token__ --password-stdin "$HOSTPORT" >/dev/null; then
    ok "podman login with the registry token"
  else bad "podman login"; fi
fi

for platform in linux/amd64 linux/arm64; do
  p rmi -af >/dev/null 2>&1 || true
  if p pull -q --tls-verify=false --platform "$platform" "$REF:latest" >/dev/null; then
    arch="$(p image inspect "$REF:latest" --format '{{.Os}}/{{.Architecture}}')"
    if [ "$arch" = "$platform" ]; then ok "podman pull --platform $platform"; else bad "podman pull --platform $platform got $arch"; fi
  else bad "podman pull --platform $platform"; fi
done
if p pull -q --tls-verify=false "$REF:beta" >/dev/null; then ok "podman pull :beta"; else bad "podman pull :beta"; fi
if p pull -q --tls-verify=false "$REF:0.9.0" >/dev/null 2>&1; then bad "the yanked 0.9.0 pulled"; else ok "the yanked 0.9.0 is refused"; fi
exit "$fail"
