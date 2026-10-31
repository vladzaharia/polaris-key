class_name PKeyTransferJournal
extends RefCounted
## The Cloud Sync transfer journal (U-23.G4): what an interrupted file upload needs to carry on after a
## kill. A port of Python `cloud_sync/journal.py`. Host-local state, never a wire shape.
##
##   {v: 1, id, kind: "upload", collection, record, uploadId, mode, partBytes, done: [...], sha256,
##    size, expiresAt, state}
##
## `mode` is single, multipart or chunks; `done` is ascending part numbers (always empty for chunks, whose
## record only lets the next run abort the previous upload); `state` is uploading, then finalizing. A reader
## refuses a `v` it does not know and leaves the record alone. A record holds ids, counts, hashes and
## times: no key, no plaintext, no bearer token.
##
## On disk (`Files`) a record is one file named by the SHA-256 of the transfer id, never by the id (so no id
## climbs out of the directory or collides), mode 0600 in a 0700 directory kept out of OS backup
## (PKeyBackupExclusion), written to a random temporary name and renamed over the target. With a native
## sealer the file is `"PKJR" 0x01 blob` sealed under the context `pkey-cloud-sync-journal/1`; without one it
## is plain JSON (nothing in it is secret). A file that does not read is a miss, never an error.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const VERSION := 1
const DIR_NAME := "cloud-sync-transfers"
const _MAGIC := "PKJR"
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER
const _MAX_BYTES := 1024 * 1024

static var _hex_re: RegEx
static var _file_re: RegEx


static func _static_init() -> void:
	_hex_re = RegEx.create_from_string("\\A[0-9a-f]{64}\\z")
	_file_re = RegEx.create_from_string("\\A[0-9a-f]{64}\\.json\\z")


static func file_name(id: String) -> String:
	return id.sha256_text() + ".json"


static func _is_text(x: Variant) -> bool:
	return x is String and x != ""


static func _is_int(x: Variant) -> bool:
	return typeof(x) == TYPE_INT


## `{ok: true, record}` (a fresh Dictionary) or `{ok: false, reason: "version" | "shape"}`.
static func parse(raw: Variant) -> Dictionary:
	if not (raw is Dictionary):
		return {"ok": false, "reason": "shape"}
	var d: Dictionary = raw
	if not _is_int(d.get("v")) or d["v"] != VERSION:
		return {"ok": false, "reason": "version"}
	var mode: Variant = d.get("mode")
	var size: Variant = d.get("size")
	var part_bytes: Variant = d.get("partBytes")
	var done: Variant = d.get("done")
	var expires: Variant = d.get("expiresAt")
	var sha: Variant = d.get("sha256")
	if (
		not _is_text(d.get("id")) or d.get("kind") != "upload" or not _is_text(d.get("collection"))
		or not _is_text(d.get("record")) or not _is_text(d.get("uploadId"))
		or not (mode in ["single", "multipart", "chunks"])
		or not (sha is String) or _hex_re.search(sha) == null
		or not _is_int(size) or size < 0 or size > PKeyConstants.SYNC_FILE_MAX_BYTES
		or not (typeof(expires) in [TYPE_INT, TYPE_FLOAT])
		or not (d.get("state") in ["uploading", "finalizing"])
		or not (done is Array)
	):
		return {"ok": false, "reason": "shape"}
	var parts := 1
	if mode == "multipart":
		if not _is_int(part_bytes) or part_bytes < 1:
			return {"ok": false, "reason": "shape"}
		parts = maxi(1, (size + part_bytes - 1) / part_bytes)
		if parts > PKeyConstants.SYNC_MAX_PARTS:
			return {"ok": false, "reason": "shape"}
	elif part_bytes != null:
		return {"ok": false, "reason": "shape"}
	if mode == "chunks" and not (done as Array).is_empty():
		return {"ok": false, "reason": "shape"}
	var last := 0
	for n in done:
		if not _is_int(n) or n <= last or n > parts:
			return {"ok": false, "reason": "shape"}
		last = n
	return {"ok": true, "record": {
		"v": VERSION, "id": d["id"], "kind": "upload", "collection": d["collection"], "record": d["record"],
		"uploadId": d["uploadId"], "mode": mode, "partBytes": part_bytes if mode == "multipart" else null,
		"done": (done as Array).duplicate(), "sha256": sha, "size": size, "expiresAt": expires, "state": d["state"],
	}}


## An in-memory journal: tests, and a host with nothing durable (a transfer then does not survive a kill).
class Memory:
	extends RefCounted
	var _map := {}

	func get_record(id: String) -> Variant:
		var s: Variant = _map.get(id)
		return null if s == null else Types.load_json_text(s)["value"]

	func put(id: String, record: Dictionary) -> void:
		_map[id] = JSON.stringify(record, "", false)

	func delete(id: String) -> void:
		_map.erase(id)

	func list() -> Array:
		return _map.keys()

	func clear() -> void:
		_map.clear()


## The journal on disk: `<dir>/cloud-sync-transfers/<sha256(id)>.json`.
class Files:
	extends RefCounted
	var dir: String
	var sealer: PKeyRecordSealer = null

	func _init(state_dir: String, p_sealer: PKeyRecordSealer = null) -> void:
		dir = state_dir.path_join(PKeyTransferJournal.DIR_NAME)
		sealer = p_sealer

	func _context() -> PackedByteArray:
		return "pkey-cloud-sync-journal/1".to_utf8_buffer()

	func path_of(id: String) -> String:
		return dir.path_join(PKeyTransferJournal.file_name(id))

	func get_record(id: String) -> Variant:
		return _read(path_of(id))

	func _read(path: String) -> Variant:
		if not FileAccess.file_exists(path):
			return null
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null or f.get_length() > PKeyTransferJournal._MAX_BYTES:
			return null
		var bytes := f.get_buffer(f.get_length())
		f.close()
		if sealer != null:
			if bytes.size() < 6 or bytes.slice(0, 4).get_string_from_utf8() != PKeyTransferJournal._MAGIC or bytes[4] != PKeyTransferJournal.VERSION:
				return null
			var opened: PKeyResult = sealer.open(bytes.slice(5), _context())
			if not opened.ok:
				return null
			bytes = opened.detail
		var parsed := Types.load_json_bytes(bytes)
		return parsed["value"] if parsed["ok"] else null

	func put(id: String, record: Dictionary) -> void:
		if not _ensure_dir():
			return
		var plain := JSON.stringify(record, "", false).to_utf8_buffer()
		var out := plain
		if sealer != null:
			var sealed: PKeyResult = sealer.seal(plain, _context())
			if not sealed.ok:
				return
			out = (PKeyTransferJournal._MAGIC + char(PKeyTransferJournal.VERSION)).to_utf8_buffer()
			out.append_array(sealed.detail)
		var name := PKeyTransferJournal.file_name(id)
		var tmp_name := "%s.tmp-%s" % [name, Crypto.new().generate_random_bytes(8).hex_encode()]
		var tmp := dir.path_join(tmp_name)
		var f := FileAccess.open(tmp, FileAccess.WRITE)
		if f == null:
			return
		f.store_buffer(out)
		f.flush()
		var err := f.get_error()
		f.close()
		if err != OK:
			DirAccess.remove_absolute(tmp)
			return
		if _unix():
			FileAccess.set_unix_permissions(tmp, PKeyTransferJournal._OWNER_RW)
		var d := DirAccess.open(dir)
		if d == null or d.rename(tmp_name, name) != OK:
			DirAccess.remove_absolute(tmp)

	func delete(id: String) -> void:
		var p := path_of(id)
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)

	## The ids held, keeping only a file whose name is the hash of the id inside it.
	func list() -> Array:
		var ids := []
		var d := DirAccess.open(dir)
		if d == null:
			return ids
		for name in d.get_files():
			if PKeyTransferJournal._file_re.search(name) == null:
				continue
			var raw: Variant = _read(dir.path_join(name))
			if raw is Dictionary and raw.get("id") is String and PKeyTransferJournal.file_name(raw["id"]) == name:
				ids.append(raw["id"])
		return ids

	## The purge that goes with the person (sign-out, forget).
	func clear() -> void:
		var d := DirAccess.open(dir)
		if d == null:
			return
		for name in d.get_files():
			DirAccess.remove_absolute(dir.path_join(name))

	func _ensure_dir() -> bool:
		if not DirAccess.dir_exists_absolute(dir):
			var err := DirAccess.make_dir_recursive_absolute(dir)
			if err != OK and not DirAccess.dir_exists_absolute(dir):
				return false
			if _unix():
				FileAccess.set_unix_permissions(dir, PKeyTransferJournal._OWNER_RWX)
		PKeyBackupExclusion.exclude(dir)
		return true

	static func _unix() -> bool:
		return OS.has_feature("macos") or OS.has_feature("linuxbsd")
