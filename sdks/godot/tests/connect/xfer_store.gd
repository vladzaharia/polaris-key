extends RefCounted
# @pkey-feature connect.transfer
# `PKeyTransferStore` (Direct Transfer, WIRE-CONTRACT-V5 section 15.11): the partial files the xfer
# machine's effects perform. Layout and modes, names, the index, quota and reservations, owner
# holds and takeover, purge epochs, eviction caps, the sweep, and delivery (a new file, an existing
# file, a directory, a link, a dangling link, overwrite, an empty transfer, a missing directory)
# plus the web rules. Modelled on the Python and Kotlin store tests.

const ID := "D9FghtxWIhxlaxzwysyg4w"
const MIB := 1048576

var _root := ""
var _now := 1000000.0
var _n := 0


class Owner extends RefCounted:
	var name := "session"


func run(t: PKeyTestContext) -> void:
	_root = "user://xfer-store-test-%s" % Crypto.new().generate_random_bytes(5).hex_encode()
	DirAccess.make_dir_recursive_absolute(_root)
	_names(t)
	_layout(t)
	_effects_and_index(t)
	_rehash(t)
	_quota(t)
	_owners(t)
	_purges(t)
	_eviction(t)
	_sweep(t)
	_delivery(t)
	_links(t)
	_web(t)
	_rm_tree(_root)


func _store(opts := {}) -> PKeyTransferStore:
	_n += 1
	var o := {"clock": Callable(self, "_clock"), "space": func() -> int: return 1 << 40}
	for k in opts:
		o[k] = opts[k]
	return PKeyTransferStore.new(_root.path_join("s%d" % _n), o)


func _clock() -> float:
	return _now


func _key(b: int) -> PackedByteArray:
	var k := PackedByteArray()
	k.resize(32)
	k.fill(b)
	return k


func _ref(n: int) -> String:
	return ("%064x" % n)


func _meta(size: int, chunk := 1024) -> Dictionary:
	return {"id": ID, "sha256": "ab".repeat(32), "size": size, "chunk": chunk}


func _bytes(n: int, seed_byte := 7) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	for i in n:
		b[i] = (seed_byte * i + 13) % 256
	return b


func _create(s: PKeyTransferStore, key: PackedByteArray, ref: String, size: int, owner: Variant) -> PKeyResult:
	return s.apply(key, {"create": ref}, _meta(size), owner)


func _put(s: PKeyTransferStore, key: PackedByteArray, ref: String, data: PackedByteArray, owner: Variant) -> PKeyResult:
	var r := _create(s, key, ref, data.size(), owner)
	if not r.ok:
		return r
	return s.apply(key, {"write": ref, "offset": 0, "data": data}, {}, owner)


func _reason(r: PKeyResult) -> String:
	return String((r.detail as Dictionary).get("reason", "")) if r.detail is Dictionary else ""


func _read(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path)


func _rm_tree(path: String) -> void:
	for f in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(f))
	for d in DirAccess.get_directories_at(path):
		_rm_tree(path.path_join(d))
	DirAccess.remove_absolute(path)


func _symlink(target: String, link: String) -> bool:
	if OS.has_feature("windows"):
		return false
	var out := []
	return OS.execute("ln", ["-s", ProjectSettings.globalize_path(target), ProjectSettings.globalize_path(link)], out) == 0


func _names(t: PKeyTestContext) -> void:
	t.check("a 64-hex ref is a ref", PKeyTransferStore.is_ref(_ref(1)))
	for bad in ["", "../x", "A".repeat(64), "a".repeat(63), "a".repeat(65), "-" + "a".repeat(63), "name.txt", "a".repeat(63) + "/"]:
		t.check("not a ref: %s" % bad.left(12), not PKeyTransferStore.is_ref(bad))
	var s := _store()
	var key := _key(1)
	var r := s.apply(key, {"create": "../escape"}, _meta(1), Owner.new())
	t.check("a bad ref is refused", not r.ok and _reason(r) == "invalid")
	r = s.apply(key, {"create": _ref(1)}, {"id": ID}, Owner.new())
	t.check("a bad meta is refused", not r.ok and _reason(r) == "invalid")
	t.check("the peer tag is a hash of the key", PKeyTransferStore.peer_tag(key).length() == 64 \
			and PKeyTransferStore.peer_tag(key) != key.hex_encode() and PKeyTransferStore.peer_tag(key) != PKeyTransferStore.peer_tag(_key(2)))
	t.check("the default directory ends in transfers", PKeyTransferStore.default_directory("user://pkey", "demo").ends_with("/transfers"))


func _layout(t: PKeyTestContext) -> void:
	var s := _store()
	var o := Owner.new()
	var r := _put(s, _key(1), _ref(1), _bytes(10), o)
	t.check("the first create makes the directory", r.ok and DirAccess.dir_exists_absolute(s.directory()))
	t.check("the partial file is named by its ref only", FileAccess.file_exists(s.directory().path_join(_ref(1))))
	s.close()
	t.check("the file has the bytes written", _read(s.directory().path_join(_ref(1))) == _bytes(10))
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		var d := FileAccess.get_unix_permissions(s.directory())
		var f := FileAccess.get_unix_permissions(s.directory().path_join(_ref(1)))
		t.check("the directory is 0700 and the file 0600", (d & 0x1FF) == 0x1C0 and (f & 0x1FF) == 0x180, "%o %o" % [d & 0x1FF, f & 0x1FF])
	var bad := PKeyTransferStore.new("relative/dir")
	t.check("a relative directory is refused", not bad.apply(_key(1), {"create": _ref(1)}, _meta(1)).ok)
	t.check("'finalize' goes through deliver", _reason(s.apply(_key(1), {"finalize": _ref(1)}, {}, o)) == "effect")


func _effects_and_index(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var o := Owner.new()
	var data := _bytes(3000)
	var r := _create(s, key, _ref(1), 3000, o)
	t.check("create ok", r.ok)
	t.check("create writes an empty file", s.partials(key)[0]["bytes"] == 0)
	t.check("write 1", s.apply(key, {"write": _ref(1), "offset": 0, "data": data.slice(0, 1024)}, {}, o).ok)
	t.check("write 2", s.apply(key, {"write": _ref(1), "offset": 1024, "data": data.slice(1024, 2048)}, {}, o).ok)
	var p: Array = s.partials(key)
	t.check("a live partial is listed as held", p.size() == 1 and p[0]["held"] == true and p[0]["bytes"] == 2048 \
			and p[0]["id"] == ID and p[0]["size"] == 3000 and p[0]["chunk"] == 1024 and p[0]["writtenAt"] == _now)
	t.check("another peer sees none", s.partials(_key(2)).is_empty())
	t.check("keep releases the hold", s.apply(key, {"keep": _ref(1)}, {}, o).ok and not s.partials(key)[0].has("held"))
	t.check("the caller's held set marks a partial", s.partials(key, {_ref(1): true})[0]["held"] == true)
	# The index holds a hash of the peer, never the key, and a fresh store reads it back.
	var idx := FileAccess.get_file_as_string(s.directory().path_join("index.json"))
	t.check("the index has no key", not idx.contains(key.hex_encode()) and idx.contains(PKeyTransferStore.peer_tag(key)))
	s.close()
	var s2 := PKeyTransferStore.new(s.directory(), {"clock": Callable(self, "_clock"), "space": func() -> int: return 1 << 40})
	var p2: Array = s2.partials(key)
	t.check("a fresh store reads the kept partial", p2.size() == 1 and p2[0]["ref"] == _ref(1) and p2[0]["bytes"] == 2048 \
			and not p2[0].has("held"))
	# Truncate, append, finish.
	var o2 := Owner.new()
	t.check("truncate to a chunk boundary", s2.apply(key, {"truncate": _ref(1), "to": 1024}, {}, o2).ok)
	t.check("the file is that long", _read(s2.directory().path_join(_ref(1))).size() == 1024 and s2.partials(key)[0]["bytes"] == 1024)
	t.check("a write that follows", s2.apply(key, {"write": _ref(1), "offset": 1024, "data": data.slice(1024)}, {}, o2).ok)
	t.check("a truncate past the end is refused", _reason(s2.apply(key, {"truncate": _ref(1), "to": 99999}, {}, o2)) == "short")
	# A file no record holds goes at load; a file with a bad record goes.
	var stray := s2.directory().path_join(_ref(9))
	var f := FileAccess.open(stray, FileAccess.WRITE)
	f.store_string("x")
	f.close()
	var f2 := FileAccess.open(s2.directory().path_join(".tmp-aa"), FileAccess.WRITE)
	f2.close()
	s2.close()
	var s3 := PKeyTransferStore.new(s2.directory(), {"clock": Callable(self, "_clock")})
	s3.partials(key)
	t.check("an unrecorded file and a leftover temporary name are removed at load", \
			not FileAccess.file_exists(stray) and not FileAccess.file_exists(s2.directory().path_join(".tmp-aa")))
	# A corrupt index is read as empty and its files go.
	s3.close()
	var bad := FileAccess.open(s3.directory().path_join("index.json"), FileAccess.WRITE)
	bad.store_string("{not json")
	bad.close()
	var s4 := PKeyTransferStore.new(s3.directory(), {"clock": Callable(self, "_clock")})
	t.check("a corrupt index reads as empty", s4.partials(key).is_empty() and not FileAccess.file_exists(s3.directory().path_join(_ref(1))))
	# discard and delete remove.
	var o3 := Owner.new()
	_create(s4, key, _ref(2), 5, o3)
	t.check("discard removes the file", s4.apply(key, {"discard": _ref(2)}, {}, o3).ok and not FileAccess.file_exists(s4.directory().path_join(_ref(2))) \
			and s4.partials(key).is_empty())
	# truncate never recreates.
	t.check("truncate of a missing partial refuses", _reason(s4.apply(key, {"truncate": _ref(2), "to": 0}, {}, o3)) == "gone")
	t.check("write to a missing partial refuses", _reason(s4.apply(key, {"write": _ref(2), "offset": 0, "data": _bytes(1)}, {}, o3)) == "gone")
	t.check("the file was not recreated", not FileAccess.file_exists(s4.directory().path_join(_ref(2))))


func _rehash(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var o := Owner.new()
	var data := _bytes(4096)
	_put(s, key, _ref(1), data, o)
	s.apply(key, {"keep": _ref(1)}, {}, o)
	var o2 := Owner.new()
	var h := s.rehash(_ref(1), 2048, o2)
	t.check("rehash returns a started hasher", h != null)
	if h != null:
		h.update(data.slice(2048))
		var ctx := HashingContext.new()
		ctx.start(HashingContext.HASH_SHA256)
		ctx.update(data)
		t.check("the hasher continues to the whole file's hash", h.finish() == ctx.finish())
	t.check("rehash claimed the partial", s.partials(key)[0].get("held") == true)
	t.check("a second owner cannot rehash it", s.rehash(_ref(1), 1024, Owner.new()) == null)
	t.check("a second owner cannot truncate it", _reason(s.apply(key, {"truncate": _ref(1), "to": 1024}, {}, Owner.new())) == "gone")
	t.check("the claimant can truncate", s.apply(key, {"truncate": _ref(1), "to": 2048}, {}, o2).ok)
	var s2 := _store()
	_put(s2, key, _ref(2), data, o)
	s2.apply(key, {"keep": _ref(2)}, {}, o)
	t.check("a short partial gives no hasher", s2.rehash(_ref(2), 4097, Owner.new()) == null)
	t.check("a missing partial gives no hasher", s2.rehash(_ref(3), 1, Owner.new()) == null)
	t.check("a bad ref gives no hasher", s2.rehash("../x", 1, Owner.new()) == null)
	t.check("a negative offset gives no hasher", s2.rehash(_ref(2), -1, Owner.new()) == null)
	t.check("a failed rehash leaves no claim", not s2.partials(key)[0].has("held"))
	# A file that shrank behind the store's back.
	var f := FileAccess.open(s2.directory().path_join(_ref(2)), FileAccess.READ_WRITE)
	f.resize(1000)
	f.close()
	t.check("a file shorter than its record gives no hasher and no claim", s2.rehash(_ref(2), 2048, Owner.new()) == null \
			and not s2.partials(key)[0].has("held"))


func _quota(t: PKeyTestContext) -> void:
	var o := Owner.new()
	var key := _key(1)
	var s := _store({"quota": 10 * 1024})
	t.check("free is the quota when the disk is large", s.free_bytes() == 10 * 1024)
	t.check("a create within the quota reserves it", _create(s, key, _ref(1), 6000, o).ok)
	t.check("the promise comes off free", s.free_bytes() == 10 * 1024 - 6000)
	t.check("a create past the room is refused", _reason(_create(s, key, _ref(2), 5000, Owner.new())) == "space")
	t.check("a refused create leaves no file", not FileAccess.file_exists(s.directory().path_join(_ref(2))) and s.partials(key).size() == 1)
	t.check("a create that fits is taken", _create(s, key, _ref(3), 4240, Owner.new()).ok)
	t.check("nothing is left", s.free_bytes() == 0)
	t.check("a write past the declared size is refused", _reason(s.apply(key, {"write": _ref(1), "offset": 5000, "data": _bytes(2000)}, {}, o)) == "space")
	t.check("a negative offset is refused", not s.apply(key, {"write": _ref(1), "offset": -1, "data": _bytes(1)}, {}, o).ok)
	t.check("a write within the promise is taken", s.apply(key, {"write": _ref(1), "offset": 0, "data": _bytes(6000)}, {}, o).ok)
	t.check("written bytes move from promised to held", s.free_bytes() == 0)
	s.apply(key, {"discard": _ref(1)}, {}, o)
	t.check("discard releases the room", s.free_bytes() == 6000)
	# The disk reserve.
	var disk := [_reserve_plus(MIB)]
	var s2 := _store({"space": func() -> int: return disk[0]})
	t.check("free is disk less the reserve", s2.free_bytes() == MIB)
	t.check("a create past the disk room is refused", _reason(_create(s2, key, _ref(1), MIB + 1, Owner.new())) == "space")
	t.check("a create within it is taken", _create(s2, key, _ref(1), MIB, Owner.new()).ok)
	disk[0] = 100
	t.check("a disk below the reserve has no room", s2.free_bytes() == 0)
	# An unknown disk leaves the quota.
	var s3 := _store({"space": func() -> int: return 0, "quota": 2048})
	t.check("an unknown disk leaves the quota", s3.free_bytes() == 2048)
	var s3b := _store({"space": func() -> int: return 0})
	t.check("an unknown disk and no host quota lowers the default", s3b.free_bytes() == PKeyTransferStore.UNKNOWN_DISK_QUOTA)
	t.check("a known disk keeps the default quota", _store().free_bytes() == PKeyTransferStore.DEFAULT_QUOTA)
	# Truncate re-reserves the rest.
	var s4 := _store({"quota": 8192})
	var o4 := Owner.new()
	_put(s4, key, _ref(1), _bytes(6000), o4)
	s4.apply(key, {"keep": _ref(1)}, {}, o4)
	var o5 := Owner.new()
	t.check("a resume reserves the rest of the size", s4.apply(key, {"truncate": _ref(1), "to": 2048}, {}, o5).ok and s4.free_bytes() == 8192 - 2048 - (6000 - 2048))
	t.check("a second transfer past the rest is refused", _reason(_create(s4, key, _ref(2), 3000, Owner.new())) == "space")


func _reserve_plus(n: int) -> int:
	return PKeyTransferStore.FREE_RESERVE + n


func _owners(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var a := Owner.new()
	var b := Owner.new()
	_put(s, key, _ref(1), _bytes(2048), a)
	t.check("a non-owner cannot create over a held partial", _reason(_create(s, key, _ref(1), 2048, b)) == "busy")
	t.check("a non-owner cannot write", _reason(s.apply(key, {"write": _ref(1), "offset": 0, "data": _bytes(1)}, {}, b)) == "gone")
	s.apply(key, {"discard": _ref(1)}, {}, b)
	t.check("a non-owner's discard is ignored", s.partials(key).size() == 1)
	s.apply(key, {"evict": _ref(1)}, {}, b)
	s.apply(key, {"delete": _ref(1)}, {}, b)
	s.apply(key, {"keep": _ref(1)}, {}, b)
	t.check("a non-owner's evict, delete and keep are ignored", s.partials(key).size() == 1 and s.partials(key)[0].get("held") == true)
	var dest := _root.path_join("owners-out")
	t.check("a non-owner cannot deliver it", _reason(s.deliver(_ref(1), dest, false, b)) == "gone" and not FileAccess.file_exists(dest))
	# Takeover only after the holder closed; the closed owner's late effects are refused.
	t.check("the holder still holds it", _reason(s.apply(key, {"truncate": _ref(1), "to": 0}, {}, b)) == "gone")
	s.release_owner(a)
	t.check("a closed owner's late write is refused", not s.apply(key, {"write": _ref(1), "offset": 0, "data": _bytes(1)}, {}, a).ok)
	t.check("a closed owner's late truncate is refused", _reason(s.apply(key, {"truncate": _ref(1), "to": 0}, {}, a)) == "closed")
	t.check("a closed owner cannot rehash", s.rehash(_ref(1), 0, a) == null)
	t.check("the release dropped the hold", not s.partials(key)[0].has("held"))
	var h := s.rehash(_ref(1), 1024, b)
	t.check("a new owner takes it over", h != null and s.apply(key, {"truncate": _ref(1), "to": 1024}, {}, b).ok)
	t.check("the old owner's write still lands nowhere", not s.apply(key, {"write": _ref(1), "offset": 1024, "data": _bytes(1)}, {}, a).ok)
	t.check("the new owner writes", s.apply(key, {"write": _ref(1), "offset": 1024, "data": _bytes(1024)}, {}, b).ok)
	# Release drops the promise too.
	var s2 := _store({"quota": 4096})
	var c := Owner.new()
	_create(s2, key, _ref(1), 4096, c)
	t.check("a live promise takes the room", s2.free_bytes() == 0)
	s2.release_owner(c)
	t.check("the owner's release gives it back", s2.free_bytes() == 4096)
	# A session with no owner is one anonymous owner.
	var s3 := _store()
	t.check("no owner: create and write work", _put(s3, key, _ref(1), _bytes(10), null).ok)


func _purges(t: PKeyTestContext) -> void:
	var s := _store()
	var k1 := _key(1)
	var k2 := _key(2)
	var a := Owner.new()
	var b := Owner.new()
	_put(s, k1, _ref(1), _bytes(100), a)
	_put(s, k2, _ref(2), _bytes(100), b)
	s.apply(k1, {"keep": _ref(1)}, {}, a)
	s.apply(k2, {"keep": _ref(2)}, {}, b)
	var e1 := s.epoch(k1)
	var e2 := s.epoch(k2)
	t.check("purge of one peer succeeds", s.purge(k1).ok)
	t.check("it removed that peer's partial only", s.partials(k1).is_empty() and s.partials(k2).size() == 1 \
			and not FileAccess.file_exists(s.directory().path_join(_ref(1))))
	t.check("that peer's epoch moved and the other's did not", s.epoch(k1) != e1 and s.epoch(k2) == e2)
	var c := Owner.new()
	t.check("a create queued before the purge is refused", _reason(s.apply(k1, {"create": _ref(1)}, _meta(100), c, e1)) == "stale")
	t.check("it did not recreate the store entry", s.partials(k1).is_empty() and not FileAccess.file_exists(s.directory().path_join(_ref(1))))
	t.check("a create from the new epoch is taken", s.apply(k1, {"create": _ref(1)}, _meta(100), c, s.epoch(k1)).ok)
	var e3 := s.epoch(k1)
	s.purge(k1)
	t.check("a write queued before the purge is refused", _reason(s.apply(k1, {"write": _ref(1), "offset": 0, "data": _bytes(1)}, {}, c, e3)) == "stale")
	t.check("the other peer is untouched", s.apply(k2, {"truncate": _ref(2), "to": 50}, {}, Owner.new(), e2).ok)
	var e4 := s.epoch(k2)
	t.check("purge of everything", s.purge().ok)
	t.check("it removed every file and the index entries", s.partials(k2).is_empty() and DirAccess.get_files_at(s.directory()).size() == 1)
	t.check("every epoch moved", s.epoch(k2) != e4)
	t.check("a late truncate after the purge refuses and recreates nothing", not s.apply(k2, {"truncate": _ref(2), "to": 0}, {}, Owner.new(), e4).ok \
			and not FileAccess.file_exists(s.directory().path_join(_ref(2))))
	# Purging a store that was never used makes no directory.
	var s2 := _store()
	t.check("purge of an unused store is ok and makes nothing", s2.purge().ok and not DirAccess.dir_exists_absolute(s2.directory()))
	t.check("the purge still bumped the epoch", s2.epoch(k1) == 1)
	# A delivery depends on its own peer's purges, not another peer's.
	var s3 := _store()
	var d1 := Owner.new()
	_put(s3, k1, _ref(7), _bytes(50), d1)
	s3.apply(k1, {"keep": _ref(7)}, {}, d1)
	var before: int = s3._delivery_epoch(_ref(7))
	s3.purge(k2)
	t.check("another peer's purge leaves a delivery's generation alone", s3._delivery_epoch(_ref(7)) == before)
	s3.purge()
	t.check("a purge of everything moves it", s3._delivery_epoch(_ref(7)) != before)


func _eviction(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var other := _key(2)
	# Eight partials for one peer; the ninth evicts the peer's own oldest, never another peer's.
	var oo := Owner.new()
	_put(s, other, _ref(500), _bytes(10), oo)
	s.apply(other, {"keep": _ref(500)}, {}, oo)
	for i in 8:
		_now += 10.0
		var o := Owner.new()
		_put(s, key, _ref(i + 1), _bytes(10), o)
		s.apply(key, {"keep": _ref(i + 1)}, {}, o)
	t.check("eight partials are kept", s.partials(key).size() == 8)
	_now += 10.0
	var o9 := Owner.new()
	t.check("the ninth is taken", _create(s, key, _ref(9), 10, o9).ok)
	var refs := []
	for p in s.partials(key):
		refs.append(p["ref"])
	t.check("the peer's own oldest went", s.partials(key).size() == 8 and not refs.has(_ref(1)) and refs.has(_ref(9)))
	t.check("another peer's partial stayed", s.partials(other).size() == 1)
	# Holds are never evicted: with all eight held the ninth is refused.
	var s2 := _store()
	var owners := []
	for i in 8:
		var o := Owner.new()
		owners.append(o)
		_put(s2, key, _ref(i + 1), _bytes(10), o)
	t.check("a full peer with all held answers store is full", _reason(_create(s2, key, _ref(9), 10, Owner.new())) == "full")
	t.check("no held partial was removed", s2.partials(key).size() == 8)
	# The overall cap.
	var s3 := _store()
	for i in PKeyTransferStore.MAX_FILES:
		var o := Owner.new()
		var k := _key(i % 200 + 10)
		_now += 1.0
		_put(s3, k, _ref(i + 1), _bytes(4), o)
		s3.apply(k, {"keep": _ref(i + 1)}, {}, o)
	var newcomer := _key(250)
	t.check("a full store evicts the oldest partial nobody holds", _create(s3, newcomer, _ref(900), 4, Owner.new()).ok \
			and not FileAccess.file_exists(s3.directory().path_join(_ref(1))))
	var s4 := _store()
	for i in PKeyTransferStore.MAX_FILES:
		_put(s4, _key(i % 200 + 10), _ref(i + 1), _bytes(4), Owner.new())
	t.check("a full store with every partial held says so", _reason(_create(s4, newcomer, _ref(900), 4, Owner.new())) == "full")


func _sweep(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var a := Owner.new()
	var b := Owner.new()
	_put(s, key, _ref(1), _bytes(10), a)
	s.apply(key, {"keep": _ref(1)}, {}, a)
	_put(s, key, _ref(2), _bytes(10), b)
	_now += 86400.0 + 1.0
	s.sweep()
	var refs := []
	for p in s.partials(key):
		refs.append(p["ref"])
	t.check("a partial older than 24 h goes, a held one stays", not refs.has(_ref(1)) and refs.has(_ref(2)))
	t.check("the file went too", not FileAccess.file_exists(s.directory().path_join(_ref(1))))
	# A create sweeps without being asked, once the hour is up.
	var s2 := _store()
	var o := Owner.new()
	_put(s2, key, _ref(3), _bytes(10), o)
	s2.apply(key, {"keep": _ref(3)}, {}, o)
	_now += 86400.0 + 3700.0
	_create(s2, key, _ref(4), 10, Owner.new())
	var refs2 := []
	for p in s2.partials(key):
		refs2.append(p["ref"])
	t.check("the sweep runs at create", not refs2.has(_ref(3)) and refs2.has(_ref(4)))
	# At load.
	s2.close()
	_now += 86400.0 + 5.0
	var s3 := PKeyTransferStore.new(s2.directory(), {"clock": Callable(self, "_clock")})
	t.check("the sweep runs at load", s3.partials(key).is_empty())


func _delivery(t: PKeyTestContext) -> void:
	var s := _store()
	var key := _key(1)
	var out := _root.path_join("out")
	DirAccess.make_dir_recursive_absolute(out)
	var data := _bytes(5000)
	var a := Owner.new()
	_put(s, key, _ref(1), data, a)
	var dest := out.path_join("file.bin")
	t.check("the destination is usable", s.destination_ok(dest))
	var r := s.deliver(_ref(1), dest, false, a)
	t.check("deliver succeeds", r.ok, r.message)
	t.check("the destination has the bytes", _read(dest) == data)
	t.check("the partial and its record are gone", s.partials(key).is_empty() and not FileAccess.file_exists(s.directory().path_join(_ref(1))))
	t.check("no temporary file is left beside it", DirAccess.get_files_at(out).size() == 1)
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		t.check("the delivered file is 0600", (FileAccess.get_unix_permissions(dest) & 0x1FF) == 0x180)
	t.check("the delivery released the room", s.free_bytes() == PKeyTransferStore.DEFAULT_QUOTA)
	# An existing file is refused and kept; overwrite replaces it.
	var b := Owner.new()
	_put(s, key, _ref(2), _bytes(100), b)
	r = s.deliver(_ref(2), dest, false, b)
	t.check("an existing file refuses", not r.ok and _reason(r) == "exists")
	t.check("the existing file is untouched", _read(dest) == data)
	t.check("the partial is kept after a refusal", s.partials(key).size() == 1 and FileAccess.file_exists(s.directory().path_join(_ref(2))))
	t.check("no temporary file is left after a refusal", DirAccess.get_files_at(out).size() == 1)
	t.check("destination_ok says no", not s.destination_ok(dest))
	r = s.deliver(_ref(2), dest, true, b)
	t.check("overwrite replaces it", r.ok and _read(dest) == _bytes(100))
	# A directory is refused, with or without overwrite.
	var sub := out.path_join("dir")
	DirAccess.make_dir_recursive_absolute(sub)
	var c := Owner.new()
	_put(s, key, _ref(3), _bytes(10), c)
	t.check("a directory at the destination refuses", _reason(s.deliver(_ref(3), sub, false, c)) == "exists")
	t.check("a directory is not replaced by overwrite", not s.deliver(_ref(3), sub, true, c).ok and DirAccess.dir_exists_absolute(sub))
	# A missing directory is not made.
	var missing := out.path_join("nope").path_join("file")
	t.check("a missing directory refuses", _reason(s.deliver(_ref(3), missing, false, c)) == "destination" \
			and not DirAccess.dir_exists_absolute(out.path_join("nope")))
	t.check("a relative path refuses", not s.deliver(_ref(3), "file.bin", false, c).ok)
	t.check("res:// refuses", not s.deliver(_ref(3), "res://file.bin", false, c).ok)
	t.check("a path in the store's own directory refuses", not s.deliver(_ref(3), s.directory().path_join("x"), false, c).ok)
	t.check("an empty name refuses", not s.deliver(_ref(3), out + "/", false, c).ok)
	# An empty transfer delivers an empty file and keeps no partial.
	var empty := out.path_join("empty.bin")
	r = s.deliver("", empty, false, c)
	t.check("an empty transfer delivers an empty file", r.ok and FileAccess.file_exists(empty) and _read(empty).is_empty())
	t.check("an empty delivery refuses an existing file", not s.deliver("", empty, false, c).ok)
	# A partial that is shorter than its record does not deliver.
	var d := Owner.new()
	var s2 := _store()
	_create(s2, key, _ref(4), 100, d)
	s2.apply(key, {"write": _ref(4), "offset": 0, "data": _bytes(40)}, {}, d)
	t.check("a short partial refuses", _reason(s2.deliver(_ref(4), out.path_join("short.bin"), false, d)) == "short" \
			and not FileAccess.file_exists(out.path_join("short.bin")))
	# A purge between claim and rename cancels the delivery.
	var s3 := _store()
	var e := Owner.new()
	_put(s3, key, _ref(5), _bytes(10), e)
	s3.purge()
	t.check("a purged partial does not deliver", not s3.deliver(_ref(5), out.path_join("purged.bin"), false, e).ok \
			and not FileAccess.file_exists(out.path_join("purged.bin")))
	# A big copy runs in blocks.
	var s4 := _store()
	var big := _bytes(3 * MIB + 17)
	var f := Owner.new()
	_put(s4, key, _ref(6), big, f)
	t.check("a multi-block partial delivers whole", s4.deliver(_ref(6), out.path_join("big.bin"), false, f).ok \
			and _read(out.path_join("big.bin")) == big)


func _links(t: PKeyTestContext) -> void:
	var probe := _root.path_join("probe-link")
	if not _symlink(_root, probe):
		t.info("symbolic links are not available here; the link checks are skipped")
		return
	DirAccess.remove_absolute(probe)
	var key := _key(1)
	var out := _root.path_join("links")
	DirAccess.make_dir_recursive_absolute(out)
	var outside := out.path_join("outside.txt")
	var f := FileAccess.open(outside, FileAccess.WRITE)
	f.store_string("keep me")
	f.close()
	# A link at the destination, to a file, to a directory, dangling.
	var s := _store()
	var o := Owner.new()
	_put(s, key, _ref(1), _bytes(10), o)
	var l1 := out.path_join("to-file")
	_symlink(outside, l1)
	t.check("a link to a file refuses", _reason(s.deliver(_ref(1), l1, false, o)) == "exists" and _read(outside) == "keep me".to_utf8_buffer())
	var l2 := out.path_join("to-dir")
	_symlink(out, l2)
	t.check("a link to a directory refuses", not s.deliver(_ref(1), l2, false, o).ok)
	var l3 := out.path_join("dangling")
	_symlink(out.path_join("gone"), l3)
	t.check("a dangling link refuses", _reason(s.deliver(_ref(1), l3, false, o)) == "exists" and not FileAccess.file_exists(out.path_join("gone")))
	t.check("destination_ok refuses a dangling link", not s.destination_ok(l3))
	# Overwrite replaces the link itself, never what it points at.
	var r := s.deliver(_ref(1), l1, true, o)
	t.check("overwrite replaces the link, not its target", r.ok and _read(outside) == "keep me".to_utf8_buffer() and _read(l1) == _bytes(10) \
			and not DirAccess.open(out).is_link("to-file"))
	# A link as the store directory is refused.
	var real := _root.path_join("real-dir")
	DirAccess.make_dir_recursive_absolute(real)
	var root_link := _root.path_join("root-link")
	_symlink(real, root_link)
	var s2 := PKeyTransferStore.new(root_link, {"clock": Callable(self, "_clock")})
	t.check("a link as the root is refused", _reason(_create(s2, key, _ref(1), 10, Owner.new())) == "root" and DirAccess.get_files_at(real).is_empty())
	# A link where a partial lives is not followed.
	var s3 := _store()
	var o3 := Owner.new()
	_put(s3, key, _ref(2), _bytes(100), o3)
	s3.apply(key, {"keep": _ref(2)}, {}, o3)
	var path := s3.directory().path_join(_ref(2))
	s3.close()
	var s3b := PKeyTransferStore.new(s3.directory(), {"clock": Callable(self, "_clock")})
	s3b.partials(key)
	DirAccess.remove_absolute(path)
	_symlink(outside, path)
	t.check("a partial that became a link gives no hasher", s3b.rehash(_ref(2), 10, Owner.new()) == null)
	t.check("a write to a link is refused", not s3b.apply(key, {"truncate": _ref(2), "to": 10}, {}, Owner.new()).ok and _read(outside) == "keep me".to_utf8_buffer())
	# A create over a planted link replaces the link, not the target.
	var s4 := _store()
	s4.partials(key)
	_symlink(outside, s4.directory().path_join(_ref(3)))
	var put := _put(s4, key, _ref(3), _bytes(8), Owner.new())
	s4.close()
	t.check("create over a link makes its own file", put.ok and _read(outside) == "keep me".to_utf8_buffer() \
			and _read(s4.directory().path_join(_ref(3))) == _bytes(8))


func _web(t: PKeyTestContext) -> void:
	var s := _store({"web": true})
	var key := _key(1)
	var o := Owner.new()
	t.check("web: the quota defaults to 64 MiB", s.free_bytes() == PKeyTransferStore.WEB_QUOTA)
	t.check("web: a create and write work", _put(s, key, _ref(1), _bytes(100), o).ok)
	t.check("web: nothing is listed for resume", s.partials(key).is_empty())
	s.apply(key, {"keep": _ref(1)}, {}, o)
	t.check("web: keep keeps nothing", s.partials(key).is_empty() and not FileAccess.file_exists(s.directory().path_join(_ref(1))))
	t.check("web: no index is written", not FileAccess.file_exists(s.directory().path_join("index.json")))
	var o2 := Owner.new()
	_put(s, key, _ref(2), _bytes(50), o2)
	var dest := _root.path_join("web-out.bin")
	t.check("web: delivery works the same", s.deliver(_ref(2), dest, false, o2).ok and _read(dest) == _bytes(50))
	t.check("web: a host quota applies", _store({"web": true, "quota": 1024}).free_bytes() == 1024)
