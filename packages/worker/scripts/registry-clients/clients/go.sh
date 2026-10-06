#!/usr/bin/env bash
# The Go client matrix (F-31, plans/F-01.md §6.8), against the module `go.seed.ts` published:
#   go.plrs.test/smoke v1.0.0, v1.0.1 (yanked), v1.1.0 (stable: `latest`), v1.2.0-beta.1 (`beta`).
#
# The go command runs with the feed's documented setup: GOPROXY naming the feed and GONOSUMDB
# naming the module prefix (never GOPRIVATE, which would make it skip the proxy). The public proxy
# that follows the feed in a real setup is `off` here, so nothing leaves the machine. Checks:
#   1. install: `go get <module>@latest` takes v1.1.0, and a program built against it runs;
#   2. integrity: the go.sum lines the go command wrote are the h1: hashes the CLI recorded at
#      publish (the seed's go-sums.json), and a re-download verifies against go.sum;
#   3. channel tags: `go get <module>@beta` resolves the channel to v1.2.0-beta.1 (`@v/beta.info`);
#   4. yank: v1.0.1 is not listed, `@v1.0` resolves to v1.0.0, and the pinned v1.0.1 still
#      downloads (a go.sum that names it keeps building);
#   5. protocol: `@latest`, `@v/list`, the 404 an unknown module answers (what makes the go command
#      try the next GOPROXY entry) and the case-encoded path.
# Authenticated mode (run.mjs --auth): run.mjs checks the anonymous 401 first; then the go command
# reaches the feed through a local forwarder adding the Basic credentials a .netrc entry gives it
# on a real https feed (it never sends credentials over the harness's plain http itself).
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${STATE:?STATE is the harness state directory}"
MODULE="go.plrs.test/smoke"
FEED="$REGISTRY/go/$OWNER"

if ! command -v go >/dev/null 2>&1; then
  if [ "${REGISTRY_CLIENTS_REQUIRE:-}" = 1 ]; then
    echo "FAIL go is not installed"
    exit 1
  fi
  echo "SKIP go is not installed (set REGISTRY_CLIENTS_REQUIRE=1 to fail instead)"
  exit 0
fi
echo "$(go version)"

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
tmp="$(mktemp -d)"
trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

PROXY="$FEED"
if [ -n "${REGISTRY_AUTH:-}" ]; then
  : "${PKEY_REGISTRY_TOKEN:?the token comes from run.mjs --auth}"
  # The go command sends credentials (.netrc, GOAUTH, URL user info) only over https, and the
  # harness Worker is plain http on 127.0.0.1. A local forwarder therefore adds exactly the header
  # the go command sends a real https feed from .netrc (Basic, __token__ and the token), so the
  # Worker's ladder sees what production sees.
  fwd_port_file="$tmp/fwd.port"
  node -e '
const http = require("http");
const upstream = new URL(process.argv[1]);
const auth = "Basic " + Buffer.from("__token__:" + process.argv[2]).toString("base64");
const srv = http.createServer((req, res) => {
  const up = http.request(
    { host: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host, authorization: auth } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
srv.listen(0, "127.0.0.1", () => require("fs").writeFileSync(process.argv[3], String(srv.address().port)));
' "$REGISTRY" "$PKEY_REGISTRY_TOKEN" "$fwd_port_file" &
  fwd_pid=$!
  trap 'kill "$fwd_pid" 2>/dev/null; chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
  for _ in $(seq 1 50); do [ -s "$fwd_port_file" ] && break; sleep 0.1; done
  PROXY="http://127.0.0.1:$(cat "$fwd_port_file")/go/$OWNER"
fi

export GOPROXY="$PROXY,off"
export GONOSUMDB="go.plrs.test"
export GOFLAGS="-modcacherw"
export GOTOOLCHAIN="local"
export GOPATH="$tmp/gopath"
export GOMODCACHE="$tmp/modcache"
export GOCACHE="$tmp/gocache"
export GOENV="off"
unset GOPRIVATE GONOPROXY GOSUMDB || true

# selected <dir>: the version of MODULE the project's build list selects.
selected() { (cd "$1" && go list -m -f '{{.Version}}' "$MODULE"); }

project() {
  local dir="$tmp/$1"
  mkdir -p "$dir"
  printf 'module example.test/%s\n\ngo 1.21\n' "$1" >"$dir/go.mod"
  echo "$dir"
}

# ── 1. install @latest and build against it ─────────────────────────────────────────────────────
app="$(project app)"
cat >"$app/main.go" <<'GO'
package main

import (
	"fmt"

	"go.plrs.test/smoke"
)

func main() { fmt.Println(smoke.Hello()) }
GO
if (cd "$app" && go get "$MODULE@latest") >"$tmp/get.log" 2>&1 &&
  [ "$(selected "$app")" = v1.1.0 ]; then
  ok "go get $MODULE@latest takes v1.1.0 (the stable head; the beta and the yanked version lose)"
else
  cat "$tmp/get.log"
  bad "go get @latest"
fi
if out="$(cd "$app" && go run . 2>&1)" && [ "$out" = "hello 1.1.0" ]; then
  ok "a program built against v1.1.0 runs ($out)"
else
  echo "  $out"
  bad "go run"
fi

# ── 2. go.sum holds the hashes the CLI recorded ─────────────────────────────────────────────────
if node -e '
const fs = require("fs");
const sums = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["v1.1.0"];
const lines = fs.readFileSync(process.argv[2], "utf8").trim().split("\n");
const want = [
  `go.plrs.test/smoke v1.1.0 ${sums.h1}`,
  `go.plrs.test/smoke v1.1.0/go.mod ${sums.goModH1}`,
];
process.exit(want.every((w) => lines.includes(w)) ? 0 : 1);
' "$STATE/go-sums.json" "$app/go.sum"; then
  ok "go.sum's h1: lines are the hashes the CLI computed at publish"
else
  cat "$app/go.sum"
  bad "go.sum hashes"
fi
chmod -R u+w "$GOMODCACHE" && rm -rf "$GOMODCACHE"
if (cd "$app" && go mod verify && go mod download -x "$MODULE") >"$tmp/verify.log" 2>&1; then
  ok "a fresh download verifies against go.sum"
else
  cat "$tmp/verify.log"
  bad "re-download"
fi

# ── 3. a channel tag ────────────────────────────────────────────────────────────────────────────
beta="$(project beta)"
if (cd "$beta" && go get "$MODULE@beta") >"$tmp/beta.log" 2>&1 &&
  [ "$(selected "$beta")" = v1.2.0-beta.1 ]; then
  ok "go get $MODULE@beta resolves the channel to v1.2.0-beta.1"
else
  cat "$tmp/beta.log"
  bad "go get @beta"
fi

# ── 4. the yanked version ───────────────────────────────────────────────────────────────────────
if versions="$(cd "$app" && go list -m -versions "$MODULE")" &&
  [ "$versions" = "$MODULE v1.0.0 v1.1.0 v1.2.0-beta.1" ]; then
  ok "go list -m -versions omits the yanked v1.0.1 ($versions)"
else
  echo "  $versions"
  bad "go list -m -versions"
fi
old="$(project old)"
if (cd "$old" && go get "$MODULE@v1.0") >"$tmp/old.log" 2>&1 &&
  [ "$(selected "$old")" = v1.0.0 ]; then
  ok "go get $MODULE@v1.0 resolves to v1.0.0, never the yanked v1.0.1"
else
  cat "$tmp/old.log"
  bad "go get @v1.0"
fi
if (cd "$old" && go mod download -json "$MODULE@v1.0.1") >"$tmp/pinned.json" 2>&1 &&
  grep -q '"Version": "v1.0.1"' "$tmp/pinned.json"; then
  ok "a pinned v1.0.1 still downloads (a go.sum naming it keeps building)"
else
  cat "$tmp/pinned.json"
  bad "pinned yanked download"
fi

# ── 5. the protocol over plain HTTP ─────────────────────────────────────────────────────────────
CURL=(curl -sS)
if [ -n "${REGISTRY_AUTH:-}" ]; then CURL+=(-u "__token__:$PKEY_REGISTRY_TOKEN"); fi
code="$("${CURL[@]}" -o "$tmp/latest" -D "$tmp/h" -w '%{http_code}' "$FEED/$MODULE/@latest")"
if [ "$code" = 200 ] && grep -q '"Version":"v1.1.0"' "$tmp/latest" &&
  grep -qi '^content-type: application/json' "$tmp/h"; then
  ok "@latest is v1.1.0"
else
  bad "@latest ($code)"
fi
if [ "$("${CURL[@]}" "$FEED/$MODULE/@v/list")" = "$(printf 'v1.0.0\nv1.1.0\nv1.2.0-beta.1')" ]; then
  ok "@v/list names every version but the yanked one"
else
  bad "@v/list"
fi
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$FEED/go.plrs.test/missing/@v/list")"
if [ "$code" = 404 ]; then
  ok "an unknown module is the 404 (the go command moves on to the next GOPROXY entry)"
else
  bad "unknown module answered $code"
fi
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$FEED/go.plrs.test/Smoke/@v/list")"
if [ "$code" = 404 ]; then
  ok "an upper-case path is not the go command's encoding: the 404"
else
  bad "un-encoded path answered $code"
fi

exit "$fail"
