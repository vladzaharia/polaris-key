extends RefCounted
# @pkey-feature devices.facts
# PKeyFacts: the DeviceFacts shape on this host, product-declared probes (and nothing else),
# locale and IANA timezone normalisation, and the `engine` and `outlet` report keys.


func run(t: PKeyTestContext) -> void:
	_shape(t)
	_probes(t)
	_normalisers(t)
	_engine(t)


func _shape(t: PKeyTestContext) -> void:
	var f := PKeyFacts.collect()
	t.check("facts: os has name and kernel", f.get("os") is Dictionary and f["os"].get("name") is String and f["os"].get("kernel") == OS.get_name(), JSON.stringify(f.get("os")))
	t.check("facts: os.name is the Node family form", f["os"]["name"] == PKeyFacts.OS_NAMES.get(OS.get_name(), OS.get_name().to_lower()))
	t.check("facts: runtime is godot with the engine version", f.get("runtime") == {"name": "godot", "version": Engine.get_version_info()["string"]}, JSON.stringify(f.get("runtime")))
	var hw = f.get("hardware")
	t.check("facts: hardware carries the core count", hw is Dictionary and hw.get("cpuCores") == OS.get_processor_count(), JSON.stringify(hw))
	t.check("facts: ramMb is an integer when present", not hw.has("ramMb") or (hw["ramMb"] is int and hw["ramMb"] > 0))
	t.check("facts: no GenericDevice model", hw.get("machineModel", "") != "GenericDevice")
	t.check("facts: locale is BCP 47", not f.has("locale") or not String(f["locale"]).contains("_"), str(f.get("locale")))
	t.check("facts: timezone, when present, is an IANA name", not f.has("timezone") or PKeyFacts.is_iana(f["timezone"]), str(f.get("timezone")))
	t.check("facts: no probes key without declarations", not f.has("probes"))
	for k in f:
		t.check("facts: %s is a DeviceFacts key" % k, ["os", "hardware", "runtime", "locale", "timezone", "probes"].has(k))


## Only declared paths are tested; a probe without a target on this OS is left out.
func _probes(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("probes")
	var app := dir.path_join("Companion.app")
	DirAccess.make_dir_recursive_absolute(app.path_join("Contents"))
	var plist := FileAccess.open(app.path_join("Contents/Info.plist"), FileAccess.WRITE)
	plist.store_string("<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>7.0.1</string></dict></plist>")
	plist.close()
	var file := dir.path_join("tool.bin")
	FileAccess.open(file, FileAccess.WRITE).store_string("x")
	var abs_app := ProjectSettings.globalize_path(app)
	var abs_file := ProjectSettings.globalize_path(file)
	var missing := ProjectSettings.globalize_path(dir.path_join("absent"))
	var decls := [
		{"id": "companion", "macos": abs_app, "windows": abs_app, "linux": abs_app},
		{"id": "tool", "macos": abs_file, "windows": abs_file, "linux": abs_file},
		{"id": "absent", "macos": missing, "windows": missing, "linux": missing},
		{"id": "elsewhere"},
		{"label": "no id", "linux": abs_file},
		"not a declaration",
	]
	var r := PKeyFacts.run_probes(decls)
	if not OS.has_feature("pc"):
		t.check("probes: none off the desktop", r.is_empty())
		return
	t.check("probes: a present directory", r.get("companion", {}).get("present") == true, JSON.stringify(r))
	t.check("probes: a present file", r.get("tool", {}).get("present") == true)
	t.check("probes: an absent path is present:false", r.get("absent") == {"present": false})
	t.check("probes: no target on this OS is not applicable (left out)", not r.has("elsewhere"))
	t.check("probes: a declaration without an id is skipped", r.size() == 3, str(r.keys()))
	if OS.get_name() == "macOS":
		t.check("probes: a macOS bundle reports its version", r["companion"].get("version") == "7.0.1")
	var many: Array = []
	for i in 40:
		many.append({"id": "p%d" % i, "macos": abs_file, "windows": abs_file, "linux": abs_file})
	t.check("probes: at most 32", PKeyFacts.run_probes(many).size() == PKeyFacts.MAX_PROBES)
	var f := PKeyFacts.collect(decls)
	t.check("facts: probes ride in the facts", f.get("probes") == r)
	PKeyTestFixtures.remove_tree(dir)


func _normalisers(t: PKeyTestContext) -> void:
	t.check("locale: en_US", PKeyFacts.bcp47("en_US") == "en-US")
	t.check("locale: en_US.UTF-8", PKeyFacts.bcp47("en_US.UTF-8") == "en-US")
	t.check("locale: sr_Latn_RS", PKeyFacts.bcp47("sr_Latn_RS") == "sr-Latn-RS")
	t.check("tz: macOS link", PKeyFacts.iana_from_zoneinfo_path("/var/db/timezone/zoneinfo/America/Los_Angeles") == "America/Los_Angeles")
	t.check("tz: relative Linux link", PKeyFacts.iana_from_zoneinfo_path("../usr/share/zoneinfo/Europe/Paris") == "Europe/Paris")
	t.check("tz: posix/ prefix", PKeyFacts.iana_from_zoneinfo_path("/usr/share/zoneinfo/posix/Asia/Tokyo") == "Asia/Tokyo")
	t.check("tz: three levels", PKeyFacts.iana_from_zoneinfo_path("/usr/share/zoneinfo/America/Argentina/Buenos_Aires") == "America/Argentina/Buenos_Aires")
	t.check("tz: not a zoneinfo path", PKeyFacts.iana_from_zoneinfo_path("/etc/localtime") == "")
	t.check("tz: an abbreviation is not IANA", not PKeyFacts.is_iana("PDT") and not PKeyFacts.is_iana("Pacific Daylight Time"))
	t.check("tz: UTC is", PKeyFacts.is_iana("UTC"))


func _engine(t: PKeyTestContext) -> void:
	var e := PKeyFacts.engine()
	var info := Engine.get_version_info()
	t.check("engine: id is godot-<major>.<minor>", e.get("id") == "godot-%d.%d" % [info["major"], info["minor"]], str(e.get("id")))
	t.check("engine: version and debug", e.get("version") == info["string"] and e.get("debug") == OS.is_debug_build())
	var known := ["id", "version", "renderer", "videoAdapter", "videoVendor", "videoApi", "display", "debug"]
	var only_known := true
	for k in e:
		only_known = only_known and known.has(k)
		if k != "debug":
			only_known = only_known and e[k] is String and e[k] != ""
	t.check("engine: only the Worker's known fields, no empty strings", only_known, JSON.stringify(e))
	t.check("engine: renderer is the rendering method", e.get("renderer", "") in ["forward_plus", "mobile", "gl_compatibility", "dummy", ""], str(e.get("renderer")))
	t.check("outlet: no build stamp means no outlet", FileAccess.file_exists(PKeyFacts.BUILD_STAMP) or PKeyFacts.outlet() == "")
