extends RefCounted
# S-06 outlet-signal probe: reads every outlet signal that pure GDScript can reach and prints one
# JSON document. Run through the prototype's runner:
#   godot --headless --path . --script res://tests/cli.gd -- outlet          (editor)
#   ./build/<app> --headless -- outlet                                       (exported template)
# Nothing here decides an outlet; it only records raw observations for notes/S-06.md.
# The home directory is rewritten to "~" and secrets (ITCHIO_API_KEY) are reduced to a length.

const ENV_KEYS := [
	# Linux sandboxes and bundles
	"FLATPAK_ID", "container", "SNAP", "SNAP_NAME", "SNAP_REVISION", "SNAP_INSTANCE_NAME",
	"SNAP_USER_DATA", "APPIMAGE", "APPDIR", "OWD", "ARGV0",
	# Steam client and Proton
	"SteamAppId", "SteamGameId", "SteamOverlayGameId", "SteamClientLaunch", "SteamEnv",
	"STEAM_COMPAT_APP_ID", "STEAM_COMPAT_DATA_PATH", "STEAM_COMPAT_CLIENT_INSTALL_PATH",
	"SteamDeck", "WINEPREFIX",
	# itch app (butler endpoints/launch/launch.go)
	"ITCHIO_APP", "ITCHIO_API_KEY", "ITCHIO_API_KEY_EXPIRES_AT", "ITCHIO_OFFLINE_MODE",
	# Windows path roots, for the path-convention checks
	"LOCALAPPDATA", "ProgramFiles", "ProgramData", "SCOOP", "ChocolateyInstall",
	# macOS
	"APP_SANDBOX_CONTAINER_ID", "XPC_SERVICE_NAME", "__CFBundleIdentifier",
	# Polaris build-stamp override used by CI (P1-11)
	"PKEY_OUTLET",
]

const SECRET_ENV := ["ITCHIO_API_KEY"]

var _home := ""


func run(args: PackedStringArray) -> void:
	# `outlet acf <steamapps dir>`: parse every appmanifest in a real library, read-only.
	if args.size() >= 2 and args[0] == "acf":
		var d := DirAccess.open(args[1])
		var rows := []
		for f in d.get_files():
			if f.begins_with("appmanifest_") and f.ends_with(".acf"):
				var kv := _vdf_flat(FileAccess.get_file_as_string(args[1].path_join(f)))
				rows.append({"file": f, "appid": kv.get("appid"), "installdir": kv.get("installdir"),
					"buildid": kv.get("buildid"), "BetaKey": kv.get("BetaKey", ""), "StateFlags": kv.get("StateFlags")})
		print("OUTLET_ACF_JSON ", JSON.stringify(rows))
		return
	# `outlet bundle <path.app>`: run the macOS bundle checks against another installed app, read-only.
	if args.size() >= 2 and args[0] == "bundle":
		_home = OS.get_environment("HOME")
		print("OUTLET_BUNDLE_JSON ", JSON.stringify(_macos_bundle(args[1])))
		return
	var t0 := Time.get_ticks_usec()
	var out := collect()
	out["probe_usec"] = Time.get_ticks_usec() - t0
	print("OUTLET_PROBE_JSON ", JSON.stringify(out, "", true))


func collect() -> Dictionary:
	_home = OS.get_environment("HOME")
	if _home == "":
		_home = OS.get_environment("USERPROFILE")
	var exe := OS.get_executable_path()
	var out := {
		"os": OS.get_name(),
		"os_version": OS.get_version(),
		"distribution": OS.get_distribution_name(),
		"engine": Engine.get_version_info().string,
		"debug_build": OS.is_debug_build(),
		"is_sandboxed": OS.is_sandboxed(),
		"executable": _redact(exe),
		"res_dir": _redact(ProjectSettings.globalize_path("res://")),
		"user_data_dir": _redact(OS.get_user_data_dir()),
		"feature_tags": _outlet_tags(),
		"env": _env(),
	}
	out["linux"] = _linux()
	out["steam"] = _steam(exe)
	out["itch"] = _itch(exe)
	out["macos"] = _macos(exe) if OS.get_name() == "macOS" else null
	out["windows_paths"] = _windows_paths(exe)
	out["ios"] = _ios(exe) if OS.get_name() == "iOS" else null
	out["android"] = _android() if OS.get_name() == "Android" else null
	return out


func _redact(p: String) -> String:
	if _home != "" and p.begins_with(_home):
		return "~" + p.substr(_home.length())
	return p


func _outlet_tags() -> Array:
	var on := []
	for t in ["pkey_outlet_direct", "pkey_outlet_steam", "pkey_outlet_itch", "pkey_outlet_app-store",
			"pkey_outlet_play", "pkey_outlet_flathub", "pkey_outlet_snap", "pkey_outlet_ms-store",
			"template", "editor", "macos", "windows", "linuxbsd", "android", "ios", "web"]:
		if OS.has_feature(t):
			on.append(t)
	return on


func _env() -> Dictionary:
	var env := {}
	for k in ENV_KEYS:
		if OS.has_environment(k):
			var v := OS.get_environment(k)
			env[k] = ("<%d chars>" % v.length()) if k in SECRET_ENV else _redact(v)
	return env


# --- Linux ---------------------------------------------------------------------------------------

func _linux() -> Dictionary:
	var r := {"flatpak_info_exists": FileAccess.file_exists("/.flatpak-info")}
	if r["flatpak_info_exists"]:
		var s := FileAccess.get_file_as_string("/.flatpak-info")
		r["flatpak_info_application_name"] = _ini_value(s, "Application", "name")
		r["flatpak_info_runtime"] = _ini_value(s, "Application", "runtime")
		r["flatpak_info_flatpak_version"] = _ini_value(s, "Instance", "flatpak-version")
		r["flatpak_info_branch"] = _ini_value(s, "Instance", "branch")
	return r


func _ini_value(text: String, section: String, key: String) -> String:
	var cur := ""
	for line in text.split("\n"):
		line = line.strip_edges()
		if line.begins_with("[") and line.ends_with("]"):
			cur = line.substr(1, line.length() - 2)
		elif cur == section and line.begins_with(key + "="):
			return line.substr(key.length() + 1)
	return ""


# --- Steam ---------------------------------------------------------------------------------------

func _steam(exe: String) -> Dictionary:
	var t0 := Time.get_ticks_usec()
	var r := {}
	# steam_appid.txt: next to the executable, in the working directory, and (macOS) in Resources.
	var candidates := [exe.get_base_dir().path_join("steam_appid.txt")]
	if OS.get_name() == "macOS":
		candidates.append(exe.get_base_dir().get_base_dir().path_join("Resources/steam_appid.txt"))
	var found := []
	for c in candidates:
		if FileAccess.file_exists(c):
			found.append({"path": _redact(c), "content": FileAccess.get_file_as_string(c).strip_edges()})
	r["steam_appid_txt"] = found
	# Library layout: <library>/steamapps/common/<installdir>/... ; manifest at <library>/steamapps/appmanifest_<id>.acf
	var parts := exe.replace("\\", "/").split("/")
	var idx := -1
	for i in range(parts.size() - 2, 0, -1):
		if parts[i] == "common" and parts[i - 1].to_lower() == "steamapps":
			idx = i
			break
	if idx < 0:
		r["library"] = null
	else:
		var steamapps := "/".join(parts.slice(0, idx))
		var installdir := parts[idx + 1]
		r["library"] = _redact(steamapps.get_base_dir())
		r["installdir"] = installdir
		r["manifest"] = _find_acf(steamapps, installdir)
	r["usec"] = Time.get_ticks_usec() - t0
	return r


func _find_acf(steamapps: String, installdir: String):
	var d := DirAccess.open(steamapps)
	if d == null:
		return {"error": "cannot open steamapps: %d" % DirAccess.get_open_error()}
	for f in d.get_files():
		if not (f.begins_with("appmanifest_") and f.ends_with(".acf")):
			continue
		var text := FileAccess.get_file_as_string(steamapps.path_join(f))
		var kv := _vdf_flat(text)
		if kv.get("installdir", "") == installdir:
			return {
				"file": f,
				"appid": kv.get("appid", ""),
				"buildid": kv.get("buildid", ""),
				"TargetBuildID": kv.get("TargetBuildID", ""),
				"StateFlags": kv.get("StateFlags", ""),
				"BetaKey": kv.get("BetaKey", kv.get("betakey", "")),
			}
	return {"error": "no appmanifest with installdir=" + installdir}


# Flat key/value view of a Valve KeyValues text file: the first occurrence of each quoted key wins,
# nesting is ignored (enough for appid, buildid, installdir and the beta key).
func _vdf_flat(text: String) -> Dictionary:
	var re := RegEx.create_from_string("\"([^\"]+)\"[ \\t]+\"([^\"]*)\"")
	var kv := {}
	for m in re.search_all(text):
		var k := m.get_string(1)
		if not kv.has(k):
			kv[k] = m.get_string(2)
	return kv


# --- itch ----------------------------------------------------------------------------------------

func _itch(exe: String) -> Dictionary:
	var t0 := Time.get_ticks_usec()
	var r := {"receipt": null}
	var dir := exe.get_base_dir()
	for _i in range(6):
		var p := dir.path_join(".itch/receipt.json.gz")
		if FileAccess.file_exists(p):
			var raw := FileAccess.get_file_as_bytes(p)
			var js := raw.decompress_dynamic(1 << 24, FileAccess.COMPRESSION_GZIP)
			var parsed = JSON.parse_string(js.get_string_from_utf8())
			var rec := {"path": _redact(p), "gz_bytes": raw.size(), "json_bytes": js.size(), "parsed": parsed != null}
			if parsed is Dictionary:
				rec["game_id"] = parsed.get("game", {}).get("id")
				rec["upload_id"] = parsed.get("upload", {}).get("id")
				var b = parsed.get("build")
				rec["build_id"] = b.get("id") if b is Dictionary else null
				rec["installerName"] = parsed.get("installerName")
			r["receipt"] = rec
			break
		var up := dir.get_base_dir()
		if up == dir:
			break
		dir = up
	r["usec"] = Time.get_ticks_usec() - t0
	return r


# --- macOS ---------------------------------------------------------------------------------------

func _macos(exe: String) -> Dictionary:
	var r := {}
	var i := exe.find(".app/Contents/MacOS/")
	if i < 0:
		r["bundle"] = null
		return r
	return _macos_bundle(exe.substr(0, i + 4))


func _macos_bundle(bundle: String) -> Dictionary:
	var r := {}
	r["bundle"] = _redact(bundle)
	var receipt := bundle.path_join("Contents/_MASReceipt/receipt")
	r["mas_receipt_exists"] = FileAccess.file_exists(receipt)
	if r["mas_receipt_exists"]:
		var raw := FileAccess.get_file_as_bytes(receipt)
		r["mas_receipt_bytes"] = raw.size()
		# The receipt is an unencrypted PKCS#7 container; its receipt-type attribute is plain ASCII
		# ("Production" or "ProductionSandbox"), so a byte search needs no ASN.1 parser.
		var hex := raw.hex_encode()
		var needle := "ProductionSandbox".to_ascii_buffer().hex_encode()
		var at := hex.find(needle)
		while at >= 0 and at % 2 == 1:
			at = hex.find(needle, at + 1)
		r["mas_receipt_production_sandbox"] = at >= 0
	r["embedded_provisionprofile_exists"] = FileAccess.file_exists(bundle.path_join("Contents/embedded.provisionprofile"))
	# Code signature through the codesign tool (OS.execute); no native call is available to GDScript.
	var t0 := Time.get_ticks_usec()
	var o := []
	var code := OS.execute("/usr/bin/codesign", ["-dvv", bundle], o, true)
	var sig := {"exit": code, "usec": Time.get_ticks_usec() - t0, "authority": [], "adhoc": false}
	for line in "\n".join(o).split("\n"):
		if line.begins_with("Authority="):
			sig["authority"].append(_strip_team(line.substr(10)))
		elif line.begins_with("Signature=adhoc"):
			sig["adhoc"] = true
		elif line.begins_with("TeamIdentifier="):
			sig["team_identifier_set"] = line.substr(15) != "not set"
	r["codesign"] = sig
	r["exe_tail_signing"] = _exe_tail_signing(bundle)
	# Homebrew Cask: Caskroom/<token>/<version>/<Name>.app is a symlink to the installed bundle.
	t0 = Time.get_ticks_usec()
	var cask = null
	var app_name := bundle.get_file()
	for root in ["/opt/homebrew/Caskroom", "/usr/local/Caskroom"]:
		var d := DirAccess.open(root)
		if d == null:
			continue
		for token in d.get_directories():
			var td := DirAccess.open(root.path_join(token))
			if td == null:
				continue
			for ver in td.get_directories():
				var link: String = root.path_join(token).path_join(ver).path_join(app_name)
				var ld := DirAccess.open(link.get_base_dir())
				if ld != null and ld.is_link(app_name) and ld.read_link(app_name) == bundle:
					cask = {"token": token, "version": ver}
	r["homebrew_cask"] = cask
	r["homebrew_cask_usec"] = Time.get_ticks_usec() - t0
	return r


# Sandbox-safe alternative to codesign: the leaf certificate's common name sits in the embedded
# code signature, which the linker places at the end of the (last slice of the) Mach-O.
func _exe_tail_signing(bundle: String) -> Dictionary:
	var t0 := Time.get_ticks_usec()
	var plist := FileAccess.get_file_as_string(bundle.path_join("Contents/Info.plist"))
	var m := RegEx.create_from_string("<key>CFBundleExecutable</key>\\s*<string>([^<]+)</string>").search(plist)
	var r := {"leaf": null}
	var exe_name := ""
	if m != null:
		exe_name = m.get_string(1)
	else: # binary plist: fall back to the executable named after the bundle, else the first file
		var files := DirAccess.get_files_at(bundle.path_join("Contents/MacOS"))
		var want := bundle.get_file().get_basename()
		exe_name = want if want in files else (files[0] if files.size() > 0 else "")
	var f := FileAccess.open(bundle.path_join("Contents/MacOS").path_join(exe_name), FileAccess.READ)
	if f == null:
		r["error"] = "open failed"
		return r
	var n := mini(65536, f.get_length())
	f.seek(f.get_length() - n)
	var hex := f.get_buffer(n).hex_encode()
	for cn in ["TestFlight Beta Distribution", "Apple Mac OS Application Signing", "Developer ID Application",
			"Apple Distribution", "Apple Development", "Mac Developer", "3rd Party Mac Developer Application"]:
		var at := hex.find(cn.to_ascii_buffer().hex_encode())
		if at >= 0 and at % 2 == 0:
			r["leaf"] = cn
			break
	r["tail_bytes"] = n
	r["usec"] = Time.get_ticks_usec() - t0
	return r


# "Developer ID Application: Name (TEAMID)" -> "Developer ID Application: <name> (<team>)"
func _strip_team(a: String) -> String:
	var j := a.find(":")
	return a if j < 0 else a.substr(0, j) + ": <redacted>"


# --- Windows (path conventions only; package identity needs native code) -------------------------

func _windows_paths(exe: String) -> Dictionary:
	var p := exe.replace("\\", "/").to_lower()
	return {
		"under_windowsapps": p.contains("/windowsapps/"),
		"under_scoop_apps": p.contains("/scoop/apps/"),
		"under_chocolatey_lib": p.contains("/chocolatey/lib/"),
		"under_winget_packages": p.contains("/microsoft/winget/packages/"),
		"under_program_files": p.contains("/program files"),
	}


# --- iOS (file presence only; AppDistributor needs Swift) -----------------------------------------

func _ios(exe: String) -> Dictionary:
	var bundle := exe.get_base_dir()
	return {
		"bundle": bundle.get_file(),
		"embedded_mobileprovision_exists": FileAccess.file_exists(bundle.path_join("embedded.mobileprovision")),
		"storekit_receipt_exists": FileAccess.file_exists(bundle.path_join("StoreKit/receipt")),
		"storekit_sandbox_receipt_exists": FileAccess.file_exists(bundle.path_join("StoreKit/sandboxReceipt")),
	}


# --- Android: PackageManager through JavaClassWrapper / AndroidRuntime (Godot 4.4+) --------------

func _android() -> Dictionary:
	var r := {"android_runtime_singleton": Engine.has_singleton("AndroidRuntime")}
	if not r["android_runtime_singleton"]:
		return r
	var rt = Engine.get_singleton("AndroidRuntime")
	var ctx = rt.getApplicationContext()
	if ctx == null:
		r["error"] = "getApplicationContext() returned null"
		return r
	var pkg: String = ctx.getPackageName()
	var pm = ctx.getPackageManager()
	r["package"] = pkg
	var build_version = JavaClassWrapper.wrap("android.os.Build$VERSION")
	var sdk_int: int = build_version.SDK_INT if build_version != null else -1
	r["sdk_int"] = sdk_int
	r["legacy_getInstallerPackageName"] = pm.getInstallerPackageName(pkg)
	if sdk_int >= 30:
		var info = pm.getInstallSourceInfo(pkg)
		if info == null:
			r["error"] = "getInstallSourceInfo returned null"
			return r
		r["installingPackageName"] = info.getInstallingPackageName()
		r["initiatingPackageName"] = info.getInitiatingPackageName()
		r["originatingPackageName"] = info.getOriginatingPackageName()
		r["has_initiatingPackageSigningInfo"] = info.getInitiatingPackageSigningInfo() != null
		if sdk_int >= 33:
			r["packageSource"] = info.getPackageSource()
		if sdk_int >= 34:
			r["updateOwnerPackageName"] = info.getUpdateOwnerPackageName()
	return r
