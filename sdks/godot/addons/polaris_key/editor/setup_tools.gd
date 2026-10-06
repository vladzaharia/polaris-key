class_name PKeySetupTools
extends RefCounted
## The setup dock's tooling (SP-G12), kept free of editor classes like PKeySetupCheck so the test
## runner exercises it on the editor binary and on a release template alike:
##
## - "Generate config" runs `pkey sdk --lang godot --write`, which reads the product's discovery
##   document and writes `res://polaris_key_config.gd` (product, base URL, trust pins, pinned
##   release keys, expected services). Release keys have no public route: the CLI reads them from
##   the nearest `.pkey/release` (the command runs in that directory), and the keys already in
##   `res://polaris_key.tres` ride along as `--release-key` when there is none. The CLI refuses,
##   writing nothing, when they do not match discovery's `releaseKeyFingerprints`.
## - "Generate catalog mirror" runs `pkey mirror --lang gdscript`, which writes
##   `catalog_generated.gd` from the product's public schema route.
## - Every export preset's include filter gets `pkey_packs/*`, so the embedded pack baselines and
##   their `.pkey.json` markers (not resources Godot would pick up) ship in the build.
##
## The dock only builds the command and shows what the CLI printed; trust decisions stay with the
## CLI (it prints each pin's fingerprint for comparison with the console).

const PACK_FILTER := "pkey_packs/*"
const PACKS_DIR := "res://pkey_packs"
const EXPORT_PRESETS := "res://export_presets.cfg"
const CONFIG_MODULE := "res://polaris_key_config.gd"
const MIRROR_DIR := "res://"
const DEFAULT_PKEY := "pkey"


## `filter` (a comma-separated include filter) with PACK_FILTER appended, unchanged when it is
## already there.
static func add_pack_filter(filter: String) -> String:
	var parts := PackedStringArray()
	for p in filter.split(",", false):
		var s := p.strip_edges()
		if s != "":
			parts.append(s)
	if parts.has(PACK_FILTER) or parts.has("pkey_packs/**") or parts.has("res://" + PACK_FILTER):
		return filter
	parts.append(PACK_FILTER)
	return ", ".join(parts)


## Add PACK_FILTER to every preset in `path` (export_presets.cfg). A missing file is not an
## error: there is nothing to export yet. {ok, changed: PackedStringArray (preset names), message}.
static func ensure_pack_filters(path := EXPORT_PRESETS) -> Dictionary:
	var out := {"ok": true, "changed": PackedStringArray(), "message": ""}
	if not FileAccess.file_exists(path):
		out["message"] = "No export presets yet: add one, then run this again."
		return out
	var cfg := ConfigFile.new()
	var err := cfg.load(path)
	if err != OK:
		out["ok"] = false
		out["message"] = "Could not read %s (error %d)." % [path, err]
		return out
	for section in cfg.get_sections():
		if not RegEx.create_from_string("\\Apreset\\.\\d+\\z").search(section):
			continue
		var before := str(cfg.get_value(section, "include_filter", ""))
		var after := add_pack_filter(before)
		if after != before:
			cfg.set_value(section, "include_filter", after)
			out["changed"].append(str(cfg.get_value(section, "name", section)))
	if out["changed"].is_empty():
		out["message"] = "Every export preset already includes %s." % PACK_FILTER
		return out
	err = cfg.save(path)
	if err != OK:
		out["ok"] = false
		out["message"] = "Could not write %s (error %d)." % [path, err]
		return out
	out["message"] = "Added %s to %s." % [PACK_FILTER, ", ".join(out["changed"])]
	return out


## The nearest directory at or above `start_dir` (an absolute OS path) holding `.pkey/release`,
## or "" when there is none.
static func find_manifest_dir(start_dir: String) -> String:
	var dir := start_dir.simplify_path()
	while dir != "":
		if FileAccess.file_exists(dir.path_join(".pkey/release")):
			return dir
		var parent := dir.get_base_dir()
		if parent == dir:
			break
		dir = parent
	return ""


## Arguments for `pkey sdk --lang godot --write`. `release_keys` (kid -> key) are passed only
## when there is no `.pkey/release` to read them from.
static func sdk_args(product: String, base_url: String, out_path: String, release_keys: Dictionary, have_manifest: bool, force := false) -> PackedStringArray:
	var a := PackedStringArray(["sdk", "--lang", "godot", "--product", product, "--base-url", base_url, "--write", "--out", out_path])
	if force:
		a.append("--force")
	if not have_manifest:
		var kids := release_keys.keys()
		kids.sort()
		for kid in kids:
			a.append_array(["--release-key", "%s=%s" % [kid, release_keys[kid]]])
	return a


## Arguments for `pkey mirror --lang gdscript` from the product's schema route.
static func mirror_args(product: String, base_url: String, out_dir: String) -> PackedStringArray:
	return PackedStringArray(["mirror", "--lang", "gdscript", "--product", product, "--base-url", base_url, "--out-dir", out_dir])


## POSIX single-quoting.
static func sh_quote(s: String) -> String:
	return "'%s'" % s.replace("'", "'\\''")


## cmd.exe quoting (double quotes; a literal quote doubled).
static func cmd_quote(s: String) -> String:
	return "\"%s\"" % s.replace("\"", "\"\"")


## {path, args} for OS.execute: `pkey_cmd args…` run in `cwd` through the platform shell, so a
## `pkey` on PATH (or `npx @polaris-key/cli`, several words) resolves as in a terminal.
static func invocation(pkey_cmd: String, args: PackedStringArray, cwd: String, windows: bool) -> Dictionary:
	var cmd := pkey_cmd.strip_edges()
	if cmd == "":
		cmd = DEFAULT_PKEY
	var words := PackedStringArray()
	for a in args:
		words.append(cmd_quote(a) if windows else sh_quote(a))
	if windows:
		var line := "%s %s" % [cmd, " ".join(words)]
		if cwd != "":
			line = "cd /d %s && %s" % [cmd_quote(cwd), line]
		return {"path": "cmd.exe", "args": PackedStringArray(["/c", line])}
	var sh_line := "%s %s" % [cmd, " ".join(words)]
	if cwd != "":
		sh_line = "cd %s && %s" % [sh_quote(cwd), sh_line]
	return {"path": "/bin/sh", "args": PackedStringArray(["-c", sh_line])}


## Run an invocation (blocking; the CLI's own output is the message). {ok, exit, output}.
static func run(inv: Dictionary) -> Dictionary:
	var output: Array = []
	var code := OS.execute(inv["path"], inv["args"], output, true)
	var text := "".join(PackedStringArray(output)).strip_edges()
	if code == -1:
		text = "Could not start %s. Install the Polaris Key CLI (`npm i -g @polaris-key/cli`) or set the command." % inv["path"]
	return {"ok": code == 0, "exit": code, "output": text}


## The web reminder the dock shows: a web export calls the Worker cross-origin, so the game's
## origin must be on the product's CORS allowlist: `web.origins` in `.pkey/product` (exact origins,
## at most 16, applied on resync; the console has no override). See /docs/build/web-cors/.
static func cors_note(product: String) -> String:
	var p := product if product != "" else "<product>"
	return ("Web exports: list the exact origin that serves the game (for example https://play.example.com, " +
		"or http://localhost:8060 for local testing) under web.origins in %s's .pkey/product, then resync " +
		"the product. Without it the browser blocks every call to Polaris Key.") % p
