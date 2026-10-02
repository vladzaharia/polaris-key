class_name PKeySlots
extends RefCounted
## The update slot store (P3-10, notes/A4 §1.5): `staged`, `current` and `previous` under
## `user://pkey/<product>/updates/`, and one state file.
##
##   updates/state.json            {v, failedBoots, skipVersion, binaryVersion, confirmedVersion,
##                                  notice, journal, events}
##   updates/staged/payload.pck    a verified code pack waiting for a restart, + meta.json
##   updates/current/meta.json     the applied pack's meta; its bytes ARE `<exe-name>.pck`
##   updates/previous/payload.pck  the pack the last swap replaced (the shipped one after the first
##                                 swap), + meta.json — what a rollback restores
##
## A meta is {version, channel, buildNumber, build, recordHash, sha256, size, engine, scheme}
## (`shipped: true` for the pack the binary came with). `channel` is the PKeyUpdateCheck.channel
## the update was staged under (the canonical one), never the requested name.
##
## Every write is temp + rename, so a crash leaves the old file or the new one, never half of
## either. File hashing and copying run on a WorkerThreadPool task where the build has threads:
## a pack is bundle-sized, and its SHA-256 must never stall a frame. Under MSIX `user://` is
## virtualised to `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`: kept across package
## updates, deleted on uninstall (S-05 §4.4).

const STATE_VERSION := 1
const PAYLOAD := "payload.pck"
const META := "meta.json"
const MAX_EVENTS := 64
const HASH_CHUNK := 1024 * 1024
## Headroom space_ok() asks for beyond the bytes it will write.
const SPACE_MARGIN := 1024 * 1024

var root := ""


func _init(p_root: String) -> void:
	root = p_root


func dir(slot: String) -> String:
	return root.path_join(slot)


func payload(slot: String) -> String:
	return dir(slot).path_join(PAYLOAD)


# ── State ─────────────────────────────────────────────────────────────────────────────────────

static func empty_state() -> Dictionary:
	return {"v": STATE_VERSION, "failedBoots": 0, "skipVersion": null, "binaryVersion": null, "confirmedVersion": null, "notice": "", "journal": null, "events": []}


## The state file, or a fresh state when it is missing or unreadable (a damaged state file must
## never stop a boot; it only forgets the counters).
func load_state() -> Dictionary:
	var out := empty_state()
	var got = _read_json(root.path_join("state.json"))
	if not (got is Dictionary):
		return out
	for k in out:
		if got.has(k):
			out[k] = got[k]
	if not PKeyClaims.is_number(out["failedBoots"]):
		out["failedBoots"] = 0
	if not (out["events"] is Array):
		out["events"] = []
	if not (out["notice"] is String):
		out["notice"] = ""
	return out


func save_state(state: Dictionary) -> bool:
	return _write_json(root.path_join("state.json"), state)


## Queue one update event (P6-03's `updates` entry, PKeyUpdater.event()). `events` is the queue
## of events not yet reported on devices/report; the oldest go first past MAX_EVENTS.
static func add_event(state: Dictionary, entry: Dictionary) -> void:
	var events: Array = state["events"] if state.get("events") is Array else []
	events.append(entry)
	while events.size() > MAX_EVENTS:
		events.pop_front()
	state["events"] = events


# ── Slots ─────────────────────────────────────────────────────────────────────────────────────

## The slot's meta, or null when it is missing or incomplete (`staged` and `previous` also need
## their payload, at the meta's size).
func meta(slot: String) -> Variant:
	var m = _read_json(dir(slot).path_join(META))
	if not (m is Dictionary) or not (m.get("version") is String) or not (m.get("sha256") is String) or not PKeyClaims.is_number(m.get("size")):
		return null
	if slot != "current" and file_size(payload(slot)) != int(m["size"]):
		return null
	return m


func write_meta(slot: String, m: Dictionary) -> bool:
	DirAccess.make_dir_recursive_absolute(dir(slot))
	return _write_json(dir(slot).path_join(META), m)


func drop(slot: String) -> void:
	remove_tree(dir(slot))


## Move a complete slot directory over another (`staged.tmp` → `staged`): the target is removed
## first, so a crash leaves at worst the source, which the next write replaces.
func promote(from_slot: String, to_slot: String) -> bool:
	drop(to_slot)
	return DirAccess.rename_absolute(dir(from_slot), dir(to_slot)) == OK


# ── Files ─────────────────────────────────────────────────────────────────────────────────────

static func file_size(path: String) -> int:
	if not FileAccess.file_exists(path):
		return -1
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return -1
	var n := int(f.get_length())
	f.close()
	return n


## Size and SHA-256 (lowercase hex) of `path`: {ok, size, sha256}. Off the main thread where the
## build has threads. A coroutine.
static func file_digest(path: String) -> Dictionary:
	return await _off_thread(func() -> Dictionary: return _digest_sync(path, ""))


## Whether `path` has exactly `size` bytes and that SHA-256. A coroutine.
static func verify_file(path: String, size: int, sha256: String) -> bool:
	if file_size(path) != size:
		return false
	var d := await file_digest(path)
	return d["ok"] and d["size"] == size and d["sha256"] == sha256.to_lower()


## Copy `src` to `dst` (any volume), hashing as it goes: {ok, size, sha256}. A coroutine.
static func copy_file(src: String, dst: String) -> Dictionary:
	DirAccess.make_dir_recursive_absolute(dst.get_base_dir())
	return await _off_thread(func() -> Dictionary: return _digest_sync(src, dst))


## Read `src` (and, with `dst`, write it there), hashing what was READ. A failed write (a full
## disk, an I/O error: `store_buffer` false or the file's error set) fails the copy, but a copy's
## bytes on disk are still only known after verify_file() reads them back.
static func _digest_sync(src: String, dst: String) -> Dictionary:
	var fail := {"ok": false, "size": -1, "sha256": ""}
	var f := FileAccess.open(src, FileAccess.READ)
	if f == null:
		return fail
	var out: FileAccess = null
	if dst != "":
		out = FileAccess.open(dst, FileAccess.WRITE)
		if out == null:
			f.close()
			return fail
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	var total := 0
	var length := int(f.get_length())
	var wrote := true
	while total < length:
		var chunk := f.get_buffer(mini(HASH_CHUNK, length - total))
		if chunk.is_empty():
			break
		ctx.update(chunk)
		if out != null:
			if not out.store_buffer(chunk) or out.get_error() != OK:
				wrote = false
				break
		total += chunk.size()
	f.close()
	if out != null:
		out.flush()
		if out.get_error() != OK:
			wrote = false
		out.close()
	if total != length or not wrote:
		return fail
	return {"ok": true, "size": total, "sha256": ctx.finish().hex_encode()}


## Whether the volume holding `dir` has room for `need` bytes (plus 1 MiB). Unknown (no
## DirAccess, or a platform that answers 0) counts as room: the read-back verification after
## every copy is the real guard.
static func space_ok(dir: String, need: int) -> bool:
	DirAccess.make_dir_recursive_absolute(dir)
	var d := DirAccess.open(dir)
	if d == null:
		return true
	var left := int(d.get_space_left())
	return left <= 0 or left >= need + SPACE_MARGIN


## Run `job` (returning a Dictionary) on a WorkerThreadPool task and wait a frame at a time; inline
## on a build without threads.
static func _off_thread(job: Callable) -> Dictionary:
	if not OS.has_feature("threads"):
		return job.call()
	var box := []
	var id := WorkerThreadPool.add_task(func() -> void: box.append(job.call()))
	var tree := Engine.get_main_loop() as SceneTree
	while not WorkerThreadPool.is_task_completed(id):
		if tree == null:
			break
		await tree.process_frame
	WorkerThreadPool.wait_for_task_completion(id)
	return box[0] if not box.is_empty() and box[0] is Dictionary else {"ok": false, "size": -1, "sha256": ""}


static func remove_tree(path: String) -> void:
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
		return
	if not DirAccess.dir_exists_absolute(path):
		return
	var d := DirAccess.open(path)
	if d == null:
		return
	d.include_hidden = true
	for f in d.get_files():
		DirAccess.remove_absolute(path.path_join(f))
	for sub in d.get_directories():
		remove_tree(path.path_join(sub))
	DirAccess.remove_absolute(path)


static func _read_json(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var bytes := FileAccess.get_file_as_bytes(path)
	var parsed := PKeyJson.parse_bytes(bytes)
	return parsed["value"] if parsed["ok"] else null


static func _write_json(path: String, value: Variant) -> bool:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var tmp := path + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(PKeyJson.stringify(value))
	f.close()
	return DirAccess.rename_absolute(tmp, path) == OK
