extends RefCounted
# The export plugin end to end (P1-11). Not in the `ci` set: run_tests.sh exports the
# "Conformance (Linux)" preset headless as ZIP packs (ZIPReader reads them; the stamp bytes are
# the same in a .pck) and then runs this suite in the editor:
#
#   godot --headless --path sdks/godot -- --pkey-test export_stamps <stamps dir> <logs dir>
#
#   steam.zip   PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42
#   steam2.zip  the same, exported again with a .pkey/distribution.yaml beside the project
#   env.zip     the same plus PKEY_OUTLET_IDS={"itchGameId":"2002","steamAppId":"999"}
#   bad.zip     the same plus PKEY_OUTLET_IDS={"itchGameId":1001} (log: export-stamp-bad.log)
#   kind.zip    PKEY_BUILD_OUTLET=itch-beta PKEY_BUILD_OUTLET_KIND=itch PKEY_BUILD_FORMAT=zip (P3-11)
#   nokind.zip  PKEY_BUILD_OUTLET=itch-beta PKEY_BUILD_OUTLET_SUBKIND=brew: no kind, a bad subkind

const STAMP := ".polaris_key/build.json"
const PRESET_OUTLET_IDS := {"caskToken": "polaris-key-sdk", "itchGameId": "1000", "msixFamilyName": "PolarisKey.SDK_8wekyb3d8bbwe", "steamAppId": "480"}
const ENV_OUTLET_IDS := {"itchGameId": "2002", "steamAppId": "999"}


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	if not t.check("usage: <stamps dir> <logs dir>", args.size() >= 2, " ".join(args)):
		return true
	var dir := args[0]
	var logs := args[1]
	var steam := _stamp(dir.path_join("steam.zip"))
	var steam2 := _stamp(dir.path_join("steam2.zip"))
	var env := _stamp(dir.path_join("env.zip"))
	var bad := _stamp(dir.path_join("bad.zip"))
	var kind := _stamp(dir.path_join("kind.zip"))
	var nokind := _stamp(dir.path_join("nokind.zip"))
	var loaded := 0
	for b in [steam, steam2, env, bad, kind, nokind]:
		if not b.is_empty():
			loaded += 1
	t.check("coverage: six stamps read", loaded == 6, "%d/6" % loaded)
	if steam.is_empty():
		return true
	var doc = PKeyJson.parse(steam.get_string_from_utf8())
	if not t.check("steam: the stamp is a strict JSON object", doc["ok"] and doc["value"] is Dictionary):
		return true
	var s: Dictionary = doc["value"]
	t.info("steam stamp: %s" % steam.get_string_from_utf8().strip_edges().replace("\n", " "))
	t.check("steam: pkeyBuild 1", s.get("pkeyBuild") == 1.0)
	t.check("steam: the environment's outlet, channel and build", s.get("outlet") == "steam" and s.get("channel") == "beta" and s.get("build") == 42.0, "%s %s %s" % [s.get("outlet"), s.get("channel"), s.get("build")])
	t.check("steam: outletKind defaults to the outlet, a kind; no subkind or format", s.get("outletKind") == "steam" and not s.has("outletSubkind") and not s.has("format"), JSON.stringify(s))
	t.check("steam: the version is application/config/version", s.get("version") == str(ProjectSettings.get_setting("application/config/version", "")))
	t.check("steam: outletIds is the preset's option, unchanged", s.get("outletIds") == PRESET_OUTLET_IDS, JSON.stringify(s.get("outletIds")))
	t.check("steam: platform linux, arch x86_64, release", s.get("platform") == "linux" and s.get("arch") == "x86_64" and s.get("debug") == false)
	t.check("steam: engine and SDK version", s.get("engine") == PKeyBuildStamp.engine_id() and s.get("sdkVersion") == PKeyBuildStamp.sdk_version())
	var text := steam.get_string_from_utf8()
	t.check("steam: no timestamp", not text.to_lower().contains("time") and not text.contains("At\""))
	t.check("steam: byte-identical across two exports (the second with a .pkey/distribution.yaml beside the project)", steam == steam2)
	var e = PKeyJson.parse(env.get_string_from_utf8())
	t.check("env: PKEY_OUTLET_IDS replaces the option's object", e["ok"] and e["value"].get("outletIds") == ENV_OUTLET_IDS, env.get_string_from_utf8())
	var b = PKeyJson.parse(bad.get_string_from_utf8())
	t.check("bad: a non-string itchGameId is left out of the stamp", b["ok"] and b["value"].get("outletIds") == {}, bad.get_string_from_utf8())
	var bad_log := FileAccess.get_file_as_string(logs.path_join("export-stamp-bad.log"))
	var warned := false
	for line in bad_log.split("\n"):
		if line.contains("WARNING") and line.contains("PKEY_OUTLET_IDS") and line.contains("itchGameId"):
			warned = true
	t.check("bad: the headless export prints a push_warning naming PKEY_OUTLET_IDS", warned, "export-stamp-bad.log")
	var k = PKeyJson.parse(kind.get_string_from_utf8())
	t.check("kind: a custom outlet id with its kind and format", k["ok"] and k["value"].get("outlet") == "itch-beta" and k["value"].get("outletKind") == "itch" and k["value"].get("format") == "zip" and not k["value"].has("outletSubkind"), kind.get_string_from_utf8())
	t.check("kind: the stamp resolves to {itch-beta, itch}", k["ok"] and _json_same(PKeyDecision.resolve_update_outlet({"stamp": k["value"]}), {"id": "itch-beta", "kind": "itch", "subkind": null}))
	var kind_log := FileAccess.get_file_as_string(logs.path_join("export-stamp-kind.log"))
	t.check("kind: a clean v4 export prints no stamp warning", kind_log != "" and not kind_log.contains("Polaris Key build stamp"))
	var nk = PKeyJson.parse(nokind.get_string_from_utf8())
	t.check("nokind: an empty outletKind is stamped, and the subkind as given", nk["ok"] and nk["value"].get("outletKind") == "" and nk["value"].get("outletSubkind") == "brew", nokind.get_string_from_utf8())
	t.check("nokind: at run time it decides as unknown", nk["ok"] and _json_same(PKeyDecision.resolve_update_outlet({"stamp": nk["value"]}), {"id": null, "kind": "unknown", "subkind": null}))
	var nokind_log := FileAccess.get_file_as_string(logs.path_join("export-stamp-nokind.log"))
	var kind_warned := false
	var subkind_warned := false
	for line in nokind_log.split("\n"):
		if line.contains("WARNING") and line.contains("decides as unknown"):
			kind_warned = true
		if line.contains("WARNING") and line.contains("PKEY_BUILD_OUTLET_SUBKIND"):
			subkind_warned = true
	t.check("nokind: the export warns that the kind is missing and the subkind unknown", kind_warned and subkind_warned, "export-stamp-nokind.log")
	var steam_log := FileAccess.get_file_as_string(logs.path_join("export-stamp-steam.log"))
	t.check("steam: a clean export prints no stamp warning", steam_log != "" and not steam_log.contains("Polaris Key build stamp"))
	return true


## The stamp's bytes inside a ZIP export, or empty.
func _stamp(path: String) -> PackedByteArray:
	var z := ZIPReader.new()
	if z.open(path) != OK:
		return PackedByteArray()
	var out := PackedByteArray()
	if z.get_files().has(STAMP):
		out = z.read_file(STAMP)
	z.close()
	return out


static func _json_same(a: Variant, b: Variant) -> bool:
	return JSON.stringify(a, "", true) == JSON.stringify(b, "", true)
