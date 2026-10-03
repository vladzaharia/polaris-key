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
	PKeyTestFixtures.remove_tree(dir)
