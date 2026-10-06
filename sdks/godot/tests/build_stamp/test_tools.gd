extends RefCounted
# The setup dock's tooling (PKeySetupTools, SP-G12): the pkey_packs/* export filter added to every
# preset once and only once, the nearest .pkey/release found by walking up, the `pkey sdk --lang
# godot --write` and `pkey mirror --lang gdscript` command lines, shell quoting on both
# platforms, a CLI that cannot start reported as such, and the web CORS note.

const TMP := "user://pkey_tools_test"


func run(t: PKeyTestContext) -> void:
	_filters(t)
	_presets(t)
	_manifest(t)
	_args(t)
	_invocation(t)
	t.check("cors: the note names web.origins and the product", PKeySetupTools.cors_note("acme").contains("web.origins") and PKeySetupTools.cors_note("acme").contains("acme"))


func _filters(t: PKeyTestContext) -> void:
	t.check("filter: added to an empty filter", PKeySetupTools.add_pack_filter("") == "pkey_packs/*")
	t.check("filter: appended to an existing list", PKeySetupTools.add_pack_filter("*.json, docs/*") == "*.json, docs/*, pkey_packs/*")
	t.check("filter: not added twice", PKeySetupTools.add_pack_filter("*.json, pkey_packs/*") == "*.json, pkey_packs/*")
	t.check("filter: a res:// spelling counts", PKeySetupTools.add_pack_filter("res://pkey_packs/*") == "res://pkey_packs/*")


func _presets(t: PKeyTestContext) -> void:
	DirAccess.make_dir_recursive_absolute(TMP)
	var path := TMP.path_join("export_presets.cfg")
	var missing := PKeySetupTools.ensure_pack_filters(TMP.path_join("absent.cfg"))
	t.check("presets: a missing file changes nothing and is not an error", missing["ok"] and missing["changed"].is_empty())
	var cfg := ConfigFile.new()
	cfg.set_value("preset.0", "name", "Linux")
	cfg.set_value("preset.0", "include_filter", "*.json")
	cfg.set_value("preset.0.options", "binary_format/embed_pck", false)
	cfg.set_value("preset.1", "name", "Web")
	cfg.set_value("preset.1", "include_filter", "")
	cfg.save(path)
	var r := PKeySetupTools.ensure_pack_filters(path)
	t.check("presets: both presets changed", r["ok"] and r["changed"] == PackedStringArray(["Linux", "Web"]), str(r))
	var back := ConfigFile.new()
	back.load(path)
	t.check("presets: filters written", back.get_value("preset.0", "include_filter") == "*.json, pkey_packs/*" and back.get_value("preset.1", "include_filter") == "pkey_packs/*")
	t.check("presets: options sections untouched", back.get_value("preset.0.options", "binary_format/embed_pck") == false and not back.has_section_key("preset.0.options", "include_filter"))
	var again := PKeySetupTools.ensure_pack_filters(path)
	t.check("presets: a second run changes nothing", again["ok"] and again["changed"].is_empty(), str(again))
	DirAccess.remove_absolute(path)


func _manifest(t: PKeyTestContext) -> void:
	var root := ProjectSettings.globalize_path(TMP).path_join("repo")
	var deep := root.path_join("game/sub")
	DirAccess.make_dir_recursive_absolute(deep)
	DirAccess.make_dir_recursive_absolute(root.path_join(".pkey"))
	t.check("manifest: none found without .pkey/release", PKeySetupTools.find_manifest_dir(deep) != root)
	var f := FileAccess.open(root.path_join(".pkey/release"), FileAccess.WRITE)
	f.store_string("{}")
	f.close()
	t.check("manifest: found by walking up", PKeySetupTools.find_manifest_dir(deep) == root, PKeySetupTools.find_manifest_dir(deep))
	t.check("manifest: found in the start directory", PKeySetupTools.find_manifest_dir(root) == root)
	DirAccess.remove_absolute(root.path_join(".pkey/release"))


func _args(t: PKeyTestContext) -> void:
	var keys := {"b-key": "BBB", "a-key": "AAA"}
	var with_manifest := PKeySetupTools.sdk_args("acme", "https://key.plrs.im", "/p/polaris_key_config.gd", keys, true)
	t.check("sdk: the command line", with_manifest == PackedStringArray(["sdk", "--lang", "godot", "--product", "acme", "--base-url", "https://key.plrs.im", "--write", "--out", "/p/polaris_key_config.gd"]), str(with_manifest))
	var without := PKeySetupTools.sdk_args("acme", "https://key.plrs.im", "/p/c.gd", keys, false)
	t.check("sdk: pinned release keys ride along, sorted, without a manifest", without.slice(10) == PackedStringArray(["--release-key", "a-key=AAA", "--release-key", "b-key=BBB"]), str(without))
	t.check("sdk: --force only on request", PKeySetupTools.sdk_args("acme", "u", "o", {}, true, true).has("--force") and not with_manifest.has("--force"))
	var m := PKeySetupTools.mirror_args("acme", "https://key.plrs.im", "/p/")
	t.check("mirror: the command line", m == PackedStringArray(["mirror", "--lang", "gdscript", "--product", "acme", "--base-url", "https://key.plrs.im", "--out-dir", "/p/"]), str(m))


func _invocation(t: PKeyTestContext) -> void:
	var a := PackedStringArray(["sdk", "--out", "/it's here/c.gd"])
	var posix := PKeySetupTools.invocation("pkey", a, "/my repo", false)
	t.check("sh: quoted and run in the directory", posix["path"] == "/bin/sh" and posix["args"][0] == "-c" and posix["args"][1] == "cd '/my repo' && pkey 'sdk' '--out' '/it'\\''s here/c.gd'", str(posix))
	var win := PKeySetupTools.invocation("npx @polaris-key/cli", PackedStringArray(["sdk", "a\"b"]), "C:\\My Game", true)
	t.check("cmd: quoted and run in the directory", win["path"] == "cmd.exe" and win["args"][1] == "cd /d \"C:\\My Game\" && npx @polaris-key/cli \"sdk\" \"a\"\"b\"", str(win))
	t.check("blank command falls back to pkey", PKeySetupTools.invocation("  ", PackedStringArray(), "", false)["args"][1].begins_with("pkey"))
	if OS.has_feature("web"):
		return
	var missing := PKeySetupTools.run({"path": "/nonexistent/pkey-cli-binary", "args": PackedStringArray()})
	t.check("run: a binary that cannot start fails", not missing["ok"], str(missing))
