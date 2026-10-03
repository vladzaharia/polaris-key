extends RefCounted
# @pkey-feature packs.handlers
# The device-side PCK checks (P4-08; notes/S-05 §5 (f)) over P4-03's fixture PCKs, which
# packages/cli/test/godotFixtures.test.ts writes with the CLI's own PCK writer and lint: every
# fixture's refusals through PKeyPck.lint_lines equal `lintPck`'s error lines exactly (so the
# publish lint and the device cannot drift), the reader refuses what the CLI's reader refuses,
# and the `godot.pck` handler's check answers the registered codes: `pck-directory-refused` with
# the first refused path, `pck-engine-mismatch` for the header.

const S := preload("res://tests/packs/support.gd")
const DIR := "res://tests/fixtures/packs/check"
## The rscc-g-run time bound (P4-27 audit GAP 2): measured 751 ms (4.7.2 editor) and 514 ms
## (4.4.1) on Apple silicon; about 6× the slowest, for slower CI runners. The per-hit scan it
## replaced spent about 62 ms per MiB of hits (measured on 4 MiB of 'G'), about 4 s on this body
## for that marker alone, and per entry, with 256 MiB declarable then.
const G_RUN_BOUND_MS := 5000


func run(t: PKeyTestContext) -> void:
	var v = S.read_json(DIR.path_join("verdicts.json"))
	if not t.check("pck: verdicts.json parses", v is Dictionary and v.get("fixtures") is Dictionary):
		return
	var prefixes: Array = v["prefixes"]
	var engine: String = v["engine"]
	var n := 0
	for name in v["fixtures"]:
		var want: Dictionary = v["fixtures"][name]
		var bytes := FileAccess.get_file_as_bytes(DIR.path_join("%s.pck" % name))
		var src := PKeyByteSource.memory(bytes)
		var dir := PKeyPck.read_directory(src)
		if want.has("reader"):
			# The CLI's message names the entry; the device's refusal carries it as `path`.
			var path := ""
			var m := RegEx.create_from_string("the payload: ([^:]+): ").search(String(want["reader"]))
			if m != null:
				path = m.get_string(1)
			t.check("pck: %s refused by the reader" % name, not dir["ok"] and dir["error"] == PKeyPck.DIRECTORY_REFUSED and String(dir.get("path", "")) == path, "%s (want path %s; CLI: %s)" % [S.canon(dir), path, want["reader"]])
		else:
			if not t.check("pck: %s reads" % name, dir["ok"], S.canon(dir)):
				continue
			var lines := PKeyPck.lint_lines(src, dir, prefixes, engine)
			S.check_same(t, "pck: %s refusals equal the CLI lint's" % name, Array(lines), want["errors"])
			# The handler's verdict: the first code, with the first refused path.
			var rec := {"handler": {"prefixes": prefixes}}
			var variant := {"requires": {"engine": engine}}
			var c := PKeyGodotPckHandler.check(src, rec, variant)
			var errors: Array = want["errors"]
			var header_bad := not errors.is_empty() and String(errors[0]).begins_with("the PCK header")
			var newer: bool = PKeyPck.engine_check(dir["header"], null) != ""
			if newer or header_bad:
				t.check("pck: %s → pck-engine-mismatch" % name, not c["ok"] and c["code"] == PKeyPck.ENGINE_MISMATCH, S.canon(c))
			elif errors.is_empty():
				t.check("pck: %s admitted" % name, c["ok"], S.canon(c))
			else:
				var first := String(errors[0]).get_slice(": ", 0)
				t.check("pck: %s → pck-directory-refused at %s" % [name, first], not c["ok"] and c["code"] == PKeyPck.DIRECTORY_REFUSED and c.get("path") == first, S.canon(c))
		n += 1
	t.check("pck: coverage", n == (v["fixtures"] as Dictionary).size() and n >= 15, "%d fixtures" % n)

	# A stripped, admitted pack whose unpatched entry was tampered fails the whole-pack hash (the
	# applier's payload check), while its directory still reads: the hash is the authority.
	var good := FileAccess.get_file_as_bytes(DIR.path_join("kaykit-v1.pck"))
	var bad := good.duplicate()
	var d := PKeyPck.read_directory(PKeyByteSource.memory(good))
	var level: Dictionary = d["entries"].filter(func(e): return String(e["path"]).ends_with("level_005.json"))[0]
	bad[int(level["offset"]) + 3] = bad[int(level["offset"]) + 3] ^ 0x20
	t.check("pck: a tampered unpatched entry still reads and passes the directory check", PKeyGodotPckHandler.check(PKeyByteSource.memory(bad), {"handler": {"prefixes": prefixes}}, {})["ok"] or PKeyPck.engine_check(d["header"]) != "")
	t.check("pck: …but its whole-pack SHA-256 is not the record's", PKeyPackClaims.sha256_hex(bad) != PKeyPackClaims.sha256_hex(good))

	# An embedded baseline is a .pck inside the game's own pack (res://pkey_packs/): it mounts from
	# its res:// path (on the release template that is a pack inside the main pack).
	var embedded_path := DIR.path_join("kaykit-v1.pck")
	if PKeyPck.engine_check(d["header"]) == "":
		var mounted := PKeyPck.mount(embedded_path, false)
		var level0 := "res://assets/kaykit/data/level_000.json"
		t.check("pck: a pack inside res:// mounts from its res:// path (%s)" % ("editor" if OS.has_feature("editor") else "a pack inside the main pack"), mounted and FileAccess.file_exists(level0) and FileAccess.get_file_as_string(level0).contains("\"level\":0"))
	else:
		t.info("pck: the nested-mount probe needs a 4.7 engine (the fixture is PCK v4)")

	_review_repros(t)
	_rscc_probes(t)
	_script_kinds_api(t)

	# remap_targets and embedded_code (the CLI's unit probes).
	S.check_same(t, "pck: remap_targets reads path, path.<x> and dest_files", Array(PKeyPck.remap_targets('[remap]\npath.s3tc="res://a/b.ctex"\npath.etc2="res://a/c.ctex"\n[deps]\ndest_files=["res://a/b.ctex", "res://a/c.ctex"]\nsource_file="res://x.png"\n')), ["a/b.ctex", "a/c.ctex"])
	t.check("pck: a .ctex is never scanned for code", PKeyPck.embedded_code(".godot/imported/t.png-1.s3tc.ctex", "GST2 GDScript".to_utf8_buffer()) == "")

	# The trailer writer and the truncation (A6 §5), on a scratch copy.
	var scratch := S.scratch("pck")
	var copy := scratch.path_join("base.pck")
	S.write_file(copy, good)
	var ver := PKeyPck.helper_version()
	if ver >= 3:
		var tr := PKeyPck.append_trailer(copy, [{"path": "__pkey/test/x", "offset": int(level["offset"]), "size": int(level["size"])}], ver)
		t.check("pck: the trailer appends at the file's old end", tr["ok"] and int(tr["start"]) == good.size(), S.canon(tr))
		t.check("pck: truncate restores the file byte for byte", PKeyPck.truncate(copy, good.size()) and PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(copy)) == PKeyPackClaims.sha256_hex(good))
	else:
		t.info("pck: this engine writes PCK v%d; the trailer needs v3+ (the GDDL route is 4.6+)" % ver)
	S.remove_tree(scratch)


## The P4-08 review's bypasses (esc.gd, esc2.gd, ext2.gd), written by this engine's own PCK writer:
## each must be refused before anything could mount it.
func _review_repros(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-repro")
	var ver := PKeyPck.helper_version()
	var rec := {"handler": {"prefixes": ["res://packs/a/"]}}
	var gd := "extends Node\nfunc _ready():\n\tprint(\"downloaded code ran\")\n".to_utf8_buffer()
	var tres := "[gd_resource type=\"Resource\" format=3]\n\n[resource]\n".to_utf8_buffer()
	var cases := [
		["`..` escapes the prefix", [{"path": "res://packs/a/../../escaped.txt", "bytes": "hello".to_utf8_buffer()}, {"path": "res://packs/a/../../tests/packs/uid_main_base.tres", "bytes": tres}]],
		["a trailing `/.` hides a script", [{"path": "res://packs/a/evil.gd/.", "bytes": gd}]],
		["`./` and a trailing `/` hide a script", [{"path": "res://packs/a/./evil.gd/", "bytes": gd}]],
		["`//` hides a script", [{"path": "res://packs/a//evil.gd/.", "bytes": gd}]],
		["a backslash", [{"path": "res://packs/a/x\\..\\y.txt", "bytes": gd}]],
		["the same file twice by case", [{"path": "res://packs/a/A.txt", "bytes": gd}, {"path": "res://packs/a/a.txt", "bytes": gd}]],
	]
	var n := 0
	for c in cases:
		var out := scratch.path_join("repro%d.pck" % n)
		n += 1
		if PKeyPck.write(out, c[1], ver) != OK:
			t.check("pck repro: %s (written)" % c[0], false)
			continue
		var src := PKeyByteSource.file(out)
		var dir := PKeyPck.read_directory(src)
		var chk := PKeyGodotPckHandler.check(src, rec, {})
		t.check("pck repro: %s is refused by the reader" % c[0], not dir["ok"] and dir["error"] == PKeyPck.DIRECTORY_REFUSED and not chk["ok"] and chk["code"] == PKeyPck.DIRECTORY_REFUSED, "%s %s" % [S.canon(dir), S.canon(chk)])
	# ext2.gd: a binary resource with another extension (.material) carrying a GDScript.
	var s := GDScript.new()
	s.source_code = "extends StandardMaterial3D\nfunc _init():\n\tpass\n"
	s.reload()
	var m := StandardMaterial3D.new()
	m.set_script(s)
	var mat := scratch.path_join("evil.material")
	var saved := ResourceSaver.save(m, mat)
	var bytes := FileAccess.get_file_as_bytes(mat)
	var out := scratch.path_join("material.pck")
	PKeyPck.write(out, [{"path": "res://packs/a/look.material", "bytes": bytes}], ver)
	var chk := PKeyGodotPckHandler.check(PKeyByteSource.file(out), rec, {})
	t.check("pck repro: a .material (RSRC) with an embedded GDScript is refused by content", saved == OK and bytes.slice(0, 4).get_string_from_ascii() == "RSRC" and not chk["ok"] and chk["code"] == PKeyPck.DIRECTORY_REFUSED and chk.get("path") == "packs/a/look.material", S.canon(chk))
	t.check("pck repro: embedded_code decides by content, whatever the extension", PKeyPck.embedded_code("packs/a/look.material", bytes) != "" and PKeyPck.embedded_code("packs/a/look.png", bytes) != "")
	S.remove_tree(scratch)


## P4-27: compressed resources this engine writes itself. ResourceSaver's FLAG_COMPRESS is the
## scene importer's path (RSCC), so a compressed resource with no script is admitted and one with
## an embedded GDScript is refused by its decompressed body; FileAccess.open_compressed writes the
## same framing (magic GCPF), here with a total that is a multiple of the block size, so the last
## block is the engine's empty frame.
func _rscc_probes(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-rscc")
	var mesh := BoxMesh.new()
	var plain := scratch.path_join("box.res")
	var ok := ResourceSaver.save(mesh, plain, ResourceSaver.FLAG_COMPRESS) == OK
	var bytes := FileAccess.get_file_as_bytes(plain)
	t.check("pck rscc: an engine-compressed mesh is RSCC and admitted", ok and bytes.slice(0, 4).get_string_from_ascii() == "RSCC" and PKeyPck.embedded_code("packs/a/box.res", bytes) == "", PKeyPck.embedded_code("packs/a/box.res", bytes))
	var s := GDScript.new()
	s.source_code = "extends StandardMaterial3D\nfunc _init():\n\tpass\n"
	s.reload()
	var m := StandardMaterial3D.new()
	m.set_script(s)
	var evil := scratch.path_join("evil.material")
	ok = ResourceSaver.save(m, evil, ResourceSaver.FLAG_COMPRESS) == OK
	bytes = FileAccess.get_file_as_bytes(evil)
	var why := PKeyPck.embedded_code("packs/a/look.material", bytes)
	t.check("pck rscc: an engine-compressed material with an embedded GDScript is refused by its body", ok and bytes.slice(0, 4).get_string_from_ascii() == "RSCC" and why.begins_with("a compressed binary resource (RSCC) that names "), why)
	var gcpf := scratch.path_join("x.gcpf")
	var f := FileAccess.open_compressed(gcpf, FileAccess.WRITE, FileAccess.COMPRESSION_ZSTD)
	var payload := PackedByteArray()
	payload.resize(8192)
	for i in 8192:
		payload[i] = (i * 31) & 0xFF
	f.store_buffer(payload)
	f.close()
	bytes = FileAccess.get_file_as_bytes(gcpf)
	var magic := "RSCC".to_ascii_buffer()
	for i in 4:
		bytes[i] = magic[i]
		bytes[bytes.size() - 4 + i] = magic[i]
	var r := PKeyPck.rscc_body(bytes)
	t.check("pck rscc: the engine's framing of an exact multiple of the block size (an empty last frame) decodes", r.has("body") and r["body"] == payload, S.canon(r) if r.has("why") else "")
	# Half zeros, half random bytes (raw zstd blocks): both of the decoder's fast and slow paths.
	var big := PackedByteArray()
	big.resize(2 * 1048576)
	big.append_array(Crypto.new().generate_random_bytes(2 * 1048576))
	f = FileAccess.open_compressed(gcpf, FileAccess.WRITE, FileAccess.COMPRESSION_ZSTD)
	f.store_buffer(big)
	f.close()
	bytes = FileAccess.get_file_as_bytes(gcpf)
	for i in 4:
		bytes[i] = magic[i]
		bytes[bytes.size() - 4 + i] = magic[i]
	var t0 := Time.get_ticks_usec()
	r = PKeyPck.rscc_body(bytes)
	t.check("pck rscc: 4 MiB in 1025 blocks decodes", r.has("body") and (r["body"] as PackedByteArray).size() == big.size())
	t.info("pck rscc: 4 MiB (1025 blocks) decompressed in %d ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	# P4-27 audit GAP 2: a 64 MiB body that is a run of 'G' (every byte a first-byte hit for
	# GDScript) is decompressed and scanned in time linear in its size, not in its hits.
	var gpck := FileAccess.get_file_as_bytes(DIR.path_join("rscc-g-run.pck"))
	var gsrc := PKeyByteSource.memory(gpck)
	var gdir := PKeyPck.read_directory(gsrc)
	var t1 := Time.get_ticks_usec()
	var gchk := PKeyPck.directory_check(gsrc, gdir, ["res://assets/kaykit/"]) if gdir["ok"] else {}
	var gms := (Time.get_ticks_usec() - t1) / 1000.0
	t.info("pck rscc: rscc-g-run (64 MiB body, a run of 'G') checked in %d ms" % gms)
	t.check("pck rscc: a 64 MiB run of 'G' is admitted within %d ms" % G_RUN_BOUND_MS, gdir["ok"] and gchk.get("ok", false) and gms < G_RUN_BOUND_MS, "%d ms %s" % [gms, S.canon(gchk)])
	S.remove_tree(scratch)


## A loader that claims an extension for `Script`, as a GDExtension language's would.
class _FakeScriptLoader extends ResourceFormatLoader:
	func _get_recognized_extensions() -> PackedStringArray:
		return PackedStringArray(["pkeyscript"])

	func _handles_type(type: StringName) -> bool:
		return type == &"Script"

	func _get_resource_type(path: String) -> String:
		return "Script" if path.get_extension() == "pkeyscript" else ""


## P4-08 audit GAP 5: the device refuses what THIS engine counts as a script, read through
## ResourceLoader.get_recognized_extensions_for_type("Script") (minus the generic resource
## containers) and ClassDB.get_inheriters_from_class("Script").
func _script_kinds_api(t: PKeyTestContext) -> void:
	PKeyPck.refresh_script_kinds()
	var kinds: Dictionary = PKeyPck._script_kinds()
	var exts: Dictionary = kinds["exts"]
	t.check("pck: the Script extensions come from the engine (gd, gdc), without the resource containers", exts.has("gd") and exts.has("gdc") and not exts.has("tres") and not exts.has("res"), S.canon(exts.keys()))
	var markers: PackedStringArray = kinds["markers"]
	var inheriters := ClassDB.get_inheriters_from_class("Script")
	var all_in := true
	for c in inheriters:
		all_in = all_in and markers.has(String(c))
	t.check("pck: every class inheriting Script is a marker (%s)" % ", ".join(inheriters), all_in and markers.slice(0, 5) == PKeyPck.script_markers(), S.canon(Array(markers)))
	var scratch := S.scratch("pck-kinds")
	var out := scratch.path_join("kinds.pck")
	var pack_ok := PKeyPck.write(out, [{"path": "res://packs/a/brain.pkeyscript", "bytes": "print(1)\n".to_utf8_buffer()}], PKeyPck.helper_version()) == OK
	var rec := {"handler": {"prefixes": ["res://packs/a/"]}}
	var before := PKeyGodotPckHandler.check(PKeyByteSource.file(out), rec, {})
	var loader := _FakeScriptLoader.new()
	ResourceLoader.add_resource_format_loader(loader)
	PKeyPck.refresh_script_kinds()
	var during := PKeyGodotPckHandler.check(PKeyByteSource.file(out), rec, {})
	ResourceLoader.remove_resource_format_loader(loader)
	PKeyPck.refresh_script_kinds()
	var after := PKeyGodotPckHandler.check(PKeyByteSource.file(out), rec, {})
	t.check("pck: an extension no loader claims for Script is data (admitted)", pack_ok and before["ok"], S.canon(before))
	t.check("pck: once a loader claims it for Script, the same entry is refused as a script (the API path)", not during["ok"] and during["code"] == PKeyPck.DIRECTORY_REFUSED and during.get("path") == "packs/a/brain.pkeyscript" and String(during.get("detail", "")).contains("a script"), S.canon(during))
	t.check("pck: …and admitted again when the loader is gone", after["ok"], S.canon(after))
	S.remove_tree(scratch)

