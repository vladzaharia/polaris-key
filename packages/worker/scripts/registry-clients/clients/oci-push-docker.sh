#!/usr/bin/env bash
# docker push against the OCI feed (F-23): log in with a publish token, build and push a version,
# pull it back by tag and by digest, and refuse what a version tag forbids: a channel tag
# (`latest`), a second image under a taken version, and a push without a publish token.
set -euo pipefail
. "$(dirname "$0")/oci-push.inc"
need docker
work="$(mktemp -d)"
cleanup() {
  docker rmi -f "$PUSH_REF:1.0.0" "$PUSH_REF:latest" "$PUSH_REF:1.0.0-other" >/dev/null 2>&1 || true
  docker logout "$HOSTPORT" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Without a publish token: an anonymous push is refused.
printf 'FROM scratch\nCOPY hello.txt /hello.txt\n' >"$work/Dockerfile"
echo "pushed by docker (F-23)" >"$work/hello.txt"
docker build -q -t "$PUSH_REF:1.0.0" "$work" >/dev/null
if docker push -q "$PUSH_REF:1.0.0" >/dev/null 2>&1; then bad "an anonymous docker push was accepted"; else ok "an anonymous docker push is refused"; fi
# A read-only token cannot push either (F-21's header token in --auth mode).
if [ -n "${REGISTRY_AUTH:-}" ]; then
  echo "$PKEY_REGISTRY_TOKEN" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null
  if docker push -q "$PUSH_REF:1.0.0" >/dev/null 2>&1; then bad "a read token pushed"; else ok "a read token cannot push"; fi
fi

if echo "$PKEY_REGISTRY_PUSH_TOKEN" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null; then
  ok "docker login with the publish token"
else bad "docker login with the publish token"; fi
if out="$(docker push "$PUSH_REF:1.0.0" 2>&1)"; then ok "docker push :1.0.0"; else
  bad "docker push :1.0.0"
  echo "$out" | tail -5
fi
local_digest="$(docker image inspect "$PUSH_REF:1.0.0" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//')"
remote_digest="$(digest_of_name "$PUSH_NAME" 1.0.0)"
if [ -n "$remote_digest" ] && [ "$local_digest" = "$remote_digest" ]; then ok "the pushed digest is served by tag"; else bad "digest $local_digest vs $remote_digest"; fi
# The version joins the product's channels like a ticket publish without --channel: the newest
# stable version is `latest` (and heads `beta` while no beta is newer).
if [ "$(tags_of "$PUSH_NAME")" = "1.0.0,beta,latest" ]; then ok "tags/list: 1.0.0 and its channel tags"; else bad "tags/list: $(tags_of "$PUSH_NAME")"; fi

docker rmi -f "$PUSH_REF:1.0.0" >/dev/null
if docker pull -q "$PUSH_REF:1.0.0" >/dev/null && docker pull -q "$PUSH_REF@$remote_digest" >/dev/null; then
  ok "docker pull the pushed version by tag and digest"
else bad "docker pull the pushed version"; fi

# A channel tag is never pushed; a taken version never moves.
docker tag "$PUSH_REF:1.0.0" "$PUSH_REF:latest"
if docker push -q "$PUSH_REF:latest" >/dev/null 2>&1; then bad "a push of :latest was accepted"; else ok "a push of :latest is refused"; fi
echo "another image" >"$work/hello.txt"
docker build -q -t "$PUSH_REF:1.0.0-other" "$work" >/dev/null
docker tag "$PUSH_REF:1.0.0-other" "$PUSH_REF:1.0.0"
if docker push -q "$PUSH_REF:1.0.0" >/dev/null 2>&1; then bad "a second image under 1.0.0 was accepted"; else ok "a taken version refuses another image"; fi
exit "$fail"
