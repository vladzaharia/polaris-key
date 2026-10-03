class_name PKeyPackStorage
extends RefCounted
## The Godot pack store (P4-08; CONTENT §9–§10; client-core `PackStorage` and `PackStateStore`,
## Node's `DirPackStorage`): staging, the content-addressed store and the install state under one
## root, by default `user://pkey`:
##
##   <root>/content/state.json                 the install state (temp file, read back, rename)
##   <root>/content/state.json.torn            a torn document held aside (never overwritten)
##   <root>/content/state.json.torn.list       the torn hold's snapshot of the store
##   <root>/content/revocations.json           the device's revocations (plans/P4-13.md §2.5): the
##                                             same atomic replace, written only once the first
##                                             entry is stored (never empty)
##   <root>/content/revocations.json.torn      a torn revocations document held aside
##   <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
##   <root>/staging/<planId>/out/              the payload being built (`payload.bin` or a tree)
##   <root>/staging/<planId>/bake.json         a trailer bake in progress (A6 §5), for repair
##   <root>/store/<sha256>.pck                 a committed container payload, never overwritten
##   <root>/store/<sha256>.zip                 the same for a container that is a zip (godot.zip:
##                                             Godot's ZIP pack source opens only `.zip` paths);
##                                             named by the payload's leading bytes (`PK`)
##   <root>/store/<sha256>.files.json          the files index kept beside it
##   <root>/trees/<sha256>/                    a committed tree payload (`.pkey/files.json` inside)
##
## Godot's FileAccess and DirAccess errors are checked everywhere and never read as "missing":
## a read answers "missing" ONLY for ERR_FILE_NOT_FOUND, every other failure is an error the
## engine treats as unreadable. Every write checks `store_buffer` and `get_error()`, and a file is
## read back from disk and compared before it is renamed into place (the P3-10 lesson). A
## listing never returns a partial result: it answers null on any error.
##
## On web, `user://` is an IndexedDB mirror held entirely in memory (A6 §2.6, S-05 §4.3): pass a
## MEMFS root outside `user://` (`/pkey`) for large packs; the state file stays small.

const CONTAINER_FILE := "payload.bin"
const INDEX_DIR := ".pkey"
const INDEX_FILE := "files.json"
const EMPTY_SHA256 := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

var root := "user://pkey"
## Where the install state lives (default `<root>/content/state.json`).
var state_path := ""
## Where the revocations live (default `<root>/content/revocations.json`), beside the state.
var revocations_path := ""
## Measured trees of embedded locations (once per process).
var _embedded_files := {}
## Indexes derived from a container's own PCK directory, by location (embedded packs, which
## cannot keep one beside them).
var _derived := {}
var _derived_mutex := Mutex.new()


func _init(p_root := "user://pkey") -> void:
	root = p_root.trim_suffix("/")
	state_path = root.path_join("content/state.json")
	revocations_path = root.path_join("content/revocations.json")


func staging_dir() -> String:
	return root.path_join("staging")


func store_dir() -> String:
	return root.path_join("store")


func trees_dir() -> String:
	return root.path_join("trees")


# ── Low-level file helpers ──────────────────────────────────────────────────────────────────

## {ok: true, bytes} or {ok: true, missing: true} (ERR_FILE_NOT_FOUND only) or {ok: false, error}.
static func read_bytes(path: String) -> Dictionary:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		var e := FileAccess.get_open_error()
		if e == ERR_FILE_NOT_FOUND:
			return {"ok": true, "missing": true}
		return {"ok": false, "error": e}
	var n := int(f.get_length())
	var b := f.get_buffer(n)
	var e2 := f.get_error()
	f.close()
	if b.size() != n or (e2 != OK and e2 != ERR_FILE_EOF):
		return {"ok": false, "error": e2 if e2 != OK else ERR_FILE_CORRUPT}
	return {"ok": true, "bytes": b}


## Whether `path` exists as a file: 1, 0 (missing), -1 (cannot tell: an error).
static func file_state(path: String) -> int:
	var f := FileAccess.open(path, FileAccess.READ)
	if f != null:
		f.close()
		return 1
	var e := FileAccess.get_open_error()
	if e == ERR_FILE_NOT_FOUND:
		return 0
	return -1


## Write `bytes` to `path` through a temp file: store, check, close, READ IT BACK and compare,
## then rename over `path`. False on any failure (the temp file is removed, `path` untouched).
static func atomic_write(path: String, bytes: PackedByteArray) -> bool:
	if DirAccess.make_dir_recursive_absolute(path.get_base_dir()) != OK and not DirAccess.dir_exists_absolute(path.get_base_dir()):
		return false
	var tmp := "%s.%d.tmp" % [path, OS.get_process_id()]
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return false
	var ok := bytes.is_empty() or f.store_buffer(bytes)
	ok = ok and f.get_error() == OK
	f.flush()
	ok = ok and f.get_error() == OK
	f.close()
	if ok:
		var back := read_bytes(tmp)
		ok = back["ok"] and not back.has("missing") and back["bytes"] == bytes
	if ok:
		ok = DirAccess.rename_absolute(tmp, path) == OK
	if not ok:
		DirAccess.remove_absolute(tmp)
	return ok


## Every entry of a directory: {ok: true, files, dirs} ({ok: true} with none ONLY when the
## directory does not exist) or {ok: false} on any error (never a partial listing).
static func list_dir(path: String) -> Dictionary:
	if not DirAccess.dir_exists_absolute(path):
		if FileAccess.file_exists(path):
			return {"ok": false}
		return {"ok": true, "files": PackedStringArray(), "dirs": PackedStringArray()}
	var d := DirAccess.open(path)
	if d == null:
		return {"ok": false}
	d.include_hidden = true
	d.include_navigational = false
	if d.list_dir_begin() != OK:
		return {"ok": false}
	var files := PackedStringArray()
	var dirs := PackedStringArray()
	var name := d.get_next()
	while name != "":
		if d.current_is_dir():
			dirs.append(name)
		else:
			files.append(name)
		name = d.get_next()
	d.list_dir_end()
	return {"ok": true, "files": files, "dirs": dirs}


## Remove a file or a directory tree; true when nothing is left.
static func remove_tree(path: String) -> bool:
	if DirAccess.dir_exists_absolute(path):
		var l := list_dir(path)
		if not l["ok"]:
			return false
		for f in l["files"]:
			DirAccess.remove_absolute(path.path_join(f))
		for sub in l["dirs"]:
			remove_tree(path.path_join(sub))
		DirAccess.remove_absolute(path)
		return not DirAccess.dir_exists_absolute(path)
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
		return not FileAccess.file_exists(path)
	return true


## Every file under `dir` as `/`-separated paths relative to it, skipping `.pkey/`; null on any
## listing error.
static func walk_tree(dir: String) -> Variant:
	var out := PackedStringArray()
	if not _walk(dir, "", out):
		return null
	return out


static func _walk(dir: String, rel: String, out: PackedStringArray) -> bool:
	var l := list_dir(dir.path_join(rel) if rel != "" else dir)
	if not l["ok"]:
		return false
	for f in l["files"]:
		var p: String = f if rel == "" else rel + "/" + f
		out.append(p)
	for sub in l["dirs"]:
		var p: String = sub if rel == "" else rel + "/" + sub
		if p == INDEX_DIR:
			continue
		if not _walk(dir, p, out):
			return false
	return true


## A directory's files with their sizes and SHA-256 (embedded and reload checks); null on error.
static func measure_tree(dir: String) -> Variant:
	var paths = walk_tree(dir)
	if paths == null:
		return null
	var out: Array = []
	for p in paths:
		var src := PKeyByteSource.file(dir.path_join(p))
		if src.error != OK:
			return null
		var h := PKeyByteSource.sha256(src)
		if src.error != OK:
			return null
		out.append({"path": p, "size": src.size, "sha256": h})
	return out


## `treeDigest` of a directory minus `.pkey/`; "" on error.
static func directory_tree_digest(dir: String) -> String:
	var files = measure_tree(dir)
	return "" if files == null else PKeyPackFiles.tree_digest(files)


## A single file's SHA-256 and size: {ok, sha256, size} or {ok: false, missing?}.
static func measure_file(path: String) -> Dictionary:
	var st := file_state(path)
	if st == 0:
		return {"ok": false, "missing": true}
	if st < 0:
		return {"ok": false}
	var src := PKeyByteSource.file(path)
	if src.error != OK:
		return {"ok": false}
	var h := PKeyByteSource.sha256(src)
	if src.error != OK:
		return {"ok": false}
	return {"ok": true, "sha256": h, "size": src.size}


# ── The state store ─────────────────────────────────────────────────────────────────────────

## The state document's text: {ok: true, text: String or null} (null ONLY when there is no file)
## or {ok: false} (it exists but cannot be read: never the empty state).
func state_read() -> Dictionary:
	var r := read_bytes(state_path)
	if not r["ok"]:
		return {"ok": false}
	if r.has("missing"):
		if DirAccess.dir_exists_absolute(state_path):
			return {"ok": false}
		return {"ok": true, "text": null}
	var text: String = (r["bytes"] as PackedByteArray).get_string_from_utf8()
	return {"ok": true, "text": text}


func state_replace(text: String) -> bool:
	return atomic_write(state_path, text.to_utf8_buffer())


## Keep a torn document's text aside as `state.json.torn` (never overwriting an earlier one).
func state_quarantine(text: String) -> bool:
	var torn := state_path + ".torn"
	var st := file_state(torn)
	if st == 1:
		return true
	if st < 0:
		return false
	return atomic_write(torn, text.to_utf8_buffer())


## Whether a quarantined document is held: 1, 0, or -1 (cannot tell).
func state_quarantined() -> int:
	return file_state(state_path + ".torn")


func state_clear_quarantine() -> bool:
	var ok := remove_tree(state_path + ".torn.list")
	return remove_tree(state_path + ".torn") and ok


## The torn hold's saved snapshot: {ok: true, text: String or null} or {ok: false}.
func state_read_hold_list() -> Dictionary:
	var r := read_bytes(state_path + ".torn.list")
	if not r["ok"]:
		return {"ok": false}
	if r.has("missing"):
		return {"ok": true, "text": null}
	return {"ok": true, "text": (r["bytes"] as PackedByteArray).get_string_from_utf8()}


## Save the hold's snapshot the first time a hold starts (never over an existing one).
func state_write_hold_list(text: String) -> bool:
	var path := state_path + ".torn.list"
	var st := file_state(path)
	if st == 1:
		return true
	if st < 0:
		return false
	return atomic_write(path, text.to_utf8_buffer())


# ── The revocations store (plans/P4-13.md §2.5): the same seam with a second key ──────────

## The revocations document's text: {ok: true, text: String or null} (null ONLY when there is no
## file; can't-read is never missing) or {ok: false} (it exists but cannot be read).
func revocations_read() -> Dictionary:
	var r := read_bytes(revocations_path)
	if not r["ok"]:
		return {"ok": false}
	if r.has("missing"):
		if DirAccess.dir_exists_absolute(revocations_path):
			return {"ok": false}
		return {"ok": true, "text": null}
	return {"ok": true, "text": (r["bytes"] as PackedByteArray).get_string_from_utf8()}


## Replace the revocations document atomically (temp file, read back, rename).
func revocations_replace(text: String) -> bool:
	return atomic_write(revocations_path, text.to_utf8_buffer())


## Keep a torn revocations document aside as `revocations.json.torn` (never over an earlier one).
func revocations_quarantine(text: String) -> bool:
	var torn := revocations_path + ".torn"
	var st := file_state(torn)
	if st == 1:
		return true
	if st < 0:
		return false
	return atomic_write(torn, text.to_utf8_buffer())


## Drop a quarantined revocations document (recover_state()).
func revocations_clear_quarantine() -> bool:
	return remove_tree(revocations_path + ".torn")


# ── Staging ─────────────────────────────────────────────────────────────────────────────────

func object_path(plan_id: String, sha256: String) -> String:
	return staging_dir().path_join(plan_id).path_join("objects").path_join(sha256)


## The staged object's size: >= 0, or -1 when it cannot be read.
func staged_size(plan_id: String, sha256: String) -> int:
	var path := object_path(plan_id, sha256)
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return 0 if FileAccess.get_open_error() == ERR_FILE_NOT_FOUND else -1
	var n := int(f.get_length())
	f.close()
	return n


func staged_source(plan_id: String, sha256: String) -> PKeyByteSource:
	var n := staged_size(plan_id, sha256)
	return PKeyByteSource.file(object_path(plan_id, sha256), maxi(n, 0))


## Append bytes to a staged object; false on any write error.
func staged_append(plan_id: String, sha256: String, bytes: PackedByteArray) -> bool:
	var path := object_path(plan_id, sha256)
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var f: FileAccess
	if FileAccess.file_exists(path):
		f = FileAccess.open(path, FileAccess.READ_WRITE)
		if f != null:
			f.seek_end()
	else:
		f = FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return false
	var ok := bytes.is_empty() or f.store_buffer(bytes)
	ok = ok and f.get_error() == OK
	f.close()
	return ok


func staged_reset(plan_id: String, sha256: String) -> bool:
	return remove_tree(object_path(plan_id, sha256))


func out_dir(plan_id: String) -> String:
	return staging_dir().path_join(plan_id).path_join("out")


## A positional writer over the plan's container output (`out/payload.bin`).
class FileSink extends RefCounted:
	var path := ""
	var _f: FileAccess = null
	var failed := false

	func _init(p_path: String) -> void:
		path = p_path

	func write(offset: int, bytes: PackedByteArray) -> bool:
		if failed:
			return false
		if _f == null:
			_f = FileAccess.open(path, FileAccess.READ_WRITE)
			if _f == null:
				failed = true
				return false
		_f.seek(offset)
		if not _f.store_buffer(bytes) or _f.get_error() != OK:
			failed = true
			return false
		return true

	func close() -> bool:
		if _f != null:
			_f.flush()
			var ok := _f.get_error() == OK
			_f.close()
			_f = null
			failed = failed or not ok
		return not failed


## A tree sink over the plan's tree output (`out/…`); paths have passed the path rules.
class TreeSink extends RefCounted:
	var dir := ""
	var failed := false

	func _init(p_dir: String) -> void:
		dir = p_dir

	func write_file(path: String, bytes: PackedByteArray) -> bool:
		var abs_path := dir.path_join(path)
		if DirAccess.make_dir_recursive_absolute(abs_path.get_base_dir()) != OK and not DirAccess.dir_exists_absolute(abs_path.get_base_dir()):
			failed = true
			return false
		var f := FileAccess.open(abs_path, FileAccess.WRITE)
		if f == null:
			failed = true
			return false
		var ok := bytes.is_empty() or f.store_buffer(bytes)
		ok = ok and f.get_error() == OK
		f.close()
		if not ok:
			failed = true
		return ok

	func close() -> bool:
		return not failed


## The plan's output area: {sink} for a container, {tree} for a tree (a fresh, empty `out/`).
func output(plan_id: String, layout: String) -> Dictionary:
	var out := out_dir(plan_id)
	remove_tree(out)
	if DirAccess.make_dir_recursive_absolute(out) != OK and not DirAccess.dir_exists_absolute(out):
		return {}
	if layout == "tree":
		return {"tree": TreeSink.new(out)}
	var file := out.path_join(CONTAINER_FILE)
	var f := FileAccess.open(file, FileAccess.WRITE)
	if f == null:
		return {}
	f.close()
	return {"sink": FileSink.new(file)}


func container_path(payload_sha256: String) -> String:
	return store_dir().path_join(payload_sha256 + ".pck")


## A zip container's store path (P4-16: a `godot.zip` mounts only from a `.zip` path).
func zip_path(payload_sha256: String) -> String:
	return store_dir().path_join(payload_sha256 + ".zip")


## Whether a staged container is a zip, by its leading bytes (`PK`), never by its type or name.
static func _is_zip(file: String) -> bool:
	var f := FileAccess.open(file, FileAccess.READ)
	if f == null:
		return false
	var head := f.get_buffer(2)
	f.close()
	return head.size() == 2 and head[0] == 0x50 and head[1] == 0x4B


func tree_path(payload_sha256: String) -> String:
	return trees_dir().path_join(payload_sha256)


## Move the plan's verified output into the store (CONTENT §10 step 6), keeping the decoded files
## index beside it: the output is READ BACK from disk and must hash to `payload_sha256` (a tree:
## its treeDigest) before it is renamed. The store location, or "" on any failure (nothing moved).
## The same payload already stored is kept (the output dropped).
func commit(plan_id: String, _pack_id: String, payload_sha256: String, layout: String, index: Variant) -> String:
	var out := out_dir(plan_id)
	var index_text := JSON.stringify(index) if index is Dictionary else ""
	if layout == "tree":
		var dest := tree_path(payload_sha256)
		if DirAccess.dir_exists_absolute(dest):
			remove_tree(out)
			return dest
		if directory_tree_digest(out) != payload_sha256:
			return ""
		if index_text != "" and not atomic_write(out.path_join(INDEX_DIR).path_join(INDEX_FILE), index_text.to_utf8_buffer()):
			return ""
		if DirAccess.make_dir_recursive_absolute(trees_dir()) != OK and not DirAccess.dir_exists_absolute(trees_dir()):
			return ""
		if DirAccess.rename_absolute(out, dest) != OK:
			return ""
		return dest
	var file := out.path_join(CONTAINER_FILE)
	var dest := zip_path(payload_sha256) if _is_zip(file) else container_path(payload_sha256)
	var exists := file_state(dest)
	if exists < 0:
		return ""
	if exists == 1:
		remove_tree(out)
		return dest
	var m := measure_file(file)
	if not m["ok"] or m["sha256"] != payload_sha256:
		return ""
	if DirAccess.make_dir_recursive_absolute(store_dir()) != OK and not DirAccess.dir_exists_absolute(store_dir()):
		return ""
	if index_text != "" and not atomic_write(store_dir().path_join(payload_sha256 + ".files.json"), index_text.to_utf8_buffer()):
		return ""
	if DirAccess.rename_absolute(file, dest) != OK:
		return ""
	remove_tree(out)
	return dest


## The kept index of a stored container or tree: the Dictionary, null when there is none, or
## false when it cannot be read.
func _kept_index(install: Dictionary) -> Variant:
	var path := ""
	if install["layout"] == "tree":
		path = String(install["location"]).path_join(INDEX_DIR).path_join(INDEX_FILE)
	else:
		path = store_dir().path_join(String(install["payloadSha256"]) + ".files.json")
	var r := read_bytes(path)
	if not r["ok"]:
		return false
	if r.has("missing"):
		return null
	var j := JSON.new()
	if j.parse((r["bytes"] as PackedByteArray).get_string_from_utf8()) != OK or not (j.data is Dictionary) or not (j.data.get("files") is Array):
		return null
	return j.data


## An install's bytes for reuse (a delta base, file seeds): {payload: PKeyByteSource or null,
## files: Array of {path, sha256, size, source} or null}, or null when its payload is gone or
## cannot be read.
func installed(install: Dictionary) -> Variant:
	var loc: String = install["location"]
	if install["layout"] == "tree":
		if not DirAccess.dir_exists_absolute(loc):
			return null
		var files = _tree_files(install)
		return null if files == null else {"payload": null, "files": files}
	if file_state(loc) != 1:
		return null
	var whole := PKeyByteSource.file(loc)
	if whole.error != OK:
		return null
	var index = null if install.get("embedded") == true else _kept_index(install)
	if index is bool:
		return null
	if index == null and loc.ends_with(".pck"):
		index = _derive_index(install, whole)
	var files = null
	if index is Dictionary:
		files = []
		for f in index["files"]:
			files.append({"path": f["path"], "sha256": f["sha256"], "size": int(f["size"]), "source": PKeyByteSource.slice(whole, int(f.get("offset", 0)), int(f["size"]))})
	return {"payload": whole, "files": files}


## A `godot.pck` container installed without a kept index (a `full` install, an embedded
## baseline) still knows its files: its own PCK directory names every entry, and hashing each one
## (once; a store pack keeps the result beside it as `<sha256>.files.json`) gives the files the
## planner and `apply_file` reuse, so the next release can come by `file` or a `files` delta.
## Derived from the payload whose SHA-256 was verified at load. null when the directory does not
## read.
func _derive_index(install: Dictionary, whole: PKeyByteSource) -> Variant:
	var loc: String = install["location"]
	_derived_mutex.lock()
	var cached = _derived.get(loc)
	_derived_mutex.unlock()
	if cached != null:
		return cached
	var dir := PKeyPck.read_directory(whole)
	if not dir["ok"]:
		return null
	var entries: Array = dir["entries"].duplicate()
	entries.sort_custom(func(a, b): return a["offset"] < b["offset"] or (a["offset"] == b["offset"] and a["size"] < b["size"]))
	var files: Array = []
	for e in entries:
		var src := PKeyByteSource.slice(whole, int(e["offset"]), int(e["size"]))
		var h := PKeyByteSource.sha256(src)
		if whole.error != OK:
			return null
		files.append({"path": e["path"], "offset": int(e["offset"]), "size": int(e["size"]), "sha256": h})
	var index := {"format": PKeyConstants.FILES_FORMAT, "layout": "container", "payload": {"size": int(install["payloadSize"]), "sha256": install["payloadSha256"]}, "files": files}
	if install.get("embedded") != true and loc.begins_with(store_dir() + "/"):
		atomic_write(store_dir().path_join(String(install["payloadSha256"]) + ".files.json"), JSON.stringify(index).to_utf8_buffer())
	else:
		_derived_mutex.lock()
		_derived[loc] = index
		_derived_mutex.unlock()
	return index


func _tree_files(install: Dictionary) -> Variant:
	var loc: String = install["location"]
	var entries = null
	if install.get("embedded") != true:
		var index = _kept_index(install)
		if index is bool:
			return null
		if index is Dictionary:
			entries = index["files"]
	if entries == null:
		if _embedded_files.has(loc):
			return _embedded_files[loc]
		entries = measure_tree(loc)
		if entries == null:
			return null
	var files: Array = []
	for f in entries:
		files.append({"path": f["path"], "sha256": f["sha256"], "size": int(f["size"]), "source": PKeyByteSource.file(loc.path_join(f["path"]), int(f["size"]))})
	if install.get("embedded") == true:
		_embedded_files[loc] = files
	return files


## Re-check an install's payload on load: 1 (present, its digest matches), 0 (missing or a
## mismatch: dropped), -1 (it could not be read: kept, out of use and out of GC this load).
func verify(install: Dictionary) -> int:
	var loc: String = install["location"]
	if install["layout"] == "tree":
		if not DirAccess.dir_exists_absolute(loc):
			return 0 if file_state(loc) == 0 else -1
		var files = measure_tree(loc)
		if files == null:
			return -1
		return 1 if PKeyPackFiles.tree_digest(files) == install["payloadSha256"] else 0
	var m := measure_file(loc)
	if not m["ok"]:
		return 0 if m.has("missing") else -1
	return 1 if m["sha256"] == install["payloadSha256"] and float(m["size"]) == float(install["payloadSize"]) else 0


## Remove a stored location (only ever inside the store or the trees: an embedded payload lives
## in the app's resources). The kept index goes with a container.
func remove(location: String) -> void:
	if location.begins_with(store_dir() + "/") and (location.ends_with(".pck") or location.ends_with(".zip")):
		remove_tree(location)
		remove_tree(location.get_basename() + ".files.json")
	elif location.begins_with(trees_dir() + "/"):
		remove_tree(location)


func remove_staging(plan_id: String) -> void:
	if plan_id == "" or plan_id.contains("/") or plan_id.contains(".."):
		return
	remove_tree(staging_dir().path_join(plan_id))


## Every stored location and staging plan: {locations, plans}, or null on any listing error (the
## engine never collects from a partial listing).
func list() -> Variant:
	var locations: Array = []
	var plans: Array = []
	var s := list_dir(store_dir())
	if not s["ok"]:
		return null
	for f in s["files"]:
		if f.ends_with(".pck") or f.ends_with(".zip"):
			locations.append(store_dir().path_join(f))
	var t := list_dir(trees_dir())
	if not t["ok"]:
		return null
	for d in t["dirs"]:
		locations.append(trees_dir().path_join(d))
	var p := list_dir(staging_dir())
	if not p["ok"]:
		return null
	for d in p["dirs"]:
		plans.append(d)
	return {"locations": locations, "plans": plans}


## Free bytes where the store lives; unknown (0) counts as plenty, as the updater does.
func free_disk() -> int:
	DirAccess.make_dir_recursive_absolute(root)
	var d := DirAccess.open(root)
	if d == null:
		return 0
	var n := int(d.get_space_left())
	return n if n > 0 else 9007199254740991


# ── The bake journal (A6 §5: a crash between the trailer and the truncation) ─────────────────

func bake_journal_path(plan_id: String) -> String:
	return staging_dir().path_join(plan_id).path_join("bake.json")


## A store pack's path, exactly `<store>/<64 lowercase hex>.pck`: the only files a trailer is
## ever appended to, and the only ones a bake journal may name.
func is_store_pack(file: String) -> bool:
	if not file.begins_with(store_dir() + "/"):
		return false
	var name := file.substr(store_dir().length() + 1)
	return name.length() == 68 and name.ends_with(".pck") and PKeyPackClaims.is_sha256(name.substr(0, 64))


func _bake_entries(plan_id: String) -> Array:
	var r := read_bytes(bake_journal_path(plan_id))
	if not r["ok"] or r.has("missing"):
		return []
	var j := JSON.new()
	if j.parse((r["bytes"] as PackedByteArray).get_string_from_utf8()) != OK or not (j.data is Array):
		return []
	return j.data


## Record (size >= 0) or clear (size < 0) a trailer bake on `file` for `plan_id`. The journal is a
## list (a batch may append trailers to more than one store pack). Only a store pack may be named.
## True when the journal on disk says so.
func note_bake(plan_id: String, file: String, size: int) -> bool:
	if not is_store_pack(file):
		return false
	var path := bake_journal_path(plan_id)
	var list: Array = []
	for e in _bake_entries(plan_id):
		if e is Dictionary and e.get("file") != file:
			list.append(e)
	if size >= 0:
		list.append({"file": file, "size": size})
	if list.is_empty():
		return remove_tree(path)
	return atomic_write(path, JSON.stringify(list).to_utf8_buffer())


## Repair every bake a crash left behind: truncate its file back to the recorded size (only a
## store pack, and only when it is longer). Returns the files repaired. Run before the state loads.
func repair_bakes() -> PackedStringArray:
	var out := PackedStringArray()
	var l := list_dir(staging_dir())
	if not l["ok"]:
		return out
	for plan in l["dirs"]:
		var path := bake_journal_path(plan)
		if file_state(path) != 1:
			continue
		for e in _bake_entries(plan):
			if not (e is Dictionary):
				continue
			var file = e.get("file")
			var size = e.get("size")
			if not (file is String) or not PKeyClaims.is_number(size) or not is_store_pack(file):
				continue
			var g := FileAccess.open(file, FileAccess.READ)
			if g == null:
				continue
			var n := int(g.get_length())
			g.close()
			if n > int(size) and PKeyPck.truncate(file, int(size)):
				out.append(file)
		remove_tree(path)
	return out
