class_name PKeyChunkCache
extends RefCounted
## The Cloud Sync chunk cache (U-23.G4, plan D-9): a port of Python `cloud_sync/chunk_cache.py`.
##
## Holds chunk objects as stored (ciphertext in E2E mode, never plaintext), keyed by the 64-character
## lowercase hex chunk id, so a download fetches only the chunks the device lacks. Entries are named from
## the id alone, never from server text: `get`, `put` and `delete` refuse anything but such an id (they
## answer null / false, so a bad name never reaches the file system). A cache is best effort: the engine
## treats a miss as a fetch and opens every cached object again before use, so a damaged entry costs a
## fetch. The budget is `budget(largest_save)` = max(256 MiB, twice the largest save). The directory is kept
## out of OS backup (PKeyBackupExclusion) and purged with the person (`clear`).

const MIN_BYTES := 256 * 1024 * 1024
const DIR_NAME := "cloud-sync-chunks"
## The most one stored chunk is (D-5: 1 MiB plus 30).
const OBJECT_MAX_BYTES := 1048576 + 30
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER

static var _id_re: RegEx


static func _static_init() -> void:
	_id_re = RegEx.create_from_string("\\A[0-9a-f]{64}\\z")


static func budget(largest_save_bytes: int) -> int:
	return maxi(MIN_BYTES, 2 * maxi(0, largest_save_bytes))


static func is_id(id: Variant) -> bool:
	return id is String and _id_re.search(id) != null


## `<state_dir>/cloud-sync-chunks/<hash(subject)>/<hash(collection)>`: one person's chunks never serve
## another's and a collection name cannot climb out of the cache root.
static func dir_for(state_dir: String, subject: String, collection: String) -> String:
	return state_dir.path_join(DIR_NAME).path_join(subject.sha256_text()).path_join(collection.sha256_text())


## An in-memory LRU: tests, and a host with no durable store.
class Memory:
	extends RefCounted
	var _max: int
	var _map := {}  # id -> PackedByteArray, oldest first (insertion order)
	var _total := 0

	func _init(max_bytes := PKeyChunkCache.MIN_BYTES) -> void:
		_max = max_bytes

	func get_object(id: String) -> Variant:
		if not PKeyChunkCache.is_id(id) or not _map.has(id):
			return null
		var v: PackedByteArray = _map[id]
		_map.erase(id)
		_map[id] = v
		return v.duplicate()

	func put(id: String, obj: PackedByteArray) -> void:
		if not PKeyChunkCache.is_id(id):
			return
		delete(id)
		if obj.size() > _max:
			return
		_map[id] = obj.duplicate()
		_total += obj.size()
		while _total > _max and not _map.is_empty():
			var oldest: String = _map.keys()[0]
			_total -= (_map[oldest] as PackedByteArray).size()
			_map.erase(oldest)

	func delete(id: String) -> void:
		if PKeyChunkCache.is_id(id) and _map.has(id):
			_total -= (_map[id] as PackedByteArray).size()
			_map.erase(id)

	func clear() -> void:
		_map.clear()
		_total = 0


## The cache on disk: one file per object named by its chunk id, an LRU of at most `max_bytes`.
class Files:
	extends RefCounted
	var dir: String
	var _max: int
	var _index: Variant = null  # id -> size, oldest first; null until the directory is scanned
	var _total := 0

	func _init(directory: String, max_bytes := PKeyChunkCache.MIN_BYTES) -> void:
		dir = directory
		_max = max_bytes

	func _load() -> Dictionary:
		if _index != null:
			return _index
		var found := []
		var d := DirAccess.open(dir)
		if d != null:
			for name in d.get_files():
				var p := dir.path_join(name)
				if not PKeyChunkCache.is_id(name):
					# A temporary file a crash left behind, or anything else we did not write.
					if name.ends_with(".tmp") or name.contains(".tmp-"):
						DirAccess.remove_absolute(p)
					continue
				var f := FileAccess.open(p, FileAccess.READ)
				if f == null:
					continue
				var size := f.get_length()
				f.close()
				if size > PKeyChunkCache.OBJECT_MAX_BYTES:
					DirAccess.remove_absolute(p)
					continue
				found.append([FileAccess.get_modified_time(p), name, size])
		found.sort()
		_index = {}
		_total = 0
		for e in found:
			_index[e[1]] = e[2]
			_total += e[2]
		return _index

	func _drop(id: String) -> void:
		var idx := _load()
		if idx.has(id):
			_total -= idx[id]
			idx.erase(id)
		var p := dir.path_join(id)
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)

	func get_object(id: String) -> Variant:
		if not PKeyChunkCache.is_id(id):
			return null
		var idx := _load()
		if not idx.has(id):
			return null
		var f := FileAccess.open(dir.path_join(id), FileAccess.READ)
		if f == null:
			_drop(id)
			return null
		var data := f.get_buffer(PKeyChunkCache.OBJECT_MAX_BYTES + 1)
		f.close()
		if data.size() != idx[id]:
			_drop(id)
			return null
		var size: int = idx[id]
		idx.erase(id)
		idx[id] = size  # newest goes last
		return data

	func put(id: String, obj: PackedByteArray) -> void:
		if not PKeyChunkCache.is_id(id):
			return
		_load()
		_drop(id)
		if obj.size() > _max or obj.size() > PKeyChunkCache.OBJECT_MAX_BYTES or not _ensure_dir():
			return
		var p := dir.path_join(id)
		var tmp := p + ".tmp-" + Crypto.new().generate_random_bytes(6).hex_encode()
		var f := FileAccess.open(tmp, FileAccess.WRITE)
		if f == null:
			return
		f.store_buffer(obj)
		f.flush()
		var err := f.get_error()
		f.close()
		if err != OK:
			DirAccess.remove_absolute(tmp)
			return
		if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
			FileAccess.set_unix_permissions(tmp, PKeyChunkCache._OWNER_RW)
		var d := DirAccess.open(dir)
		if d == null or d.rename(tmp.get_file(), id) != OK:
			DirAccess.remove_absolute(tmp)
			return
		var idx := _load()
		idx[id] = obj.size()
		_total += obj.size()
		for oldest in idx.keys():
			if _total <= _max:
				break
			if oldest == id:
				continue
			DirAccess.remove_absolute(dir.path_join(oldest))
			_total -= idx[oldest]
			idx.erase(oldest)

	func delete(id: String) -> void:
		if PKeyChunkCache.is_id(id):
			_load()
			_drop(id)

	func clear() -> void:
		var d := DirAccess.open(dir)
		if d != null:
			for name in d.get_files():
				DirAccess.remove_absolute(dir.path_join(name))
		_index = {}
		_total = 0

	func _ensure_dir() -> bool:
		if not DirAccess.dir_exists_absolute(dir):
			var err := DirAccess.make_dir_recursive_absolute(dir)
			if err != OK and not DirAccess.dir_exists_absolute(dir):
				return false
			if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
				FileAccess.set_unix_permissions(dir, PKeyChunkCache._OWNER_RWX)
		PKeyBackupExclusion.exclude(dir)
		return true
