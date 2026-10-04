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
trap cleanup EXIT

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
