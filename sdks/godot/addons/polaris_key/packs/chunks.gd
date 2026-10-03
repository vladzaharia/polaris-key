class_name PKeyPackChunks
extends RefCounted
## Chunk sync (plans/P4-10.md §2.3, §2.5; notes/A7 §3.4; P4-11): the `pkey-chunks/1` parser, the
## request runs, the seed map, the applier and the exact Content-Range adapter, a port of
## client-core `packs/chunks.ts` and `packs/chunkApply.ts`. `content/cases.json` pins
## `parse_chunk_index` (chunkIndexCases) and `apply_chunk` (the `strategy: chunk` applyCases).
##
##   parse_chunk_index(stored, ref, payload, decode, max_bytes)   {ok: true, index} or {ok: false,
##                                       error, chunk?|bundle?}; never fails otherwise
##   parse_chunk_index_bytes(b, payload) steps 1–10 over decoded index bytes
##   chunk_runs(records, seeded)         the request runs (the planner's rule exactly)
##   seed_map(seeds)                     id -> [seed, offset], first occurrence wins
##   apply_chunk(variant, seeds, ports, repair, completed_runs, on_run_done, on_progress)
##                                       a coroutine: {verdict, index?}
##   chunk_range_fetch(open_range)       the applier's `fetch_range` over a transport's ranged open
##
## Index layout (all little-endian), exactly A7 §3.1:
##
##   header   64 B   "PKEYCHNK" | version u16 = 1 | recordSize u16 = 48 | flags u32 (bit 0
##                   fileAware) | chunkCount u32 | bundleCount u32 | payloadSize u64 |
##                   payloadSha256[32]
##   chunks   48 B   id[32] | len u32 | clen u32 | bundle u32 | offset u32, in payload order
##   bundles  48 B   sha256[32] | size u64 | reserved u64
##
## The u64 rule: `hi × 2^32 + lo` from two decode_u32 reads (low word first), saturated at 2^53,
## never `decode_u64` (a GDScript int is signed, and every SDK must reach the same value). Chunk
## ids are kept as lowercase hex Strings, the planner's own keys (`installed[].chunks.ids`).
##
## THREADS: the parser touches no shared state and indexes no const Array, so it may run on a
## WorkerThreadPool task (PKeyPackJob). The applier is a coroutine on the main thread (its range
## requests poll HTTPClient once per frame); every hash and decode inside it is native.
##
## Memory: the applier holds the parsed index, the seed map and one chunk (`clen + len`, at most
## 2 × MAX_CHUNK_BYTES); the output goes through a positional writer it can read back, and each run's
## body is pulled record by record, never buffered whole.

const CHUNKS_REF_MISMATCH := "chunks-ref-mismatch"
const CHUNKS_BAD_LENGTH := "chunks-bad-length"
const CHUNKS_BAD_MAGIC := "chunks-bad-magic"
const CHUNKS_UNSUPPORTED_VERSION := "chunks-unsupported-version"
const CHUNKS_BAD_RECORD_SIZE := "chunks-bad-record-size"
const CHUNKS_BAD_FLAGS := "chunks-bad-flags"
const CHUNKS_RESERVED_NONZERO := "chunks-reserved-nonzero"
const CHUNKS_ZERO_LENGTH := "chunks-zero-length"
const CHUNKS_BAD_CLEN := "chunks-bad-clen"
const CHUNKS_BAD_BUNDLE_REF := "chunks-bad-bundle-ref"
const CHUNKS_BAD_BUNDLE_RANGE := "chunks-bad-bundle-range"
const CHUNKS_SIZE_MISMATCH := "chunks-size-mismatch"
const CHUNKS_PAYLOAD_MISMATCH := "chunks-payload-mismatch"
const CHUNK_BUNDLE_TRUNCATED := "chunk-bundle-truncated"
const CHUNK_CORRUPT := "chunk-corrupt"
const PAYLOAD_HASH_MISMATCH := "payload-hash-mismatch"
const NETWORK_ERROR := "network-error"
## `network-error` details: the strategy falls back (`range-refused`) or resumes later (`interrupted`).
const RANGE_REFUSED := "range-refused"
const INTERRUPTED := "interrupted"

const MAGIC := "PKEYCHNK"
const HEADER_BYTES := 64
const RECORD_BYTES := 48
const FLAG_FILE_AWARE := 1
const TWO_32 := 4294967296
const TWO_53 := 9007199254740992
## 2^53 / 2^32: a high word at or above it saturates (and keeps `hi × 2^32` inside an int64).
const HI_SATURATED := 2097152

## Record kinds in the applier's pass (a PackedByteArray of these, never a const Array).
const KIND_SEED := 0
const KIND_SELF := 1
const KIND_FETCH := 2


static func _fail(error: String, at: Dictionary = {}) -> Dictionary:
	var v := {"ok": false, "error": error}
	v.merge(at)
	return v


## A u64 at `at` by the u64 rule: two u32 reads, low word first, saturated at 2^53.
static func read_u64(b: PackedByteArray, at: int) -> int:
	var lo := b.decode_u32(at)
	var hi := b.decode_u32(at + 4)
	if hi >= HI_SATURATED:
		return TWO_53
	return mini(hi * TWO_32 + lo, TWO_53)


## `parseChunkIndex(stored, ref, payload | null, {decode, maxBytes})` (plans/P4-10.md §2.3): the
## index, or the first failure in this order:
##
##  0. `ref.size` above `max_bytes` (before anything is decoded) or not a number, the stored length
##     or SHA-256 differs from the ref, a `zstd` ref fails to decode (`decode` is
##     PKeyPackZstd.decode's shape: empty on failure), any other codec, or the decoded length is not
##     `ref.size` → `chunks-ref-mismatch`;
##  1–10. parse_chunk_index_bytes.
static func parse_chunk_index(stored: PackedByteArray, ref: Variant, payload: Variant, decode: Callable = Callable(), max_bytes: int = PKeyConstants.MAX_CHUNK_INDEX_BYTES) -> Dictionary:
	if not (ref is Dictionary):
		return _fail(CHUNKS_REF_MISMATCH)
	var size = ref.get("size")
	if not PKeyClaims.is_number(size) or float(size) > float(max_bytes):
		return _fail(CHUNKS_REF_MISMATCH)
	var nbytes = ref.get("bytes")
	if not PKeyClaims.is_number(nbytes) or float(stored.size()) != float(nbytes):
		return _fail(CHUNKS_REF_MISMATCH)
	var sha = ref.get("sha256")
	if not (sha is String) or PKeyPackClaims.sha256_hex(stored) != sha:
		return _fail(CHUNKS_REF_MISMATCH)
	var b: PackedByteArray
	var codec = ref.get("codec")
	if PKeyPackClaims.same(codec, "none"):
		b = stored
	elif PKeyPackClaims.same(codec, "zstd") and decode.is_valid():
		# A size that is not a whole non-negative number can never be the decoded length.
		if float(size) < 0.0 or float(size) != floorf(float(size)):
			return _fail(CHUNKS_REF_MISMATCH)
		var out = decode.call(stored, int(size))
		if not (out is PackedByteArray):
			return _fail(CHUNKS_REF_MISMATCH)
		b = out
	else:
		return _fail(CHUNKS_REF_MISMATCH)
	if float(b.size()) != float(size):
		return _fail(CHUNKS_REF_MISMATCH)
	return parse_chunk_index_bytes(b, payload)


## Steps 1–10 of parse_chunk_index over the decoded index bytes (no ref):
##
##  1. length < 64 → `chunks-bad-length`; 2. magic → `chunks-bad-magic`; 3. version ≠ 1 →
##     `chunks-unsupported-version`; 4. recordSize ≠ 48 → `chunks-bad-record-size`;
##     5. `flags & ~1` → `chunks-bad-flags`;
##  6. length ≠ 64 + 48 × (chunkCount + bundleCount), exact (both counts < 2^32: < 2^39) →
##     `chunks-bad-length`;
##  7. bundle records in order: reserved ≠ 0 → `chunks-reserved-nonzero {bundle}`;
##  8. chunk records in order: `len == 0` → `chunks-zero-length`; `clen == 0 || clen > len` →
##     `chunks-bad-clen`; `bundle ≥ bundleCount` → `chunks-bad-bundle-ref`;
##     `offset + clen > bundles[bundle].size` → `chunks-bad-bundle-range`, each `{chunk}`;
##  9. Σ len ≠ payloadSize → `chunks-size-mismatch`;
## 10. with `payload` ({size, sha256}), a different payloadSha256 or payloadSize →
##     `chunks-payload-mismatch`.
static func parse_chunk_index_bytes(b: PackedByteArray, payload: Variant) -> Dictionary:
	if b.size() < HEADER_BYTES:
		return _fail(CHUNKS_BAD_LENGTH)
	if b.slice(0, 8) != MAGIC.to_ascii_buffer():
		return _fail(CHUNKS_BAD_MAGIC)
	if b.decode_u16(8) != 1:
		return _fail(CHUNKS_UNSUPPORTED_VERSION)
	if b.decode_u16(10) != RECORD_BYTES:
		return _fail(CHUNKS_BAD_RECORD_SIZE)
	var flags := b.decode_u32(12)
	if (flags & ~FLAG_FILE_AWARE) != 0:
		return _fail(CHUNKS_BAD_FLAGS)
	var n := b.decode_u32(16)
	var nb := b.decode_u32(20)
	if b.size() != HEADER_BYTES + RECORD_BYTES * (n + nb):
		return _fail(CHUNKS_BAD_LENGTH)
	var payload_size := read_u64(b, 24)
	var payload_sha := b.slice(32, 64).hex_encode()

	var bundles: Array = []
	var bundle_sizes := PackedInt64Array()
	for j in nb:
		var o := HEADER_BYTES + RECORD_BYTES * (n + j)
		if b.decode_u32(o + 40) != 0 or b.decode_u32(o + 44) != 0:
			return _fail(CHUNKS_RESERVED_NONZERO, {"bundle": j})
		var bsize := read_u64(b, o + 32)
		bundles.append([b.slice(o, o + 32).hex_encode(), bsize])
		bundle_sizes.append(bsize)
	var records: Array = []
	var total := 0
	for i in n:
		var o := HEADER_BYTES + RECORD_BYTES * i
		var ln := b.decode_u32(o + 32)
		var clen := b.decode_u32(o + 36)
		var bundle := b.decode_u32(o + 40)
		var offset := b.decode_u32(o + 44)
		if ln == 0:
			return _fail(CHUNKS_ZERO_LENGTH, {"chunk": i})
		if clen == 0 or clen > ln:
			return _fail(CHUNKS_BAD_CLEN, {"chunk": i})
		if bundle >= nb:
			return _fail(CHUNKS_BAD_BUNDLE_REF, {"chunk": i})
		if offset + clen > bundle_sizes[bundle]:
			return _fail(CHUNKS_BAD_BUNDLE_RANGE, {"chunk": i})
		total += ln
		records.append([b.slice(o, o + 32).hex_encode(), ln, clen, bundle, offset])
	if total != payload_size:
		return _fail(CHUNKS_SIZE_MISMATCH)
	if payload is Dictionary:
		var ps = payload.get("size")
		if not PKeyPackClaims.same(payload.get("sha256"), payload_sha) or not PKeyClaims.is_number(ps) or float(ps) != float(payload_size):
			return _fail(CHUNKS_PAYLOAD_MISMATCH)
	return {"ok": true, "index": {
		"fileAware": (flags & FLAG_FILE_AWARE) != 0, "payloadSize": payload_size, "payloadSha256": payload_sha,
		"records": records, "bundles": bundles,
	}}


## Whether a variant's `chunks` member is one this SDK can use: format pkey-chunks/1, a usable
## codec, `size` and `bytes` numbers no larger than MAX_CHUNK_INDEX_BYTES.
static func usable_ref(c: Variant) -> bool:
	if not (c is Dictionary):
		return false
	if not PKeyPackClaims.same(c.get("format"), PKeyConstants.CHUNKS_FORMAT) or not PKeyPackSelect.usable_codec(c.get("codec")):
		return false
	if not PKeyPackClaims.is_sha256(c.get("sha256")):
		return false
	var m := float(PKeyConstants.MAX_CHUNK_INDEX_BYTES)
	return PKeyClaims.is_number(c.get("size")) and float(c["size"]) <= m and PKeyClaims.is_number(c.get("bytes")) and float(c["bytes"]) <= m


## The request runs over a target index's records given the seeded ids (a Dictionary used as a
## set; plans/P4-10.md §2.5, the planner's rule): the records neither seeded nor already fetched,
## grouped while the bundle stays the same and `offset == prev.offset + prev.clen`. Each run is
## {bundle, offset, length, records: [record index…]}.
static func chunk_runs(records: Array, seeded: Dictionary) -> Array:
	var runs: Array = []
	var seen := {}
	var prev = null
	for i in records.size():
		var r: Array = records[i]
		var id: String = r[0]
		if seeded.has(id) or seen.has(id):
			continue
		seen[id] = true
		var bundle := int(r[3])
		var offset := int(r[4])
		var clen := int(r[2])
		if prev == null or bundle != int(prev[3]) or offset != int(prev[4]) + int(prev[2]):
			runs.append({"bundle": bundle, "offset": offset, "length": 0, "records": []})
		var run: Dictionary = runs[runs.size() - 1]
		run["length"] = offset + clen - int(run["offset"])
		(run["records"] as Array).append(i)
		prev = r
	return runs


## The seed map: id -> [seed index, offset in that seed's payload], first occurrence over the seeds
## in order, then over each seed's records in order. `seeds`: [{index, payload}].
static func seed_map(seeds: Array) -> Dictionary:
	var s := {}
	for si in seeds.size():
		var off := 0
		for r in seeds[si]["index"]["records"]:
			if not s.has(r[0]):
				s[r[0]] = [si, off]
			off += int(r[1])
	return s


static func _sha256(bytes: PackedByteArray) -> String:
	return PKeyPackClaims.sha256_hex(bytes)


## One record's stored bytes decoded and verified: the data, or a failure verdict.
static func _verify(rec: Array, i: int, raw: PackedByteArray, zstd: PKeyPackZstd) -> Variant:
	var ln := int(rec[1])
	var clen := int(rec[2])
	if raw.size() < clen:
		return _fail(CHUNK_BUNDLE_TRUNCATED, {"chunk": i})
	var data := raw
	if clen != ln:
		data = zstd.decode(raw, ln) if zstd != null else PackedByteArray()
	if data.size() != ln or _sha256(data) != rec[0]:
		return _fail(CHUNK_CORRUPT, {"chunk": i})
	return data


## One single-range request: a body, or the verdict (a refusal or a transport failure). A coroutine.
static func _open(fetch_range: Callable, bundle: String, offset: int, length: int) -> Variant:
	if not fetch_range.is_valid():
		return _fail(NETWORK_ERROR, {"detail": INTERRUPTED})
	var res = await fetch_range.call(bundle, offset, length)
	if not (res is Dictionary):
		return _fail(NETWORK_ERROR, {"detail": INTERRUPTED})
	if PKeyPackClaims.same(res.get("status"), "refused"):
		return _fail(NETWORK_ERROR, {"detail": RANGE_REFUSED})
	if not PKeyPackClaims.same(res.get("status"), "ok") or res.get("body") == null:
		return _fail(NETWORK_ERROR, {"detail": INTERRUPTED})
	return res["body"]


static func _close(body: Variant) -> void:
	if body != null and body is Object and body.has_method("close"):
		body.close()


## The SHA-256 of the output's first `size` bytes, read back in READ_CHUNK steps.
static func _rehash(output: Object, size: int) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var at := 0
	while at < size:
		var part: PackedByteArray = output.read(at, mini(PKeyByteSource.READ_CHUNK, size - at))
		if part.is_empty():
			break
		h.update(part)
		at += part.size()
	return h.finish().hex_encode()


## `applyChunk(variant, seeds, ports, opts)` (plans/P4-10.md §2.5): the payload rebuilt into
## `ports.output`, or the first failure. A coroutine returning {verdict, index?}; never fails
## otherwise.
##
## `seeds`: [{index (a parsed index), payload: PKeyByteSource}]. `ports`: `objects`
## Callable(sha256) -> PKeyByteSource or null (the stored target index); `zstd` a PKeyPackZstd;
## `fetch_range` Callable(bundle_sha256, offset, length), a coroutine answering {status: "ok", body}
## (`body.take(n)` gives the next n bytes, fewer when it ends, or null when the transfer failed;
## `body.close()`), {status: "refused"} or anything else (a transport failure); `output` an object
## with `write(offset, bytes) -> bool` and `read(offset, length) -> PackedByteArray`.
##
## `completed_runs` (a Dictionary used as a set): runs an earlier attempt completed (the run
## journal); each record of such a run is read back from the output and re-hashed before reuse,
## and one that differs refetches the whole run. `on_run_done(run)` after every record of a run is
## written; `on_progress(fetched_bytes)` after every run.
##
##  1. The target index read by its ref (only when `bytes` and `size` are within
##     MAX_CHUNK_INDEX_BYTES and the stored object is `bytes` long) and parsed bound to the payload.
##  2. A record longer than MAX_CHUNK_BYTES → `chunk-corrupt {chunk}` before anything is fetched.
##  3. The seed map and the runs; for each record in payload order: copy from a seed (a short read
##     zero-padded, not re-hashed: seeds were verified at install), else from the output when the
##     id was already written, else the next `clen` bytes of its run's single-range request
##     (fewer → `chunk-bundle-truncated {chunk}`; a decode failure, a wrong length or SHA-256 →
##     `chunk-corrupt {chunk}`).
##  4. The payload's SHA-256 → `payload-hash-mismatch`; with `repair`, every seed-sourced record
##     that no longer hashes to its id is refetched first (one request each, not counted) and
##     listed in `repairedChunks`.
##
## A refused range is `network-error` with detail `range-refused`; a failed transfer is
## `network-error` with detail `interrupted`.
static func apply_chunk(variant: Dictionary, seeds: Array, ports: Dictionary, repair := false, completed_runs: Dictionary = {}, on_run_done := Callable(), on_progress := Callable()) -> Dictionary:
	var payload = variant.get("payload")
	var ref = variant.get("chunks")
	if not (ref is Dictionary) or not (payload is Dictionary):
		return {"verdict": _fail(CHUNKS_REF_MISMATCH)}
	var zstd: PKeyPackZstd = ports.get("zstd")
	var output: Object = ports.get("output")
	var fetch_range: Callable = ports.get("fetch_range", Callable())

	# 1. The target index, bounded before a byte is read.
	var stored := PackedByteArray()
	var m := float(PKeyConstants.MAX_CHUNK_INDEX_BYTES)
	if PKeyClaims.is_number(ref.get("bytes")) and PKeyClaims.is_number(ref.get("size")) and float(ref["bytes"]) <= m and float(ref["size"]) <= m:
		var objects: Callable = ports.get("objects", Callable())
		var src = objects.call(ref.get("sha256")) if objects.is_valid() and ref.get("sha256") is String else null
		if src is PKeyByteSource and float(src.size) == float(ref["bytes"]):
			stored = PKeyByteSource.read_all(src)
	var parsed := parse_chunk_index(stored, ref, payload, zstd.decode if zstd != null else Callable())
	if not parsed["ok"]:
		return {"verdict": parsed}
	var index: Dictionary = parsed["index"]
	var records: Array = index["records"]
	for i in records.size():
		if int(records[i][1]) > PKeyConstants.MAX_CHUNK_BYTES:
			return {"verdict": _fail(CHUNK_CORRUPT, {"chunk": i}), "index": index}

	# 2–3. The seed map and the runs.
	var smap := seed_map(seeds)
	var runs := chunk_runs(records, smap)
	var run_of := {}
	var last_of_run := {}
	for k in runs.size():
		var rr: Array = runs[k]["records"]
		for i in rr:
			run_of[i] = k
		last_of_run[rr[rr.size() - 1]] = k
	var pos_of := PackedInt64Array()
	pos_of.resize(records.size())
	var p := 0
	for i in records.size():
		pos_of[i] = p
		p += int(records[i][1])

	var hasher := HashingContext.new()
	hasher.start(HashingContext.HASH_SHA256)
	var kinds := PackedByteArray()
	kinds.resize(records.size())
	var first := {}
	var fetched_chunks := 0
	var fetched_bytes := 0
	var seed_chunks := 0
	var self_chunks := 0
	var requests := 0
	var open_run := -1
	var resumed_run := -1
	var body = null
	for i in records.size():
		var rec: Array = records[i]
		var id: String = rec[0]
		var ln := int(rec[1])
		var clen := int(rec[2])
		var pos := pos_of[i]
		var data: PackedByteArray
		var seeded = smap.get(id)
		var write := true
		if seeded != null:
			var sp: PKeyByteSource = seeds[seeded[0]]["payload"]
			data = sp.read(int(seeded[1]), ln)
			if data.size() != ln:
				# A short seed keeps its place; the payload hash (or the repair pass) catches it.
				data.resize(ln)
			kinds[i] = KIND_SEED
			seed_chunks += 1
		elif first.has(id):
			data = output.read(int(first[id]), ln)
			kinds[i] = KIND_SELF
			self_chunks += 1
		else:
			var k: int = run_of[i]
			if k != open_run and k != resumed_run:
				_close(body)
				body = null
				if completed_runs.has(k) and _run_intact(runs[k], records, pos_of, output):
					resumed_run = k
				else:
					var run: Dictionary = runs[k]
					var opened = await _open(fetch_range, index["bundles"][run["bundle"]][0], int(run["offset"]), int(run["length"]))
					if opened is Dictionary:
						return {"verdict": opened, "index": index}
					body = opened
					open_run = k
					requests += 1
			if k == resumed_run:
				data = output.read(pos, ln)
				write = false
			else:
				var raw = await body.take(clen)
				if not (raw is PackedByteArray):
					_close(body)
					return {"verdict": _fail(NETWORK_ERROR, {"detail": INTERRUPTED}), "index": index}
				var got = _verify(rec, i, raw, zstd)
				if got is Dictionary:
					_close(body)
					return {"verdict": got, "index": index}
				data = got
			kinds[i] = KIND_FETCH
			fetched_chunks += 1
			fetched_bytes += clen
		if not first.has(id):
			first[id] = pos
		if write and output.write(pos, data) != true:
			_close(body)
			return {"verdict": _fail(CHUNK_CORRUPT, {"chunk": i}), "index": index}
		hasher.update(data)
		var done = last_of_run.get(i)
		if done != null:
			if body != null and open_run == done:
				_close(body)
				body = null
			if on_run_done.is_valid():
				on_run_done.call(done)
			if on_progress.is_valid():
				on_progress.call(fetched_bytes)
	_close(body)

	# 4. The payload hash, with the repair pass.
	var repaired: Array = []
	if hasher.finish().hex_encode() != payload["sha256"]:
		if not repair:
			return {"verdict": _fail(PAYLOAD_HASH_MISMATCH), "index": index}
		for i in records.size():
			if kinds[i] != KIND_SEED:
				continue
			var rec: Array = records[i]
			var ln := int(rec[1])
			var clen := int(rec[2])
			var back: PackedByteArray = output.read(pos_of[i], ln)
			if back.size() == ln and _sha256(back) == rec[0]:
				continue
			var opened = await _open(fetch_range, index["bundles"][int(rec[3])][0], int(rec[4]), clen)
			if opened is Dictionary:
				return {"verdict": opened, "index": index}
			var raw = await opened.take(clen)
			_close(opened)
			if not (raw is PackedByteArray):
				return {"verdict": _fail(NETWORK_ERROR, {"detail": INTERRUPTED}), "index": index}
			var got = _verify(rec, i, raw, zstd)
			if got is Dictionary:
				return {"verdict": got, "index": index}
			if output.write(pos_of[i], got) != true:
				return {"verdict": _fail(CHUNK_CORRUPT, {"chunk": i}), "index": index}
			repaired.append(i)
		var size := int(index["payloadSize"])
		if await PKeyPackJob.run(_rehash.bind(output, size), "PolarisKey chunk verify") != payload["sha256"]:
			return {"verdict": _fail(PAYLOAD_HASH_MISMATCH), "index": index}
	return {"verdict": {
		"ok": true, "sha256": payload["sha256"], "size": int(index["payloadSize"]), "fetchedChunks": fetched_chunks,
		"fetchedBytes": fetched_bytes, "requests": requests, "seedChunks": seed_chunks, "selfChunks": self_chunks,
		"repairedChunks": repaired,
	}, "index": index}


## Whether every record of a journalled run still hashes to its id in the output.
static func _run_intact(run: Dictionary, records: Array, pos_of: PackedInt64Array, output: Object) -> bool:
	for i in (run["records"] as Array):
		var rec: Array = records[i]
		var ln := int(rec[1])
		var got: PackedByteArray = output.read(pos_of[i], ln)
		if got.size() != ln or _sha256(got) != rec[0]:
			return false
	return true


# ── The exact Content-Range adapter ─────────────────────────────────────────────────────────

static var _content_range_re: RegEx = RegEx.create_from_string("^bytes (\\d{1,16})-(\\d{1,16})/(\\d{1,16})$")


## Whether a ranged answer may be read, and how many bytes (plans/P4-10.md §2.5): only a `206`
## whose Content-Range is exactly `bytes o-e/<size>` for the request (`e == o + length − 1 <
## size`), or one clipped at the object's end (`e == size − 1 < o + length − 1`, `e ≥ o`: the
## records past it are then `chunk-bundle-truncated`), with an ETag, when present, exactly
## `"<bundle sha256>"`. The bytes to read, or -1 (refused: the body is never read).
static func accepted_length(status: int, content_range: Variant, etag: Variant, bundle: String, offset: int, length: int) -> int:
	if status != 206 or not (content_range is String) or length <= 0:
		return -1
	if etag is String and etag != "" and etag != "\"%s\"" % bundle:
		return -1
	var m := _content_range_re.search((content_range as String).strip_edges())
	if m == null:
		return -1
	var o := m.get_string(1).to_int()
	var e := m.get_string(2).to_int()
	var size := m.get_string(3).to_int()
	var end := offset + length - 1
	if o == offset and e == end and end < size:
		return length
	if o == offset and e < end and e == size - 1 and e >= o:
		return e - o + 1
	return -1


## The chunk strategy's `fetch_range` over a transport's ranged open (plans/P4-10.md §2.5):
## `open_range(req)` is a coroutine taking {sha256, offset, length, if_range} (one single-range
## request: `Range: bytes=<o>-<o+length-1>`, `If-Range: "<bundle sha256>"`, `Accept-Encoding:
## identity`; never a multi-range) and answering {status, content_range, etag, body, error}
## (`body` with take/close, unread). Only accepted_length's answers are read, cut at the accepted
## length; anything else is refused and its body closed unread. A transport failure (an `error`
## before the head) is answered as such: the applier reads it as `interrupted`.
static func chunk_range_fetch(open_range: Callable) -> Callable:
	return func(bundle: String, offset: int, length: int) -> Dictionary:
		var tag := "\"%s\"" % bundle
		var res = await open_range.call({"sha256": bundle, "offset": offset, "length": length, "if_range": tag})
		if not (res is Dictionary):
			return {"status": "error"}
		var body = res.get("body")
		if String(res.get("error", "")) != "" and int(res.get("status", 0)) == 0:
			_close(body)
			return {"status": "error"}
		var take := accepted_length(int(res.get("status", 0)), res.get("content_range"), res.get("etag"), bundle, offset, length)
		if take < 0 or body == null:
			_close(body)
			return {"status": "refused"}
		return {"status": "ok", "body": CappedBody.new(body, take)}


## A body read through at most `left` bytes, then released.
class CappedBody extends RefCounted:
	var inner: Object
	var left := 0

	func _init(p_inner: Object, n: int) -> void:
		inner = p_inner
		left = n

	## The next `n` bytes (fewer when the cap or the body ends), or null when the transfer failed.
	## A coroutine.
	func take(n: int) -> Variant:
		var k := mini(n, left)
		if k <= 0:
			close()
			return PackedByteArray()
		var got = await inner.take(k)
		if not (got is PackedByteArray):
			return null
		left -= (got as PackedByteArray).size()
		if left <= 0:
			close()
		return got

	func close() -> void:
		if inner != null and inner.has_method("close"):
			inner.close()


## A body over bytes in memory (the corpus's fetcher, tests). `fail_at >= 0` fails the transfer
## once that many bytes have been taken (an interrupted run).
class MemoryBody extends RefCounted:
	var bytes := PackedByteArray()
	var at := 0
	var fail_at := -1
	var closed := false

	func _init(p_bytes: PackedByteArray, p_fail_at := -1) -> void:
		bytes = p_bytes
		fail_at = p_fail_at

	func take(n: int) -> Variant:
		if closed:
			return PackedByteArray()
		if fail_at >= 0 and at + n > fail_at:
			return null
		var out := bytes.slice(at, at + n)
		at += out.size()
		return out

	func close() -> void:
		closed = true


## A positional output over bytes in memory, `size` long (the corpus's output).
class MemoryOutput extends RefCounted:
	var bytes := PackedByteArray()

	func _init(size: int) -> void:
		bytes.resize(size)

	func write(offset: int, data: PackedByteArray) -> bool:
		if offset < 0 or offset + data.size() > bytes.size():
			return false
		var out := bytes.slice(0, offset)
		out.append_array(data)
		out.append_array(bytes.slice(offset + data.size()))
		bytes = out
		return true

	func read(offset: int, length: int) -> PackedByteArray:
		return bytes.slice(offset, offset + length)
