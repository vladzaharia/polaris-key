@tool
class_name PKeySyncExport
extends RefCounted
## The core of `cloud_sync.export()` (WIRE-CONTRACT-V5 section 13.12, `pkey-sync-export/1`): a readable,
## unencrypted zip of what an app synced, made on the device. A port of Python `cloud_sync/export.py` and
## client-core `sync/export.ts`. It plans the archive, then streams it into a sink; it speaks to no network
## and opens no file. The host (`services/cloud_sync/export_host.gd`) gives it
##
##   changes   the rows as the Worker served them, after a pull with `more` false (sealed in end-to-end mode)
##   codec     the host codec in end-to-end mode (`locked()` and `open_pull(body, mutations, aliases, open_keys,
##             record_keys)`, as the host's codec port has them), null in server mode
##   file_codec  Callable(collection) -> the collection's file codec (the guarded end-to-end one, or the server
##             one); the root stays inside it
##   files     a file source (below)
##   sink      `write(bytes: PackedByteArray) -> bool`; false is a destination failure
##
## A file source is an Object with
##   pointers(collection, record) -> Array   every kept version of a record's file, the current one included,
##                                           each `{version, size, sha256, format}` as served (may be a coroutine)
##   open_stored(ref) -> reader | null       the stored bytes of a version (a whole file, or the manifest of a
##                                           chunked one); `ref` is `{collection, record, version, format, size}`
##                                           (may be a coroutine). null: the Worker has none
##   reader.read_piece() -> PackedByteArray  the next piece, empty at the end (may be a coroutine)
##   reader.close()
##   chunk(collection, id_hex) -> PackedByteArray | null   a chunk object (may be a coroutine); null: none
##   error: Dictionary                       `{code, reason}` once the source failed beyond recovery (a network
##                                           failure past its bounds, a cancel): the export stops with it
## Retries, `Range` resume, the hourly allowance and the bounded waits are the source's.
##
## Everything the Worker served is untrusted. A row that does not open is dropped and listed; a file that
## does not check is written as far as it checks and flagged `partial`; nothing stops the export but a bound
## (`sync-export-too-large`, before the first byte), a source that failed, a locked ring and a cancel.
##
## Memory: the settings map, per row the ids and sizes the plan needs (a row is opened again when its line is
## written), the manifests of the chunked files and one central record per entry. A file is read a segment
## (1 MiB + 16) or a chunk at a time, with SHA-256 incremental; CRC-32 and the AES-GCM of the GDScript lane
## run on a worker thread.
##
## Order: the central directory lists the entries in the order of section 13.12 (README, settings, records,
## files, files.json, index.json, data.json). The bytes are written in the order the data is known: a record
## line cites its file's size and SHA-256, so the files are streamed first.
##
## `run` answers `{ok: true, bytes, planned_bytes, entries, settings, records, files, skipped}` or
## `{ok: false, code, reason}`. Nothing here puts a value, an id or a path in a result or a log line.

const README := [
	"This is a readable copy of data an app synced with Polaris Locker.",
	"",
	"The app made it on this device. It is NOT encrypted: anyone who can open",
	"this file can read everything in it. Keep it where you keep your other",
	"private files, and delete it when you no longer need it. The time it was",
	"made is \"exportedAt\" in data.json, in milliseconds since 1970-01-01 UTC.",
	"",
	"Polaris Locker's own export of this data, from its website, uses the same",
	"layout and holds the data as the app stored it: encrypted when the app",
	"encrypts it.",
	"",
	"data.json                              what this holds, and what could not be read",
	"stores/sync.cloudSync/settings.json    the synced settings",
	"stores/sync.cloudSync/records/         the synced records, one file a collection",
	"stores/sync.cloudSync/index.json       which file holds which collection",
	"stores/sync.cloudSync/files/           the synced files",
	"stores/sync.cloudSync/files.json       which file belongs to which record",
	"",
	"A file marked \"partial\" in data.json is incomplete or did not match what",
	"the app stored. Do not rely on it.",
]
const MAX_SAFE := 9007199254740991
## A sink write of file data is at most one segment: 1 MiB of plaintext.
const PIECE := 1048576


## The fixed text of README.txt.
static func readme_text() -> String:
	return "\n".join(README) + "\n"


## Plans the archive, refusing with `sync-export-too-large` before the first byte, then writes it to `sink`.
## `inp`: {product, exported_at (ms), unsynced, include_revisions, changes, files, codec, file_codec, caps
## {maxEntries?, maxBytes?}, cancel (an object with `cancelled`), on_progress Callable(done, total),
## zip_limit}. The caller commits (or discards) the sink's destination once this answers.
static func run(inp: Dictionary, sink: Object) -> Dictionary:
	var r := _Run.new(inp, sink)
	return await r.go()


## A pointer's size when it is a non-negative safe integer (a JSON number), else -1.
static func size_of(n: Variant) -> int:
	match typeof(n):
		TYPE_INT:
			return n if n >= 0 and n <= MAX_SAFE else -1
		TYPE_FLOAT:
			if is_finite(n) and n == floorf(n) and n >= 0.0 and n <= float(MAX_SAFE):
				return int(n)
	return -1


static func is_number(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT


## True when `v` is a whole number the JSON number space cannot hold exactly (past 2^53 - 1).
static func is_unsafe_integer(v: Variant) -> bool:
	match typeof(v):
		TYPE_INT:
			return absi(v) > MAX_SAFE
		TYPE_FLOAT:
			return is_finite(v) and v == floorf(v) and absf(v) > float(MAX_SAFE)
	return false


static func is_hex64(s: Variant) -> bool:
	if not (s is String) or (s as String).length() != 64:
		return false
	for i in 64:
		var c := (s as String).unicode_at(i)
		if not ((c >= 48 and c <= 57) or (c >= 97 and c <= 102)):
			return false
	return true


## Containers nest at most `MAX_DEPTH` deep from the value's own outermost array or object (level 1); a
## scalar never counts.
static func depth_ok(v: Variant, level := 1) -> bool:
	if v is Array:
		if level > PKeySyncCanonicalJson.MAX_DEPTH:
			return false
		for e in v:
			if not depth_ok(e, level + 1):
				return false
	elif v is Dictionary:
		if level > PKeySyncCanonicalJson.MAX_DEPTH:
			return false
		for k in v:
			if not depth_ok(v[k], level + 1):
				return false
	return true


## Whether `v` has a canonical JSON spelling: no lone surrogate, no number that is not finite, no integer past
## 2^53, nesting within `MAX_DEPTH`.
static func serialisable(v: Variant) -> bool:
	return depth_ok(v) and PKeySyncCanonicalJson.canonicalize_value(v, 0)["ok"]


## The canonical JSON of `v` plus `\n`, with no nesting bound (the caller checked its parts), or empty.
static func line_of(v: Variant) -> PackedByteArray:
	var c := PKeySyncCanonicalJson.canonicalize_value(v, 0)
	if not c["ok"]:
		return PackedByteArray()
	var b: PackedByteArray = c["bytes"]
	b.append(10)
	return b


static func utf8_len(s: String) -> int:
	return s.to_utf8_buffer().size()


class _Run:
	extends RefCounted

	const Support := preload("res://addons/polaris_key/services/cloud_sync/transfer_support.gd")
	const TransferCodec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
	const FILE_ONLY := "file-only"
	const OMIT := "omit"
	const INVALID := "invalid"

	var inp: Dictionary
	var sink: Object
	var codec: Object = null
	var files: Object
	var cancel: Object = null
	var e2e := false
	var fail: Dictionary = {}
	var _codecs := {}
	var _zip: PKeyZipStore
	var _chunk_total := 0
	var _written_plain := 0
	var _file_bytes := 0
	var _changes: Array = []
	var _settings := {}
	var _settings_line := PackedByteArray()
	var _setting_count := 0
	var _setting_changes: Array = []
	var _record_changes: Array = []
	var _collections: Array = []
	## [{collection, rows}]: the collections with a row to write.
	var _written: Array = []
	## collection -> the file-only records it holds.
	var _file_only := {}
	var _pointer_collections: Array = []
	## Every file entry planned: {row, ref, file, live, planned, manifest}.
	var _planned: Array = []
	var _names := PackedStringArray()
	var _planned_bytes := 0
	var _record_count := 0
	## serial of a row -> what its live file's entry holds, for its line.
	var _line_file := {}
	var _setting_skips: Array = []
	var _record_skips: Array = []
	var _file_skips: Array = []
	var _partial_skips: Array = []
	var _summary: Dictionary = {}

	func _init(p_inp: Dictionary, p_sink: Object) -> void:
		inp = p_inp
		sink = p_sink
		codec = p_inp.get("codec")
		files = p_inp["files"]
		cancel = p_inp.get("cancel")
		e2e = codec != null
		for c in p_inp["changes"]:
			if c is Dictionary:
				_changes.append(c)

	# ── failure and cancel ───────────────────────────────────────────────────────────────────

	func _bad(code: String, reason := "") -> bool:
		if fail.is_empty():
			fail = {"ok": false, "code": code, "reason": reason}
		return false

	func _stop() -> bool:
		if not fail.is_empty():
			return true
		if _zip != null and not _zip.error.is_empty():
			_bad(String(_zip.error["code"]), String(_zip.error.get("reason", "")))
			return true
		var src: Variant = files.get("error")
		if src is Dictionary and not (src as Dictionary).is_empty():
			_bad(String(src["code"]), String(src.get("reason", "")))
			return true
		if cancel != null and cancel.cancelled:
			_bad(PKeyConstants.ErrorCode.CANCELLED)
			return true
		if codec != null and codec.has_method("locked") and codec.locked():
			_bad(PKeyConstants.ErrorCode.SYNC_LOCKED)
			return true
		return false

	func _file_codec(collection: String) -> Object:
		if not _codecs.has(collection):
			var c: Variant = inp["file_codec"].call(collection) if inp.get("file_codec") is Callable else TransferCodec.Server.new()
			_codecs[collection] = c
		return _codecs[collection]

	func _file_codec_stale(c: Object) -> bool:
		if c == null or (c.has_method("locked") and c.locked()):
			_bad(PKeyConstants.ErrorCode.SYNC_LOCKED)
			return true
		return false

	## Runs `fn` on a worker thread when the AES-GCM lane is GDScript and the work is big, else inline.
	static func _off(fn: Callable, size: int) -> Variant:
		var gd := PKeySyncAead.lane_name() == "gdscript"
		return await Support.off_thread(fn, size if gd else 0)

	# ── opening rows ─────────────────────────────────────────────────────────────────────────

	## An opened change as the host codec opens a pull, or null when it does not open.
	func _via_pull(c: Dictionary) -> Variant:
		var r: Dictionary = codec.open_pull({"changes": [c]}, null, {}, [], [])
		if not r.get("ok", false):
			return null
		var rows: Variant = (r.get("opened", {}) as Dictionary).get("changes")
		var row: Variant = rows[0] if rows is Array and not (rows as Array).is_empty() else null
		if not (row is Dictionary) or row.get("sealed") != true:
			return null
		var e: Variant = (r["body"]["changes"] as Array)[0]
		return e if e is Dictionary else null

	## `[name, value]` of a setting, or null when it does not open.
	func _setting(c: Dictionary) -> Variant:
		var wire: String = c["setting"]
		if codec == null:
			var members: Variant = c.get("members")
			if members is Dictionary:
				return [wire, members]
			return [wire, c["value"]] if c.has("value") else null
		if not c.has("ct") and not (c.get("members") is Array):
			return null
		var e: Variant = _via_pull(c)
		if e == null or not (e.get("setting") is String) or not e.has("value"):
			return null
		return [e["setting"], e["value"]]

	static func _pointer_of(c: Dictionary) -> Variant:
		var f: Variant = c.get("file")
		if f is Dictionary and PKeySyncExport.is_number(f.get("version")):
			return f
		return null

	## Whether the sealed `$file` binding names this pointer's file.
	static func _named_by(b: Dictionary, f: Dictionary) -> bool:
		var size: Variant = f.get("size")
		return f.get("sha256") == b["sha256"] and PKeySyncExport.is_number(size) and size == b["size"] and f.get("format") == b["format"]

	static func _binding_of(raw: Variant) -> Variant:
		if not (raw is Dictionary):
			return null
		var sha: Variant = raw.get("sha256")
		var size := PKeySyncExport.size_of(raw.get("size"))
		var fmt: Variant = raw.get("format")
		if not PKeySyncExport.is_hex64(sha) or size <= 0:
			return null
		if fmt != "whole" and fmt != "chunks":
			return null
		return {"sha256": sha, "size": size, "format": fmt}

	## A record row: an opened `{id, version, has_value, value, binding}`, or `OMIT`, `INVALID` or `FILE_ONLY`.
	func _record(collection: String, wire: String, c: Dictionary) -> Variant:
		if codec == null:
			return {"id": wire, "version": c.get("version"), "has_value": c.has("value"), "value": c.get("value"), "binding": null}
		for shape in ["fields", "elements"]:
			var cells: Variant = c.get(shape)
			if cells is Array and (cells as Array).is_empty():
				return OMIT
		var sealed_shape: bool = c.get("fields") is Array or c.get("elements") is Array or c.get("ct") is String
		if not sealed_shape:
			# A file and no value: nothing names the id, nothing binds the file.
			return FILE_ONLY if not c.has("ct") and _pointer_of(c) != null else INVALID
		return _open_sealed_record(collection, c)

	func _open_sealed_record(collection: String, c: Dictionary) -> Variant:
		var e: Variant = _via_pull(c)
		var rec: Variant = e.get("record") if e != null else null
		if e == null or not (rec is Array) or (rec as Array).size() < 2 or rec[0] != collection or not (rec[1] is String) or not e.has("value"):
			return INVALID
		var value: Variant = e["value"]
		var binding: Variant = null
		if c.get("ct") is String and value is Dictionary and (value as Dictionary).has("$file"):
			var raw: Variant = value["$file"]
			var rest := {}
			for k in value:
				if k != "$file":
					rest[k] = value[k]
			value = rest
			binding = _binding_of(raw)
		return {"id": rec[1], "version": c.get("version"), "has_value": true, "value": value, "binding": binding}

	## A record the export can write: its id, version and value have a canonical spelling and the version
	## is not an integer past 2^53 - 1.
	static func _writable(r: Dictionary) -> bool:
		return not PKeySyncExport.is_unsafe_integer(r["version"]) and PKeySyncExport.serialisable(r["id"]) \
				and PKeySyncExport.serialisable(r["version"]) and PKeySyncExport.serialisable(r["value"] if r["has_value"] else null)

	static func _line_text(r: Dictionary, file: Variant, id: Variant = null) -> PackedByteArray:
		var o := {"id": r["id"] if id == null else id, "version": r["version"]}
		if r["has_value"]:
			o["value"] = r["value"]
		if file != null:
			o["file"] = file
		return PKeySyncExport.line_of(o)

	static func _ref_of(c: Dictionary) -> Variant:
		var r: Variant = c.get("record")
		if r is Array and (r as Array).size() >= 2 and r[0] is String and r[1] is String:
			return [r[0], r[1]]
		return null

	static func _entry_names(records: int, files: int) -> PackedStringArray:
		var d := PKeyConstants.SYNC_EXPORT_STORE_DIR
		var out := PackedStringArray(["README.txt", d + "settings.json"])
		for i in records:
			out.append("%srecords/%d.ndjson" % [d, i])
		for i in files:
			out.append("%sfiles/%d.bin" % [d, i])
		out.append_array(PackedStringArray([d + "files.json", d + "index.json", "data.json"]))
		return out

	## Sorts `items` (Dictionaries) by the String under `key` in code point order (the UTF-8 byte order of
	## valid text), keeping the order the rows came in for equal keys.
	static func _sort_by(items: Array, key: String) -> void:
		for i in items.size():
			items[i]["_i"] = i
		items.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
			var ka: String = a[key]
			var kb: String = b[key]
			if ka == kb:
				return a["_i"] < b["_i"]
			return ka < kb)

	# ── the plan and the archive ─────────────────────────────────────────────────────────────

	func go() -> Dictionary:
		if _stop() or not _open_settings() or not _open_records() or not await _plan_files() or not _bounds():
			return fail
		if not await _write_archive():
			return fail
		return _summary

	## Settings, in the order of the name the Worker served.
	func _open_settings() -> bool:
		_setting_changes = []
		for c: Dictionary in _changes:
			if c.get("setting") is String:
				_setting_changes.append({"c": c, "name": c["setting"]})
		_sort_by(_setting_changes, "name")
		for sc: Dictionary in _setting_changes:
			if _stop():
				return false
			var got: Variant = _setting(sc["c"])
			if got == null or not PKeySyncExport.serialisable(got[0]) or not PKeySyncExport.serialisable(got[1]):
				_setting_skips.append({"kind": "setting", "code": "invalid"})
			else:
				_settings[got[0]] = got[1]
				_setting_count += 1
		_settings_line = PKeySyncExport.line_of(_settings)
		return true

	## Records, a collection at a time, rows in the order of the wire id.
	func _open_records() -> bool:
		var collection_set := {}
		for c: Dictionary in _changes:
			var ref: Variant = _ref_of(c)
			if ref != null:
				_record_changes.append({"c": c, "collection": ref[0], "wire": ref[1]})
				collection_set[ref[0]] = true
		var collection_items: Array = []
		for k in collection_set:
			collection_items.append({"name": k})
		_sort_by(collection_items, "name")
		for ci: Dictionary in collection_items:
			_collections.append(ci["name"])
		var serial := 0
		for collection: String in _collections:
			var rows: Array = []
			var mine: Array = _record_changes.filter(func(x: Dictionary) -> bool: return x["collection"] == collection)
			_sort_by(mine, "wire")
			for m: Dictionary in mine:
				if _stop():
					return false
				var r: Variant = _record(collection, m["wire"], m["c"])
				if r is String and r == FILE_ONLY:
					_file_only[collection] = int(_file_only.get(collection, 0)) + 1
				elif r is String and r == INVALID or r is Dictionary and not _writable(r):
					_record_skips.append({"kind": "record", "code": "invalid", "collection": collection})
				elif r is Dictionary:
					serial += 1
					rows.append({
						"serial": serial, "collection": collection, "wire": m["wire"], "id": r["id"], "change": m["c"],
						"pointer": _pointer_of(m["c"]), "binding": r["binding"], "line_bytes": _line_text(r, null).size(),
					})
			_sort_by(rows, "id")
			if not rows.is_empty():
				_written.append({"collection": collection, "rows": rows})
		return true

	## Every file entry, live first and then the revisions, newest first. The manifests of the chunked files are
	## fetched and checked here, before anything is read.
	func _plan_files() -> bool:
		for collection: String in _collections:
			for _n in _file_only.get(collection, 0):
				_no_entry(collection)
			var rows: Array = []
			for w: Dictionary in _written:
				if w["collection"] == collection:
					rows = w["rows"]
			for row: Dictionary in rows:
				if row["pointer"] == null:
					continue
				if _stop():
					return false
				if not await _plan_row(collection, row):
					return false
		return true

	func _no_entry(collection: String) -> void:
		_pointer_collections.append(collection)
		_file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})

	func _plan_row(collection: String, row: Dictionary) -> bool:
		var binding: Variant = row["binding"]
		if e2e and binding == null:
			# A file the sealed value does not name is no readable file there (13.10.4).
			_no_entry(collection)
			row["pointer"] = null
			return true
		var current: Dictionary = row["pointer"]
		var others: Array = []
		var served: Variant = await files.pointers(collection, row["wire"])
		if _stop():
			return false
		if served is Array:
			for f in served:
				if f is Dictionary and PKeySyncExport.is_number(f.get("version")) and f.get("version") != current.get("version"):
					others.append(f.duplicate())
		others.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["version"] > b["version"])
		var candidates: Array = [current]
		candidates.append_array(others)
		for _f in candidates:
			_pointer_collections.append(collection)
		var live := -1
		for i in candidates.size():
			if (i == 0) if binding == null else _named_by(binding, candidates[i]):
				live = i
				break
		# No candidate is the live file: the row has no readable file.
		if live < 0:
			row["pointer"] = null
			_file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})
			return true
		var order: Array = [live]
		if inp.get("include_revisions", false):
			for i in candidates.size():
				if i != live:
					order.append(i)
		for i: int in order:
			if not await _plan_file(collection, row, candidates[i], i == live):
				return false
		return true

	func _plan_file(collection: String, row: Dictionary, f: Dictionary, is_live: bool) -> bool:
		var fsize := PKeySyncExport.size_of(f.get("size"))
		var fmt := "chunks" if f.get("format") == "chunks" else "whole"
		var ref := {"collection": collection, "record": row["wire"], "version": f.get("version"), "format": fmt, "size": maxi(fsize, 0)}
		var v: Variant = null
		if _chunk_total <= PKeyConstants.SYNC_EXPORT_MAX_CHUNKS:
			v = await _validate(collection, ref, f)
		if _stop():
			return false
		if v == null:
			_file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})
			if is_live:
				row["pointer"] = null
			return true
		_planned.append({"row": row, "ref": ref, "file": f, "live": is_live, "planned": v["plain"], "manifest": v["manifest"]})
		return true

	## The bounds, all before the first byte: false with `sync-export-too-large`.
	func _bounds() -> bool:
		var caps: Dictionary = inp.get("caps", {}) if inp.get("caps") is Dictionary else {}
		var max_entries: int = int(caps.get("maxEntries", PKeyConstants.SYNC_EXPORT_MAX_ENTRIES))
		var max_bytes: int = int(caps.get("maxBytes", PKeyConstants.SYNC_EXPORT_MAX_BYTES))
		if 5 + _written.size() + _planned.size() > max_entries or _chunk_total > PKeyConstants.SYNC_EXPORT_MAX_CHUNKS:
			return _bad(PKeyConstants.ErrorCode.SYNC_EXPORT_TOO_LARGE)
		_file_bytes = 0
		for p: Dictionary in _planned:
			# Each term and the sum stay safe integers: stop at the cap.
			_file_bytes += int(p["planned"])
			if _file_bytes > max_bytes:
				return _bad(PKeyConstants.ErrorCode.SYNC_EXPORT_TOO_LARGE)
		_names = _entry_names(_written.size(), _planned.size())
		var overhead := PKeyConstants.SYNC_EXPORT_ZIP_END_BYTES
		for n in _names:
			overhead += PKeyConstants.SYNC_EXPORT_ZIP_ENTRY_BYTES + 2 * PKeySyncExport.utf8_len(n)
		_planned_bytes = _file_bytes + _known_bytes() + overhead
		if _planned_bytes > max_bytes:
			return _bad(PKeyConstants.ErrorCode.SYNC_EXPORT_TOO_LARGE)
		return true

	## K of the zip32 total (13.12): the entries other than the files, at their bound where the reads decide.
	func _known_bytes() -> int:
		var reserve := PKeyConstants.SYNC_EXPORT_ITEM_RESERVE_BYTES
		var live_rows := {}
		for p: Dictionary in _planned:
			if p["live"]:
				live_rows[(p["row"] as Dictionary)["serial"]] = true
		var known := PKeySyncExport.utf8_len(PKeySyncExport.readme_text()) + _settings_line.size() + _index_bytes(_written)
		for w: Dictionary in _written:
			for r: Dictionary in w["rows"]:
				known += int(r["line_bytes"]) + (reserve if live_rows.has(r["serial"]) else 0)
		known += 2 + _planned.size()
		for p: Dictionary in _planned:
			var row: Dictionary = p["row"]
			known += reserve + 6 * (PKeySyncExport.utf8_len(row["collection"]) + PKeySyncExport.utf8_len(row["id"]))
		known += reserve + reserve * _setting_changes.size()
		for rc: Dictionary in _record_changes:
			known += reserve + 6 * PKeySyncExport.utf8_len(rc["collection"])
		for pc: String in _pointer_collections:
			known += reserve + 6 * PKeySyncExport.utf8_len(pc)
		return known

	# ── write ────────────────────────────────────────────────────────────────────────────────

	func _write_archive() -> bool:
		var d := PKeyConstants.SYNC_EXPORT_STORE_DIR
		_zip = PKeyZipStore.new(sink, int(inp.get("zip_limit", PKeyZipStore.MAX_U32)))
		await _zip.add_bytes("README.txt", PKeySyncExport.readme_text().to_utf8_buffer())
		await _zip.add_bytes(d + "settings.json", _settings_line)
		if _stop():
			return false
		var file_index := await _write_files()
		if _stop():
			return false
		var index_records := await _write_records()
		if _stop():
			return false
		await _zip.add_bytes(d + "files.json", PKeySyncExport.line_of(file_index))
		await _zip.add_bytes(d + "index.json", PKeySyncExport.line_of({"records": index_records}))
		var skipped: Array = []
		skipped.append_array(_setting_skips)
		skipped.append_array(_record_skips)
		skipped.append_array(_file_skips)
		skipped.append_array(_partial_skips)
		var data := {
			"schema": PKeyConstants.SYNC_EXPORT_FORMAT,
			"source": "device",
			"product": inp["product"],
			"exportedAt": inp["exported_at"],
			"encryption": "e2e" if e2e else "server",
			"counts": {"settings": _setting_count, "records": _record_count, "files": _planned.size()},
			"unsynced": inp["unsynced"],
			"skipped": skipped,
		}
		await _zip.add_bytes("data.json", PKeySyncExport.line_of(data))
		var total := _zip.finish(_names)
		if _stop():
			return false
		if total > _planned_bytes:
			return _bad(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
		_summary = {
			"ok": true, "bytes": total, "planned_bytes": _planned_bytes, "entries": _names.size(), "settings": _setting_count,
			"records": _record_count, "files": _planned.size(), "skipped": skipped,
		}
		return true

	## The files, read one at a time, in plan order, at most the planned size each: files.json's items.
	func _write_files() -> Array:
		var d := PKeyConstants.SYNC_EXPORT_STORE_DIR
		var file_index: Array = []
		for n in _planned.size():
			var p: Dictionary = _planned[n]
			if _stop():
				return file_index
			var entry := "%sfiles/%d.bin" % [d, n]
			_zip.begin(entry)
			var got: Dictionary = await _read_file(p)
			if _stop():
				return file_index
			_zip.end()
			var row: Dictionary = p["row"]
			var facts := {"entry": entry, "version": p["file"].get("version"), "size": got["size"], "sha256": got["sha256"]}
			if got["partial"]:
				_partial_skips.append({"kind": "file", "collection": row["collection"], "entry": entry, "code": "sync-file-invalid", "partial": true})
				facts["partial"] = true
				facts["expectedSize"] = p["planned"]
			var item := facts.duplicate()
			item["collection"] = row["collection"]
			item["id"] = row["id"]
			item["live"] = p["live"]
			if e2e and not p["live"]:
				item["bound"] = false
			file_index.append(item)
			if p["live"]:
				_line_file[row["serial"]] = facts
		return file_index

	## The record files, a line at a time: each row is opened again for its line.
	func _write_records() -> Array:
		var d := PKeyConstants.SYNC_EXPORT_STORE_DIR
		var index_records: Array = []
		for i in _written.size():
			var w: Dictionary = _written[i]
			var name := "%srecords/%d.ndjson" % [d, i]
			_zip.begin(name)
			for r: Dictionary in w["rows"]:
				if _stop():
					return index_records
				var again: Variant = _record(w["collection"], r["wire"], r["change"])
				if again is String:
					_bad(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "changed")
					return index_records
				await _zip.write(_line_text(again, _line_file.get(r["serial"]), r["id"]))
				_record_count += 1
			_zip.end()
			index_records.append({"entry": name, "collection": w["collection"], "count": w["rows"].size()})
		return index_records

	## The bytes of index.json for the records written (`rows` of each `{collection, rows}`).
	func _index_bytes(written: Array) -> int:
		var d := PKeyConstants.SYNC_EXPORT_STORE_DIR
		var recs: Array = []
		for i in written.size():
			recs.append({"entry": "%srecords/%d.ndjson" % [d, i], "collection": written[i]["collection"], "count": written[i]["rows"].size()})
		return PKeySyncExport.line_of({"records": recs}).size()

	# ── validating a candidate file ──────────────────────────────────────────────────────────

	## `{plain, manifest}` of a file that checks (a chunked one with its manifest), or null (invalid).
	func _validate(collection: String, ref: Dictionary, f: Dictionary) -> Variant:
		var size := PKeySyncExport.size_of(f.get("size"))
		if size < 0 or not PKeySyncExport.is_hex64(f.get("sha256")):
			return null
		var fc := _file_codec(collection)
		if _file_codec_stale(fc):
			return null
		var fmt: Variant = f.get("format")
		if fmt == "chunks":
			return await _validate_chunked(fc, ref, f, size)
		if fmt != "whole":
			return null
		if not e2e:
			return {"plain": size, "manifest": null}
		var plain: int = fc.plain_size(size)
		return null if plain < 0 else {"plain": plain, "manifest": null}

	## The manifest of a chunked file, fetched and checked: its stored bytes hash to the pointer's, it opens, it
	## parses and the pointer's size is the stored size of its `plainSize`.
	func _validate_chunked(fc: Object, ref: Dictionary, f: Dictionary, size: int) -> Variant:
		var manifest_max: int = fc.stored_size(PKeySyncManifest.HEADER_BYTES + PKeySyncManifest.RECORD_BYTES * PKeyConstants.SYNC_MAX_CHUNKS_PER_FILE)
		var got: Variant = await _read_bounded(ref, manifest_max)
		if got == null or _stop():
			return null
		var stored: PackedByteArray = got
		if PKeySyncHkdf.sha256(stored).hex_encode() != f["sha256"]:
			return null
		var opened: Dictionary = await Support.codec_off(fc, "open_manifest", [stored], stored.size(), {"ok": false, "reason": "locked"})
		if _stop() or _file_codec_stale(fc) or not opened["ok"]:
			return null
		var parsed := PKeySyncManifest.parse(opened["plain"])
		if not parsed["ok"] or fc.stored_size(parsed["manifest"]["plain_size"]) != size:
			return null
		var m: Dictionary = parsed["manifest"]
		_chunk_total += (m["records"] as Array).size()
		return {"plain": m["plain_size"], "manifest": m}

	## The stored bytes of `ref` up to `limit`, or null when the source has none or has more.
	func _read_bounded(ref: Dictionary, limit: int) -> Variant:
		var reader: Variant = await files.open_stored(ref)
		if reader == null:
			return PackedByteArray()
		var out := PackedByteArray()
		var over := false
		while true:
			if _stop():
				break
			var piece: PackedByteArray = await reader.read_piece()
			if piece.is_empty():
				break
			if out.size() + piece.size() > limit:
				over = true
				break
			out.append_array(piece)
		reader.close()
		return null if over else out

	# ── reading one file ─────────────────────────────────────────────────────────────────────

	## Streams one planned file into the open entry: `{size, sha256, partial}`.
	func _read_file(p: Dictionary) -> Dictionary:
		var st := {"written": 0, "ctx": HashingContext.new(), "partial": false}
		(st["ctx"] as HashingContext).start(HashingContext.HASH_SHA256)
		var planned_size: int = p["planned"]
		var f: Dictionary = p["file"]
		var collection: String = p["row"]["collection"]
		var fc := _file_codec(collection)
		if _file_codec_stale(fc):
			return _read_result(st)
		if f.get("format") == "chunks":
			await _read_chunks(p, fc, st)
			return _read_result(st)
		var stored := PKeySyncExport.size_of(f.get("size"))
		var reader: Variant = await files.open_stored(p["ref"])
		var lim := _Limited.new(reader, stored)
		if e2e:
			await _read_sealed(lim, fc, planned_size, st)
		else:
			# Server mode: the stored bytes are the plaintext.
			while not _stop():
				var piece: PackedByteArray = await lim.next()
				if piece.is_empty():
					break
				var at := 0
				while at < piece.size() and not _stop():
					await _put(piece.slice(at, at + PIECE), planned_size, st)
					at += PIECE
		lim.close()
		if not st["partial"] and fail.is_empty():
			st["partial"] = lim.total != stored or lim.hex() != f.get("sha256")
		return _read_result(st)

	static func _read_result(st: Dictionary) -> Dictionary:
		return {"size": st["written"], "sha256": (st["ctx"] as HashingContext).finish().hex_encode(), "partial": st["partial"]}

	## Writes `b` to the open entry, counting it against the plan.
	func _put(b: PackedByteArray, planned_size: int, st: Dictionary) -> void:
		if st["written"] + b.size() > planned_size:
			_bad(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
			return
		if b.is_empty():
			return
		(st["ctx"] as HashingContext).update(b)
		st["written"] += b.size()
		await _zip.write(b)
		_written_plain += b.size()
		var cb: Variant = inp.get("on_progress")
		if cb is Callable and (cb as Callable).is_valid():
			cb.call(_written_plain, _file_bytes)

	## An end-to-end whole file: a segment at a time, each authenticated, the entry ending at the last good one.
	func _read_sealed(lim: _Limited, fc: Object, planned_size: int, st: Dictionary) -> void:
		var inner: Variant = fc.inner() if fc.has_method("inner") else fc
		if inner == null:
			_bad(PKeyConstants.ErrorCode.SYNC_LOCKED)
			return
		var opener: PKeySyncFileStream.Opener = inner.whole_opener()
		opener.unbounded = true
		while not _stop():
			var piece: PackedByteArray = await lim.next()
			if piece.is_empty():
				break
			var segments: Array = await _off(func() -> Array: return opener.push(piece), piece.size())
			if _stop() or _file_codec_stale(fc):
				return
			for plain: PackedByteArray in segments:
				await _put(plain, planned_size, st)
			if opener.error != "":
				st["partial"] = true
				return
		if _stop():
			return
		var last: PackedByteArray = await _off(func() -> PackedByteArray: return opener.finish(), PKeySyncFileStream.SEGMENT_BYTES)
		if _file_codec_stale(fc):
			return
		if opener.error != "":
			st["partial"] = true
			return
		await _put(last, planned_size, st)

	## A chunked file: chunk by chunk, each opened under its id with its length checked, `plainSha256` last.
	func _read_chunks(p: Dictionary, fc: Object, st: Dictionary) -> void:
		var m: Dictionary = p["manifest"]
		var collection: String = p["row"]["collection"]
		var total := HashingContext.new()
		total.start(HashingContext.HASH_SHA256)
		for rec: Dictionary in m["records"]:
			if _stop():
				return
			var obj: Variant = await files.chunk(collection, (rec["id"] as PackedByteArray).hex_encode())
			if _stop():
				return
			if not (obj is PackedByteArray) or (obj as PackedByteArray).size() > TransferCodec.SERVER_CHUNK_MAX_STORED_BYTES:
				st["partial"] = true
				return
			var o: Dictionary = await Support.codec_off(fc, "open_chunk", [rec["id"], obj], (obj as PackedByteArray).size(), {"ok": false, "reason": "locked"})
			if _file_codec_stale(fc):
				return
			if not o["ok"] or (o["plain"] as PackedByteArray).size() != rec["plain_len"]:
				st["partial"] = true
				return
			total.update(o["plain"])
			await _put(o["plain"], p["planned"], st)
			if _stop():
				return
		if total.finish() != m["plain_sha256"]:
			st["partial"] = true

	## A source that yields at most `limit` bytes in all, hashing what it yields.
	class _Limited:
		extends RefCounted
		var total := 0
		var _reader: Variant
		var _limit: int
		var _ctx := HashingContext.new()

		func _init(reader: Variant, limit: int) -> void:
			_reader = reader
			_limit = limit
			_ctx.start(HashingContext.HASH_SHA256)

		func next() -> PackedByteArray:
			if _reader == null or total >= _limit:
				return PackedByteArray()
			var piece: PackedByteArray = await _reader.read_piece()
			var room := _limit - total
			if piece.size() > room:
				piece = piece.slice(0, room)
			total += piece.size()
			if not piece.is_empty():
				_ctx.update(piece)
			return piece

		func hex() -> String:
			return _ctx.finish().hex_encode()

		func close() -> void:
			if _reader != null:
				_reader.close()
