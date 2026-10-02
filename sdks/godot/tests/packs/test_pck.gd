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
