extends RefCounted
# @pkey-feature packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.record packs.index.chunks packs.apply.chunk packs.delegation
# The content corpus (conformance/corpus/v2/content/cases.json, read from the checkout through
# PKEY_CONTENT_CORPUS; plans/P4-01.md §4.4), mirroring conformance/runners/node/suites.ts
# `defineContentSuites` vector for vector: the blobs table, pathCases, filesIndexCases,
# applyCases (full, delta and file through the addon's appliers, the engine's own zstd and GDDL
# decoders), packSetIdCases, stampCases and frameWindowCases.
#
# P4-19's dataOnlyCases (plans/P4-19.md §4.3 with Amendment A1) run through
# PKeyDataOnly.data_only_refusal: the file is `content` (standard base64) when the case carries it,
# else `head` + `tail` (or `tailFill`: `length` copies of `byte`), and the rule sees its first
# DATA_ONLY_HEAD_BYTES, its last DATA_ONLY_TAIL_BYTES and the whole file, as the Node runner does.
#
# Content corpus v2 (plans/P4-10.md §4.3) adds chunkIndexCases and eight `strategy: chunk` apply
# cases. Godot's chunk parser and applier are P4-11's: both are declared planned by exact id (and
# in parity.json), never skipped silently; their <ref> inputs (the put* mutations included) are
# materialised and checked against their refs here, as the Python and Swift runners do.
#
# The `zstd-patch-from` decode is engine-internal (P4-01 decision 7): on an engine outside
# PKeyPackZstd.PATCH_FROM_ENGINES (4.4, 4.5) the SDK does not advertise the method, so the planner
# never picks a delta, and a delta apply case must give its own verdict when that comes before the
# first decode and otherwise fail closed with `delta-apply-failed`: that is what such an engine is
# held to, and the INFO line says so.

const S := preload("res://tests/packs/support.gd")
## The content corpus's directory under conformance/corpus/v2/ (PKEY_CONTENT_CORPUS names it).
const CONTENT := "content/"

const FLOORS := {"dataOnlyCases": 76, "pathCases": 18, "filesIndexCases": 15, "chunkIndexCases": 22, "packSetIdCases": 7, "stampCases": 10, "frameWindowCases": 13, "applyCases": 27}

## plans/P4-10.md §4.3: the sections Godot declares planned until P4-11, by exact id.
const CHUNK_INDEX_PLANNED := [
	"chunks-v1-valid", "chunks-v2-valid", "chunks-short-header", "chunks-bad-magic",
	"chunks-bad-version", "chunks-bad-record-size", "chunks-bad-flags", "chunks-bad-length",
	"chunks-bad-length-count", "chunks-zero-length", "chunks-bad-clen", "chunks-bad-bundle-ref",
	"chunks-bad-bundle-range", "chunks-reserved-nonzero", "chunks-size-mismatch", "chunks-zero-clen",
	"chunks-bad-length-wrap", "chunks-size-high-word", "chunks-ref-tampered", "chunks-ref-over-max",
	"chunks-payload-mismatch", "chunks-bundle-size-saturated",
]
const CHUNK_APPLY_PLANNED := [
	"chunk-v1-to-v2", "chunk-no-seed", "chunk-tampered-zstd", "chunk-tampered-raw",
	"chunk-bundle-truncated", "chunk-seed-tampered", "chunk-seed-tampered-repair",
	"chunk-index-for-other-payload",
]


func run(t: PKeyTestContext) -> void:
	var dir := S.content_dir()
	if not t.check("content: PKEY_CONTENT_CORPUS names the checkout's %s corpus" % CONTENT, dir != "", OS.get_environment("PKEY_CONTENT_CORPUS")):
		return
	var doc = S.read_json(dir.path_join("cases.json"))
	if not t.check("content: cases.json parses", doc is Dictionary):
		return
	t.info("content cases.json sha256=%s" % FileAccess.get_sha256(dir.path_join("cases.json")))
	t.check("content: contentCorpusVersion", PKeyPackClaims.same(doc.get("contentCorpusVersion"), PKeyConstants.CONTENT_CORPUS_VERSION), str(doc.get("contentCorpusVersion")))
	for section in FLOORS:
		t.check("content: %s has %d cases" % [section, FLOORS[section]], doc.get(section) is Array and doc[section].size() == FLOORS[section], str((doc.get(section, []) as Array).size()))
	_blobs(t, dir, doc)
	_paths(t, doc.get("pathCases", []))
	_files_index(t, doc.get("filesIndexCases", []))
	_chunks_planned(t, doc)
	_data_only(t, doc.get("dataOnlyCases", []))
	_apply(t, (doc.get("applyCases", []) as Array).filter(func(c): return c["strategy"] != "chunk"))
	_pack_sets(t, doc.get("packSetIdCases", []))
	_stamps(t, doc.get("stampCases", []))
	_windows(t, doc.get("frameWindowCases", []))


func _walk(root: String, rel: String, out: PackedStringArray) -> void:
	var d := DirAccess.open(root.path_join(rel))
	if d == null:
		return
	d.include_hidden = true
	for f in d.get_files():
		out.append(f if rel == "" else rel + "/" + f)
	for sub in d.get_directories():
		_walk(root, sub if rel == "" else rel + "/" + sub, out)


func _blobs(t: PKeyTestContext, dir: String, doc: Dictionary) -> void:
	var on_disk := PackedStringArray()
	_walk(dir.path_join("blobs"), "", on_disk)
	on_disk.sort()
	var table: Array = (doc.get("blobs", {}) as Dictionary).keys()
	table.sort()
	t.check("content: every file under blobs/ is in the blobs table, and nothing else", on_disk == PackedStringArray(table), "%d on disk, %d in the table" % [on_disk.size(), table.size()])
	var bad := PackedStringArray()
	for name in table:
		var want: Dictionary = doc["blobs"][name]
		var got := S.blob(name)
		if got.size() != int(want["size"]) or PKeyPackClaims.sha256_hex(got) != want["sha256"]:
			bad.append(name)
	t.check("content: every blob matches its size and SHA-256", bad.is_empty(), ", ".join(bad))


func _paths(t: PKeyTestContext, cases: Array) -> void:
	var n := 0
	for c in cases:
		var got := PKeyPackFiles.check_paths(c["paths"])
		S.check_same(t, "paths %s" % c["id"], got, c["expect"])
		n += 1
	t.check("content: pathCases coverage", n == cases.size() and n >= FLOORS["pathCases"], "%d/%d" % [n, cases.size()])


func _files_index(t: PKeyTestContext, cases: Array) -> void:
	var z := PKeyPackZstd.new()
	var n := 0
	var started := Time.get_ticks_usec()
	for c in cases:
		var stored := S.materialise(c["stored"])
		var r := PKeyPackFiles.parse_files_index(stored, c["files"], c["payload"], z.decode)
		var verdict = {"ok": true, "files": (r["index"]["files"] as Array).size()} if r["ok"] else r
		S.check_same(t, "files index %s" % c["id"], verdict, c["expect"])
		n += 1
	t.info("filesIndexCases: %d in %.1f ms" % [n, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("content: filesIndexCases coverage", n == cases.size() and n >= FLOORS["filesIndexCases"], "%d/%d" % [n, cases.size()])


## Whether an apply case reaches a `--patch-from` decode on its success path.
static func _decodes(c: Dictionary) -> bool:
	return c["strategy"] == "delta" or (c["strategy"] == "file" and c.get("delta") != null)


func _apply(t: PKeyTestContext, cases: Array) -> void:
	var z := PKeyPackZstd.new()
	var patch_from := z.patch_from_available()
	t.info("applyCases: zstd-patch-from %s on %s" % ["advertised" if patch_from else "NOT advertised (fails closed)", Engine.get_version_info().string])
	var n := 0
	for c in cases:
		var started := Time.get_ticks_usec()
		var store := {}
		for h in c["objects"]:
			store[h] = S.materialise(c["objects"][h])
		var objects := func(h: String) -> Variant:
			return PKeyByteSource.memory(store[h]) if store.has(h) else null
		var base := PackedByteArray()
		var installed: Array = []
		if c.get("installed") is Dictionary:
			base = S.materialise(c["installed"]["payload"])
			var idx = S.read_json_bytes(S.materialise(c["installed"]["files"]))
			var whole := PKeyByteSource.memory(base)
			for f in idx["files"]:
				installed.append({"path": f["path"], "sha256": f["sha256"], "size": int(f["size"]), "source": PKeyByteSource.slice(whole, int(f["offset"]), int(f["size"]))})
		var ports := {"objects": objects, "zstd": z}
		var r: Dictionary
		match String(c["strategy"]):
			"full":
				r = PKeyPackApply.apply_full(c["variant"], ports)
			"delta":
				r = PKeyPackApply.apply_delta(c["variant"], int(c["delta"]), PKeyByteSource.memory(base), ports, c.get("skipBaseCheck") == true)
			_:
				r = PKeyPackApply.apply_file(c["variant"], int(c["delta"]) if c.get("delta") != null else -1, installed, ports)
		var ms := (Time.get_ticks_usec() - started) / 1000.0
		var want = c["expect"]
		if not patch_from and _decodes(c):
			# Its own verdict when that comes before the first decode, else a closed failure.
			var closed: bool = r["verdict"].get("ok") == false and r["verdict"].get("error") == PKeyPackApply.DELTA_APPLY_FAILED
			t.check("apply %s (without patch-from: its verdict or delta-apply-failed)" % c["id"], S.same(r["verdict"], want) or closed, "got %s want %s" % [S.canon(r["verdict"]), S.canon(want)])
		else:
			S.check_same(t, "apply %s" % c["id"], r["verdict"], want)
		t.info("apply %s: %.1f ms" % [c["id"], ms])
		n += 1
	t.info("applyCases GDDL: %s" % S.canon(z.stats))
	t.check("content: applyCases coverage (every non-chunk case)", n == cases.size() and n + CHUNK_APPLY_PLANNED.size() == FLOORS["applyCases"], "%d/%d" % [n, cases.size()])


## No silent skip: the planned lists are exactly the corpus's chunk cases, parity.json declares
## both features planned in P4-11, and every chunk index case's input materialises to the bytes
## its `chunks` ref names (except chunks-ref-tampered, whose stored frame is the mutated one).
func _chunks_planned(t: PKeyTestContext, doc: Dictionary) -> void:
	var idx_ids := []
	for c in doc.get("chunkIndexCases", []):
		idx_ids.append(c["id"])
	var apply_ids := []
	for c in doc.get("applyCases", []):
		if c["strategy"] == "chunk":
			apply_ids.append(c["id"])
	t.check("content: chunkIndexCases are exactly the planned ids (P4-11)", idx_ids == CHUNK_INDEX_PLANNED, S.canon(idx_ids))
	t.check("content: the chunk applyCases are exactly the planned ids (P4-11)", apply_ids == CHUNK_APPLY_PLANNED, S.canon(apply_ids))
	# res://parity.json: the export preset's include_filter (*.json) packs it into the template too.
	var parity = S.read_json("res://parity.json")
	for fid in ["packs.index.chunks", "packs.apply.chunk"]:
		var f = parity.get("features", {}).get(fid) if parity is Dictionary else null
		t.check("content: parity.json declares %s planned in P4-11" % fid, f is Dictionary and f.size() == 2 and f.get("status") == "planned" and f.get("wp") == "P4-11", S.canon(f))
	for c in doc.get("chunkIndexCases", []):
		var stored := S.materialise(c["stored"])
		var ref: Dictionary = c["chunks"]
		var matches: bool = stored.size() == int(ref["bytes"]) and PKeyPackClaims.sha256_hex(stored) == ref["sha256"]
		t.check("chunk index %s: its input materialises to its ref (planned: P4-11)" % c["id"], matches == (c["id"] != "chunks-ref-tampered"))
	t.info("planned: P4-11 (packs.index.chunks, packs.apply.chunk): %d chunk index and %d chunk apply cases" % [idx_ids.size(), apply_ids.size()])


## The data-only cases' file bytes: `content` (the whole file), else `head` + `tail` or `tailFill`.
static func data_only_file(c: Dictionary) -> PackedByteArray:
	if c.has("content"):
		return Marshalls.base64_to_raw(c["content"])
	var f := Marshalls.base64_to_raw(c["head"])
	var fill = c.get("tailFill")
	if fill is Dictionary:
		var tail := PackedByteArray()
		tail.resize(int(fill["length"]))
		tail.fill(int(fill["byte"]))
		f.append_array(tail)
	else:
		f.append_array(Marshalls.base64_to_raw(c["tail"]))
	return f


func _data_only(t: PKeyTestContext, cases: Array) -> void:
	var n := 0
	var started := Time.get_ticks_usec()
	for c in cases:
		var f := data_only_file(c)
		var rule := PKeyDataOnly.data_only_refusal(
			c["path"],
			f.slice(0, PKeyConstants.DATA_ONLY_HEAD_BYTES),
			f.slice(maxi(0, f.size() - PKeyConstants.DATA_ONLY_TAIL_BYTES)),
			f,
		)
		var got := {"ok": true} if rule == "" else {"ok": false, "rule": rule}
		S.check_same(t, "data-only %s" % c["id"], got, c["expect"])
		# The whole-file form gives the same verdict.
		t.check("data-only %s (whole file)" % c["id"], PKeyDataOnly.data_only_file_refusal(c["path"], f) == rule)
		n += 1
	t.info("dataOnlyCases: %d in %.1f ms" % [n, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("content: dataOnlyCases coverage", n == cases.size() and n >= FLOORS["dataOnlyCases"], "%d/%d" % [n, cases.size()])


func _pack_sets(t: PKeyTestContext, cases: Array) -> void:
	var n := 0
	for c in cases:
		var got := {"packSetId": PKeyPackClaims.pack_set_id(c["entries"])}
		S.check_same(t, "pack set %s" % c["id"], got, c["expect"])
		n += 1
	t.check("content: packSetIdCases coverage", n == cases.size() and n >= FLOORS["packSetIdCases"], "%d/%d" % [n, cases.size()])


func _stamps(t: PKeyTestContext, cases: Array) -> void:
	var n := 0
	var holds := 0
	for c in cases:
		var got := PKeyPackClaims.parse_content_stamp(c["stamp"])
		# parse_content_stamp's result is unchanged by P4-13: `expect.holds`, where present, is
		# holds_of over the stamp at its top level with its own pointers (plans/P4-13.md §2.4).
		var want: Dictionary = (c["expect"] as Dictionary).duplicate()
		want.erase("holds")
		S.check_same(t, "stamp %s" % c["id"], got, want)
		if (c["expect"] as Dictionary).has("holds"):
			S.check_same(t, "stamp %s holds" % c["id"], PKeyPackClaims.stamp_holds(c["stamp"]), c["expect"]["holds"])
			holds += 1
		n += 1
	t.check("content: stampCases coverage", n == cases.size() and n >= FLOORS["stampCases"], "%d/%d" % [n, cases.size()])
	t.check("content: stampCases with expect.holds (plans/P4-13.md §4.1: four)", holds >= 4, str(holds))


func _windows(t: PKeyTestContext, cases: Array) -> void:
	var n := 0
	for c in cases:
		var got := {"window": PKeyPackZstd.frame_window(String(c["header"]).hex_decode())}
		S.check_same(t, "frame window %s" % c["id"], got, c["expect"])
		n += 1
	t.check("content: frameWindowCases coverage", n == cases.size() and n >= FLOORS["frameWindowCases"], "%d/%d" % [n, cases.size()])
