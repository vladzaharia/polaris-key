extends RefCounted
# @pkey-feature update.driver
# The export-time half of the macOS Sparkle bridge (PKeyNativeExport, used by PKeyExportPlugin on
# macOS presets): the Info.plist keys appended without clobbering the preset's own, the Disable
# Library Validation entitlement, codesign never Disabled, the dialog's problems, and the paths
# whose executable bit is restored after export. The macOS end-to-end run exports through the
# real plugin (sdks/godot/native/e2e/macos/run.sh).

const N := preload("res://addons/polaris_key/export/native_export.gd")
const PUB := "rjbF4rUO7nUmHvDZ2pLxRrIjUKCQPvy1qTSl56Dp0hY="


func run(t: PKeyTestContext) -> void:
	var p := N.plist_content("", PUB, "https://key.plrs.im/djdl/update/appcast.xml", false)
	t.check("export: SUPublicEDKey, SUFeedURL and SUEnableAutomaticChecks are appended", p == "<key>SUPublicEDKey</key><string>%s</string><key>SUFeedURL</key><string>https://key.plrs.im/djdl/update/appcast.xml</string><key>SUEnableAutomaticChecks</key><false/>" % PUB, p)
	var own := "<key>SUPublicEDKey</key><string>OWN</string><key>LSApplicationCategoryType</key><string>public.app-category.games</string>"
	p = N.plist_content(own, PUB, "", true)
	t.check("export: a key the preset already sets is left alone, others kept", p.begins_with(own) and p.count("SUPublicEDKey") == 1 and p.ends_with("<key>SUEnableAutomaticChecks</key><true/>") and not p.contains("SUFeedURL"), p)
	t.check("export: values are XML-escaped", N.plist_content("", "", "https://x/a?b=1&c=2", false).contains("b=1&amp;c=2"))
	var o := N.overrides("", 0, PUB, "", false)
	t.check("export: codesign Disabled becomes built-in ad-hoc, with Disable Library Validation", o.get(N.CODESIGN) == N.CODESIGN_BUILT_IN and o.get(N.LIBRARY_VALIDATION) == true and String(o.get(N.PLIST)).contains(PUB), str(o))
	t.check("export: an explicit codesign tool is kept", not N.overrides("", 3, PUB, "", false).has(N.CODESIGN) and not N.overrides("", 2, PUB, "", false).has(N.CODESIGN))
	t.check("export: no public key is a problem", N.problems("", "").size() == 1 and N.problems("", "")[0].contains("public key"))
	t.check("export: a malformed key is a problem", N.problems("abc", "").size() == 1)
	t.check("export: an http feed off loopback is a problem; https and loopback http are not", N.problems(PUB, "http://example.com/a.xml").size() == 1 and N.problems(PUB, "https://example.com/a.xml").is_empty() and N.problems(PUB, "http://127.0.0.1:8711/a.xml").is_empty())
	t.check("export: truthy accepts the env spellings", N.truthy("1") and N.truthy("true") and N.truthy("YES") and N.truthy(true) and not N.truthy("0") and not N.truthy("") and not N.truthy(false))
	t.check("export: the explicit key wins over PKeyOptions'; none at all is empty", N.public_key(PUB, "") == PUB and N.public_key("", "") == "")
	var paths := N.helper_paths("/out/Game.app")
	t.check("export: the five Mach-O files under Sparkle.framework/Versions/B", paths.size() == 5 and paths[0] == "/out/Game.app/Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle" and paths[4].ends_with("XPCServices/Installer.xpc/Contents/MacOS/Installer"), str(paths))
	var dir := PKeyTestFixtures.scratch_dir("native-export")
	var app := dir.path_join("Game.app")
	for f in paths:
		var real := f.replace("/out/Game.app", app)
		DirAccess.make_dir_recursive_absolute(real.get_base_dir())
		var h := FileAccess.open(real, FileAccess.WRITE)
		h.store_string("x")
		h.close()
		FileAccess.set_unix_permissions(real, 0x1A4)
	var failed := N.restore_executable_bits(app)
	var ok := failed.is_empty()
	if OS.get_name() in ["macOS", "Linux"]:
		for f in N.helper_paths(app):
			ok = ok and (FileAccess.get_unix_permissions(f) & 0x40) != 0
	t.check("export: restore_executable_bits sets 0755 on all five", ok, str(failed))
	t.check("export: a missing file is reported", N.restore_executable_bits(dir.path_join("Missing.app")).size() == 5)
	_store(t, dir)
	PKeyTestFixtures.remove_tree(dir)


static func _write(path: String, text := "x") -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var h := FileAccess.open(path, FileAccess.WRITE)
	h.store_string(text)
	h.close()


## A Microsoft Store export keeps no updater but StoreContext, by export kind.
func _store(t: PKeyTestContext, dir: String) -> void:
	# .exe into its own folder: everything the export wrote goes, the game and pkey_win.dll stay.
	var own := dir.path_join("own")
	var before := N.snapshot(own)
	for f in ["pkeye2e.exe", "pkey_win.dll", "velopack_libc.dll", "WinSparkle.dll", "pkey_velopack_shim.exe"]:
		_write(own.path_join(f))
	var r: Dictionary = N.strip_store_export(own.path_join("pkeye2e.exe"), before)
	t.check("store export (.exe): the updater DLLs and the shim this export wrote are removed; the game and pkey_win.dll stay", r["kind"] == "exe" and r["removed"].size() == 3 and FileAccess.file_exists(own.path_join("pkey_win.dll")) and FileAccess.file_exists(own.path_join("pkeye2e.exe")) and not FileAccess.file_exists(own.path_join("WinSparkle.dll")), str(r))
	# .exe into a folder that already holds a direct build: its untouched files survive.
	var shared := dir.path_join("shared")
	for f in ["direct.exe", "velopack_libc.dll", "WinSparkle.dll", "pkey_velopack_shim.exe"]:
		_write(shared.path_join(f), "direct build")
	before = N.snapshot(shared)
	_write(shared.path_join("store.exe"))
	_write(shared.path_join("pkey_win.dll"))
	r = N.strip_store_export(shared.path_join("store.exe"), before)
	t.check("store export (.exe): a direct build's files in the same folder survive", r["removed"].is_empty() and r["failed"].is_empty() and FileAccess.file_exists(shared.path_join("velopack_libc.dll")) and FileAccess.file_exists(shared.path_join("WinSparkle.dll")) and FileAccess.file_exists(shared.path_join("pkey_velopack_shim.exe")), str(r))
	# .zip: the archive is rewritten without the three entries.
	var zip := dir.path_join("store.zip")
	var packer := ZIPPacker.new()
	packer.open(zip)
	for f in ["pkeye2e.exe", "pkeye2e.pck", "pkey_win.dll", "velopack_libc.dll", "WinSparkle.dll", "pkey_velopack_shim.exe"]:
		packer.start_file(f)
		packer.write_file(f.to_utf8_buffer())
		packer.close_file()
	packer.close()
	_write(dir.path_join("velopack_libc.dll"), "beside the zip")
	r = N.strip_store_export(zip, {})
	var reader := ZIPReader.new()
	reader.open(zip)
	var names := Array(reader.get_files())
	var game: PackedByteArray = reader.read_file("pkeye2e.pck")
	reader.close()
	names.sort()
	t.check("store export (.zip): the archive loses the three entries and keeps the rest intact", r["kind"] == "zip" and r["error"] == OK and names == ["pkey_win.dll", "pkeye2e.exe", "pkeye2e.pck"] and game.get_string_from_utf8() == "pkeye2e.pck", str(names))
	t.check("store export (.zip): a same-named file beside the archive is not touched", FileAccess.file_exists(dir.path_join("velopack_libc.dll")))
	# .pck: nothing.
	_write(dir.path_join("WinSparkle.dll"), "beside the pck")
	r = N.strip_store_export(dir.path_join("store.pck"), {})
	t.check("store export (.pck): nothing is removed", r["kind"] == "none" and r["removed"].is_empty() and FileAccess.file_exists(dir.path_join("WinSparkle.dll")))
