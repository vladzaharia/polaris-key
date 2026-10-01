#!/usr/bin/env bash
# One measured simulator session against mock/serve.py: set the served version, launch the probe
# with a plan, stop it after N seconds, and save both logs under build/mock/<name>-{app,req}.jsonl.
# usage: session.sh <name> <served-version> <plan> [seconds=30]
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
name="$1" ver="$2" plan="$3" secs="${4:-30}"
U="${SIM_UDID:?set SIM_UDID}"; BID=dev.polariskey.research.pkba; M="$here/build/mock"
CA="${MOCK_CA:?set MOCK_CA to the CA pem}"
curl -s --cacert "$CA" "https://localhost:54985/_set?version=$ver" >/dev/null || { echo "mock server down"; exit 1; }
D=$(xcrun simctl get_app_container "$U" "$BID" data)
: > "$D/Documents/pkba_log.jsonl"; : > "$M/req.jsonl"
xcrun simctl launch "$U" "$BID" -- "--plan=$plan" >/dev/null
sleep "$secs"
xcrun simctl terminate "$U" "$BID" 2>/dev/null
cp "$D/Documents/pkba_log.jsonl" "$M/$name-app.jsonl"; cp "$M/req.jsonl" "$M/$name-req.jsonl"
python3 - "$M/$name-req.jsonl" <<'PY'
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1])]
tot=sum(r['sent'] for r in rs if r['path'].startswith('/assets/'))
for r in rs: print(f"  {r['method']} {r['path']:28} range={r['range']} status={r['status']} sent={r['sent']}")
print(f"  asset bytes sent: {tot}")
PY
