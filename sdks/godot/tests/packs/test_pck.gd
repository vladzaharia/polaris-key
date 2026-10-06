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
## The scan's complexity checks (P4-27 audit GAP 2) count work, never time, so no machine load
## can move them (P1-13): PKeyPck.scan_probes (native passes and candidate comparisons) and
## scan_bytes (the bytes they cover), diffed around each call. A run of 'G' (every byte a marker's
## first byte) may cost at most G_RUN_HIT_FACTOR times the work of a run of a byte no marker holds,
## of the same size: the scan is linear in the bytes, not in the hits (the counts are equal; a
## per-hit loop put back into `first_present` makes one comparison per 'G'). And 4× the bytes may
## cost at most G_RUN_SCALE_FACTOR times the work: linear is 4× (plus the window overlaps),
## quadratic 16×.
const G_RUN_HIT_FACTOR := 2
const G_RUN_SCALE_FACTOR := 5
## A hang guard only (wall clock, so a loaded machine still passes): the 64 MiB rscc-g-run fixture
## checks in 514–751 ms on an idle Apple-silicon machine; a regression back to a per-hit scan is
## caught by the work counts above, not by this.
const G_RUN_HANG_MS := 120000
## GAP D (P4-28 audit): a check reads each app path's type once (`ctx.types`, counted by
## PKeyPck.type_reads), whatever the number of references. The wall-clock bound is a hang guard.
const TYPE_SCALE_HANG_MS := 120000


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
			# P4-28: the fixture's attachable list, on both sides.
			var attachable: Array = want.get("attachable", [])
			var lines := PKeyPck.lint_lines(src, dir, prefixes, engine, attachable)
			S.check_same(t, "pck: %s refusals equal the CLI lint's" % name, Array(lines), want["errors"])
			# The handler's verdict: the first code, with the first refused path.
			var rec := {"handler": {"prefixes": prefixes}}
			var variant := {"requires": {"engine": engine}}
			var c := PKeyGodotPckHandler.check(src, rec, variant, attachable)
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
	_attach_probes(t)
	_type_probes(t)
	_cache_probe(t)
	_type_scale_probe(t)
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


## P4-28 on resources this engine writes itself: a Resource with an app script attached
## (tests/packs/attach_probe.gd, exported property `power` = 7), saved as text, binary and
## compressed binary, each referencing the script by path and (4.4+) by its UID. With nothing
## attachable every one is refused; with the script's path alone the UID still is; with both it is
## admitted. Mounted, the pack's resource loads with the app script attached and the pack's value
## set: the residual P4-08 recorded, measured.
func _attach_probes(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-attach")
	var ver := PKeyPck.helper_version()
	var script_path := "res://tests/packs/attach_probe.gd"
	var script := load(script_path) as Script
	var r := Resource.new()
	r.set_script(script)
	r.set("power", 7)
	var id := ResourceLoader.get_resource_uid(script_path)
	var uid := ResourceUID.id_to_text(id) if id != ResourceUID.INVALID_ID else ""
	var entries: Array = []
	for f in [["probe.tres", 0], ["probe.res", 0], ["probe_c.res", ResourceSaver.FLAG_COMPRESS]]:
		var out := scratch.path_join(f[0])
		if not t.check("pck attach: %s saved" % f[0], ResourceSaver.save(r, out, f[1]) == OK):
			S.remove_tree(scratch)
			return
		entries.append({"path": "res://packs/attach/%s" % f[0], "bytes": FileAccess.get_file_as_bytes(out)})
	var pck := scratch.path_join("attach.pck")
	if not t.check("pck attach: the pack is written", PKeyPck.write(pck, entries, ver) == OK):
		S.remove_tree(scratch)
		return
	var src := PKeyByteSource.file(pck)
	var dir := PKeyPck.read_directory(src)
	var prefixes := ["res://packs/attach/"]
	var none := PKeyPck.lint_lines(src, dir, prefixes, null, [])
	var refused := none.size() == 3
	for i in none.size():
		var f: String = ["probe.tres", "probe.res", "probe_c.res"][i]
		var by_path := "packs/attach/%s: references the app script %s, which the app does not list as attachable." % [f, script_path]
		var by_uid := "packs/attach/%s: references %s, outside the pack's uid cache, which the app does not list as attachable." % [f, uid]
		refused = refused and (none[i] == by_path or (uid != "" and none[i] == by_uid))
	t.check("pck attach: text, binary and compressed references to an app script are refused with nothing attachable", refused, S.canon(Array(none)))
	# Whether the saver wrote the script's UID into the reference depends on where it saved (the
	# scratch is outside res://); when it did, the path alone does not admit it.
	var path_only := PKeyPck.lint_lines(src, dir, prefixes, null, [script_path])
	var uid_ok := path_only.is_empty()
	for l in path_only:
		uid_ok = uid != "" and l.contains(uid)
	t.check("pck attach: the script's path alone admits only references without its UID", uid_ok, S.canon(Array(path_only)))
	t.info("pck attach: %d of 3 references carry the script's UID (%s)" % [path_only.size(), uid])
	var both: Array = [script_path] if uid == "" else [script_path, uid]
	var listed := PKeyGodotPckHandler.check(src, {"handler": {"prefixes": prefixes}}, {}, both)
	t.check("pck attach: listed (path and UID), the pack is admitted", listed["ok"], S.canon(listed))
	t.check("pck attach: a directory entry admits the path too", PKeyPck.lint_lines(src, dir, prefixes, null, ["res://tests/packs/"] + ([] if uid == "" else [uid])).is_empty())
	if PKeyPck.engine_check(dir["header"]) == "" and PKeyPck.mount(pck, true):
		var loaded = load("res://packs/attach/probe.tres")
		var attached: bool = loaded != null and loaded.get_script() != null and (loaded.get_script() as Script).resource_path == script_path
		t.check("pck attach: mounted, the pack's resource loads with the app script attached and the pack's value (measured)", attached and int(loaded.get("power")) == 7, "%s" % loaded)
	S.remove_tree(scratch)


## P4-28 audit GAP C and the device's UID rule: the `type` of a reference is the pack's hint, and
## the engine picks the loader by extension, so an app GDScript saved as `.tres`
## (tests/packs/script_as_res.tres) referenced as `Resource` attaches a script. The device reads
## the real type (`ResourceLoader.get_resource_type`, through a `.remap` on an export) and refuses
## it unlisted. A UID the app registers is judged by the path it names: an app resource passes,
## an app script needs listing. The CLI cannot do either (it refuses every unlisted UID).
func _type_probes(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-type")
	var ver := PKeyPck.helper_version()
	var target := "res://tests/packs/script_as_res.tres"
	t.check("pck type: the app ships a GDScript saved as .tres", ClassDB.is_parent_class(PKeyPck._remapped_type(target), "Script"), PKeyPck._remapped_type(target))
	var hint := "[gd_resource type=\"Resource\" load_steps=2 format=3]\n\n[ext_resource type=\"Resource\" path=\"%s\" id=\"1\"]\n\n[resource]\nscript = ExtResource(\"1\")\n" % target
	var main_uid := "[gd_resource type=\"Resource\" load_steps=2 format=3]\n\n[ext_resource type=\"Resource\" uid=\"uid://s05mainbase1\" path=\"res://tests/packs/uid_main_base.tres\" id=\"1\"]\n\n[resource]\nmetadata/base = ExtResource(\"1\")\n"
	var script_uid := "[gd_resource type=\"Resource\" load_steps=2 format=3]\n\n[ext_resource type=\"Resource\" uid=\"uid://bp428scrres\" path=\"res://packs/type/missing.tres\" id=\"1\"]\n\n[resource]\nscript = ExtResource(\"1\")\n"
	var cases := [
		["a reference typed Resource to an app GDScript .tres", hint, [], "packs/type/x.tres: references the app script %s, which the app does not list as attachable." % target],
		["…listed", hint, [target], ""],
		["a UID the app registers for a resource (uid://s05mainbase1)", main_uid, [], ""],
		["a UID the app registers for a script, unlisted", script_uid, [], "packs/type/x.tres: references the app script %s, which the app does not list as attachable." % target],
		["…its path listed", script_uid, [target], ""],
	]
	var n := 0
	for c in cases:
		var out := scratch.path_join("type%d.pck" % n)
		n += 1
		PKeyPck.write(out, [{"path": "res://packs/type/x.tres", "bytes": String(c[1]).to_utf8_buffer()}], ver)
		var src := PKeyByteSource.file(out)
		var lines := PKeyPck.lint_lines(src, PKeyPck.read_directory(src), ["res://packs/type/"], null, c[2])
		S.check_same(t, "pck type: %s" % c[0], Array(lines), [] if c[3] == "" else [c[3]])
	S.remove_tree(scratch)


## P4-28 audit GAP D: an app scene's type is read from its first RSCC block only, once per path
## per check. Two engine-compressed app scenes are made available as app files through a helper
## pack (res://pkeygen/): one of about 30 MB of incompressible data, one declaring more than the
## pack cap (64 MiB). A pack .tres naming the first in 2,000 ext_resource tags typed Resource,
## and the second once, is admitted, both typed PackedScene, reading each scene's type once.
func _type_scale_probe(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-scale")
	var zeros := PackedByteArray()
	zeros.resize(PKeyPck.RSCC_MAX_TOTAL + 4194304)
	var files := {"big.scn": Crypto.new().generate_random_bytes(30000000), "huge.scn": zeros}
	var entries: Array = []
	for name in files:
		var node := Node.new()
		node.set_meta("blob", files[name])
		var scene := PackedScene.new()
		scene.pack(node)
		node.free()
		var out := scratch.path_join(name)
		if not t.check("pck scale: %s saved compressed" % name, ResourceSaver.save(scene, out, ResourceSaver.FLAG_COMPRESS) == OK):
			S.remove_tree(scratch)
			return
		entries.append({"path": "res://pkeygen/%s" % name, "source": PKeyByteSource.file(out)})
	files.clear()
	zeros = PackedByteArray()
	var helper := scratch.path_join("pkeygen.pck")
	var ver := PKeyPck.helper_version()
	var huge_head := FileAccess.get_file_as_bytes(scratch.path_join("huge.scn")).slice(0, 16)
	t.check("pck scale: the large app scene declares more than the pack cap", huge_head.size() == 16 and huge_head.decode_u32(12) > PKeyPck.RSCC_MAX_TOTAL, "%d" % (huge_head.decode_u32(12) if huge_head.size() == 16 else -1))
	if PKeyPck.write(helper, entries, ver) != OK or PKeyPck.engine_check(PKeyPck.read_directory(PKeyByteSource.file(helper))["header"]) != "" or not PKeyPck.mount(helper, true):
		t.info("pck scale: the helper pack did not mount on this engine; probe skipped")
		S.remove_tree(scratch)
		return
	t.check("pck scale: types are read from block 0 (big, over the cap)", PKeyPck._remapped_type("res://pkeygen/big.scn") == "PackedScene" and PKeyPck._remapped_type("res://pkeygen/huge.scn") == "PackedScene", "%s %s" % [PKeyPck._remapped_type("res://pkeygen/big.scn"), PKeyPck._remapped_type("res://pkeygen/huge.scn")])
	var text := "[gd_resource type=\"Resource\" load_steps=2002 format=3]\n\n"
	for i in 2000:
		text += "[ext_resource type=\"Resource\" path=\"res://pkeygen/big.scn\" id=\"%d\"]\n" % i
	text += "[ext_resource type=\"Resource\" path=\"res://pkeygen/huge.scn\" id=\"huge\"]\n\n[resource]\n"
	var pck := scratch.path_join("many.pck")
	PKeyPck.write(pck, [{"path": "res://packs/many/x.tres", "bytes": text.to_utf8_buffer()}], ver)
	var src := PKeyByteSource.file(pck)
	var reads_before := PKeyPck.type_reads
	var started := Time.get_ticks_msec()
	var lines := PKeyPck.lint_lines(src, PKeyPck.read_directory(src), ["res://packs/many/"], null, [])
	var ms := Time.get_ticks_msec() - started
	var reads := PKeyPck.type_reads - reads_before
	t.info("pck scale: 2,001 references to two large app scenes checked in %d ms (%d type reads)" % [ms, reads])
	S.check_same(t, "pck scale: 2,000 references to one ~30 MB app scene and one over the cap are admitted", Array(lines), [])
	t.check("pck scale: …reading each scene's type once (2 reads for 2,001 references)", reads == 2, "%d reads" % reads)
	t.check("pck scale: …and not hanging (guard %d ms)" % TYPE_SCALE_HANG_MS, ms < TYPE_SCALE_HANG_MS, "%d ms" % ms)
	S.remove_tree(scratch)


## P4-28 audit GAP A, measured: a pack sub-resource that sets `resource_path` to an app path not
## yet cached. The check refuses it; mounted anyway, loading it and then the app path shows which
## object the app gets.
func _cache_probe(t: PKeyTestContext) -> void:
	var scratch := S.scratch("pck-cache")
	var target := "res://tests/packs/cache_target.tres"
	var poison := "[gd_resource type=\"Resource\" load_steps=2 format=3]\n\n[sub_resource type=\"Resource\" id=\"Resource_p\"]\nresource_path = \"%s\"\nmetadata/tag = \"pack\"\n\n[resource]\nmetadata/sub = SubResource(\"Resource_p\")\n" % target
	var out := scratch.path_join("poison.pck")
	PKeyPck.write(out, [{"path": "res://packs/cachepoison/poison.tres", "bytes": poison.to_utf8_buffer()}], PKeyPck.helper_version())
	var src := PKeyByteSource.file(out)
	var dir := PKeyPck.read_directory(src)
	S.check_same(t, "pck cache: a sub-resource setting resource_path is refused", Array(PKeyPck.lint_lines(src, dir, ["res://packs/cachepoison/"], null, [])), ["packs/cachepoison/poison.tres: %s." % PKeyPck.RESOURCE_PATH_WHY])
	if PKeyPck.engine_check(dir["header"]) != "" or ResourceLoader.has_cached(target):
		t.info("pck cache: probe skipped (engine or %s already cached)" % target)
		S.remove_tree(scratch)
		return
	if not PKeyPck.mount(out, true):
		t.check("pck cache: the probe pack mounts", false)
		S.remove_tree(scratch)
		return
	var held = load("res://packs/cachepoison/poison.tres")
	var sub = held.get_meta("sub", null) if held != null else null
	var cached := ResourceLoader.has_cached(target)
	var app = load(target)
	var tag := String(app.get_meta("tag", "")) if app != null else "<null>"
	t.info("pck cache (%s): after loading the pack resource, %s cached=%s; load() returns tag %s" % [Engine.get_version_info()["string"], target, cached, tag])
	t.check("pck cache: mounted anyway, load() of the app path returns the pack's sub-resource (measured: why resource_path is refused)", held != null and cached and app == sub and tag == "pack", "tag %s" % tag)
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
	# GDScript) is decompressed, scanned and admitted.
	var gpck := FileAccess.get_file_as_bytes(DIR.path_join("rscc-g-run.pck"))
	var gsrc := PKeyByteSource.memory(gpck)
	var gdir := PKeyPck.read_directory(gsrc)
	var t1 := Time.get_ticks_usec()
	var gchk := PKeyPck.directory_check(gsrc, gdir, ["res://assets/kaykit/"]) if gdir["ok"] else {}
	var gms := (Time.get_ticks_usec() - t1) / 1000.0
	t.info("pck rscc: rscc-g-run (64 MiB body, a run of 'G') checked in %d ms" % gms)
	t.check("pck rscc: a 64 MiB run of 'G' is admitted (hang guard %d ms)" % G_RUN_HANG_MS, gdir["ok"] and gchk.get("ok", false) and gms < G_RUN_HANG_MS, "%d ms %s" % [gms, S.canon(gchk)])
	_scan_scaling(t)
	S.remove_tree(scratch)


## P4-27 audit GAP 2, as complexity rather than wall time: the marker scan's work is linear in the
## bytes, not in the hits (a run of 'G' costs what a run of 'Z' does) and not quadratic (4× the
## bytes cost about 4× the work). Counted work, so the checks hold under any load.
func _scan_scaling(t: PKeyTestContext) -> void:
	var mib := 1048576
	var g8 := PackedByteArray()
	g8.resize(8 * mib)
	g8.fill(0x47)
	var z8 := PackedByteArray()
	z8.resize(8 * mib)
	z8.fill(0x5A)
	var g2 := g8.slice(0, 2 * mib)
	var work := []
	var clean := true
	for data in [g8, z8, g2]:
		var probes := PKeyPck.scan_probes
		var bytes := PKeyPck.scan_bytes
		var started := Time.get_ticks_usec()
		clean = PKeyPck._marker(data) == "" and clean
		work.append([PKeyPck.scan_probes - probes, PKeyPck.scan_bytes - bytes, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("pck scan: runs of 'G' and 'Z' name no marker", clean)
	t.info("pck scan: 8 MiB of 'G' %d probes / %d bytes (%.1f ms), 8 MiB of 'Z' %d / %d (%.1f ms), 2 MiB of 'G' %d / %d (%.1f ms)" % [work[0][0], work[0][1], work[0][2], work[1][0], work[1][1], work[1][2], work[2][0], work[2][1], work[2][2]])
	var g: Array = work[0]
	var z: Array = work[1]
	var g_small: Array = work[2]
	t.check("pck scan: a run of hits costs at most %d× the work of a run of no hits (linear in bytes, not hits)" % G_RUN_HIT_FACTOR, z[0] > 0 and g[0] <= G_RUN_HIT_FACTOR * z[0] and g[1] <= G_RUN_HIT_FACTOR * z[1], "G %d probes / %d bytes, Z %d / %d" % [g[0], g[1], z[0], z[1]])
	t.check("pck scan: 4× the bytes cost at most %d× the work (linear 4×, quadratic 16×)" % G_RUN_SCALE_FACTOR, g_small[0] > 0 and g[0] <= G_RUN_SCALE_FACTOR * g_small[0] and g[1] <= G_RUN_SCALE_FACTOR * g_small[1], "8 MiB %d probes / %d bytes, 2 MiB %d / %d" % [g[0], g[1], g_small[0], g_small[1]])


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

