#!/usr/bin/env bash
# docker pull against the OCI feed (F-08): both platforms of the multi-arch `latest`, the beta
# channel tag, and the yanked tag refused. A loopback registry is plain HTTP for dockerd by
# default, so no daemon configuration is needed.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
need docker
cleanup() {
  docker rmi -f "$REF:latest" "$REF:beta" "$REF:0.9.0" >/dev/null 2>&1 || true
}
trap 'cleanup; [ -z "${REGISTRY_AUTH:-}" ] || docker logout "$HOSTPORT" >/dev/null 2>&1 || true' EXIT
# F-21: against an authenticated feed, `docker login` with the registry token (docker then trades
# it at /v2/token for pull tokens); a public feed pulls with anonymous pull tokens.
if [ -n "${REGISTRY_AUTH:-}" ]; then
  if echo "$PKEY_REGISTRY_TOKEN" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null; then
    ok "docker login with the registry token"
  else bad "docker login"; fi
  if echo "pkeyr_$(printf 'x%.0s' {1..43})" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null 2>&1; then
    bad "docker login accepted an unknown token"
  else ok "docker login refuses an unknown token"; fi
  echo "$PKEY_REGISTRY_TOKEN" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null
fi

for platform in linux/amd64 linux/arm64; do
  cleanup
  if docker pull -q --platform "$platform" "$REF:latest" >/dev/null; then
    arch="$(docker image inspect "$REF:latest" --format '{{.Os}}/{{.Architecture}}')"
    if [ "$arch" = "$platform" ]; then ok "docker pull --platform $platform"; else bad "docker pull --platform $platform got $arch"; fi
  else bad "docker pull --platform $platform"; fi
done
if docker pull -q "$REF:beta" >/dev/null; then ok "docker pull :beta"; else bad "docker pull :beta"; fi
if docker pull -q "$REF:0.9.0" >/dev/null 2>&1; then bad "the yanked 0.9.0 pulled"; else ok "the yanked 0.9.0 is refused"; fi
exit "$fail"
