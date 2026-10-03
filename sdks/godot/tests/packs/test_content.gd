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
# Content corpus v2 (plans/P4-10.md §4.3) adds chunkIndexCases (PKeyPackChunks.parse_chunk_index,
# P4-11) and eight `strategy: chunk` apply cases (PKeyPackChunks.apply_chunk): the seeds' indexes
# parsed unbound, a fetcher that answers each single-range request with the object's bytes clipped
# at its end, and an in-memory output, exactly as conformance/runners/node/suites.ts.
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

## plans/P4-10.md §4.3: the chunk apply cases, every one run through apply_chunk (P4-11).
const CHUNK_APPLY_CASES := [
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
	_chunk_index(t, doc.get("chunkIndexCases", []))
	_data_only(t, doc.get("dataOnlyCases", []))
	_apply(t, (doc.get("applyCases", []) as Array).filter(func(c): return c["strategy"] != "chunk"))
	await _apply_chunks(t, (doc.get("applyCases", []) as Array).filter(func(c): return c["strategy"] == "chunk"))
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
	t.check("content: applyCases coverage (every non-chunk case)", n == cases.size() and n + CHUNK_APPLY_CASES.size() == FLOORS["applyCases"], "%d/%d" % [n, cases.size()])


## plans/P4-10.md §2.3: every chunk index case through parse_chunk_index (the engine's zstd
## decoder); the verdict compared is {ok: true, chunks, bundleSizes} or the failure itself.
func _chunk_index(t: PKeyTestContext, cases: Array) -> void:
	var z := PKeyPackZstd.new()
	var n := 0
	var started := Time.get_ticks_usec()
	for c in cases:
		var stored := S.materialise(c["stored"])
		var r := PKeyPackChunks.parse_chunk_index(stored, c["chunks"], c["payload"], z.decode)
		var verdict = r
		if r["ok"]:
			var sizes: Array = []
			for b in r["index"]["bundles"]:
				sizes.append(b[1])
			verdict = {"ok": true, "chunks": (r["index"]["records"] as Array).size(), "bundleSizes": sizes}
		S.check_same(t, "chunk index %s" % c["id"], verdict, c["expect"])
		n += 1
	t.info("chunkIndexCases: %d in %.1f ms" % [n, (Time.get_ticks_usec() - started) / 1000.0])
	t.check("content: chunkIndexCases coverage", n == cases.size() and n == FLOORS["chunkIndexCases"], "%d/%d" % [n, cases.size()])


## plans/P4-10.md §4.3: the eight chunk apply cases through apply_chunk. Seeds: each case seed's
## index parsed unbound (skipped when it does not parse) and its payload; objects as for the other
## apply cases; a fetcher answering objects[bundle] sliced to [offset, offset + length), clipped at
## the object's end (a missing object is an empty body), always ok; an in-memory output.
func _apply_chunks(t: PKeyTestContext, cases: Array) -> void:
	var ids: Array = cases.map(func(c): return c["id"])
	t.check("content: the chunk applyCases are exactly the corpus's eight (P4-11)", ids == CHUNK_APPLY_CASES, S.canon(ids))
	var z := PKeyPackZstd.new()
	var n := 0
	for c in cases:
		var started := Time.get_ticks_usec()
		var store := {}
		for h in c["objects"]:
			store[h] = S.materialise(c["objects"][h])
		var seeds: Array = []
		for sd in c.get("seeds", []):
			var p := PKeyPackChunks.parse_chunk_index_bytes(S.materialise(sd["index"]), null)
			if p["ok"]:
				seeds.append({"index": p["index"], "payload": PKeyByteSource.memory(S.materialise(sd["payload"]))})
		var out := PKeyPackChunks.MemoryOutput.new(int(c["variant"]["payload"]["size"]))
		var ports := {
			"objects": func(h: String) -> Variant: return PKeyByteSource.memory(store[h]) if store.has(h) else null,
			"zstd": z,
			"fetch_range": func(bundle: String, offset: int, length: int) -> Dictionary:
				var b: PackedByteArray = store.get(bundle, PackedByteArray())
				return {"status": "ok", "body": PKeyPackChunks.MemoryBody.new(b.slice(mini(offset, b.size()), mini(offset + length, b.size())))},
			"output": out,
		}
		var r: Dictionary = await PKeyPackChunks.apply_chunk(c["variant"], seeds, ports, c.get("repair") == true)
		S.check_same(t, "apply %s" % c["id"], r["verdict"], c["expect"])
		t.info("apply %s: %.1f ms" % [c["id"], (Time.get_ticks_usec() - started) / 1000.0])
		n += 1
	t.check("content: chunk applyCases coverage", n == CHUNK_APPLY_CASES.size(), "%d/%d" % [n, CHUNK_APPLY_CASES.size()])


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
