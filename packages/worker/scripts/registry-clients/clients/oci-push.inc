# Shared by the OCI push clients (F-23); sourced, never run. Pushes go to
repositories # `seeds/oci.ts` declares empty (`docker push` never creates a
deliverable), with # PKEY_REGISTRY_PUSH_TOKEN, an owner-bound `publish` token
`run.mjs` mints in both modes. . "$(dirname "$0")/oci.inc" :
"${PKEY_REGISTRY_PUSH_TOKEN:?PKEY_REGISTRY_PUSH_TOKEN is the harness push
token}" PUSH_REPO="tools/pushed" PUSH_NAME="$OWNER/$PUSH_REPO"
PUSH_REF="$HOSTPORT/$PUSH_NAME" # tags_of
<name
  >: the repository's tag list, comma-separated, from the registry itself.
  tags_of() { curl -fsS "$REGISTRY/v2/$1/tags/list" | node -e 'let
  s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).tags.join(",")))'
  }
</name>
