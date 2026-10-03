#!/bin/bash
# S-10 play-flavour sequence: FakeAppUpdateManager scenarios, the real AppUpdateManager on an
# emulator without the Play Store, and Play Asset Delivery against bundletool --local-testing.
set -uo pipefail
W=$(cd "$(dirname "$0")" && pwd); cd "$W"
export ANDROID_ADB_SERVER_PORT=${ANDROID_ADB_SERVER_PORT:-5099}
DEV=${DEV:-127.0.0.1:5611}; export DEV
SUF=${SUF:-}
P=org.polariskey.s10
fake() { # name setup-json steps-json
  printf '{"op":"call","name":"iau.fake","args":{"setup":%s,"steps":%s},"await":"iau_state","timeout_ms":8000,"label":"%s"}' "$2" "$3" "$1"
}
S='{"available":2,"priority":4,"staleness":3,"total":1000000}'
STEPS="[{\"op\":\"source\"},
$(fake flexible_happy "$S" '["info","start:flexible","accept","downloadStarts","bytes:500000","downloadCompletes","info","complete","installCompletes","info"]'),
$(fake flexible_rejected "$S" '["info","startTask:flexible","reject","info"]'),
$(fake flexible_accepted_task "$S" '["info","startTask:flexible","accept","downloadStarts","downloadCompletes","complete","installCompletes"]'),
$(fake immediate_happy "$S" '["info","start:immediate","accept","downloadStarts","downloadCompletes","installCompletes","info"]'),
$(fake immediate_resume "$S" '["info","start:immediate","accept","downloadStarts","info"]'),
$(fake flexible_only_type '{"available":2,"type":0}' '["info","start:immediate"]'),
$(fake download_fails "$S" '["info","start:flexible","accept","downloadStarts","downloadFails","info"]'),
$(fake user_cancels_download "$S" '["info","start:flexible","accept","downloadStarts","cancelDownload","info"]'),
$(fake install_fails "$S" '["info","start:flexible","accept","downloadStarts","downloadCompletes","complete","installFails","info"]'),
$(fake not_available '{}' '["info","start:flexible"]'),
$(fake install_not_allowed '{"available":2,"installError":-6}' '["info","start:flexible","accept","downloadStarts"]'),
{\"op\":\"call\",\"name\":\"iau.real\",\"args\":{\"steps\":[\"info\"]},\"await\":\"iau_state\",\"timeout_ms\":15000}]"
./run.sh $P iau$SUF "$STEPS" 120 >/dev/null || true

# PAD: states before, on-demand fetch with listener, mount, remove, fast-follow, cancel, confirm.
PAD="[{\"op\":\"call\",\"name\":\"pad.locations\"},
{\"op\":\"call\",\"name\":\"pad.states\",\"args\":{\"names\":[\"s10ff\",\"s10od\",\"nosuchpack\"]},\"await\":\"pad_state\",\"timeout_ms\":8000},
{\"op\":\"mount\",\"pack\":\"s10od\",\"file\":\"s10od.pck\"},
{\"op\":\"call\",\"name\":\"pad.fetch\",\"args\":{\"names\":[\"s10od\"]},\"await\":\"pad_state\",\"count\":1,\"timeout_ms\":8000},
{\"op\":\"wait\",\"ms\":4000},
{\"op\":\"call\",\"name\":\"pad.location\",\"args\":{\"name\":\"s10od\"}},
{\"op\":\"mount\",\"pack\":\"s10od\",\"file\":\"s10od.pck\",\"probe\":\"res://data/s10od/manifest.json\"},
{\"op\":\"call\",\"name\":\"pad.fetch\",\"args\":{\"names\":[\"s10ff\"]},\"await\":\"pad_state\",\"timeout_ms\":8000},
{\"op\":\"wait\",\"ms\":3000},
{\"op\":\"mount\",\"pack\":\"s10ff\",\"file\":\"s10ff.pck\",\"probe\":\"res://data/s10ff/manifest.json\"},
{\"op\":\"call\",\"name\":\"pad.confirm\",\"await\":\"pad_state\",\"timeout_ms\":8000},
{\"op\":\"call\",\"name\":\"pad.fetch\",\"args\":{\"names\":[\"nosuchpack\"]},\"await\":\"pad_state\",\"timeout_ms\":8000},
{\"op\":\"call\",\"name\":\"pad.remove\",\"args\":{\"name\":\"s10od\"},\"await\":\"pad_state\",\"timeout_ms\":8000},
{\"op\":\"wait\",\"ms\":1000},
{\"op\":\"call\",\"name\":\"pad.location\",\"args\":{\"name\":\"s10od\"}},
{\"op\":\"call\",\"name\":\"pad.fetch\",\"args\":{\"names\":[\"s10od\"]}},
{\"op\":\"call\",\"name\":\"pad.cancel\",\"args\":{\"names\":[\"s10od\"]}},
{\"op\":\"wait\",\"ms\":4000},
{\"op\":\"call\",\"name\":\"pad.states\",\"args\":{\"names\":[\"s10od\"]},\"await\":\"pad_state\",\"timeout_ms\":8000}]"
./run.sh $P pad$SUF "$PAD" 120 >/dev/null || true
./run.sh $P pad2$SUF "[{\"op\":\"call\",\"name\":\"pad.locations\"},{\"op\":\"call\",\"name\":\"pad.states\",\"args\":{\"names\":[\"s10ff\",\"s10od\"]},\"await\":\"pad_state\",\"timeout_ms\":8000},{\"op\":\"mount\",\"pack\":\"s10ff\",\"file\":\"s10ff.pck\",\"probe\":\"res://data/s10ff/manifest.json\"}]" 60 >/dev/null || true
