#!/bin/bash
# usage: make_feed.sh <variant e.g. cs1> [delta:yes|no] -> serve/<variant>/{S11Sparkle-1.1.zip,.sig,delta,appcast.xml}
set -e
cd "$(dirname "$0")"
VAR=$1; DELTA=${2:-yes}
SP=${SPARKLE_BIN:-../dl/sparkle/bin}; S=serve/$VAR; mkdir -p $S; rm -f $S/*
ditto -c -k --sequesterRsrc --keepParent out/$VAR-v2/S11Sparkle.app $S/S11Sparkle-1.1.zip
$SP/sign_update --ed-key-file keys/ed_seed.b64 -p $S/S11Sparkle-1.1.zip > $S/S11Sparkle-1.1.zip.sig
# cross-check: Node's Ed25519 over the same bytes must give the same (deterministic) signature
node -e 'const c=require("crypto"),fs=require("fs");const seed=Buffer.from(fs.readFileSync("keys/ed_seed.b64","utf8"),"base64");
const k=c.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
const s=c.sign(null,fs.readFileSync(process.argv[1]),k).toString("base64");const t=fs.readFileSync(process.argv[2],"utf8").trim();
console.log("node-vs-sign_update", s===t?"identical":"DIFFERENT")' $S/S11Sparkle-1.1.zip $S/S11Sparkle-1.1.zip.sig
DJSON=""
if [ "$DELTA" = yes ]; then
  $SP/BinaryDelta create out/$VAR-v1/S11Sparkle.app out/$VAR-v2/S11Sparkle.app $S/S11Sparkle2-1.delta
  $SP/sign_update --ed-key-file keys/ed_seed.b64 -p $S/S11Sparkle2-1.delta > $S/S11Sparkle2-1.delta.sig
  DJSON=",\"deltas\":[{\"file\":\"$PWD/$S/S11Sparkle2-1.delta\",\"sig\":\"$PWD/$S/S11Sparkle2-1.delta.sig\",\"deltaFrom\":\"1\"}]"
fi
/bin/cat > $S/spec.json <<J
{"outDir":"$PWD/$S","baseUrl":"http://127.0.0.1:8711/$VAR","publicKey":"$(cat keys/ed_pub.b64)","productName":"S11Sparkle",
 "kind":"sparkle","feedName":"appcast.xml",
 "releases":[{"version":"1.1","build":"2","file":"$PWD/$S/S11Sparkle-1.1.zip","sig":"$PWD/$S/S11Sparkle-1.1.zip.sig","minOs":"11.0"$DJSON}]}
J
(cd "${REPO:?set REPO to a polaris-key checkout}" && npx tsx "$OLDPWD/gen_feeds.mts" "$OLDPWD/$S/spec.json")
ls -la $S
