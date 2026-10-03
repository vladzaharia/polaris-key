extends RefCounted
# @pkey-feature packs.apply.delta
# The delta bake over a base that is CURRENTLY MOUNTED (brief "The bake mutates the base";
# notes/A6 §7 had not tested it): the kaykit v1 pack sits in a store path and is mounted, the
# v1→v2 payload delta and the files delta are decoded by the engine's GDDL decoder through a
# trailer appended to that very file, and afterwards the running session's reads of the mounted
# v1 entries are unchanged, the base is restored byte for byte (SHA-256 re-checked) and each
# output is CI's v2. Then a crash between the trailer and the truncation is repaired at the next
# load from the bake journal. Runs where `zstd-patch-from` is advertised (4.6+); elsewhere the
# INFO line says why it cannot.

const S := preload("res://tests/packs/support.gd")
const UPDATE := "res://tests/fixtures/packs/update"


func _reads(entries: Array) -> Dictionary:
	var out := {}
	for e in entries:
		var p: String = e["path"]
		if not p.begins_with("assets/"):
			continue
		var f := FileAccess.open("res://" + p, FileAccess.READ)
		out[p] = PKeyPackClaims.sha256_hex(f.get_buffer(f.get_length())) if f != null else "<unreadable>"
	return out


func run(t: PKeyTestContext) -> void:
	var z := PKeyPackZstd.new()
	if not z.patch_from_available():
		t.check("bake: zstd-patch-from is not advertised on this engine", not PackedStringArray(PKeyPackZstd.PATCH_FROM_ENGINES).has("%d.%d" % [Engine.get_version_info()["major"], Engine.get_version_info()["minor"]]))
		t.info("bake: skipped on %s (no GDDL decoder: PACK_FILE_DELTA arrived in 4.6)" % Engine.get_version_info().string)
		return
	var m = S.read_json(UPDATE.path_join("manifest.json"))
	if not t.check("bake: manifest.json parses", m is Dictionary):
		return
	var v1 := FileAccess.get_file_as_bytes(UPDATE.path_join("kaykit-v1.pck"))
	var v2sha: String = m["v2"]["variant"]["payload"]["sha256"]
	var v1sha := PKeyPackClaims.sha256_hex(v1)
	var storage := PKeyPackStorage.new(S.scratch("bake"))
	var base_path := storage.container_path(v1sha)
	DirAccess.make_dir_recursive_absolute(storage.store_dir())
	t.check("bake: the v1 base is in the store", S.write_file(base_path, v1))
	var dir := PKeyPck.read_directory(PKeyByteSource.memory(v1))
	# Mounted as a game mounts it (replace_files=true), so these paths are served by this file. The
	# fixture is a 4.7.2 export (PCK format 4); 4.6 reads format 3 at most, so there it must refuse
	# to mount, and the delta cases below decode over an unmounted base (P1-12's 4.6 leg).
	var base_format := int(dir["header"]["formatVersion"])
	var engine_format := PKeyPck.helper_version()
	var before := {}
	if base_format <= engine_format:
		t.check("bake: the base mounts", PKeyPck.mount(base_path, true))
		before = _reads(dir["entries"])
		t.check("bake: the mounted base's entries read through res://", before.size() >= 10 and not before.values().has("<unreadable>"), "%d entries" % before.size())
	else:
		t.check("bake: a PCK format %d base does not mount on an engine that reads format %d" % [base_format, engine_format], engine_format > 0 and not PKeyPck.mount(base_path, true))
		before = _reads(dir["entries"])
		t.info("bake: the mounted-base reads are not exercised on %s (the fixture is PCK format %d)" % [Engine.get_version_info().string, base_format])

	var objects := func(h: String) -> Variant:
		var p := UPDATE.path_join("objects").path_join(h)
		return PKeyByteSource.memory(FileAccess.get_file_as_bytes(p)) if FileAccess.file_exists(p) else null
	var variant: Dictionary = m["v2"]["variant"]
	var deltas: Array = variant["deltas"]
	var payload_k := -1
	var files_k := -1
	for k in deltas.size():
		if deltas[k]["scope"] == "payload":
			payload_k = k
		else:
			files_k = k
	var notes: Array = []
	z.on_bake = func(file: String, size: int) -> bool:
		notes.append([file, size])
		return storage.note_bake("bake-test", file, size)

	# 1. The whole-payload delta, its base the mounted store file.
	var sink := PKeyPackStorage.FileSink.new(storage.root.path_join("out-payload.bin"))
	S.write_file(sink.path, PackedByteArray())
	var started := Time.get_ticks_usec()
	var r := PKeyPackApply.apply_delta(variant, payload_k, PKeyByteSource.file(base_path), {"objects": objects, "zstd": z, "sink": sink})
	sink.close()
	var ms := (Time.get_ticks_usec() - started) / 1000.0
	t.check("bake: the payload delta over the mounted base gives CI's v2", r["verdict"].get("ok") == true and r["verdict"].get("sha256") == v2sha and PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(sink.path)) == v2sha, S.canon(r["verdict"]))
	t.check("bake: it went through a trailer on the base (not a copy)", z.stats["trailers"] >= 1 and notes.size() == 2 and notes[0][0] == base_path and notes[0][1] == v1.size() and notes[1][1] == -1, S.canon(notes))
	t.info("bake: payload delta %.1f ms (%s)" % [ms, S.canon(z.stats)])
	t.check("bake: the base is restored byte for byte (SHA-256 re-checked)", PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(base_path)) == v1sha)
	S.check_same(t, "bake: the running session's reads of the mounted base are unchanged", _reads(dir["entries"]), before)

	# 2. The files delta (per-entry frames), its bases ranges of the mounted store file.
	var installed: Array = []
	var whole := PKeyByteSource.file(base_path)
	for e in dir["entries"]:
		installed.append({"path": e["path"], "sha256": PKeyPackClaims.sha256_hex(v1.slice(int(e["offset"]), int(e["offset"]) + int(e["size"]))), "size": int(e["size"]), "source": PKeyByteSource.slice(whole, int(e["offset"]), int(e["size"]))})
	var sink2 := PKeyPackStorage.FileSink.new(storage.root.path_join("out-files.bin"))
	S.write_file(sink2.path, PackedByteArray())
	notes.clear()
	started = Time.get_ticks_usec()
	var r2 := PKeyPackApply.apply_file(variant, files_k, installed, {"objects": objects, "zstd": z, "sink": sink2})
	sink2.close()
	ms = (Time.get_ticks_usec() - started) / 1000.0
	t.check("bake: the files delta over the mounted base gives CI's v2", r2["verdict"].get("ok") == true and r2["verdict"].get("sha256") == v2sha and int(r2["verdict"].get("deltaFiles", 0)) >= 1 and PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(sink2.path)) == v2sha, S.canon(r2["verdict"]))
	t.check("bake: one trailer for every entry frame (one mount pair)", notes.size() == 2 and notes[0][0] == base_path, S.canon(notes))
	t.info("bake: files delta %.1f ms (%s)" % [ms, S.canon(z.stats)])
	t.check("bake: the base is restored byte for byte again", PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(base_path)) == v1sha)
	S.check_same(t, "bake: the mounted base still reads the same", _reads(dir["entries"]), before)
	t.check("bake: no bake journal is left behind", not FileAccess.file_exists(storage.bake_journal_path("bake-test")))

	# 3. A crash between the trailer and the truncation: the journal repairs it at the next load.
	var tr := PKeyPck.append_trailer(base_path, [{"path": "__pkey/crash/x", "offset": 0, "size": 16}], PKeyPck.helper_version())
	storage.note_bake("crash-plan", base_path, v1.size())
	t.check("bake: (a crashed bake leaves the base longer)", tr["ok"] and FileAccess.get_file_as_bytes(base_path).size() > v1.size())
	var repaired := storage.repair_bakes()
	t.check("bake: repair_bakes truncates it back and clears the journal", repaired.has(base_path) and PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(base_path)) == v1sha and not FileAccess.file_exists(storage.bake_journal_path("crash-plan")), str(repaired))
	# A bake journal names only store packs (exactly store/<64 hex>.pck), and a journal that
	# cannot be written keeps the base untouched: its prefixes go into a copy host instead.
	t.check("bake: the journal refuses a file that is not a store pack", not storage.note_bake("x", storage.root.path_join("elsewhere.pck"), 1) and not storage.note_bake("x", storage.store_dir().path_join("abc.pck"), 1))
	var z2 := PKeyPackZstd.new()
	z2.on_bake = func(_f: String, _n: int) -> bool: return false
	var trailers_before: int = z2.stats["trailers"]
	var sink3 := PKeyPackStorage.FileSink.new(storage.root.path_join("out-nojournal.bin"))
	S.write_file(sink3.path, PackedByteArray())
	var r3 := PKeyPackApply.apply_delta(variant, payload_k, PKeyByteSource.file(base_path), {"objects": objects, "zstd": z2, "sink": sink3})
	sink3.close()
	t.check("bake: without a journal the delta still decodes, through a copy host and no trailer", r3["verdict"].get("ok") == true and z2.stats["trailers"] == trailers_before and z2.stats["hosts"] >= 1 and PKeyPackClaims.sha256_hex(FileAccess.get_file_as_bytes(base_path)) == v1sha, "%s %s" % [S.canon(r3["verdict"]), S.canon(z2.stats)])
	S.remove_tree(storage.root)
