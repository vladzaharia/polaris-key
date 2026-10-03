#!/bin/bash
# S-10 direct-flavour sequence on one emulator: refusals, prompt, silent self-update, gentle
# constraints, missing permission, and a Play-owned install. Results land in results/.
set -uo pipefail
W=$(cd "$(dirname "$0")" && pwd); cd "$W"
export ANDROID_ADB_SERVER_PORT=${ANDROID_ADB_SERVER_PORT:-5099}
DEV=${DEV:-127.0.0.1:5611}; export DEV
A() { "$HOME/Library/Android/sdk/platform-tools/adb" -s "$DEV" "$@"; }
P=org.polariskey.s10d; E=/sdcard/Android/data/$P/files; U=/data/user/0/$P/files
sha() { shasum -a 256 "out/$1.apk" | cut -d' ' -f1; }
S2=$(sha direct-v2-s10); S3=$(sha direct-v3-s10); S2O=$(sha direct-v2-omit)
SUF=${SUF:-}
fresh() { # $1 = apk tag, rest = adb install flags
  local tag=$1; shift
  A uninstall $P >/dev/null 2>&1; A install "$@" "out/$tag.apk" | tail -1
  A shell mkdir -p $E
  for f in direct-v1-s10 direct-v2-s10 direct-v3-s10 direct-v2-s10other direct-v2-omit; do A push out/$f.apk $E/$f.apk >/dev/null; done
}
dump() { A shell dumpsys package $P | grep -E 'versionCode|installerPackageName|initiatingPackageName|originatingPackageName|packageSource|updateOwner' | tr -s ' ' | sort -u; }
copyin='{"op":"copyIn","src":"direct-v2-s10.apk","dst":"v2.apk"},{"op":"copyIn","src":"direct-v3-s10.apk","dst":"v3.apk"},{"op":"copyIn","src":"direct-v2-s10other.apk","dst":"v2other.apk"},{"op":"copyIn","src":"direct-v1-s10.apk","dst":"v1.apk"},{"op":"copyIn","src":"direct-v2-omit.apk","dst":"v2omit.apk"}'

main_seq() {
  echo "== D1 fresh adb install of v1, no install permission"
  fresh direct-v1-s10
  ./run.sh $P d1$SUF "[$copyin,{\"op\":\"source\"},
    {\"op\":\"call\",\"name\":\"pi.verify\",\"args\":{\"path\":\"$U/v2.apk\",\"sha256\":\"$S2\"}},
    {\"op\":\"call\",\"name\":\"pi.verify\",\"args\":{\"path\":\"$U/v2.apk\",\"sha256\":\"00$S2\"}},
    {\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v2other.apk\"}},
    {\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v1.apk\"}},
    {\"op\":\"call\",\"name\":\"pi.canRequest\"},{\"op\":\"call\",\"name\":\"pi.constraints\"},
    {\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v2.apk\",\"sha256\":\"$S2\"},\"await\":\"pi_status\",\"timeout_ms\":8000},
    {\"op\":\"call\",\"name\":\"pi.sessions\"}]" 40 >/dev/null
  echo "== D2 user grants 'install unknown apps' (appop), silent self-update v1->v2 with update ownership"
  A shell appops set $P REQUEST_INSTALL_PACKAGES allow
  NOSTOP=1 ./run.sh $P d2$SUF "[{\"op\":\"call\",\"name\":\"pi.canRequest\"},
    {\"op\":\"ksWrap\",\"alias\":\"pkey_device\",\"plain\":\"device-token-123\",\"strongBox\":false},
    {\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v2.apk\",\"sha256\":\"$S2\",\"requestUpdateOwnership\":true},\"await\":\"pi_status\",\"timeout_ms\":8000},
    {\"op\":\"wait\",\"ms\":3000}]" 12 >/dev/null
  sleep 3; A logcat -d -s S10 > results/logcat_d2b$SUF.txt; echo "pid now: $(A shell pidof $P)"; dump | tee results/dump_d2$SUF.txt
  echo "== D3 relaunch v2: source, Keystore survives, gentle-constraint update v2->v3 while foreground"
  NOSTOP=1 ./run.sh $P d3$SUF "[{\"op\":\"source\"},{\"op\":\"call\",\"name\":\"pi.log\"},
    {\"op\":\"ksUnwrapSaved\",\"alias\":\"pkey_device\"},{\"op\":\"ksInfo\",\"alias\":\"pkey_device\"},
    {\"op\":\"ksWrap\",\"alias\":\"pkey_sb\",\"plain\":\"x\",\"strongBox\":true},
    {\"op\":\"call\",\"name\":\"pi.constraints\"},
    {\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v3.apk\",\"sha256\":\"$S3\",\"gentle\":true,\"timeoutMs\":120000}},
    {\"op\":\"wait\",\"ms\":60000}]" 6 >/dev/null
  T0=$(date +%s); echo "foreground for 10 s"; sleep 10; echo "vc after 10 s foreground: $(A shell dumpsys package $P | grep -m1 versionCode)"
  A shell input keyevent KEYCODE_HOME; echo "HOME pressed at +$(( $(date +%s) - T0 )) s"
  for i in $(seq 1 90); do sleep 1; vc=$(A shell dumpsys package $P | grep -m1 -o 'versionCode=[0-9]*'); [ "$vc" = versionCode=3 ] && { echo "v3 installed at +$(( $(date +%s) - T0 )) s"; break; }; done
  A logcat -d -s S10 > results/logcat_d3b$SUF.txt; dump | tee results/dump_d3$SUF.txt
  echo "== D4 relaunch v3"
  ./run.sh $P d4$SUF "[{\"op\":\"source\"},{\"op\":\"call\",\"name\":\"pi.log\"},{\"op\":\"ksUnwrapSaved\",\"alias\":\"pkey_device\"}]" 30 >/dev/null
}
omit_seq() {
  echo "== D5 installer without UPDATE_PACKAGES_WITHOUT_USER_ACTION"
  fresh direct-v1-omit
  A shell appops set $P REQUEST_INSTALL_PACKAGES allow
  NOSTOP=1 ./run.sh $P d5$SUF "[$copyin,{\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v2omit.apk\",\"sha256\":\"$S2O\"},\"await\":\"pi_status\",\"timeout_ms\":8000},{\"op\":\"wait\",\"ms\":2000}]" 20 >/dev/null
  sleep 2; A logcat -d -s S10 > results/logcat_d5$SUF.txt; dump | tee results/dump_d5$SUF.txt
}
owner_seq() {
  echo "== D6 Play-owned install (adb --update-ownership -i com.android.vending), then self-update"
  A shell pm list packages com.android.vending
  fresh direct-v1-s10 --update-ownership -i com.android.vending
  dump | tee results/dump_d6pre$SUF.txt
  A shell appops set $P REQUEST_INSTALL_PACKAGES allow
  NOSTOP=1 ./run.sh $P d6$SUF "[$copyin,{\"op\":\"source\"},{\"op\":\"call\",\"name\":\"pi.install\",\"args\":{\"path\":\"$U/v2.apk\",\"sha256\":\"$S2\",\"launchPrompt\":true},\"await\":\"pi_status\",\"timeout_ms\":8000},{\"op\":\"wait\",\"ms\":1500}]" 20 >/dev/null
  sleep 2; A shell uiautomator dump /sdcard/ui.xml >/dev/null; A pull /sdcard/ui.xml results/ui_d6$SUF.xml >/dev/null
  python3 -c "import re;x=open('results/ui_d6$SUF.xml').read();print('UI:', re.findall(r'text=\"([^\"]+)\"',x), set(re.findall(r'package=\"([^\"]+)\"',x)))"
  A exec-out screencap -p > results/d6_prompt$SUF.png
}
case "${1:-all}" in
  main) main_seq;; omit) omit_seq;; owner) owner_seq;;
  all) main_seq; omit_seq; owner_seq;;
esac
