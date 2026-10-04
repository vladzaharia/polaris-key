# Shared by the OCI clients (F-08); sourced, never run (run.mjs runs only `clients/*.sh`).
# The seeded repository (seeds/oci.ts) is REPO under OWNER:
#   0.8.0 (deprecated), 0.9.0 (yanked), 1.0.0 (multi-arch linux/amd64 + linux/arm64, `latest`),
#   1.1.0-beta.1 (`beta`).
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
REPO="tools/smoke"
NAME="$OWNER/$REPO"
HOSTPORT="${REGISTRY#http://}"
HOSTPORT="${HOSTPORT#https://}"
REF="$HOSTPORT/$NAME"
EXPECTED_TAGS='["0.8.0","1.0.0","1.1.0-beta.1","beta","latest"]'

# need <tool>: the client's tool must be installed. CI (REGISTRY_CLIENTS_REQUIRE=1) fails without
# it; a local run without it skips this client with a notice.
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    if [ "${REGISTRY_CLIENTS_REQUIRE:-}" = 1 ]; then
      echo "FAIL $1 is not installed"
      exit 1
    fi
    echo "SKIP $1 is not installed (set REGISTRY_CLIENTS_REQUIRE=1 to fail instead)"
    exit 0
  fi
}

# digest_of <tag>: the manifest digest a tag resolves to, from the registry's own header.
digest_of() {
  curl -fsSI "$REGISTRY/v2/$NAME/manifests/$1" | tr -d '\r' |
    awk 'tolower($1) == "docker-content-digest:" { print $2 }'
}

# json_field <path>: one field of the JSON document on stdin (`.config.digest`, `.layers.0.digest`).
json_field() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split(".").filter(Boolean))v=v[k];console.log(v)})' "$1"
}

# sha256_of <file>: the file's SHA-256 as an OCI digest.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256:$(sha256sum "$1" | cut -d' ' -f1)"
  else
    echo "sha256:$(shasum -a 256 "$1" | cut -d' ' -f1)"
  fi
}

fail=0
ok() { echo "ok   $1"; }
bad() {
  echo "FAIL $1"
  fail=1
}
