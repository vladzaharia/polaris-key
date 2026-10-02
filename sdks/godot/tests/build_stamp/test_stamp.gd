extends RefCounted
# @pkey-feature devices.report
# PKeyBuildStamp without an editor: the option checks the export dialog shows, outlet-id
# parsing, feature tags, platform and arch, deterministic encoding, the reader (over committed
# fixtures) and the core taking its channel and outlet from a stamp.

const FIXTURE := "res://tests/fixtures/build_stamp.json"
const BAD_CHANNEL := "res://tests/fixtures/build_stamp_bad_channel.json"
const V2 := "res://tests/fixtures/build_stamp_v2.json"
const V4 := "res://tests/fixtures/build_stamp_v4_fields.json"


func run(t: PKeyTestContext) -> void:
	_options(t)
	_outlet_ids(t)
	_tags_platform_arch(t)
	_encode(t)
	_read(t)
	await _core(t)


func _options(t: PKeyTestContext) -> void:
	t.check("options: 17 report §3.1 outlets", PKeyBuildStamp.OUTLETS.size() == 17 and PKeyBuildStamp.OUTLETS.has("app-store") and not PKeyBuildStamp.OUTLETS.has("app_store"))
	for row in [["linux", "direct"], ["windows", "direct"], ["macos", "direct"], ["android", "play"], ["ios", "app-store"], ["web", "web"]]:
		t.check("options: %s defaults to %s" % row, PKeyBuildStamp.default_outlet(row[0]) == row[1])
	t.check("options: a kind or a product outlet id has no outlet warning", PKeyBuildStamp.outlet_warning("steam") == "" and PKeyBuildStamp.outlet_warning("app-store") == "" and PKeyBuildStamp.outlet_warning("itch-beta") == "")
	t.check("options: an outlet that is not an outlet id warns", PKeyBuildStamp.outlet_warning("app_store").contains("not an outlet id") and PKeyBuildStamp.outlet_warning("Steam") != "" and PKeyBuildStamp.outlet_warning("") != "")
	# The v4 fields (plans/P3-01.md §8, P3-11).
	t.check("options: outletKind defaults to the outlet when it is a kind", PKeyBuildStamp.outlet_kind_for("steam", "") == "steam" and PKeyBuildStamp.outlet_kind_for("itch-beta", "") == "" and PKeyBuildStamp.outlet_kind_for("itch-beta", "itch") == "itch")
	t.check("options: a kind among the 17 has no kind warning", PKeyBuildStamp.outlet_kind_warning("steam", "") == "" and PKeyBuildStamp.outlet_kind_warning("itch-beta", "itch") == "")
	t.check("options: a custom outlet with no kind warns that it decides as unknown", PKeyBuildStamp.outlet_kind_warning("gog", "").contains("decides as unknown") and PKeyBuildStamp.outlet_kind_warning("gog", "").contains(PKeyBuildStamp.OPTION_OUTLET_KIND))
	t.check("options: a kind outside the 17 warns", PKeyBuildStamp.outlet_kind_warning("epic-store", "epic").contains("Unknown outlet kind 'epic'"))
	t.check("options: the 8 subkinds and none have no warning; another warns", ["", "homebrew", "flatpak", "appimage"].all(func(k): return PKeyBuildStamp.outlet_subkind_warning(k) == "") and PKeyBuildStamp.outlet_subkind_warning("brew").contains("Unknown outlet subkind"))
	t.check("options: the subkinds and kinds equal the generated enums", PKeyBuildStamp.OUTLET_SUBKINDS == Array(PKeyConstants.OUTLET_SUBKIND_VALUES) and PKeyBuildStamp.OUTLETS == Array(PKeyConstants.OUTLET_KIND_VALUES))
	t.check("options: stable, beta, dev, pr-12 and a manual channel are fine", ["stable", "beta", "dev", "pr-12", "nightly"].all(func(c): return PKeyBuildStamp.channel_warning(c, "1.0.0") == ""))
	t.check("options: a channel outside the vocabulary warns", PKeyBuildStamp.channel_warning("Beta", "1.0.0").contains("not a channel name") and PKeyBuildStamp.channel_warning("beta\n", "1.0.0") != "" and PKeyBuildStamp.channel_warning("has space", "1.0.0") != "")
	t.check("options: an alias is stamped canonically, with a warning", PKeyBuildStamp.canonical_channel("staging", "1.0.0") == "beta" and PKeyBuildStamp.channel_warning("staging", "1.0.0").contains("'beta'"))
	t.check("options: pr12 is stamped pr-12", PKeyBuildStamp.canonical_channel("pr12", "1.0.0") == "pr-12")
	t.check("options: a malformed channel has no canonical form", PKeyBuildStamp.canonical_channel("Beta", "1.0.0") == null)
	t.check("options: an empty channel follows the version", PKeyBuildStamp.canonical_channel("", "1.0.0") == "stable" and PKeyBuildStamp.canonical_channel("", "0.0.0-dev.3") == "dev")
	t.check("options: a semver version has no warning", PKeyBuildStamp.version_warning("1.2.3") == "" and PKeyBuildStamp.version_warning("0.0.0-beta.1") == "")
	t.check("options: a non-semver version warns", PKeyBuildStamp.version_warning("1.0").contains("not semver") and PKeyBuildStamp.version_warning("") != "")
	t.check("options: build number from the option", PKeyBuildStamp.parse_build_number(42) == {"value": 42, "problem": ""})
	t.check("options: build number from the environment", PKeyBuildStamp.parse_build_number("42") == {"value": 42, "problem": ""} and PKeyBuildStamp.parse_build_number(" 7 ")["value"] == 7)
	t.check("options: an empty build number is 0", PKeyBuildStamp.parse_build_number("") == {"value": 0, "problem": ""})
	for bad in ["4x", "-1", "1.5", -3]:
		var b := PKeyBuildStamp.parse_build_number(bad)
		t.check("options: build number %s is refused (0)" % JSON.stringify(bad), b["value"] == 0 and b["problem"] != "", str(b))


func _outlet_ids(t: PKeyTestContext) -> void:
	var full := {"steamAppId": "480", "itchGameId": "1000", "flatpakId": "im.plrs.Dice", "snapName": "dice", "caskToken": "dice", "homebrewFormula": "dice", "msixFamilyName": "Plrs.Dice_8wekyb3d8bbwe", "bundleId": "im.plrs.dice"}
	var r := PKeyBuildStamp.parse_outlet_ids(JSON.stringify(full))
	t.check("outlet_ids: all eight keys pass unchanged (homebrewFormula included)", r["ids"] == full and r["problems"].is_empty(), str(r))
	t.check("outlet_ids: \"\" and {} are an empty object", PKeyBuildStamp.parse_outlet_ids("")["ids"] == {} and PKeyBuildStamp.parse_outlet_ids("{}") == {"ids": {}, "problems": []})
	for bad in ["[1,2]", "\"steam\"", "42", "null"]:
		r = PKeyBuildStamp.parse_outlet_ids(bad)
		t.check("outlet_ids: %s is not a JSON object" % bad, r["ids"] == {} and r["problems"].size() == 1 and r["problems"][0].contains("not a JSON object"), str(r))
	r = PKeyBuildStamp.parse_outlet_ids("{\"steamAppId\": \"480\",}")
	t.check("outlet_ids: invalid JSON is refused whole", r["ids"] == {} and r["problems"][0].contains("not valid JSON"), str(r))
	r = PKeyBuildStamp.parse_outlet_ids("{\"steamAppId\": \"1\", \"steamAppId\": \"2\"}")
	t.check("outlet_ids: a duplicate key is refused (strict JSON)", r["ids"] == {} and not r["problems"].is_empty())
	r = PKeyBuildStamp.parse_outlet_ids("{\"itchGameId\": 1001, \"steamAppId\": \"480\"}")
	t.check("outlet_ids: a non-string value is dropped, the rest kept", r["ids"] == {"steamAppId": "480"} and r["problems"].size() == 1 and r["problems"][0].contains("itchGameId") and r["problems"][0].contains("1001") and not r["problems"][0].contains("1001.0"), str(r))
	r = PKeyBuildStamp.parse_outlet_ids("{\"gogId\": \"1\", \"snapName\": \"dice\"}")
	t.check("outlet_ids: an unknown key is dropped, the rest kept", r["ids"] == {"snapName": "dice"} and r["problems"].size() == 1 and r["problems"][0].contains("gogId"), str(r))
	t.check("outlet_ids: an empty value is left out", PKeyBuildStamp.parse_outlet_ids("{\"snapName\": \"\"}") == {"ids": {}, "problems": []})
	t.check("outlet_ids: a Dictionary option value parses too", PKeyBuildStamp.parse_outlet_ids({"caskToken": "dice"})["ids"] == {"caskToken": "dice"})
	t.check("outlet_ids: the dialog warning names every problem", PKeyBuildStamp.outlet_ids_warning("{\"itchGameId\": 1, \"x\": \"y\"}").contains("itchGameId") and PKeyBuildStamp.outlet_ids_warning("{\"itchGameId\": 1, \"x\": \"y\"}").contains("'x'"))
	t.check("outlet_ids: no warning for a clean value", PKeyBuildStamp.outlet_ids_warning("{\"steamAppId\": \"480\"}") == "" and PKeyBuildStamp.outlet_ids_warning("") == "")
	var m := PKeyBuildStamp.merge_bundle_id({"steamAppId": "480"}, "im.plrs.dice")
	t.check("outlet_ids: the preset's bundle id is added", m["ids"] == {"steamAppId": "480", "bundleId": "im.plrs.dice"} and m["problems"].is_empty())
	m = PKeyBuildStamp.merge_bundle_id({"bundleId": "com.other"}, "im.plrs.dice")
	t.check("outlet_ids: a different option bundleId warns and the preset wins", m["ids"]["bundleId"] == "im.plrs.dice" and m["problems"].size() == 1)
	m = PKeyBuildStamp.merge_bundle_id({"bundleId": "im.plrs.dice"}, "")
	t.check("outlet_ids: without a preset bundle id the option's stays", m["ids"] == {"bundleId": "im.plrs.dice"} and m["problems"].is_empty())
	t.check("outlet_ids: Android's $genname resolves from the project name", PKeyBuildStamp.resolve_bundle_id("com.example.$genname") == "com.example.polariskeysdk" and PKeyBuildStamp.resolve_bundle_id("im.plrs.dice") == "im.plrs.dice", PKeyBuildStamp.resolve_bundle_id("com.example.$genname"))


func _tags_platform_arch(t: PKeyTestContext) -> void:
	t.check("tags: outlet and channel, - mapped to _", PKeyBuildStamp.feature_tags("app-store", "pr-12") == PackedStringArray(["pkey_outlet_app_store", "pkey_channel_pr_12"]))
	t.check("tags: steam and beta", PKeyBuildStamp.feature_tags("steam", "beta") == PackedStringArray(["pkey_outlet_steam", "pkey_channel_beta"]))
	for row in [["Linux", "linux"], ["Windows Desktop", "windows"], ["macOS", "macos"], ["Android", "android"], ["iOS", "ios"], ["Web", "web"]]:
		var feats := PackedStringArray([row[1]]) if row[0] == "Windows Desktop" else PackedStringArray()
		t.check("platform: %s -> %s" % row, PKeyBuildStamp.platform_for(row[0], feats) == row[1])
	var arch := func(p: String, f: Array) -> String: return PKeyBuildStamp.arch_for(p, PackedStringArray(f))
	t.check("arch: linux x86_64", arch.call("linux", ["linux", "pc", "x86_64", "64"]) == "x86_64")
	t.check("arch: windows arm64", arch.call("windows", ["windows", "arm64"]) == "arm64")
	t.check("arch: arm32 is armv7", arch.call("android", ["android", "arm32"]) == "armv7")
	t.check("arch: Android with more than one ABI is universal", arch.call("android", ["android", "arm64", "arm32", "x86_64"]) == "universal")
	t.check("arch: a universal macOS export", arch.call("macos", ["macos", "universal"]) == "universal" and arch.call("macos", ["macos", "x86_64", "arm64"]) == "universal")
	t.check("arch: web is wasm32", arch.call("web", ["web", "threads"]) == "wasm32")
	t.check("arch: unknown is empty", arch.call("linux", ["linux"]) == "" and arch.call("linux", ["x86_32"]) == "")


func _encode(t: PKeyTestContext) -> void:
	var inputs := {"product": "djdl", "version": "1.2.3", "build": 42, "outlet": "steam", "channel": "beta", "platform": "linux", "arch": "x86_64", "debug": false, "outlet_ids": {"steamAppId": "480", "caskToken": "dice"}}
	var a := PKeyBuildStamp.encode(PKeyBuildStamp.build(inputs))
	var b := PKeyBuildStamp.encode(PKeyBuildStamp.build(inputs.duplicate(true)))
	t.check("encode: deterministic bytes", a == b and a.size() > 0)
	var text := a.get_string_from_utf8()
	var parsed := PKeyJson.parse(text)
	t.check("encode: strict JSON", parsed["ok"] and parsed["value"] is Dictionary)
	var doc: Dictionary = parsed["value"]
	var want := ["arch", "build", "channel", "debug", "embeddedPacks", "engine", "engineVersion", "outlet", "outletIds", "outletKind", "packSources", "pkeyBuild", "platform", "product", "sdkVersion", "version"]
	t.check("encode: exactly the pkeyBuild 1 keys, sorted (outletKind always; no subkind or format unless set)", doc.keys() == want, str(doc.keys()))
	t.check("encode: outletKind defaults to the outlet", doc["outletKind"] == "steam")
	var v4 := inputs.duplicate(true)
	v4["outlet"] = "itch-beta"
	v4["outlet_kind"] = "itch"
	v4["outlet_subkind"] = "appimage"
	v4["format"] = "zip"
	var v4doc: Dictionary = PKeyJson.parse(PKeyBuildStamp.encode(PKeyBuildStamp.build(v4)).get_string_from_utf8())["value"]
	t.check("encode: a custom outlet id with its kind, subkind and format", v4doc["outlet"] == "itch-beta" and v4doc["outletKind"] == "itch" and v4doc["outletSubkind"] == "appimage" and v4doc["format"] == "zip")
	t.check("encode: the v4 stamp resolves to {itch-beta, itch, appimage}", PKeyDecision.resolve_update_outlet({"stamp": v4doc}) == {"id": "itch-beta", "kind": "itch", "subkind": "appimage"})
	var nokind := inputs.duplicate(true)
	nokind["outlet"] = "gog"
	var nk := PKeyBuildStamp.build(nokind)
	t.check("encode: a custom outlet with no kind stamps outletKind \"\" and decides as unknown", nk["outletKind"] == "" and PKeyDecision.resolve_update_outlet({"stamp": nk}) == {"id": null, "kind": "unknown", "subkind": null})
	t.check("encode: no timestamp", not text.to_lower().contains("time") and not text.contains("\"date") and not text.contains("At\""))
	t.check("encode: integers stay integers", text.contains("\"build\": 42,") and text.contains("\"pkeyBuild\": 1,"), text)
	t.check("encode: nested keys sorted", text.find("caskToken") < text.find("steamAppId"))
	t.check("encode: engine and SDK version", doc["engine"] == PKeyBuildStamp.engine_id() and doc["sdkVersion"] == load(PKeyTestFixtures.SDK_SCRIPT).SDK_VERSION and doc["packSources"] == "embedded" and doc["embeddedPacks"] == [])


func _read(t: PKeyTestContext) -> void:
	var s = PKeyBuildStamp.read(FIXTURE)
	if not t.check("read: the fixture stamp", s is Dictionary):
		return
	t.check("read: fields as written", s["outlet"] == "itch" and s["channel"] == "beta" and s["product"] == "djdl" and s["version"] == "1.2.3" and s["platform"] == "macos" and s["arch"] == "arm64")
	t.check("read: build and pkeyBuild come back as ints", s["build"] is int and s["build"] == 7 and s["pkeyBuild"] is int and s["pkeyBuild"] == 1)
	t.check("read: outletIds keeps only string values of known keys", s["outletIds"] == {"itchGameId": "1000"}, JSON.stringify(s["outletIds"]))
	t.check("read: an unknown format version is no stamp", PKeyBuildStamp.read(V2) == null)
	t.check("read: a P1-11 stamp without the v4 fields gains none", not s.has("outletKind") and not s.has("outletSubkind") and not s.has("format"))
	var v4 = PKeyBuildStamp.read(V4)
	t.check("read: the v4 fields come back as strings; a non-string one is dropped", v4 is Dictionary and v4.get("outletKind") == "itch" and v4.get("format") == "zip" and not v4.has("outletSubkind") and v4["outletIds"] == {"homebrewFormula": "diceroll", "itchGameId": "1001"}, JSON.stringify(v4))
	t.check("read: a missing file or empty path is no stamp", PKeyBuildStamp.read("res://tests/fixtures/missing.json") == null and PKeyBuildStamp.read("") == null)
	var f := PKeyBuildStamp.fallback("dev", "djdl")
	t.check("fallback: the project version, build 0, no outlet, the given channel", f["version"] == str(ProjectSettings.get_setting("application/config/version", "")) and f["build"] == 0 and f["outlet"] == "" and f["channel"] == "dev" and f["product"] == "djdl")
	t.check("fallback: this platform and arch", f["platform"] == PKeyHeaders.platform() and f["arch"] == PKeyHeaders.arch())
	t.check("fallback: the stamp's shape", f["pkeyBuild"] == 1 and f["outletIds"] == {} and f["embeddedPacks"] == [] and f["packSources"] == "embedded" and f["engine"] == PKeyBuildStamp.engine_id())
	var d := PKeyBuildStamp.editor_defaults("res://tests/fixtures/missing.tres")
	t.check("editor defaults: without res://polaris_key.tres the version decides", d["product"] == "" and d["channel"] == PKeySemver.channel_for_version(str(ProjectSettings.get_setting("application/config/version", ""))), str(d))


func _opts(stamp: String) -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = "djdl"
	o.version = "1.0.0"
	o.local_only = true
	o.store = PKeyMemoryStore.new()
	o.build_stamp_path = stamp
	return o


func _core(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var o := _opts(FIXTURE)
	o.default_channel = "dev"
	var r: PKeyResult = sdk.configure(o)
	t.check("core: configure with a stamp", r.ok, r.message)
	if r.ok:
		t.check("core: the stamp's channel wins over default_channel", sdk.core.channel == "beta", sdk.core.channel)
		t.check("core: X-PKey-Channel is the stamp's", sdk.core.headers()[PKeyHeaders.CHANNEL] == "beta")
		t.check("core: build_info() is the stamp", sdk.build_info() == PKeyBuildStamp.read(FIXTURE))
		t.check("core: the outlet comes from the stamp", sdk.core.outlet() == "itch")
		await sdk.start()
		t.check("core: the device report carries the stamped outlet", sdk.devices.snapshot().get("outlet") == "itch")
	o = _opts("")
	o.default_channel = "dev"
	r = sdk.configure(o)
	t.check("core: without a stamp default_channel is sent", r.ok and sdk.core.channel == "dev")
	if r.ok:
		var info: Dictionary = sdk.build_info()
		t.check("core: without a stamp build_info() is the fallback with the core's channel and version", info["channel"] == "dev" and info["outlet"] == "" and info["version"] == "1.0.0" and info["build"] == 0 and info["product"] == "djdl", JSON.stringify(info))
		await sdk.start()
		t.check("core: no stamp, no outlet in the report", not sdk.devices.snapshot().has("outlet"))
	r = sdk.configure(_opts(BAD_CHANNEL))
	t.check("core: a malformed stamped channel is refused at configure", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and r.message.contains("build stamp"), r.message)
	sdk.queue_free()
