#!/usr/bin/env bash
# One personal token over two owners, with docker (F-33b.6, plans/F-33b-ST-30c-slices.md §2).
# `run.mjs --person` seeded the owners acme, bolt and cove (OCI feeds, `licensed`), one account
# with a usable licence in acme and in bolt and none in cove, and a `pkeyp_` `packages:read` token
# for it (PKEY_PERSON_TOKEN). One `docker login`, then a pull from each owner it holds a licence
# in; cove answers 403 DENIED. The token is never echoed: it goes to docker on stdin and to curl
# in a config file.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
: "${PKEY_PERSON_TOKEN:?PKEY_PERSON_TOKEN is the personal token (run.mjs --person)}"
need docker
REFS=("$HOSTPORT/acme/tools/smoke:latest" "$HOSTPORT/bolt/tools/smoke:latest")
cleanup() {
  docker rmi -f "${REFS[@]}" >/dev/null 2>&1 || true
  docker logout "$HOSTPORT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if echo "$PKEY_PERSON_TOKEN" | docker login "$HOSTPORT" -u __token__ --password-stdin >/dev/null; then
  ok "one docker login with the personal token"
else bad "docker login with the personal token"; fi

for ref in "${REFS[@]}"; do
  if docker pull -q --platform linux/amd64 "$ref" >/dev/null; then ok "docker pull ${ref#"$HOSTPORT"/}"; else bad "docker pull ${ref#"$HOSTPORT"/}"; fi
done

# cove: no licence for this account. docker fails, and the registry's own answer is 403 DENIED
# (at the token exchange, where an OCI client is told what it may pull).
if docker pull -q --platform linux/amd64 "$HOSTPORT/cove/tools/smoke:latest" >/dev/null 2>&1; then
  bad "docker pulled from cove, where the account holds no licence"
else ok "docker pull from cove is refused"; fi
cfg="$(mktemp)"
trap 'rm -f "$cfg"; cleanup' EXIT
printf 'header = "Authorization: Basic %s"\n' "$(printf '__token__:%s' "$PKEY_PERSON_TOKEN" | base64 | tr -d '\n')" >"$cfg"
for o in acme bolt cove; do
  body="$(curl -sS -w '\n%{http_code}' --config "$cfg" \
    "$REGISTRY/v2/token?service=${HOSTPORT%:*}&scope=repository:$o/tools/smoke:pull")"
  code="${body##*$'\n'}"
  if [ "$o" = cove ]; then
    if [ "$code" = 403 ] && grep -q DENIED <<<"$body"; then ok "cove: the pull token is refused, 403 DENIED"; else bad "cove: pull token answered $code, not 403 DENIED"; fi
  elif [ "$code" = 200 ]; then ok "$o: the pull token is granted"; else bad "$o: pull token answered $code"; fi
done
unset body
exit "$fail"
