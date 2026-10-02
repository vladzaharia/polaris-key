class_name PKeyPackApply
extends RefCounted
## The appliers (plans/P4-01.md §2.9; notes/A7 §3.4): `apply_full`, `apply_delta` and
## `apply_file`, a port of client-core `packs/apply.ts`. `content/cases.json#applyCases` pins
## every verdict and counter. The first failure is the verdict; nothing raises.
##
## Ports (a Dictionary): `objects` Callable(sha256) -> PKeyByteSource or null (the stored objects
## the strategy fetched); `zstd` a PKeyPackZstd; optionally `sink` (an object with
## `write(offset, bytes) -> bool`: a container payload being rebuilt) and `tree` (an object with
## `write_file(path, bytes) -> bool`). A sink that refuses a write is the failing step's code.
##
## Verify before use: a stored object's length and SHA-256 are checked against its ref before a
## byte is decoded, an installed base's SHA-256 against the delta's `from` before it is used, and
## the output's SHA-256 before it is reported. Every `zstd-patch-from` frame passes §2.7 rule 3's
## window check (with the decoder's own P) before it is decoded, and a base that starts with the
## zstd dictionary magic is refused (rule 5).
##
## The engine decodes `--patch-from` frames in batches (PKeyPackZstd.decode_prefix_batch: one
## private-namespace mount pair per batch, A6 §2.4). `apply_file` therefore collects the delta
## entries whose base and window checks pass, decodes them together, and then walks the target
## index exactly as client-core does, taking each decoded result where client-core calls the
## decoder: the verdicts and their order are client-core's. Prefix decodes mount packs, so
## `apply_delta` and a `files`-scope `apply_file` run on the main thread; `apply_full` and the
## `file` strategy touch no engine state and may run on a WorkerThreadPool task.

const FULL_CORRUPT := "full-corrupt"
const DELTA_ARTIFACT_MISMATCH := "delta-artifact-mismatch"
const DELTA_BASE_MISMATCH := "delta-base-mismatch"
const DELTA_APPLY_FAILED := "delta-apply-failed"
const FILE_CORRUPT := "file-corrupt"
const FILE_SOURCE_MISSING := "file-source-missing"
const PAYLOAD_HASH_MISMATCH := "payload-hash-mismatch"


static func _fail(error: String, path: Variant = null) -> Dictionary:
	var v := {"ok": false, "error": error}
	if path != null:
		v["path"] = path
	return {"verdict": v}


static func _object(ports: Dictionary, sha256: Variant) -> PKeyByteSource:
	var f: Callable = ports.get("objects", Callable())
	if not f.is_valid() or not (sha256 is String):
		return null
	var s = f.call(sha256)
	return s if s is PKeyByteSource else null


static func _sink_write(ports: Dictionary, offset: int, bytes: PackedByteArray) -> bool:
	var sink = ports.get("sink")
	if sink == null or bytes.is_empty():
		return true
	return sink.write(offset, bytes) == true


static func _tree_write(ports: Dictionary, path: String, bytes: PackedByteArray) -> bool:
	var tree = ports.get("tree")
	if tree == null:
		return true
	return tree.write_file(path, bytes) == true


static func _starts_with_dictionary_magic(base: PKeyByteSource) -> bool:
	var head := base.read(0, 4)
	return head.size() == 4 and head[0] == 0x37 and head[1] == 0xA4 and head[2] == 0x30 and head[3] == 0xEC


## The checks of §2.7 rules 3 and 5 before a prefix decode: false refuses the frame.
static func prefix_allowed(zstd: PKeyPackZstd, frame: PackedByteArray, base: PKeyByteSource, mem_bytes: Variant) -> bool:
	if _starts_with_dictionary_magic(base):
		return false
	var p := zstd.pointer_bits()
	return PKeyPackZstd.window_log_max(mem_bytes, p) != null and PKeyPackZstd.window_allowed(frame, mem_bytes, p)


## Read and parse the target index (§2.7), refusing an oversized one before reading it.
static func _read_index(variant: Dictionary, ports: Dictionary) -> Dictionary:
	var files: Dictionary = variant["files"]
	var stored := PackedByteArray()
	if PKeyClaims.is_number(files.get("size")) and PKeyClaims.is_number(files.get("bytes")) and float(files["size"]) <= float(PKeyConstants.MAX_FILES_INDEX_BYTES) and float(files["bytes"]) <= float(PKeyConstants.MAX_FILES_INDEX_BYTES):
		var src := _object(ports, files.get("sha256"))
		if src != null and float(src.size) == float(files["bytes"]):
			stored = PKeyByteSource.read_all(src)
	var zstd: PKeyPackZstd = ports["zstd"]
	return PKeyPackFiles.parse_files_index(stored, files, variant["payload"], zstd.decode)


## Copy a source's bytes into the sink at `at`, feeding `hasher`; the bytes copied, or -1 when
## the sink refused a write.
static func _copy_through(source: PKeyByteSource, ports: Dictionary, at: int, hasher: HashingContext) -> int:
	var n := 0
	while n < source.size:
		var chunk := source.read(n, mini(PKeyByteSource.READ_CHUNK, source.size - n))
		if chunk.is_empty():
			break
		hasher.update(chunk)
		if not _sink_write(ports, at + n, chunk):
			return -1
		n += chunk.size()
	return n


## `applyFull` (§2.9): a tree first validates its index (§2.7's codes). Then, before decoding,
## the `full` ref must be usable with `full.size == payload.size`, and the stored length and
## SHA-256 must equal the ref (else `full-corrupt`); the decode must give exactly `full.size`
## bytes. A container's bytes must hash to `payload.sha256`; a tree's are split by entry sizes in
## index order and every file's SHA-256 checked (`full-corrupt`).
static func apply_full(variant: Dictionary, ports: Dictionary) -> Dictionary:
	var payload: Dictionary = variant["payload"]
	var full = variant.get("full")
	var index = null
	if PKeyPackClaims.same(variant["files"].get("layout"), "tree"):
		var r := _read_index(variant, ports)
		if not r["ok"]:
			return {"verdict": r}
		index = r["index"]
	if not (full is Dictionary) or not PKeyPackSelect.usable_codec(full.get("codec")) or not PKeyClaims.is_number(full.get("size")) or float(full["size"]) != float(payload["size"]):
		return _fail(FULL_CORRUPT)
	var stored := _object(ports, full.get("sha256"))
	if stored == null or not PKeyClaims.is_number(full.get("bytes")) or float(stored.size) != float(full["bytes"]):
		return _fail(FULL_CORRUPT)
	var out = PKeyPackPatch.open_object(stored, full, ports["zstd"])
	if out == null:
		return _fail(FULL_CORRUPT)
	var bytes: PackedByteArray = out
	if index == null:
		if PKeyPackClaims.sha256_hex(bytes) != payload["sha256"]:
			return _fail(FULL_CORRUPT)
		if not _sink_write(ports, 0, bytes):
			return _fail(FULL_CORRUPT)
		return {"verdict": {"ok": true, "sha256": payload["sha256"], "size": bytes.size()}}
	var pos := 0
	for f in index["files"]:
		var size := int(f["size"])
		var part := bytes.slice(pos, pos + size)
		pos += size
		if part.size() != size or PKeyPackClaims.sha256_hex(part) != f["sha256"]:
			return _fail(FULL_CORRUPT)
		if not _tree_write(ports, f["path"], part):
			return _fail(FULL_CORRUPT)
	return {"verdict": {"ok": true, "files": (index["files"] as Array).size(), "bytes": bytes.size(), "treeDigest": PKeyPackFiles.tree_digest(index["files"])}, "index": index}


## `applyDelta` (`payload` scope, §2.9): the artifact against its ref → `delta-artifact-mismatch`;
## the base's SHA-256 equals `from` → `delta-base-mismatch` (skipped only by the corpus's
## test switch); §2.7 rule 3's window check, then the raw-prefix decode, its length and its SHA-256
## against `payload` → `delta-apply-failed`. Main thread.
static func apply_delta(variant: Dictionary, delta_index: int, base: PKeyByteSource, ports: Dictionary, skip_base_check := false) -> Dictionary:
	var payload: Dictionary = variant["payload"]
	var deltas = variant.get("deltas", [])
	var d = deltas[delta_index] if deltas is Array and delta_index >= 0 and delta_index < deltas.size() else null
	if not (d is Dictionary) or not PKeyPackClaims.same(d.get("scope"), "payload"):
		return _fail(DELTA_ARTIFACT_MISMATCH)
	var a: Dictionary = d["artifact"]
	var src := _object(ports, a.get("sha256"))
	if src == null or float(src.size) != float(a["bytes"]):
		return _fail(DELTA_ARTIFACT_MISMATCH)
	var frame := PKeyByteSource.read_all(src)
	if float(frame.size()) != float(a["bytes"]) or PKeyPackClaims.sha256_hex(frame) != a["sha256"]:
		return _fail(DELTA_ARTIFACT_MISMATCH)
	if not skip_base_check and PKeyByteSource.sha256(base) != d["from"]:
		return _fail(DELTA_BASE_MISMATCH)
	var zstd: PKeyPackZstd = ports["zstd"]
	if not prefix_allowed(zstd, frame, base, d["memBytes"]):
		return _fail(DELTA_APPLY_FAILED)
	var out = zstd.decode_prefix_batch([{"frame": frame, "base": base, "size": int(payload["size"])}])[0]
	if not (out is PackedByteArray) or float(out.size()) != float(payload["size"]) or PKeyPackClaims.sha256_hex(out) != payload["sha256"]:
		return _fail(DELTA_APPLY_FAILED)
	if not _sink_write(ports, 0, out):
		return _fail(DELTA_APPLY_FAILED)
	return {"verdict": {"ok": true, "sha256": payload["sha256"], "size": (out as PackedByteArray).size()}}


## `applyFile` (§2.9), for the `file` strategy (`delta_index` -1) and a `files`-scope set: the
## target index (§2.7's codes), the gaps ref of a container (`files-layout-mismatch`), the
## descriptor and data of a set (`delta-artifact-mismatch`). Then for each target file in index
## order: reuse an installed file with the same SHA-256; else the set's `delta` entry (no
## installed file with its `from` → `delta-base-mismatch {path}`; the window check against the
## set's `memBytes`, then the decode → `delta-apply-failed {path}`); else its `blob` entry, or for
## the `file` strategy the file's own blob by its ref (`file-corrupt {path}`); else
## `file-source-missing {path}`. A container's payload SHA-256 → `payload-hash-mismatch`; a tree
## checks every file, reused ones included, and reports its `treeDigest`. `installed`: an Array
## of {path, sha256, size, source: PKeyByteSource}.
static func apply_file(variant: Dictionary, delta_index: int, installed: Array, ports: Dictionary) -> Dictionary:
	var payload: Dictionary = variant["payload"]
	var zstd: PKeyPackZstd = ports["zstd"]
	var r := _read_index(variant, ports)
	if not r["ok"]:
		return {"verdict": r}
	var index: Dictionary = r["index"]
	var container := PKeyPackClaims.same(index["layout"], "container")

	var gaps := PackedByteArray()
	if container:
		var g = variant["files"].get("gaps")
		var gsrc := _object(ports, g.get("sha256")) if g is Dictionary else null
		var opened = PKeyPackPatch.open_object(gsrc, g, zstd) if g is Dictionary else null
		if opened == null:
			return _fail(PKeyPackFiles.FILES_LAYOUT_MISMATCH)
		gaps = opened

	var entries := {}
	var data: PKeyByteSource = null
	var mem_bytes: Variant = 0
	var downloaded := 0
	var using_set := false
	if delta_index >= 0:
		var deltas = variant.get("deltas", [])
		var d = deltas[delta_index] if deltas is Array and delta_index < deltas.size() else null
		if not (d is Dictionary) or not PKeyPackClaims.same(d.get("scope"), "files"):
			return _fail(DELTA_ARTIFACT_MISMATCH)
		using_set = true
		mem_bytes = d["memBytes"]
		var patch_src := _object(ports, d["patch"].get("sha256"))
		var patch = PKeyPackPatch.parse_patch(patch_src, d, payload["sha256"], index, zstd)
		if patch == null:
			return _fail(DELTA_ARTIFACT_MISMATCH)
		data = _object(ports, d["data"].get("sha256"))
		if data == null or float(data.size) != float(d["data"]["bytes"]) or PKeyByteSource.sha256(data) != d["data"]["sha256"]:
			return _fail(DELTA_ARTIFACT_MISMATCH)
		downloaded = int(d["patch"]["bytes"]) + int(d["data"]["bytes"])
		for e in patch["entries"]:
			entries[e["path"]] = e

	var have := {}
	for f in installed:
		if not have.has(f["sha256"]):
			have[f["sha256"]] = f

	# Pass 1 (the batch): every delta entry whose base exists, hashes to `from` and passes the
	# window check is decoded now, in one mount pair. Pass 2 below decides exactly as client-core.
	var decoded := {}  # target path -> PackedByteArray or null
	var base_ok := {}  # sha256 -> bool (a base hashed once)
	if using_set:
		var jobs: Array = []
		var job_paths := PackedStringArray()
		for f in index["files"]:
			if have.has(f["sha256"]):
				continue
			var e = entries.get(f["path"])
			if not (e is Dictionary) or not PKeyPackClaims.same(e.get("op"), "delta"):
				continue
			var b = have.get(e["from"])
			if b == null:
				continue
			if not base_ok.has(e["from"]):
				base_ok[e["from"]] = PKeyByteSource.sha256(b["source"]) == e["from"]
			if not base_ok[e["from"]]:
				continue
			var slice := data.read(int(e["offset"]), int(e["length"]))
			if not prefix_allowed(zstd, slice, b["source"], mem_bytes):
				continue
			jobs.append({"frame": slice, "base": b["source"], "size": int(f["size"])})
			job_paths.append(f["path"])
		if not jobs.is_empty():
			var outs := zstd.decode_prefix_batch(jobs)
			for i in jobs.size():
				decoded[job_paths[i]] = outs[i]

	var counters := {"reusedFiles": 0, "deltaFiles": 0, "blobFiles": 0}
	var hasher := HashingContext.new()
	hasher.start(HashingContext.HASH_SHA256)
	var pos := 0
	var gp := 0
	var written := 0
	var reused: Array = []
	for f in index["files"]:
		var path: String = f["path"]
		var size := int(f["size"])
		var reuse = have.get(f["sha256"])
		var bytes = null
		if reuse != null:
			counters["reusedFiles"] += 1
		elif using_set:
			var e = entries.get(path)
			if e == null:
				return _fail(FILE_SOURCE_MISSING, path)
			var slice := data.read(int(e["offset"]), int(e["length"]))
			if PKeyPackClaims.same(e["op"], "delta"):
				var b = have.get(e["from"])
				if b == null:
					return _fail(DELTA_BASE_MISMATCH, path)
				if not base_ok.has(e["from"]):
					base_ok[e["from"]] = PKeyByteSource.sha256(b["source"]) == e["from"]
				if not base_ok[e["from"]]:
					return _fail(DELTA_BASE_MISMATCH, path)
				if not prefix_allowed(zstd, slice, b["source"], mem_bytes):
					return _fail(DELTA_APPLY_FAILED, path)
				var out = decoded.get(path)
				if not (out is PackedByteArray) or out.size() != size or PKeyPackClaims.sha256_hex(out) != f["sha256"]:
					return _fail(DELTA_APPLY_FAILED, path)
				bytes = out
				counters["deltaFiles"] += 1
			else:
				var out: PackedByteArray = slice
				if PKeyPackClaims.same(e.get("codec"), "zstd"):
					out = zstd.decode(slice, size)
				if out.size() != size or PKeyPackClaims.sha256_hex(out) != f["sha256"]:
					return _fail(FILE_CORRUPT, path)
				bytes = out
				counters["blobFiles"] += 1
		else:
			var stored := _object(ports, f["blob"]["sha256"])
			if stored == null:
				return _fail(FILE_SOURCE_MISSING, path)
			var ref: Dictionary = f["blob"].duplicate()
			ref["size"] = f["size"]
			var out = PKeyPackPatch.open_object(stored, ref, zstd)
			if out == null or PKeyPackClaims.sha256_hex(out) != f["sha256"]:
				return _fail(FILE_CORRUPT, path)
			bytes = out
			counters["blobFiles"] += 1
			downloaded += stored.size

		if container:
			var off := int(f["offset"])
			var gap := gaps.slice(gp, gp + (off - pos))
			if not gap.is_empty():
				hasher.update(gap)
			if not _sink_write(ports, written, gap):
				return _fail(FILE_CORRUPT, path)
			written += gap.size()
			gp += off - pos
			var src: PKeyByteSource = PKeyByteSource.memory(bytes) if bytes != null else reuse["source"]
			var n := _copy_through(PKeyByteSource.slice(src, 0, size), ports, written, hasher)
			if n < 0:
				return _fail(FILE_CORRUPT, path)
			written += n
			pos = off + size
		else:
			if bytes != null and not _tree_write(ports, path, bytes):
				return _fail(FILE_CORRUPT, path)
			reused.append(reuse if bytes == null else null)

	if not container:
		var files: Array = index["files"]
		var total := 0
		for i in files.size():
			total += int(files[i]["size"])
			var re = reused[i]
			if re == null:
				continue
			var fsize := int(files[i]["size"])
			var rb := PKeyByteSource.read_all(PKeyByteSource.slice(re["source"], 0, fsize))
			if rb.size() != fsize or PKeyPackClaims.sha256_hex(rb) != files[i]["sha256"]:
				return _fail(FILE_CORRUPT, files[i]["path"])
			if not _tree_write(ports, files[i]["path"], rb):
				return _fail(FILE_CORRUPT, files[i]["path"])
		var v := {"ok": true, "files": files.size(), "bytes": total, "treeDigest": PKeyPackFiles.tree_digest(files)}
		v.merge(counters)
		v["downloadedBytes"] = downloaded
		return {"verdict": v, "index": index}
	var trailing := gaps.slice(gp)
	if not trailing.is_empty():
		hasher.update(trailing)
	if not _sink_write(ports, written, trailing):
		return _fail(FILE_CORRUPT)
	written += trailing.size()
	if hasher.finish().hex_encode() != payload["sha256"]:
		return _fail(PAYLOAD_HASH_MISMATCH)
	var out := {"ok": true, "sha256": payload["sha256"], "size": written}
	out.merge(counters)
	out["downloadedBytes"] = downloaded
	return {"verdict": out, "index": index}
