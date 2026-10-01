class_name PKeyBuildStamp
extends RefCounted
## The build stamp, `res://.polaris_key/build.json` (`pkeyBuild: 1`): which build this is. The
## export plugin (export/export_plugin.gd, P1-11) writes it into every export, per preset and
## overridable from CI; the SDK reads it at run time with FileAccess (data added by `add_file` is
## not imported). The stamp is unsigned local data: tampering only changes what the install
## reports about itself.
##
##   pkeyBuild      1
##   product        the slug in res://polaris_key.tres ("" when there is none)
##   version        application/config/version
##   build          the build number (polaris_key/build_number, PKEY_BUILD_NUMBER), an integer
##   outlet         a report §3.1 outlet id (polaris_key/outlet, PKEY_BUILD_OUTLET)
##   channel        a §5.1 channel name, canonical (polaris_key/channel, PKEY_BUILD_CHANNEL)
##   engine         godot-<major>.<minor>;  engineVersion  the full engine version string
##   platform, arch the report §3.1 values (`universal` for a multi-ABI Android or a universal
##                  macOS export; `wasm32` on web)
##   packSources    `embedded` (until P4-08);  embeddedPacks  [] (until P4-08)
##   debug          a debug export;  sdkVersion  the addon's version
##   outletIds      the product's non-secret outlet identities runtime outlet detection checks
##                  offline (notes/S-06 rule 4): any of OUTLET_ID_KEYS, every value a string
##
## Deterministic: no timestamps, keys sorted, so two exports of one preset are byte-identical.
##
## Without a stamp (the editor, or an export without the plugin) `fallback()` stands in:
## application/config/version, build 0, no outlet, the editor channel (the setup dock's
## `default_channel` in res://polaris_key.tres), the running platform and arch.
##
## The pure functions below (option checks, outlet-id parsing, feature tags, platform and arch)
## are what the export plugin calls, so they are tested without an editor.

const PATH := "res://.polaris_key/build.json"
## The game's options, written by the setup dock (outside addons/, so updates keep it).
const CONFIG_PATH := "res://polaris_key.tres"
const FORMAT := 1

const OPTION_OUTLET := "polaris_key/outlet"
const OPTION_CHANNEL := "polaris_key/channel"
const OPTION_BUILD_NUMBER := "polaris_key/build_number"
const OPTION_OUTLET_IDS := "polaris_key/outlet_ids"
const ENV_OUTLET := "PKEY_BUILD_OUTLET"
const ENV_CHANNEL := "PKEY_BUILD_CHANNEL"
const ENV_BUILD_NUMBER := "PKEY_BUILD_NUMBER"
const ENV_OUTLET_IDS := "PKEY_OUTLET_IDS"

const DEFAULT_CHANNEL := "stable"
const PACK_SOURCES := "embedded"

## Report §3.1's outlet ids, in one table until P1b-02 generates the enum.
const OUTLETS := [
	"direct", "app-store", "testflight", "altstore", "altstore-pal", "play", "play-testing",
	"obtainium", "fdroid-repo", "ms-store", "app-installer", "steam", "itch", "flathub", "snap",
	"winget", "web",
]
## The outlet a preset gets until it says otherwise, by report §3.1 platform.
const DEFAULT_OUTLETS := {"android": "play", "ios": "app-store", "web": "web"}

## The `outletIds` keys (notes/S-06; `pkey distribution outlet-ids` prints all but bundleId).
const OUTLET_ID_KEYS := ["steamAppId", "itchGameId", "flatpakId", "snapName", "caskToken", "msixFamilyName", "bundleId"]
## The preset option that carries the bundle id, by report §3.1 platform.
const BUNDLE_ID_OPTIONS := {
	"ios": "application/bundle_identifier",
	"macos": "application/bundle_identifier",
	"android": "package/unique_name",
}

## Export feature tag -> report §3.1 arch.
const ARCH_FEATURES := {
	"x86_64": "x86_64",
	"arm64": "arm64",
	"arm32": "armv7",
	"wasm32": "wasm32",
	"x86_32": "x86_32",
}


# ── Reading (run time) ─────────────────────────────────────────────────────────────────────

## The stamp at `path`, or null when there is none or it is not a `pkeyBuild: 1` object.
## Numbers come back as ints (`build`), strings and the rest as written.
static func read(path := PATH) -> Variant:
	if path == "" or not FileAccess.file_exists(path):
		return null
	var parsed := PKeyJson.parse(FileAccess.get_file_as_string(path))
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return null
	var doc: Dictionary = parsed["value"]
	var v = doc.get("pkeyBuild")
	if not (PKeyClaims.is_number(v) and float(v) == float(FORMAT)):
		return null
	doc["pkeyBuild"] = FORMAT
	var b = doc.get("build")
	doc["build"] = int(b) if PKeyClaims.is_number(b) and float(b) == floor(float(b)) else 0
	for key in ["product", "version", "outlet", "channel", "engine", "engineVersion", "platform", "arch", "packSources", "sdkVersion"]:
		if not (doc.get(key) is String):
			doc[key] = ""
	if not (doc.get("embeddedPacks") is Array):
		doc["embeddedPacks"] = []
	if not (doc.get("debug") is bool):
		doc["debug"] = false
	var ids := {}
	if doc.get("outletIds") is Dictionary:
		for k in doc["outletIds"]:
			if OUTLET_ID_KEYS.has(k) and doc["outletIds"][k] is String:
				ids[k] = doc["outletIds"][k]
	doc["outletIds"] = ids
	return doc


## What a build without a stamp reports: the project's version, build 0, no outlet, `channel`
## (the editor channel), this machine's platform and arch.
static func fallback(channel: String, product := "", version := "") -> Dictionary:
	var v := version if version != "" else str(ProjectSettings.get_setting("application/config/version", ""))
	var info := Engine.get_version_info()
	return {
		"pkeyBuild": FORMAT,
		"product": product,
		"version": v,
		"build": 0,
		"outlet": "",
		"channel": channel,
		"engine": engine_id(),
		"engineVersion": str(info.get("string", "")),
		"platform": PKeyHeaders.platform(),
		"arch": PKeyHeaders.arch(),
		"packSources": PACK_SOURCES,
		"embeddedPacks": [],
		"debug": OS.is_debug_build(),
		"sdkVersion": sdk_version(),
		"outletIds": {},
	}


## The editor channel and product from res://polaris_key.tres (the setup dock's file): the
## channel PKeyCore would send for it, or `stable`/derived when the file is absent.
## {product, channel}.
static func editor_defaults(config_path := CONFIG_PATH) -> Dictionary:
	var product := ""
	var channel_option := ""
	var version := str(ProjectSettings.get_setting("application/config/version", ""))
	if config_path != "" and ResourceLoader.exists(config_path):
		var opts = load(config_path)
		if opts is PKeyOptions:
			# Properties only: in the editor a loaded non-tool resource may be a placeholder.
			product = str(opts.get("product"))
			channel_option = str(opts.get("default_channel"))
			if str(opts.get("version")) != "":
				version = str(opts.get("version"))
	var channel = PKeyChannel.header_for(channel_option, version)
	return {"product": product, "channel": channel if channel != null else channel_option}


## `godot-<major>.<minor>` for the running engine.
static func engine_id() -> String:
	var info := Engine.get_version_info()
	return "godot-%d.%d" % [int(info.get("major", 0)), int(info.get("minor", 0))]


static func sdk_version() -> String:
	var root: Script = load("res://addons/polaris_key/polaris_key.gd")
	return str(root.get_script_constant_map().get("SDK_VERSION", "")) if root != null else ""


# ── Export-side checks (pure; the export plugin's dialog warnings and push_warnings) ────────

## The default outlet for a report §3.1 platform: `direct` on the desktop.
static func default_outlet(platform: String) -> String:
	return DEFAULT_OUTLETS.get(platform, "direct")


## "" or the warning for an outlet id outside report §3.1.
static func outlet_warning(outlet: String) -> String:
	if OUTLETS.has(outlet):
		return ""
	return "Unknown outlet '%s'. Use one of: %s." % [outlet, ", ".join(OUTLETS)]


## The channel to stamp: the canonical §5.1 name (aliases rewritten, `pr<n>` as `pr-<n>`), the
## version-implied family for "", or null when the value is malformed.
static func canonical_channel(channel: String, version: String) -> Variant:
	if channel == "":
		return PKeySemver.channel_for_version(version) if PKeySemver.is_valid(version) else DEFAULT_CHANNEL
	if channel == PKeyConstants.CHANNEL_PR:
		return channel
	return PKeyChannel.normalize_header(channel, version)


## "" or the warning for a channel outside the §5.1 vocabulary (or an alias that is stamped as
## its canonical name).
static func channel_warning(channel: String, version: String) -> String:
	var c = canonical_channel(channel, version)
	if c == null:
		return "Channel '%s' is not a channel name: use stable, beta, pr-<n>, dev or a manual channel matching %s." % [channel, PKeyConstants.CHANNEL_NAME_PATTERN]
	if channel != "" and c != channel:
		return "Channel '%s' is stamped as '%s'." % [channel, c]
	return ""


## "" or the warning for a version that is not semver (PolarisKey.configure refuses it).
static func version_warning(version: String) -> String:
	if PKeySemver.is_valid(version):
		return ""
	return "application/config/version '%s' is not semver; PolarisKey.configure() will refuse this build." % version


## The build number from an option (int) or the environment (a decimal string).
## {value: int, problem: String}.
static func parse_build_number(raw: Variant) -> Dictionary:
	if raw is int:
		return {"value": raw, "problem": ""} if raw >= 0 else {"value": 0, "problem": "build number must not be negative, got %d" % raw}
	if raw is float and raw == floor(raw) and raw >= 0:
		return {"value": int(raw), "problem": ""}
	if raw is String:
		var s: String = raw.strip_edges()
		if s == "":
			return {"value": 0, "problem": ""}
		if RegEx.create_from_string("\\A[0-9]{1,15}\\z").search(s) != null:
			return {"value": int(s), "problem": ""}
	return {"value": 0, "problem": "build number must be a non-negative integer, got '%s'" % str(raw)}


## Parse the polaris_key/outlet_ids value (or PKEY_OUTLET_IDS): a JSON object of OUTLET_ID_KEYS
## to strings. "" means {}. Bad keys are dropped, never the whole object unless it is not one.
## {ids: Dictionary, problems: Array[String]}.
static func parse_outlet_ids(raw: Variant) -> Dictionary:
	var problems: Array[String] = []
	var value = raw
	if raw is String:
		var text: String = raw.strip_edges()
		if text == "":
			return {"ids": {}, "problems": problems}
		var parsed := PKeyJson.parse(text)
		if not parsed["ok"]:
			problems.append("is not valid JSON")
			return {"ids": {}, "problems": problems}
		value = parsed["value"]
	elif raw == null:
		return {"ids": {}, "problems": problems}
	if not (value is Dictionary):
		problems.append("is not a JSON object")
		return {"ids": {}, "problems": problems}
	var ids := {}
	var keys: Array = value.keys()
	keys.sort()
	for k in keys:
		if not OUTLET_ID_KEYS.has(k):
			problems.append("has an unknown key '%s' (allowed: %s)" % [str(k), ", ".join(OUTLET_ID_KEYS)])
		elif not (value[k] is String):
			problems.append("has a non-string value for '%s' (%s); quote it" % [k, _show(value[k])])
		elif value[k] == "":
			continue
		else:
			ids[k] = value[k]
	return {"ids": ids, "problems": problems}


static func _show(v: Variant) -> String:
	if v is float and is_finite(v) and v == floor(v) and absf(v) < 1e15:
		return str(int(v))
	return JSON.stringify(v)


## "" or one warning listing every problem with an outlet_ids value.
static func outlet_ids_warning(raw: Variant) -> String:
	var p: Array = parse_outlet_ids(raw)["problems"]
	if p.is_empty():
		return ""
	return "outlet_ids %s; those keys are left out of the stamp." % "; ".join(p)


## Merge the preset's bundle id over the option's. {ids, problems}: a different bundleId in the
## option is a problem, and the preset's value wins.
static func merge_bundle_id(ids: Dictionary, preset_bundle_id: String) -> Dictionary:
	var out := ids.duplicate()
	var problems: Array[String] = []
	if preset_bundle_id == "":
		return {"ids": out, "problems": problems}
	if out.has("bundleId") and out["bundleId"] != preset_bundle_id:
		problems.append("outlet_ids bundleId '%s' differs from the preset's '%s'; the preset's is stamped" % [out["bundleId"], preset_bundle_id])
	out["bundleId"] = preset_bundle_id
	return {"ids": out, "problems": problems}


## Android's `$genname` placeholder, resolved the way the Android exporter does.
static func resolve_bundle_id(raw: String) -> String:
	if not raw.contains("$genname"):
		return raw
	var name := str(ProjectSettings.get_setting("application/config/name", "")).to_lower()
	var gen := ""
	for i in name.length():
		var c := name[i]
		if (c >= "a" and c <= "z") or (c >= "0" and c <= "9") or c == "_":
			gen += c
	if gen == "" or (gen[0] >= "0" and gen[0] <= "9"):
		gen = "noname" + gen
	return raw.replace("$genname", gen)


## The feature tags for an outlet and channel: pkey_outlet_<id>, pkey_channel_<channel>, with
## `-` mapped to `_` (pkey_outlet_app_store, pkey_channel_pr_12).
static func feature_tags(outlet: String, channel: String) -> PackedStringArray:
	var out := PackedStringArray()
	if outlet != "":
		out.append("pkey_outlet_" + outlet.replace("-", "_"))
	if channel != "":
		out.append("pkey_channel_" + channel.replace("-", "_"))
	return out


## The canonical platform (WIRE-CONTRACT-V3 §5.2) for an EditorExportPlatform OS name (`Linux`,
## `macOS`, …) through PKeyHeaders.canonical_platform, else from the export features
## (`Windows Desktop` has no spelling of its own).
static func platform_for(os_name: String, features: PackedStringArray) -> String:
	var canonical := PKeyHeaders.canonical_platform(os_name)
	if canonical != "":
		return canonical
	for p in ["windows", "macos", "linux", "android", "ios", "web"]:
		if features.has(p):
			return p
	return ""


## The report §3.1 arch for an export: `wasm32` on web, `universal` for a universal macOS export
## or more than one Android ABI, else the one architecture feature ("" when none is known).
static func arch_for(platform: String, features: PackedStringArray) -> String:
	if platform == "web":
		return "wasm32"
	if features.has("universal"):
		return "universal"
	var archs: Array[String] = []
	for f in features:
		if ARCH_FEATURES.has(f) and not archs.has(ARCH_FEATURES[f]):
			archs.append(ARCH_FEATURES[f])
	if archs.size() > 1:
		return "universal"
	if archs.size() == 1 and PKeyConstants.ARCH_VALUES.has(archs[0]):
		return archs[0]
	return ""


## Assemble a stamp. `inputs`: product, version, build, outlet, channel, platform, arch, debug,
## outlet_ids. The engine fields and the SDK version are this editor's.
static func build(inputs: Dictionary) -> Dictionary:
	return {
		"pkeyBuild": FORMAT,
		"product": str(inputs.get("product", "")),
		"version": str(inputs.get("version", "")),
		"build": int(inputs.get("build", 0)),
		"outlet": str(inputs.get("outlet", "")),
		"channel": str(inputs.get("channel", "")),
		"engine": engine_id(),
		"engineVersion": str(Engine.get_version_info().get("string", "")),
		"platform": str(inputs.get("platform", "")),
		"arch": str(inputs.get("arch", "")),
		"packSources": PACK_SOURCES,
		"embeddedPacks": [],
		"debug": bool(inputs.get("debug", false)),
		"sdkVersion": sdk_version(),
		"outletIds": inputs.get("outlet_ids", {}).duplicate(),
	}


## The stamp's bytes: sorted keys, two-space indent, a trailing newline.
static func encode(stamp: Dictionary) -> PackedByteArray:
	return (JSON.stringify(stamp, "  ", true) + "\n").to_utf8_buffer()
