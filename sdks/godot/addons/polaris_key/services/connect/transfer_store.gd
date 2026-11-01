class_name PKeyTransferStore
extends RefCounted
## The partial-file store for Direct Transfer (WIRE-CONTRACT-V5 section 15.11): it performs the
## machine's `partial` effects and decides nothing. A port of Python `transfer_store.py` after the
## CC-20 port fixes, with the owner holds of the Kotlin store.
##
## Layout, under one directory per product (`default_directory`):
##
##   <ref>        one file per kept partial, named by its 64-hex ref only (checked before any join).
##                A transfer's `name` never reaches a path.
##   index.json   per ref: the peer (SHA-256 of the peer key, never the key), the id, the hash, the
##                size, the chunk and the time of the last write. Written to a temporary name and
##                renamed over.
##
## The directory is kept out of OS backups (PKeyBackupExclusion) and is 0700 with 0600 files where
## the OS has modes. A root, an index or a partial that is a link is refused. GDScript has no O_EXCL
## and no O_NOFOLLOW: random temporary names and the link checks stand in (a residual: a same-user
## process can swap a path between a check and its use).
##
## Rules:
##   quota      `free_bytes()` = min(disk - reserve - promised, quota - held - promised). The default quota
##              is 4 GiB (a host option) with a 256 MiB disk reserve; a disk that cannot say how
##              much is free (`get_space_left()` of 0) leaves only the quota.
##   promises   `create` and `truncate` reserve `size - have`. A `write` past the promise is refused
##              and the session ends. A promise is released on keep, discard, delivery and owner
##              release.
##   owners     every effect names its owner (a session). A non-owner's create, truncate, write,
##              removal or delivery is refused; `rehash` reads and claims in one step. A takeover
##              needs the holder to have closed (`release_owner`), and a closed owner's late effects
##              are refused.
##   purges     `purge()` bumps the store epoch and `purge(peer_key)` that peer's. `create`,
##              `truncate` and `write` check the epoch the session recorded at its start, and
##              `truncate` never recreates a missing partial.
##   eviction   at most 8 partials per peer and 64 in all, evicting the oldest one nobody holds.
##              With none free the answer is "store is full".
##   sweep      partials older than 24 h go at load, at each `create`, on `partials` and when the
##              host calls `sweep()` (hourly).
##   delivery   a copy into a random temporary file beside the destination (which must exist; no
##              directories are made), flushed, then a rename. Without `overwrite` the destination
##              is checked (a file, a directory, a link, dangling included) at accept and again just
##              before the rename. The residual: a same-user process that creates the destination
##              between that check and the rename is replaced. The partial goes only after the
##              destination exists.
##   web        no partial is kept (resume off: `partials` is empty, `keep` removes), the quota
##              defaults to 64 MiB and the disk is not asked.
##
## Threads: every method locks one Mutex around the store's state and none holds it across file
## reading. `rehash` and `deliver` do big reads and copies; the caller runs them as a pump task
## with the claim held (inline on web). Failures are PKeyResult values with `store-failed` and a
## `detail.reason`.

const DEFAULT_QUOTA := 4 * 1024 * 1024 * 1024
const WEB_QUOTA := 64 * 1024 * 1024
const FREE_RESERVE := 256 * 1024 * 1024
const MAX_FILES := 64
const MAX_PER_PEER := 8
const SWEEP_EVERY := 3600.0
const INDEX := "index.json"
const _BLOCK := 1024 * 1024
const _OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
const _OWNER_RWX := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER
const _CLOSED_MEMORY := 256
const _UNBOUNDED := 9007199254740991

var _dir: String
var _clock: Callable
var _space: Callable
var _quota: int
var _web: bool
var _mutex := Mutex.new()
var _loaded := false
var _broken := ""
var _idx := {}
var _sizes := {}
var _open := {}
var _claims := {}
var _promised := {}
var _epoch := 0
var _peer_epoch := {}
var _closed_owners: Array = []
var _anon := RefCounted.new()
var _last_sweep := 0.0
var _dirty := false


## `directory`: the store's directory (see `default_directory`). `opts`: `quota` (bytes), `clock`
## (Callable() -> epoch seconds), `space` (Callable() -> free disk bytes, 0 or less when unknown;
## tests set it) and `web` (bool, default from the runtime).
func _init(directory: String, opts := {}) -> void:
	_dir = directory.simplify_path().trim_suffix("/") if directory != "user://" else directory
	_web = bool(opts.get("web", OS.has_feature("web")))
	_quota = int(opts.get("quota", WEB_QUOTA if _web else DEFAULT_QUOTA))
	_clock = opts.get("clock", Callable())
	_space = opts.get("space", Callable())


func _to_string() -> String:
	return "PKeyTransferStore()"


## `<store root>/<storage namespace>/transfers`, rooted as the other sensitive stores are.
static func default_directory(store_root: String, storage_namespace: String) -> String:
	return PKeyBackupExclusion.root(store_root).path_join(storage_namespace).path_join("transfers")


## The index's name for a peer: a hash, so the file holds no key.
static func peer_tag(peer_key: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update("pkey-xfer/1 peer".to_utf8_buffer())
	h.update(PackedByteArray([0]))
	h.update(peer_key)
	return h.finish().hex_encode()


## True for a name the store may join to its directory: 64 lower-case hex characters.
static func is_ref(s: String) -> bool:
	if s.length() != 64:
		return false
	for b in s.to_utf8_buffer():
		if not ((b >= 48 and b <= 57) or (b >= 97 and b <= 102)):
			return false
	return true


func directory() -> String:
	return _dir


# -- what the machine is told -------------------------------------------------------------------

## Changes whenever the store or this peer's partials are purged. A session records it when it
## starts and passes it back, so an effect queued before a purge cannot recreate what the purge
## removed.
func epoch(peer_key: PackedByteArray) -> int:
	_mutex.lock()
	var n := _epoch + int(_peer_epoch.get(peer_tag(peer_key), 0))
	_mutex.unlock()
	return n


## The kept partials of one peer key as the machine reads them (`writtenAt` in epoch seconds). A
## partial a live transfer holds, or whose ref is a key of `held`, has `held`. Empty on web.
func partials(peer_key: PackedByteArray, held := {}) -> Array:
	_mutex.lock()
	var out := _partials(peer_key, held)
	_mutex.unlock()
	return out


func _partials(peer_key: PackedByteArray, held: Dictionary) -> Array:
	var out: Array = []
	if _web or not _ensure().ok:
		return out
	_tick()
	var tag := peer_tag(peer_key)
	for ref in _idx:
		var e: Dictionary = _idx[ref]
		if e["peer"] != tag:
			continue
		var p := {
			"ref": ref, "id": e["id"], "sha256": e["sha256"], "size": e["size"], "chunk": e["chunk"],
			"bytes": int(_sizes.get(ref, 0)), "writtenAt": e["at"],
		}
		if _claims.has(ref) or held.has(ref):
			p["held"] = true
		out.append(p)
	return out


## A SHA-256 HashingContext fed with the first `offset` bytes of a kept partial, read again now,
## or null when the partial is gone, short, another session's or unreadable. The claim is taken
## before the read, in the same locked step as the checks, so no other session changes the file
## between this hash and the truncate that follows; a failed read releases a claim taken here.
func rehash(ref: String, offset: int, owner: Variant = null) -> HashingContext:
	var who := _who(owner)
	var path := ""
	var taken := false
	_mutex.lock()
	if is_ref(ref) and offset >= 0 and _ensure().ok and _idx.has(ref) and not _is_closed(who) \
			and _mine(ref, who) and int(_sizes.get(ref, 0)) >= offset:
		path = _dir.path_join(ref)
		if _is_link(path):
			path = ""
		else:
			_close(ref)
			if not _claims.has(ref):
				_claims[ref] = who
				taken = true
	_mutex.unlock()
	if path == "":
		return null
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var ok := true
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null or f.get_length() < offset:
		ok = false
	else:
		var left := offset
		while left > 0:
			var b := f.get_buffer(mini(_BLOCK, left))
			if b.is_empty():
				ok = false
				break
			h.update(b)
			left -= b.size()
	f = null
	if not ok:
		if taken:
			_mutex.lock()
			if _claims.get(ref) == who:
				_claims.erase(ref)
			_mutex.unlock()
		return null
	return h


## Bytes the store can take: the smaller of the disk's free space after the reserve and the quota
## after the bytes kept, both less what live transfers are promised and have not yet written.
func free_bytes() -> int:
	_mutex.lock()
	var n := 0
	if _ensure().ok:
		var p := _promised_bytes("")
		n = _quota - _held_bytes() - p
		var disk := _disk_free()
		if disk >= 0:
			n = mini(n, disk - FREE_RESERVE - p)
	_mutex.unlock()
	return maxi(0, n)


# -- effects ------------------------------------------------------------------------------------

## One effect of the machine on the partial files, or a write into one. `meta` carries what a
## `create` remembers: `id`, `sha256`, `size`, `chunk`. `owner` is the session the effect comes
## from; `p_epoch` is the value `epoch(peer_key)` gave when it started (-1: not checked). A
## refusal (a purge since, a partial another session holds, no room, a write past the promise)
## ends the one session that asked.
func apply(peer_key: PackedByteArray, effect: Dictionary, meta := {}, owner: Variant = null, p_epoch := -1) -> PKeyResult:
	_mutex.lock()
	var r := _apply(peer_key, effect, meta, _who(owner), p_epoch)
	_mutex.unlock()
	return r


func _apply(peer_key: PackedByteArray, effect: Dictionary, meta: Dictionary, who: Object, p_epoch: int) -> PKeyResult:
	var up := _ensure()
	if not up.ok:
		return up
	if _is_closed(who):
		return _refuse("closed", "The session has ended.")
	var stale := p_epoch >= 0 and p_epoch != _epoch + int(_peer_epoch.get(peer_tag(peer_key), 0))
	if effect.has("write"):
		return _write(String(effect["write"]), int(effect.get("offset", -1)), effect.get("data"), who, stale)
	if effect.has("create"):
		return _create(peer_key, String(effect["create"]), meta, who, stale)
	if effect.has("truncate"):
		return _truncate(String(effect["truncate"]), int(effect.get("to", -1)), who, stale)
	var done := _settle(effect, who)
	return done if done != null else _refuse("effect", "An effect the store does not perform.")


## keep, discard, evict and delete; null for any other effect. Another session's live partial is
## not this session's to change.
func _settle(effect: Dictionary, who: Object) -> PKeyResult:
	if effect.has("keep"):
		var ref := String(effect["keep"])
		if is_ref(ref) and _mine(ref, who):
			_close(ref)
			_release(ref, who)
			if _web:
				_remove(ref)
			_flush_index()
		return PKeyResult.success()
	for k in ["discard", "evict", "delete"]:
		if effect.has(k):
			var ref2 := String(effect[k])
			if is_ref(ref2) and _mine(ref2, who):
				_release(ref2, who)
				_remove(ref2)
				_flush_index()
			return PKeyResult.success()
	return null


func _store_at(ref: String, offset: int, data: PackedByteArray) -> bool:
	var f := _handle(ref)
	if f == null:
		return false
	f.seek(offset)
	f.store_buffer(data)
	return f.get_error() == OK


func _write(ref: String, offset: int, p_data: Variant, who: Object, stale: bool) -> PKeyResult:
	if not (p_data is PackedByteArray):
		return _refuse("invalid", "A bad write.")
	var data: PackedByteArray = p_data
	if stale:
		return _refuse("stale", "The store was purged.")
	if not is_ref(ref) or not _idx.has(ref) or _claims.get(ref) != who:
		return _refuse("gone", "The partial is gone or held by another session.")
	var end := offset + data.size()
	var pr: Variant = _promised.get(ref)
	if offset < 0 or end > int(_idx[ref]["size"]) or (pr != null and end > int(pr[0])):
		return _refuse("space", "A write past the promised size.")
	if not _store_at(ref, offset, data):
		return _refuse("io", "The partial cannot be written.")
	if pr != null:
		pr[1] = maxi(int(pr[1]), end)
	_sizes[ref] = maxi(int(_sizes.get(ref, 0)), end)
	_idx[ref]["at"] = _now()
	return PKeyResult.success()


func _create_refusal(ref: String, meta: Dictionary, who: Object) -> PKeyResult:
	if not is_ref(ref) or not _meta_ok(meta):
		return _refuse("invalid", "A bad partial.")
	if not _mine(ref, who):
		return _refuse("busy", "A live transfer holds this partial.")
	return null


func _create(peer_key: PackedByteArray, ref: String, meta: Dictionary, who: Object, stale: bool) -> PKeyResult:
	if stale:
		return _refuse("stale", "The store was purged.")
	var bad := _create_refusal(ref, meta, who)
	if bad != null:
		return bad
	_tick()
	var tag := peer_tag(peer_key)
	# The caps first, so an eviction frees room for the reservation.
	if not _make_room(tag, ref):
		return _refuse("full", "The store is full.")
	if not _reserve(ref, int(meta["size"]), 0):
		return _refuse("space", "Not enough room for the transfer.")
	_close(ref)
	if _idx.has(ref):
		_remove(ref)
	if not _new_file(ref):
		_promised.erase(ref)
		return _refuse("io", "The partial cannot be created.")
	_claims[ref] = who
	_sizes[ref] = 0
	_idx[ref] = {
		"peer": tag, "id": String(meta["id"]), "sha256": String(meta["sha256"]),
		"size": int(meta["size"]), "chunk": int(meta["chunk"]), "at": _now(),
	}
	_flush_index()
	return PKeyResult.success()


## An empty partial under its ref: a random temporary name, then a rename over the ref (which
## replaces a planted link rather than following it).
func _new_file(ref: String) -> bool:
	var tmp := _dir.path_join(".tmp-%s" % _random())
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return false
	f.close()
	_perm(tmp, false)
	if DirAccess.rename_absolute(tmp, _dir.path_join(ref)) != OK:
		DirAccess.remove_absolute(tmp)
		return false
	return true


func _truncate(ref: String, to: int, who: Object, stale: bool) -> PKeyResult:
	if stale:
		return _refuse("stale", "The store was purged.")
	if not is_ref(ref) or to < 0 or not _idx.has(ref) or not _mine(ref, who):
		return _refuse("gone", "The partial is gone or held by another session.")
	if int(_sizes.get(ref, 0)) < to:
		return _refuse("short", "The partial is shorter than its record.")
	if not _reserve(ref, int(_idx[ref]["size"]), to):
		return _refuse("space", "Not enough room for the transfer.")
	_claims[ref] = who
	var f := _handle(ref)
	if f == null or f.get_length() < to or f.resize(to) != OK:
		_release(ref, who)
		return _refuse("io", "The partial cannot be truncated.")
	_sizes[ref] = to
	_idx[ref]["at"] = _now()
	return PKeyResult.success()


## Moves a complete partial to `dest`, the host's choice: a temporary file in the destination's
## directory (which must exist), then a rename. `ref` "" delivers an empty file (a transfer of zero
## bytes keeps no partial). Without `overwrite`, anything at `dest` (a file, a directory, a link,
## dangling included) refuses, here and again just before the rename. The partial is removed only
## after the destination exists. Reads the whole partial: run it off the main thread.
func deliver(ref: String, dest: String, overwrite := false, owner: Variant = null) -> PKeyResult:
	var who := _who(owner)
	var base := dest.get_base_dir()
	var epoch0 := 0
	var want := 0
	_mutex.lock()
	var up := _ensure()
	var refusal: PKeyResult = null
	if not up.ok:
		refusal = up
	elif _is_closed(who):
		refusal = _refuse("closed", "The session has ended.")
	elif ref != "" and (not is_ref(ref) or not _idx.has(ref) or _claims.get(ref) != who):
		refusal = _refuse("gone", "The partial is gone or held by another session.")
	elif not _dest_usable(dest, overwrite):
		refusal = _refuse("exists" if _occupied(dest) else "destination", "The destination cannot be used.")
	else:
		if ref != "":
			_close(ref)
			want = int(_idx[ref]["size"])
		epoch0 = _epoch + _total_peer_epoch()
	_mutex.unlock()
	if refusal != null:
		return refusal
	var tmp := base.path_join(".pkey-xfer-%s" % _random())
	var made := _copy_out(ref, tmp, want)
	if not made.ok:
		return made
	_mutex.lock()
	var r := _finish_delivery(ref, tmp, dest, overwrite, who, epoch0)
	_mutex.unlock()
	if not r.ok:
		DirAccess.remove_absolute(tmp)
	return r


func _finish_delivery(ref: String, tmp: String, dest: String, overwrite: bool, who: Object, epoch0: int) -> PKeyResult:
	if ref != "" and (not _idx.has(ref) or _claims.get(ref) != who):
		return _refuse("gone", "The partial is gone or held by another session.")
	if epoch0 != _epoch + _total_peer_epoch():
		return _refuse("stale", "The store was purged.")
	# The check just before the rename (the Q3 residual sits between this line and the rename).
	if not _dest_usable(dest, overwrite):
		return _refuse("exists" if _occupied(dest) else "destination", "The destination cannot be used.")
	if DirAccess.rename_absolute(tmp, dest) != OK:
		return _refuse("io", "The file cannot be delivered.")
	if ref != "":
		_claims.erase(ref)
		_promised.erase(ref)
		_remove(ref)
		_flush_index()
	return PKeyResult.success()


## Copies the partial (or nothing) into `tmp`, 0600, and flushes it. Checks the length.
func _copy_out(ref: String, tmp: String, want: int) -> PKeyResult:
	var src: FileAccess = null
	if ref != "":
		var path := _dir.path_join(ref)
		if _is_link(path):
			return _refuse("io", "The partial is a link.")
		src = FileAccess.open(path, FileAccess.READ)
		if src == null or src.get_length() != want:
			return _refuse("short", "The partial does not match its record.")
	var dst := FileAccess.open(tmp, FileAccess.WRITE)
	if dst == null:
		return _refuse("destination", "The destination cannot be written.")
	_perm(tmp, false)
	var ok := true
	if src != null:
		while src.get_position() < src.get_length():
			dst.store_buffer(src.get_buffer(_BLOCK))
			if dst.get_error() != OK:
				ok = false
				break
	dst.flush()
	ok = ok and dst.get_error() == OK
	dst.close()
	if not ok:
		DirAccess.remove_absolute(tmp)
		return _refuse("io", "The file cannot be written.")
	return PKeyResult.success()


## True when `dest` could take a delivery now: its directory exists and is not the store's, it
## names a file, and (without `overwrite`) nothing is there; a directory is never replaced.
func destination_ok(dest: String, overwrite := false) -> bool:
	return _dest_usable(dest, overwrite)


func _dest_usable(dest: String, overwrite: bool) -> bool:
	if dest.get_file() == "" or dest.begins_with("res://") or not (dest.is_absolute_path() or dest.begins_with("user://")):
		return false
	var base := dest.get_base_dir()
	if not DirAccess.dir_exists_absolute(base) or _inside_store(base):
		return false
	if DirAccess.dir_exists_absolute(dest) and not _is_link(dest):
		return false
	return overwrite or not _occupied(dest)


func _occupied(dest: String) -> bool:
	return FileAccess.file_exists(dest) or DirAccess.dir_exists_absolute(dest) or _is_link(dest)


func _inside_store(base: String) -> bool:
	var a := ProjectSettings.globalize_path(base).simplify_path().trim_suffix("/")
	var s := ProjectSettings.globalize_path(_dir).simplify_path().trim_suffix("/")
	return a == s or a.begins_with(s + "/")


# -- upkeep -------------------------------------------------------------------------------------

## Deletes the partials of one peer key, or all of them (sign-out, deactivation) when `peer_key`
## is empty. Late effects from before it are refused. Fails when a file could not be deleted.
func purge(peer_key := PackedByteArray()) -> PKeyResult:
	_mutex.lock()
	var r := _purge(peer_key)
	_mutex.unlock()
	return r


func _purge(peer_key: PackedByteArray) -> PKeyResult:
	var all := peer_key.is_empty()
	var tag := "" if all else peer_tag(peer_key)
	if all:
		_epoch += 1
	else:
		_peer_epoch[tag] = int(_peer_epoch.get(tag, 0)) + 1
	if not _loaded and not DirAccess.dir_exists_absolute(_dir):
		return PKeyResult.success()
	var up := _ensure()
	if not up.ok:
		return up
	for ref in _idx.keys():
		if all or _idx[ref]["peer"] == tag:
			_claims.erase(ref)
			_promised.erase(ref)
			_remove(ref)
	var stuck := false
	if all:
		for n in _files():
			if is_ref(n) or n.begins_with(".tmp-") or n.begins_with(".index-"):
				if DirAccess.remove_absolute(_dir.path_join(n)) != OK:
					stuck = true
	_flush_index()
	if stuck:
		return _refuse("io", "A kept partial could not be deleted.")
	return PKeyResult.success()


## A session ended: it holds nothing and is owed nothing, and its late effects are refused.
func release_owner(owner: Variant) -> void:
	var who := _who(owner)
	_mutex.lock()
	for ref in _claims.keys():
		if _claims[ref] == who:
			_release(ref, who)
			_close(ref)
	if who != _anon:
		_closed_owners.append(who.get_instance_id())
		while _closed_owners.size() > _CLOSED_MEMORY:
			_closed_owners.pop_front()
	_mutex.unlock()


## Removes partials older than 24 h that no session holds. Cheap; the host may call it hourly.
func sweep() -> void:
	_mutex.lock()
	if _ensure().ok:
		_sweep()
	_mutex.unlock()


## Closes the open files and writes the index.
func close() -> void:
	_mutex.lock()
	for ref in _open.keys():
		_close(ref)
	if _loaded and _dirty:
		_flush_index()
	_mutex.unlock()


# -- internals (the mutex is held) ---------------------------------------------------------------

func _refuse(reason: String, message: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.STORE_FAILED, message, {"reason": reason})


func _now() -> float:
	return float(_clock.call()) if _clock.is_valid() else Time.get_unix_time_from_system()


func _who(owner: Variant) -> Object:
	return owner if owner is Object else _anon


func _is_closed(who: Object) -> bool:
	return who != _anon and _closed_owners.has(who.get_instance_id())


func _total_peer_epoch() -> int:
	var n := 0
	for k in _peer_epoch:
		n += int(_peer_epoch[k])
	return n


func _mine(ref: String, who: Object) -> bool:
	return not _claims.has(ref) or _claims[ref] == who


func _release(ref: String, who: Object) -> void:
	if _claims.get(ref) == who:
		_claims.erase(ref)
	_promised.erase(ref)


func _meta_ok(m: Dictionary) -> bool:
	var size: Variant = m.get("size")
	var chunk: Variant = m.get("chunk")
	return m.get("id") is String and m.get("sha256") is String and typeof(size) == TYPE_INT \
			and typeof(chunk) == TYPE_INT and size >= 0 and chunk > 0 and size <= PKeyPeerXfer.MAX_SIZE


func _promised_bytes(skip: String) -> int:
	var n := 0
	for r in _promised:
		if r != skip:
			n += maxi(0, int(_promised[r][0]) - int(_promised[r][1]))
	return n


func _held_bytes() -> int:
	var n := 0
	for r in _sizes:
		n += int(_sizes[r])
	return n


## Free bytes of the disk, or -1 when not asked (web) or unknown.
func _disk_free() -> int:
	if _space.is_valid():
		var n := int(_space.call())
		return n if n > 0 else -1
	if _web:
		return -1
	var d := DirAccess.open(_dir)
	if d == null:
		return -1
	var n2 := int(d.get_space_left())
	return n2 if n2 > 0 else -1


## Promises `size - have` more bytes to `ref`, or refuses when the rest would not fit.
func _reserve(ref: String, size: int, have: int) -> bool:
	var need := maxi(0, size - have)
	var p := _promised_bytes(ref)
	var own := int(_sizes.get(ref, 0)) if _idx.has(ref) else 0
	var room := _quota - (_held_bytes() - own) - p - have
	var disk := _disk_free()
	if disk >= 0:
		room = mini(room, disk - FREE_RESERVE - p)
	if need > room:
		return false
	_promised[ref] = [size, have]
	return true


## Keeps the per-peer and the overall file caps for a new `ref`: evicts the oldest partial nobody
## holds (the peer's own for the per-peer cap, then the overall oldest). False when none can go.
func _make_room(tag: String, ref: String) -> bool:
	while true:
		var mine_n := 0
		var all_n := 0
		for r in _idx:
			if r == ref:
				continue
			all_n += 1
			if _idx[r]["peer"] == tag:
				mine_n += 1
		var own_cap := mine_n >= MAX_PER_PEER
		if not own_cap and all_n < MAX_FILES:
			return true
		var victim := ""
		for r in _idx:
			if r == ref or _claims.has(r) or (own_cap and _idx[r]["peer"] != tag):
				continue
			if victim == "" or float(_idx[r]["at"]) < float(_idx[victim]["at"]):
				victim = r
		if victim == "":
			return false
		_remove(victim)
	return false


func _tick() -> void:
	var now := _now()
	if now - _last_sweep >= SWEEP_EVERY:
		_sweep()


func _sweep() -> void:
	var now := _now()
	_last_sweep = now
	var gone: Array = []
	for r in _idx:
		if now - float(_idx[r]["at"]) > PKeyPeerXfer.PARTIAL_SECONDS and not _claims.has(r):
			gone.append(r)
	for r in gone:
		_remove(r, false)
	if not gone.is_empty():
		_flush_index()


func _handle(ref: String) -> FileAccess:
	var f: FileAccess = _open.get(ref)
	if f != null:
		return f
	var path := _dir.path_join(ref)
	if _is_link(path):
		return null
	f = FileAccess.open(path, FileAccess.READ_WRITE)
	if f != null:
		_open[ref] = f
	return f


func _close(ref: String) -> void:
	var f: FileAccess = _open.get(ref)
	if f != null:
		f.flush()
		_open.erase(ref)


func _remove(ref: String, flush := false) -> void:
	_close(ref)
	if is_ref(ref):
		DirAccess.remove_absolute(_dir.path_join(ref))
	_sizes.erase(ref)
	if _idx.erase(ref):
		_dirty = true
		if flush:
			_flush_index()


func _random() -> String:
	return Crypto.new().generate_random_bytes(8).hex_encode()


## The files directly in the directory, hidden ones too (the temporary names start with a dot).
func _files() -> PackedStringArray:
	var d := DirAccess.open(_dir)
	if d == null:
		return PackedStringArray()
	d.include_hidden = true
	return d.get_files()


static func _is_link(path: String) -> bool:
	var parent := DirAccess.open(path.get_base_dir())
	return parent != null and parent.is_link(path.get_file())


static func _perm(path: String, is_dir: bool) -> void:
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		FileAccess.set_unix_permissions(path, _OWNER_RWX if is_dir else _OWNER_RW)


## Makes the directory and reads the index, once. A refusal (the root is a link, the directory
## cannot be made) is kept and answered on every call.
func _ensure() -> PKeyResult:
	if _loaded:
		return PKeyResult.success()
	if _broken != "":
		return _refuse("root", _broken)
	if _dir == "" or _dir.contains("..") or not (_dir.is_absolute_path() or _dir.begins_with("user://")):
		_broken = "The transfer directory is not usable."
		return _refuse("root", _broken)
	var err := DirAccess.make_dir_recursive_absolute(_dir)
	if (err != OK and not DirAccess.dir_exists_absolute(_dir)) or _is_link(_dir):
		_broken = "The transfer directory is not usable."
		return _refuse("root", _broken)
	_perm(_dir, true)
	PKeyBackupExclusion.exclude(_dir)
	_load_index()
	_loaded = true
	_sweep()
	return PKeyResult.success()


func _load_index() -> void:
	_idx = {}
	_sizes = {}
	var path := _dir.path_join(INDEX)
	if not _web and FileAccess.file_exists(path) and not _is_link(path):
		var j := JSON.new()
		if j.parse(FileAccess.get_file_as_string(path)) == OK and j.data is Dictionary \
				and (j.data as Dictionary).get("entries") is Dictionary:
			var ents: Dictionary = (j.data as Dictionary)["entries"]
			for ref in ents:
				var e := _entry(ents[ref])
				if is_ref(String(ref)) and not e.is_empty():
					_idx[String(ref)] = e
	# Keep only entries whose file is there, not a link and not longer than its record.
	for ref in _idx.keys():
		var p := _dir.path_join(ref)
		var f: FileAccess = null if _is_link(p) else FileAccess.open(p, FileAccess.READ)
		if f == null or f.get_length() > int(_idx[ref]["size"]):
			_idx.erase(ref)
			DirAccess.remove_absolute(p)
		else:
			_sizes[ref] = f.get_length()
	# A file no record holds, and a leftover temporary name, go.
	for n in _files():
		if (is_ref(n) and not _idx.has(n)) or n.begins_with(".tmp-") or n.begins_with(".index-"):
			DirAccess.remove_absolute(_dir.path_join(n))
	_dirty = false


static func _entry(v: Variant) -> Dictionary:
	if not (v is Dictionary):
		return {}
	var d: Dictionary = v
	for k in ["peer", "id", "sha256"]:
		if not (d.get(k) is String):
			return {}
	for k in ["size", "chunk"]:
		if typeof(d.get(k)) not in [TYPE_INT, TYPE_FLOAT] or float(d[k]) != floorf(float(d[k])) or float(d[k]) < 0.0:
			return {}
	if typeof(d.get("at")) not in [TYPE_INT, TYPE_FLOAT] or int(d["size"]) > PKeyPeerXfer.MAX_SIZE:
		return {}
	return {
		"peer": d["peer"], "id": d["id"], "sha256": d["sha256"],
		"size": int(d["size"]), "chunk": int(d["chunk"]), "at": float(d["at"]),
	}


func _flush_index() -> bool:
	if _web or not _loaded:
		return true
	var tmp := _dir.path_join(".index-%s" % _random())
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return false
	_perm(tmp, false)
	f.store_string(JSON.stringify({"v": 1, "entries": _idx}))
	f.flush()
	var ok := f.get_error() == OK
	f.close()
	if not ok or DirAccess.rename_absolute(tmp, _dir.path_join(INDEX)) != OK:
		DirAccess.remove_absolute(tmp)
		return false
	_dirty = false
	return true
