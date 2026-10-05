#!/usr/bin/env bash
# The OCI pull contract over real HTTP (F-08, plans/F-01.md §6.7 and §6.8), with curl: the tag
# list and its pagination, manifests by tag and by digest with their headers, Range on blobs, the
# yank and channel-tag rules, the reserved token endpoint and the refused push.
set -euo pipefail
. "$(dirname "$0")/oci.inc"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# F-21: against an authenticated feed (run.mjs --auth) every answer is private and uncached; curl
# sends the registry token through CURL_HOME's .curlrc.
if [ -n "${REGISTRY_AUTH:-}" ]; then
  INDEX_CC='private, no-store'
  IMMUTABLE_CC='private, no-store'
else
  INDEX_CC='public, max-age=60, stale-while-revalidate=60'
  IMMUTABLE_CC='public, max-age=31536000, immutable'
fi

tags="$(curl -fsS "$REGISTRY/v2/$NAME/tags/list" | tr -d '\n')"
if [ "$tags" = "{\"name\":\"$NAME\",\"tags\":$EXPECTED_TAGS}" ]; then ok "tags/list"; else bad "tags/list: $tags"; fi

curl -fsS -D "$tmp/h" -o "$tmp/b" "$REGISTRY/v2/$NAME/tags/list?n=2"
if grep -qiF "link: </v2/$NAME/tags/list?n=2&last=1.0.0>; rel=\"next\"" "$tmp/h" &&
  grep -qF '"tags":["0.8.0","1.0.0"]' "$tmp/b"; then
  ok "tags/list?n=2 links the next page"
else bad "tags/list pagination"; fi

latest="$(digest_of latest)"
if [ -n "$latest" ] && [ "$latest" = "$(digest_of 1.0.0)" ]; then ok "latest = 1.0.0 ($latest)"; else bad "latest"; fi
if [ "$(digest_of beta)" = "$(digest_of 1.1.0-beta.1)" ]; then ok "beta = 1.1.0-beta.1"; else bad "beta"; fi

curl -fsS -D "$tmp/h" -o "$tmp/b" -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "$REGISTRY/v2/$NAME/manifests/latest"
if grep -qi '^content-type: application/vnd.oci.image.index.v1+json' "$tmp/h" &&
  grep -qi "^cache-control: $INDEX_CC" "$tmp/h" &&
  grep -qi '^docker-distribution-api-version: registry/2.0' "$tmp/h" &&
  grep -qi '^x-content-type-options: nosniff' "$tmp/h" &&
  [ "$(sha256_of "$tmp/b")" = "$latest" ]; then
  ok "manifest by tag: its type, index caching, the digest of its body"
else bad "manifest by tag"; fi

curl -fsS -D "$tmp/h" -o /dev/null "$REGISTRY/v2/$NAME/manifests/$latest"
if grep -qi "^cache-control: $IMMUTABLE_CC" "$tmp/h"; then
  ok "manifest by digest: $IMMUTABLE_CC"
else bad "manifest by digest"; fi

code="$(curl -sS -o "$tmp/b" -w '%{http_code}' "$REGISTRY/v2/$NAME/manifests/0.9.0")"
if [ "$code" = 404 ] && grep -q MANIFEST_UNKNOWN "$tmp/b"; then ok "the yanked 0.9.0 has no tag"; else bad "yanked tag ($code)"; fi

layer="$(curl -fsS "$REGISTRY/v2/$NAME/manifests/1.1.0-beta.1" | json_field layers.0.digest)"
code="$(curl -sS -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' -H 'Range: bytes=0-9' \
  "$REGISTRY/v2/$NAME/blobs/$layer")"
if [ "$code" = 206 ] && [ "$(wc -c <"$tmp/b" | tr -d ' ')" = 10 ] &&
  grep -qi '^content-range: bytes 0-9/' "$tmp/h" && grep -qi "^docker-content-digest: $layer" "$tmp/h"; then
  ok "blob Range answers 206"
else bad "blob Range ($code)"; fi
curl -fsS -o "$tmp/b" "$REGISTRY/v2/$NAME/blobs/$layer"
if [ "$(sha256_of "$tmp/b")" = "$layer" ]; then ok "blob bytes match their digest"; else bad "blob bytes"; fi

# F-21: the token service grants pull on this repository (anonymously for a public feed, to the
# registry token on an authenticated one), and the pull token reads the tag list.
code="$(curl -sS -o "$tmp/b" -w '%{http_code}' "$REGISTRY/v2/token?scope=repository:$NAME:pull")"
pull="$(json_field token <"$tmp/b" 2>/dev/null || true)"
if [ "$code" = 200 ] && [ -n "$pull" ] &&
  [ "$(curl -q -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $pull" "$REGISTRY/v2/$NAME/tags/list")" = 200 ]; then
  ok "/v2/token grants pull, and the pull token reads the repository"
else bad "/v2/token ($code)"; fi
if [ -n "${REGISTRY_AUTH:-}" ]; then
  code="$(curl -q -sS -o /dev/null -w '%{http_code}' "$REGISTRY/v2/token?scope=repository:$NAME:pull")"
  [ "$code" = 401 ] && ok "/v2/token refuses an anonymous caller a private repository" || bad "/v2/token anonymous ($code)"
fi
code="$(curl -sS -o "$tmp/b" -w '%{http_code}' -X PUT "$REGISTRY/v2/$NAME/manifests/x")"
if [ "$code" = 405 ] && grep -q UNSUPPORTED "$tmp/b"; then ok "push is refused"; else bad "push ($code)"; fi

exit "$fail"
