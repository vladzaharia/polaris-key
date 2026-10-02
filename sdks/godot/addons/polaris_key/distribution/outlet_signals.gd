class_name PKeyOutletSignals
extends RefCounted
## The Godot runtime's outlet signals (plans/P3-01.md §2.9, §4.7; notes/S-06 §10), read in pure
## GDScript through a PKeyOutletEnv:
##
##   signal                    read from
##   ────────────────────────  ────────────────────────────────────────────────────────────────
##   linux.flatpakInfo         /.flatpak-info's [Application] name (FLATPAK_ID is an inherited
##                             environment variable and is not evidence)
##   linux.snapEnv             SNAP_NAME, SNAP_REVISION
##   linux.appImageEnv         APPIMAGE, APPDIR and OS.get_executable_path()
##   steam.libraryManifest     <library>/steamapps/appmanifest_<steamAppId>.acf naming this install
##   steam.appIdEnv            SteamAppId, SteamClientLaunch
##   itch.receipt              the nearest .itch/receipt.json.gz above the executable: game.id
##   itch.appEnv               ITCHIO_APP=1 (diagnostic only)
##   macos.masReceipt          <bundle>/Contents/_MASReceipt/receipt
##   macos.receiptSandbox      ProductionSandbox in that receipt (TestFlight)
##   macos.signingLeaf         the leaf certificate's name in the Mach-O tail (`none` when no
##                             known leaf is there: ad hoc and unsigned bundles)
##   macos.homebrewCask        <prefix>/Caskroom/<caskToken>/<version>/<App>.app links here
##   windows.*                 the windows_package() hook (unavailable for now) and the
##                             WinGet/Scoop/Chocolatey path conventions
##   android.installSource     getInstallSourceInfo with the initiator's certificate SHA-256
##   android.installerMismatch installer != initiator, from the same call
##   ios.appDistributor        the ios_app_distributor() hook (unavailable until P5-05)
##   web.displayMode           JavaScriptBridge (a web export)
##
## The stamp comes from PolarisKey.build_info() (the export plugin's build.json); without one, a
## `pkey_outlet_<kind>` feature tag stands in (feature_tag_stamp()), and a web export synthesises
## `outletKind: web`. The MAPPING is PKeyOutlet.detect_outlet; this file only reads markers. It
## never enumerates installed applications (AGENTS rule 7): a launcher's file is read only under
## the product's own identity (appmanifest_<steamAppId>.acf, Caskroom/<caskToken>/), and raw
## values never leave the device. steam_appid.txt is not read (S-06 refuted it), nor the macOS
## provisioning profile.

## The Mach-O tail searched for the leaf certificate's name.
const TAIL_BYTES := 65536

## The leaf names the Mach-O tail search recognises, store leaves first. Only the two store
## leaves select an outlet; the rest (and no leaf) veto app-store and testflight alike.
static var KNOWN_LEAVES := PackedStringArray([
	"TestFlight Beta Distribution", "Apple Mac OS Application Signing", "Developer ID Application",
	"Apple Distribution", "Apple Development", "Mac Developer", "3rd Party Mac Developer Application",
])
static var _cask_prefixes := PackedStringArray(["/opt/homebrew/Caskroom", "/usr/local/Caskroom"])


## Read this runtime's outlet signals through `env` (the real runtime when null). `outlet_ids`
## (the stamp's) says which launcher files to read. Every reader is independent and silent: one
## that cannot read its marker records nothing.
static func read_outlet_signals(env: PKeyOutletEnv = null, outlet_ids: Dictionary = {}) -> Dictionary:
	var e := env if env != null else PKeyOutletEnv.new()
	var out := {}
	var platform := e.platform()
	var exe := e.executable_path()
	match platform:
		"linux":
			_linux(e, exe, out)
		"macos":
			_macos(e, exe, outlet_ids, out)
		"windows":
			_windows(e, exe, out)
		"android":
			_android(e, out)
		"ios":
			var d = e.ios_app_distributor()
			if d is String and d != "":
				out["ios.appDistributor"] = d
		"web":
			var mode := e.web_display_mode()
			if mode != "":
				out["web.displayMode"] = mode
	if platform in ["linux", "macos", "windows"]:
		_steam(e, exe, outlet_ids, out)
		_itch(e, exe, out)
	return out


## The stamp a `pkey_outlet_<kind>` feature tag implies, for a build without build.json (the
## export plugin adds the tag beside the stamp), or null. Only the 17 kinds are recognised.
static func feature_tag_stamp(env: PKeyOutletEnv = null) -> Variant:
	var e := env if env != null else PKeyOutletEnv.new()
	for kind in PackedStringArray(PKeyConstants.OUTLET_KIND_VALUES):
		if e.has_feature("pkey_outlet_" + kind.replace("-", "_")):
			return {"outlet": kind, "outletKind": kind}
	return null


static func _linux(e: PKeyOutletEnv, exe: String, out: Dictionary) -> void:
	if e.file_exists("/.flatpak-info"):
		var name := _ini_value(e.read_bytes("/.flatpak-info").get_string_from_utf8(), "Application", "name")
		if name != "":
			out["linux.flatpakInfo"] = name
	var snap := e.env("SNAP_NAME")
	if snap != "":
		var rev := e.env("SNAP_REVISION")
		out["linux.snapEnv"] = {"name": snap, "revision": rev if rev != "" else null}
	var appimage := e.env("APPIMAGE")
	var appdir := e.env("APPDIR")
	if appimage != "" and appdir != "":
		out["linux.appImageEnv"] = {"appImage": appimage, "appDir": appdir, "exePath": exe}


static func _ini_value(text: String, section: String, key: String) -> String:
	var current := ""
	for raw in text.split("\n"):
		var line := raw.strip_edges()
		if line.begins_with("[") and line.ends_with("]"):
			current = line.substr(1, line.length() - 2)
		elif current == section and line.begins_with(key + "="):
			return line.substr(key.length() + 1).strip_edges()
	return ""


static func _macos(e: PKeyOutletEnv, exe: String, ids: Dictionary, out: Dictionary) -> void:
	var i := exe.find(".app/Contents/MacOS/")
	if i < 0:
		return
	var bundle := exe.substr(0, i + 4)
	var receipt := bundle.path_join("Contents/_MASReceipt/receipt")
	var exists := e.file_exists(receipt)
	out["macos.masReceipt"] = exists
	if exists:
		out["macos.receiptSandbox"] = _contains_ascii(e.read_bytes(receipt), "ProductionSandbox")
	var tail := e.read_tail(exe, TAIL_BYTES)
	if not tail.is_empty():
		var leaf := "none"
		for cn in KNOWN_LEAVES:
			if _contains_ascii(tail, cn):
				leaf = cn
				break
		out["macos.signingLeaf"] = leaf
	var token = ids.get("caskToken")
	if token is String and RegEx.create_from_string("^[a-z0-9][a-z0-9@._+-]*$").search(token) != null:
		var app := bundle.get_file()
		for prefix in _cask_prefixes:
			var root := prefix.path_join(token)
			for version in e.directories(root):
				if e.link_target(root.path_join(version).path_join(app)) == bundle:
					out["macos.homebrewCask"] = token
					return


## True when `bytes` holds `marker`'s ASCII bytes (an even hex offset is a byte boundary).
static func _contains_ascii(bytes: PackedByteArray, marker: String) -> bool:
	if bytes.is_empty():
		return false
	var hex := bytes.hex_encode()
	var needle := marker.to_ascii_buffer().hex_encode()
	var at := hex.find(needle)
	while at >= 0 and at % 2 == 1:
		at = hex.find(needle, at + 1)
	return at >= 0


static func _windows(e: PKeyOutletEnv, exe: String, out: Dictionary) -> void:
	var pkg = e.windows_package()
	if pkg is Dictionary and pkg.get("packageIdentity") is String:
		out["windows.packageIdentity"] = pkg["packageIdentity"]
		for k in ["signatureKind", "appInstallerUri", "externalLocation"]:
			if pkg.has(k):
				out["windows." + k] = pkg[k]
	var p := exe.replace("\\", "/").to_lower()
	if p.contains("/microsoft/winget/packages/"):
		out["windows.pathConvention"] = "winget"
	elif p.contains("/scoop/apps/"):
		out["windows.pathConvention"] = "scoop"
	elif p.contains("/chocolatey/lib/"):
		out["windows.pathConvention"] = "chocolatey"


static func _android(e: PKeyOutletEnv, out: Dictionary) -> void:
	var src = e.android_install_source()
	if not (src is Dictionary):
		return
	out["android.installSource"] = src
	out["android.installerMismatch"] = src.get("installer") != src.get("initiator")


static func _steam(e: PKeyOutletEnv, exe: String, ids: Dictionary, out: Dictionary) -> void:
	var app_id = ids.get("steamAppId")
	if app_id is String and RegEx.create_from_string("^[0-9]+$").search(app_id) != null:
		var m := RegEx.create_from_string("(?i)^(.*)/steamapps/common/([^/]+)/").search(exe.replace("\\", "/"))
		if m != null:
			var manifest := m.get_string(1).path_join("steamapps/appmanifest_%s.acf" % app_id)
			var text := e.read_bytes(manifest).get_string_from_utf8()
			var appid := _acf_value(text, "appid")
			if appid != "" and _acf_value(text, "installdir").to_lower() == m.get_string(2).to_lower():
				out["steam.libraryManifest"] = appid
	var env_id := e.env("SteamAppId")
	if env_id != "":
		out["steam.appIdEnv"] = {"appId": env_id, "clientLaunch": e.env("SteamClientLaunch") == "1"}


static func _acf_value(text: String, key: String) -> String:
	var m := RegEx.create_from_string("(?i)\"%s\"\\s+\"([^\"]*)\"" % key).search(text)
	return m.get_string(1) if m != null else ""


static func _itch(e: PKeyOutletEnv, exe: String, out: Dictionary) -> void:
	var dir := exe.replace("\\", "/").get_base_dir()
	for _i in range(12):
		if dir == "":
			break
		var receipt := dir.path_join(".itch/receipt.json.gz")
		if e.file_exists(receipt):
			var raw := e.read_bytes(receipt)
			var json := raw.decompress_dynamic(1 << 24, FileAccess.COMPRESSION_GZIP) if not raw.is_empty() else PackedByteArray()
			var parsed = JSON.parse_string(json.get_string_from_utf8()) if not json.is_empty() else null
			if parsed is Dictionary and parsed.get("game") is Dictionary:
				var id = parsed["game"].get("id")
				# JSON parses game.id as a float: compare it as a decimal string (S-06).
				if id is float and is_finite(id) and id >= 0 and id == floor(id) and id <= 9007199254740991.0:
					out["itch.receipt"] = str(int(id))
			break
		var up := dir.get_base_dir()
		if up == dir:
			break
		dir = up
	if e.env("ITCHIO_APP") == "1":
		out["itch.appEnv"] = true
