class_name PKeyPackZstd
extends RefCounted
## The zstd port of the Godot SDK (client-core `ZstdPort`, plans/P4-01.md §2.7 rules 1–5) and the
## window check every SDK runs (`window.ts`).
##
##   decode(frame, size)                 one plain frame through PackedByteArray.decompress (which
##                                       needs the exact size; every reference carries it). Empty
##                                       on failure (the caller compares the length)
##   decode_prefix_batch(jobs)           `zstd --patch-from` frames over raw-content prefixes,
##                                       decoded by the ENGINE's own delta decoder (notes/A6 §2.4):
##                                       each prefix is exposed under a private path
##                                       (`__pkey/<session>/<n>/b<i>`), a helper PCK lists the
##                                       `GDDL\x01` + frame as a PACK_FILE_DELTA entry for it, and
##                                       reading the path decodes. Main thread only (it mounts)
##   patch_from_available()              whether `zstd-patch-from` is advertised here: the engine's
##                                       `major.minor` is in PATCH_FROM_ENGINES and a start-up
##                                       probe decodes a known frame
##   frame_window(bytes), window_log_max(mem, p), window_allowed(frame, mem, p)   §2.7 rule 3
##
## A prefix that lives in a writable file (an installed `user://pkey/store/<sha256>.pck`) is
## exposed without a copy: a trailer directory is appended to the file, mounted at its own offset,
## and truncated off again after the reads (A6 §5 `expose_private`; the base's size is journalled
## first through `on_bake`, so a crash in between is repaired by truncation at the next load). Any
## other prefix (bytes in memory, an embedded `res://` pack) is copied into a helper "host" PCK.
## Mounts cannot be undone, so every batch uses its own private namespace, never a path a game
## could load (A7 §6).
##
## The appliers run the window check (window_allowed with `pointer_bits`) before any frame reaches
## here: the engine's one-shot decoder enforces no window limit of its own (A6 §2.4).

## The engine `major.minor` versions whose GDDL route is pinned (P4-01 decision 7): PACK_FILE_DELTA
## and DeltaEncoding arrived in 4.6. A newer engine is not advertised until it is added here and
## the content corpus passes on it.
const PATCH_FROM_ENGINES := ["4.6", "4.7"]

const WINDOW_CEILING := 4294967296.0

## The start-up probe: a 260-byte target from a 256-byte prefix (`zstd -19 --patch-from`).
const PROBE_FRAME_HEX := "28b52ffd640400cd00007803706f6c617269736b65797461696c02000fa0100ca4eb0a55c6c408"
const PROBE_TARGET_SHA256 := "1b1958d5c7e290a9341735a94c71f0588a7364e1abb9891d91eea77a0316993a"

## Where helper packs are written (removed after each batch).
var work_dir := "user://pkey/gddl"
## Called with (file_path, size) before a trailer is appended to a file, and with (file_path, -1)
## once it has been truncated back: the engine journals it so a crash mid-bake is repairable. It
## answers true when the journal was written; false keeps the file untouched (its prefixes are
## copied into a host pack instead).
var on_bake := Callable()
## The last batch's failure, "" when it decoded (or refused) cleanly.
var last_error := ""
## Mount and decode counters (INFO in the tests).
var stats := {"batches": 0, "frames": 0, "mounts": 0, "trailers": 0, "hosts": 0}

static var _probe := -1
static var _session := ""
static var _seq := 0


## P for the window rule: 31 for a 64-bit decoder, 30 for a 32-bit or wasm32 one.
static func pointer_bits() -> int:
	var arch := Engine.get_architecture_name()
	if OS.has_feature("web") or arch == "wasm32" or arch == "x86_32" or arch == "arm32" or arch == "rv32" or arch == "ppc32":
		return 30
	return 31


## `frameWindow(bytes)` (§2.7): the window of the zstd frame whose header starts `bytes`, per
## RFC 8878 §3.1.1, as a float (2^32 saturates); null unless bytes 0–3 are the magic, the
## reserved bit is clear and `bytes` hold the whole header.
static func frame_window(b: PackedByteArray) -> Variant:
	if b.size() < 5:
		return null
	if b[0] != 0x28 or b[1] != 0xB5 or b[2] != 0x2F or b[3] != 0xFD:
		return null
	var d := b[4]
	if (d & 0x08) != 0:
		return null
	var single := (d & 0x20) != 0
	# No array literal is indexed here: GDScript folds a constant literal into a shared read-only
	# Array, which 4.4.1 reads racily from two threads (README "Writing GDScript here").
	var dict_bytes := d & 0x03
	if dict_bytes == 3:
		dict_bytes = 4
	var fcs_flag := d >> 6
	var fcs_bytes := 0
	if fcs_flag == 0:
		fcs_bytes = 1 if single else 0
	else:
		fcs_bytes = 1 << fcs_flag
	var header_bytes := 5 + (0 if single else 1) + dict_bytes + fcs_bytes
	if b.size() < header_bytes:
		return null
	if not single:
		var w := b[5]
		var base := pow(2.0, 10 + (w >> 3))
		return minf(base + (base / 8.0) * (w & 7), WINDOW_CEILING)
	var at := 5 + dict_bytes
	if fcs_bytes == 8:
		for i in range(4, 8):
			if b[at + i] != 0:
				return WINDOW_CEILING
	var v := 0.0
	for i in range(mini(fcs_bytes, 4) - 1, -1, -1):
		v = v * 256.0 + b[at + i]
	if fcs_bytes == 2:
		v += 256.0
	return minf(v, WINDOW_CEILING)


## `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))` in integers (⌈log2 m⌉ is the bit length of
## m − 1). null when `mem` is not a non-negative safe integer or `p` is not 30 or 31.
static func window_log_max(mem: Variant, p := 31) -> Variant:
	if not PKeyClaims.is_number(mem):
		return null
	var f := float(mem)
	if not is_finite(f) or f != floorf(f) or f < 0.0 or f > 9007199254740991.0:
		return null
	if p != 30 and p != 31:
		return null
	var n := 0
	var v := int(f) - 1
	while v > 0:
		v = v >> 1
		n += 1
	return maxi(10, mini(p, n))


## The window check: true when `frame`'s header window is known and at most 2^windowLogMax.
static func window_allowed(frame: PackedByteArray, mem: Variant, p := 31) -> bool:
	var limit = window_log_max(mem, p)
	var window = frame_window(frame)
	return limit != null and window != null and float(window) <= pow(2.0, limit)


## One plain frame with its content size. Empty on failure; a zero-size frame is checked by
## decoding it followed by a one-byte frame (decompress refuses a zero-size buffer).
func decode(frame: PackedByteArray, size: int) -> PackedByteArray:
	if size < 0 or frame.is_empty():
		return PackedByteArray()
	if size == 0:
		var probe := frame.duplicate()
		probe.append_array(PackedByteArray([0x78]).compress(FileAccess.COMPRESSION_ZSTD))
		var out := probe.decompress(1, FileAccess.COMPRESSION_ZSTD)
		return PackedByteArray() if out.size() == 1 and out[0] == 0x78 else PackedByteArray([0])
	return frame.decompress(size, FileAccess.COMPRESSION_ZSTD)


## Whether this engine decodes `zstd --patch-from` frames (the pinned list, then the probe once).
func patch_from_available() -> bool:
	if _probe >= 0:
		return _probe == 1
	_probe = 0
	var v := Engine.get_version_info()
	if not PackedStringArray(PATCH_FROM_ENGINES).has("%d.%d" % [v["major"], v["minor"]]):
		return false
	if PKeyPck.helper_version() < 3:
		return false
	var base := PackedByteArray()
	base.resize(256)
	for i in 256:
		base[i] = (i * 7 + 3) % 251
	_probe = 1  # let the batch run
	var out := _batch([{"frame": PROBE_FRAME_HEX.hex_decode(), "base": PKeyByteSource.memory(base), "size": 260}])
	var ok: bool = out[0] is PackedByteArray and PKeyPackClaims.sha256_hex(out[0]) == PROBE_TARGET_SHA256
	_probe = 1 if ok else 0
	return ok


## Decode each job {frame: PackedByteArray, base: PKeyByteSource, size: int} with its base as the
## raw-content prefix. Returns one entry per job: the decoded bytes when they are exactly `size`
## long, else null. Every frame must already have passed the window check.
func decode_prefix_batch(jobs: Array) -> Array:
	if not patch_from_available():
		var none: Array = []
		none.resize(jobs.size())
		last_error = "patch-from is not available on this engine"
		return none
	return _batch(jobs)


## Whether a prefix's file takes a trailer: a writable container pack (`.pck` outside res://).
## A tree's files are live game data a reader may open at any moment, so they are copied instead.
static func _writable_file(path: String) -> bool:
	return path.ends_with(".pck") and not path.begins_with("res://") and not path.begins_with("uid://")


func _batch(jobs: Array) -> Array:
	last_error = ""
	stats["batches"] += 1
	var results: Array = []
	results.resize(jobs.size())
	if jobs.is_empty():
		return results
	var version := PKeyPck.helper_version()
	if _session == "":
		var rng := RandomNumberGenerator.new()
		rng.randomize()
		_session = "%08x" % (rng.randi() & 0x7FFFFFFF)
	_seq += 1
	var ns := "__pkey/%s/%d" % [_session, _seq]
	var dir := work_dir.path_join("%s-%d" % [_session, _seq])
	DirAccess.make_dir_recursive_absolute(dir)
	var exposed := {}  # job index -> true
	# Group the prefixes: one trailer per writable file, one copy host for the rest.
	var by_file := {}
	var hosted: Array = []
	for i in jobs.size():
		var base: PKeyByteSource = jobs[i]["base"]
		var fp := base.file_path()
		if _writable_file(fp):
			if not by_file.has(fp):
				by_file[fp] = []
			by_file[fp].append(i)
		else:
			hosted.append(i)
	var trailers: Array = []  # [path, original size]
	for fp in by_file:
		var g := FileAccess.open(fp, FileAccess.READ)
		if g == null:
			for i in by_file[fp]:
				hosted.append(i)
			continue
		var n := int(g.get_length())
		g.close()
		var recs: Array = []
		for i in by_file[fp]:
			var base: PKeyByteSource = jobs[i]["base"]
			recs.append({"path": "%s/b%d" % [ns, i], "offset": base.file_offset(), "size": base.size})
		if on_bake.is_valid() and on_bake.call(fp, n) != true:
			last_error = "the bake journal for %s could not be written; its prefixes are copied" % fp
			for i in by_file[fp]:
				hosted.append(i)
			continue
		var t := PKeyPck.append_trailer(fp, recs, version)
		if not t["ok"] or int(t["start"]) != n:
			last_error = "the trailer could not be appended to %s" % fp
			if on_bake.is_valid():
				on_bake.call(fp, -1)
			for i in by_file[fp]:
				hosted.append(i)
			continue
		trailers.append([fp, n])
		stats["trailers"] += 1
		stats["mounts"] += 1
		if PKeyPck.mount(fp, false, n):
			for i in by_file[fp]:
				exposed[i] = true
		else:
			last_error = "the trailer of %s did not mount" % fp
	if not hosted.is_empty():
		var entries: Array = []
		for i in hosted:
			entries.append({"path": "%s/b%d" % [ns, i], "source": jobs[i]["base"], "flags": 0})
		var host := dir.path_join("host.pck")
		if PKeyPck.write(host, entries, version) == OK:
			stats["hosts"] += 1
			stats["mounts"] += 1
			if PKeyPck.mount(host, false):
				for i in hosted:
					exposed[i] = true
		else:
			last_error = "the host pack could not be written"
	var deltas: Array = []
	for i in jobs.size():
		if exposed.has(i):
			var g := "GDDL".to_ascii_buffer()
			g.append(1)
			g.append_array(jobs[i]["frame"])
			deltas.append({"path": "%s/b%d" % [ns, i], "bytes": g, "flags": PKeyPck.PACK_FILE_DELTA})
	var delta := dir.path_join("delta.pck")
	if not deltas.is_empty() and PKeyPck.write(delta, deltas, version) == OK:
		stats["mounts"] += 1
		if PKeyPck.mount(delta, false):
			for i in jobs.size():
				if not exposed.has(i):
					continue
				stats["frames"] += 1
				var f := FileAccess.open("res://%s/b%d" % [ns, i], FileAccess.READ)
				if f == null:
					continue
				var out := f.get_buffer(f.get_length())
				f.close()
				if out.size() == int(jobs[i]["size"]):
					results[i] = out
	# Undo every trailer before anything else reads the files, and prove each is its own size.
	for t in trailers:
		if not PKeyPck.truncate(t[0], t[1]):
			last_error = "%s could not be truncated back to %d bytes" % [t[0], t[1]]
			results.fill(null)
		elif on_bake.is_valid():
			on_bake.call(t[0], -1)
	DirAccess.remove_absolute(dir.path_join("host.pck"))
	DirAccess.remove_absolute(delta)
	DirAccess.remove_absolute(dir)
	return results
