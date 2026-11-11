extends RefCounted
# @pkey-feature sync.saves
# @pkey-feature sync.conflict
# Cloud Sync saves (U-22.5, U-23): PolarisKey.cloud_sync.saves over the records binding and the file transport.
#
#   * PKeySaves (saves.gd) against an in-memory Worker for the file routes and a records port: write, read,
#     list, the E2E `$file` binding, the format check (D-11), conflicts and keep, delete, pause, resume and
#     cancel, the 16-slot cap, events;
#   * the guarded file codec: once the ring locks, every method and every piece refuses (sync-locked);
#   * the records binding (saves_records.gd) over a real host and a loopback Worker: the machine's rows, put_at
#     and remove_at with their one outcome (ok, conflict, rejected, dropped), a cancel, drop_all, and the
#     host passing `recordKeys` to the codec on every pull;
#   * the typed `unsupported` refusal on iOS and Android, and the sign-out order: lock, purge the saves, then
#     remove the pin.
# The machine's own rules (tickets, file-only rows, outcomes) are fileRecordCases in suite_sync_scenarios.

const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const POINTER := {"version": 3, "size": 5, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "format": "whole"}
const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")
const Codec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const Host := preload("res://addons/polaris_key/services/cloud_sync/host.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")
const SavesRecords := preload("res://addons/polaris_key/services/cloud_sync/saves_records.gd")
const CloudSync := preload("res://addons/polaris_key/services/cloud_sync.gd")

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Machine := preload("res://addons/polaris_key/core/sync/cloud_sync_machine.gd")

const PULL := {
	"subject": "sub_alice", "serverNow": 1760000000000, "cursor": 9, "more": false, "lastMutationId": 0, "catalogVersion": 1, "aliases": {},
	"quota": {"bytes": 268435456, "files": true}, "usage": {"bytes": 0, "settings": 0, "records": 0, "files": 0},
	"changes": [{"record": ["progress", "main"], "value": {"level": 3}, "version": 7}], "tombstones": [],
}
const PRODUCT := "diceroll"
const MIB := 1048576


## Every rig the tests made. A test hands a rig's saves and fakes lambdas that read the rig, so each rig holds
## itself; the suite lets go of those callbacks at its end.
var _rigs: Array = []


## The Worker's file routes for any number of records, behind the transport port the engine calls.

class FakeFiles:
	extends RefCounted
	var records := {}  # wire id -> {version, revs: [{version, size, sha256, format, data}], value, file}
	var uploads := {}
	var chunks := {}
	var seq := 0
	var calls: Array[String] = []
	## The baseVersion of each begin, in order.
	var bases: Array = []
	var aborted: Array[String] = []
	var puts: Array[PackedByteArray] = []
	## Awaited before a GET lands.
	var before_get := Callable()
	## Awaited before a PUT lands (a coroutine): a window to pause or lock in.
	var before_put := Callable()
	## Rewrites the finalize answer: Callable(answer) -> answer (the stored file is untouched).
	var finalize_answer := Callable()

	func rec(wire: String) -> Dictionary:
		if not records.has(wire):
			records[wire] = {"version": 0, "revs": [], "value": null, "file": null}
		return records[wire]

	func begin(target: Dictionary, r: Dictionary) -> Dictionary:
		calls.append("begin")
		var cur: int = records[target["record"]]["version"] if records.has(target["record"]) else 0
		var base: Variant = r.get("baseVersion")
		bases.append(base)
		if base != null and not ((base is String and base == "*" and cur == 0) or (not (base is String) and int(base) == cur)):
			return Transfer.reply_fail(409, "revision_conflict", -1.0, {"server": {"version": cur}})
		seq += 1
		var id := "up%d" % seq
		var mode := "chunks" if r["format"] == "chunks" else "single"
		uploads[id] = {"record": target["record"], "size": r["size"], "sha256": r["sha256"], "format": r["format"], "mode": mode, "body": null}
		return Transfer.reply_ok({"uploadId": id, "mode": mode, "expiresAt": 1760086400000})

	func status(_t: Dictionary, upload_id: String) -> Dictionary:
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		return Transfer.reply_ok({"received": [1] if uploads[upload_id]["body"] != null else []})

	func put_single(_t: Dictionary, upload_id: String, body: PackedByteArray, digest: String) -> Dictionary:
		calls.append("put")
		if before_put.is_valid():
			await before_put.call()
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		if PKeySyncHkdf.sha256(body).hex_encode() != digest:
			return Transfer.reply_fail(400, "upload_mismatch")
		uploads[upload_id]["body"] = body
		puts.append(body)
		return Transfer.reply_ok()

	func put_part(_a, _b, _c, _d, _e) -> Dictionary:
		return Transfer.reply_fail(400, "unused")

	func abort(_t: Dictionary, upload_id: String) -> Dictionary:
		calls.append("abort")
		aborted.append(upload_id)
		uploads.erase(upload_id)
		return Transfer.reply_ok()

	func plan_chunks(_t: Dictionary, upload_id: String, request: Dictionary) -> Dictionary:
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		var missing := []
		var present := []
		for e in request["chunks"]:
			if chunks.has(e[0]):
				present.append([e[0], e[1]])
			else:
				missing.append(e[0])
		return Transfer.reply_ok({"missing": missing, "present": present})

	func put_chunk(_t: Dictionary, upload_id: String, chunk_id: String, body: PackedByteArray, digest: String) -> Dictionary:
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		if PKeySyncHkdf.sha256(body).hex_encode() != digest:
			return Transfer.reply_fail(400, "upload_mismatch")
		chunks[chunk_id] = body
		return Transfer.reply_ok()

	func finalize(_t: Dictionary, request: Dictionary) -> Dictionary:
		calls.append("finalize")
		var u: Variant = uploads.get(request["uploadId"])
		if u == null:
			return Transfer.reply_fail(410, "upload_expired")
		if u["body"] == null:
			return Transfer.reply_fail(409, "upload_incomplete", -1.0, {"missing": []})
		var data: PackedByteArray = u["body"]
		if PKeySyncHkdf.sha256(data).hex_encode() != u["sha256"]:
			return Transfer.reply_fail(400, "upload_mismatch")
		var r := rec(u["record"])
		r["version"] += 1
		var entry := {"version": r["version"], "size": u["size"], "sha256": u["sha256"], "format": u["format"], "data": data}
		r["revs"].push_front(entry)
		r["file"] = {"version": entry["version"], "size": entry["size"], "sha256": entry["sha256"], "format": entry["format"]}
		uploads.erase(request["uploadId"])
		var answer := {"version": entry["version"], "size": entry["size"], "sha256": entry["sha256"], "format": entry["format"]}
		return Transfer.reply_ok(finalize_answer.call(answer) if finalize_answer.is_valid() else answer)

	func get_file(target: Dictionary, query: Dictionary) -> Dictionary:
		calls.append("get_file")
		if before_get.is_valid():
			await before_get.call()
		var r: Variant = records.get(target["record"])
		if r == null or r["revs"].is_empty():
			return Transfer.reply_fail(404, "not_found")
		var data: PackedByteArray = r["revs"][0]["data"]
		if query.get("version") != null:
			for e in r["revs"]:
				if e["version"] == int(query["version"]):
					data = e["data"]
		var rng: Variant = query.get("range")
		if rng is Array:
			var end := mini(data.size(), rng[1])
			return Transfer.reply_ok({"status": 206, "data": data.slice(rng[0], end), "etag": "\"e\"", "content_range": [rng[0], end, data.size()]})
		return Transfer.reply_ok({"status": 200, "data": data, "etag": "\"e\"", "content_range": null})

	func get_chunk(_collection: String, chunk_id: String) -> Dictionary:
		if not chunks.has(chunk_id):
			return Transfer.reply_fail(404, "not_found")
		return Transfer.reply_ok(chunks[chunk_id])

	func revisions(target: Dictionary) -> Dictionary:
		calls.append("revisions")
		var r: Variant = records.get(target["record"])
		if r == null:
			return Transfer.reply_fail(404, "not_found")
		var out := []
		for e in r["revs"]:
			out.append({"version": e["version"], "size": e["size"], "sha256": e["sha256"], "format": e["format"]})
		return Transfer.reply_ok({"revisions": out})


## The records port over the same store: a record's version is its file's, and a metadata `set` bumps it.
class FakeRecords:
	extends RefCounted
	var files: FakeFiles
	var e2e_mode := false
	var ring: RefCounted = null
	## Awaited before a set is judged (a coroutine): a window for another writer.
	var before_set := Callable()
	## id -> wire id, for the plaintext ids this port has seen
	var wires := {}
	var dropped := 0
	## Holds a set until `release` or a cancel (a coroutine wait).
	var hold_set := false
	var release_set := false
	var set_calls := 0
	var set_files: Array = []
	var rejected_code := ""
	## While set, get_record answers this device's stale cache instead of the server's row.
	var stale_row: Variant = null
	## What a pull does (another device wrote meanwhile); invalid: this port cannot pull.
	var on_pull := Callable()
	var pulls := 0

	func _init(f: FakeFiles) -> void:
		files = f

	func e2e() -> bool:
		return e2e_mode

	func wire_id(id: String) -> String:
		if not e2e_mode:
			return id
		if ring.locked:
			return ""
		var w := PKeySyncBlind.blind(ring.root, "record", "saves", id)
		wires[w] = id
		return w

	func _row(wire: String, r: Dictionary) -> Dictionary:
		return {"id": wires.get(wire, wire), "version": r["version"], "value": (r["value"] as Dictionary).duplicate(true) if r["value"] != null else {}, "file": r["file"]}

	func list() -> Array:
		var out := []
		for w: String in files.records:
			if files.records[w]["value"] != null:
				out.append(_row(w, files.records[w]))
		return out

	func get_record(id: String) -> Variant:
		if stale_row != null:
			return stale_row
		var w := wire_id(id) if not ring.locked else id
		if not files.records.has(w) or files.records[w]["value"] == null:
			return null
		return _row(w, files.records[w])

	func set_record(id: String, value: Dictionary, base_version: Variant, cancel: Variant = null, file: Variant = null) -> Dictionary:
		set_calls += 1
		set_files.append(file)
		var tree := Engine.get_main_loop() as SceneTree
		while hold_set and not release_set:
			if cancel != null and cancel.cancelled:
				return {"ok": false, "reason": "aborted"}
			await tree.process_frame
		if before_set.is_valid():
			await before_set.call()
		if rejected_code != "":
			return {"ok": false, "reason": "rejected", "code": rejected_code}
		var w := wire_id(id)
		var r = files.rec(w)
		if int(base_version) != r["version"]:
			return {"ok": false, "reason": "conflict", "server": _row(w, r) if r["value"] != null else null}
		r["version"] += 1
		r["value"] = value.duplicate(true)
		return {"ok": true, "version": r["version"]}

	func delete_record(id: String, base_version: int) -> Dictionary:
		var w := wire_id(id)
		var r: Variant = files.records.get(w)
		if r == null:
			return {"ok": false, "reason": "rejected", "code": "not_found"}
		if base_version != r["version"]:
			return {"ok": false, "reason": "conflict", "server": _row(w, r)}
		files.records.erase(w)
		return {"ok": true, "version": base_version + 1}

	func drop_all() -> void:
		dropped += 1

	func pull_records() -> bool:
		if not on_pull.is_valid():
			return false
		pulls += 1
		on_pull.call()
		return true


## A ring: a root and a lock flag.
class Ring:
	extends RefCounted
	var root := Crypto.new().generate_random_bytes(32)
	var locked := false


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_guarded(t)
	_root_replaced(t)
	await _server_mode(t)
	await _e2e(t)
	await _format_and_binding(t)
	await _finalize_answer(t)
	await _conflicts(t)
	await _record_requests(t)
	await _delete(t)
	await _pause_cancel(t)
	await _interrupted(t)
	await _stale_off_thread(t)
	await _locked(t)
	await _chunked(t)
	await _unsupported(t)
	await _purge_order(t)
	await _records_binding(t)
	await _host_record_keys(t)
	await _through_the_sdk(t)
	await _off_thread(t)
	await PKeyTestFixtures.frames(10)
	_drop_rigs()
	return true


# ── rigs ────────────────────────────────────────────────────────────────────────────────────────

func _noise(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


## A saves rig: the files, the records, the ring, the events, and PKeySaves over them.
func _rig(e2e_mode: bool, over := {}) -> Dictionary:
	var files := FakeFiles.new()
	var records := FakeRecords.new(files)
	var ring := Ring.new()
	records.e2e_mode = e2e_mode
	records.ring = ring
	var journal := Journal.Memory.new()
	var engine := Transfer.new(files, journal)
	engine.sleep = func(_s: float) -> void: await (Engine.get_main_loop() as SceneTree).process_frame
	var events: Array = []
	var deps := {
		"records": records,
		"engine": engine,
		"file_codec": func() -> Variant:
			if ring.locked:
				return null
			if not e2e_mode:
				return Codec.Server.new()
			return Codec.Guarded.new(Codec.E2e.new(ring.root, "saves"), func() -> bool: return ring.locked),
		"cache": func() -> Variant: return null,
		"delta": false,
		"emit": func(e: Dictionary) -> void: events.append(e),
		"supported": func() -> bool: return true,
	}
	deps.merge(over, true)
	var saves := PKeySaves.new(deps)
	var rig := {"files": files, "records": records, "ring": ring, "journal": journal, "engine": engine, "events": events, "saves": saves, "deps": deps}
	_rigs.append(rig)
	return rig


func _drop_rigs() -> void:
	for rig: Dictionary in _rigs:
		(rig["saves"] as PKeySaves)._d = {}
		(rig["deps"] as Dictionary).clear()
		for hook in ["before_get", "before_put", "finalize_answer"]:
			(rig["files"] as Object).set(hook, Callable())
		for hook in ["before_set", "on_pull"]:
			(rig["records"] as Object).set(hook, Callable())
	_rigs.clear()


## The app's metadata, without the SDK's own savedAt / deviceLabel stamps.
func _bare(meta: Dictionary) -> Dictionary:
	var out := meta.duplicate()
	out.erase("savedAt")
	out.erase("deviceLabel")
	return out


func _types(events: Array) -> Array:
	var out := []
	for e: Dictionary in events:
		out.append(e["type"])
	return out


func _write(rig: Dictionary, id: String, data: PackedByteArray, meta := {}, opts := {}) -> Dictionary:
	var h: PKeyTransfer = rig["saves"].write(id, data, meta, opts)
	return await h.wait()


# ── the guarded codec ───────────────────────────────────────────────────────────────────────────

func _guarded(t: PKeyTestContext) -> void:
	var ring := Ring.new()
	var g := Codec.Guarded.new(Codec.E2e.new(ring.root, "saves"), func() -> bool: return ring.locked)
	var plain := _noise(1000)
	var id := g.chunk_id(plain)
	var obj := g.seal_chunk(id, plain)
	var whole := g.seal_whole(plain)
	t.check("guarded: while the ring is held it seals and opens", not id.is_empty() and not obj.is_empty() and g.open_chunk(id, obj)["ok"] and g.open_whole(whole)["ok"] and not g.tripped)
	ring.locked = true
	var refused: Array = [g.chunk_id(plain).is_empty(), g.seal_chunk(id, plain).is_empty(), g.seal_manifest(plain).is_empty(), g.seal_whole(plain).is_empty()]
	t.check("guarded: once the ring locks, every seal and id answers nothing", not refused.has(false), str(refused))
	var locked := {"ok": false, "reason": "locked"}
	t.check("guarded: once the ring locks, every open refuses", g.open_chunk(id, obj) == locked and g.open_whole(whole) == locked and g.open_manifest(whole) == locked)
	t.check("guarded: sizes are refused too, and the lock is remembered", g.stored_size(10) == -1 and g.plain_size(10) == -1 and g.tripped and g.locked())
	ring.locked = false
	t.check("guarded: a ring that unlocks again does not revive a codec that saw the lock (a new codec is made per operation)", g.chunk_id(plain).is_empty())
	var s := Codec.Guarded.new(Codec.E2e.new(ring.root, "saves"), func() -> bool: return ring.locked)
	t.check("guarded: its text hides the key", not str(s).contains(Marshalls.raw_to_base64(ring.root)))


## A real ring's root replaced under a codec made for the old one (an accepted, adopted or recovered root,
## with no lock in between): the codec fails closed, like a lock.
func _root_replaced(t: PKeyTestContext) -> void:
	var down := func(_m: String, _p: String, _b: Variant) -> PKeyResult: return PKeyResult.failure(&"network-error", "down")
	var ring := PKeySyncRing.new(PRODUCT, "dev_a", down, null, PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	var port := PKeySyncHostCodec.new(ring)
	var root_a := _noise(32)
	var root_b := _noise(32)
	var ring_id := "rg_" + "A".repeat(22)
	ring._memory.set_held(PKeySyncRing._Held.new(ring_id, 1, PKeySyncHkdf.derive_kid(root_a), root_a), [])
	var codec = Codec.e2e_for(port, "saves")
	var plain := _noise(500)
	var id: PackedByteArray = codec.chunk_id(plain)
	var sealed: PackedByteArray = codec.seal_whole(plain)
	var usable: bool = codec != null and not id.is_empty() and not sealed.is_empty()
	t.check("replaced root: while the root is the one it was made for, the codec works", usable and codec.open_whole(sealed)["ok"] and not codec.tripped)
	var gen := port.root_generation()
	ring._memory.set_held(PKeySyncRing._Held.new(ring_id, 2, PKeySyncHkdf.derive_kid(root_b), root_b))
	t.check("replaced root: every replacement moves the generation", port.root_generation() == gen + 1 and not port.locked())
	var refused := [codec.chunk_id(plain).is_empty(), codec.seal_chunk(id, plain).is_empty(), codec.seal_manifest(plain).is_empty(), codec.seal_whole(plain).is_empty()]
	t.check("replaced root: the old codec seals nothing (no lock was taken)", not refused.has(false), str(refused))
	var no := {"ok": false, "reason": "locked"}
	t.check("replaced root: it opens nothing, and the cause is the lock the saves layer reports", codec.open_whole(sealed) == no and codec.open_chunk(id, sealed) == no and codec.tripped)
	var fresh = Codec.e2e_for(port, "saves")
	t.check("replaced root: a codec made now is for the new root and works", fresh != null and not fresh.seal_whole(plain).is_empty() and not fresh.tripped)
	ring.lock()
	t.check("replaced root: a lock still stales it, and a locked ring makes no codec", fresh.seal_whole(plain).is_empty() and fresh.tripped and Codec.e2e_for(port, "saves") == null)


# ── server mode ─────────────────────────────────────────────────────────────────────────────────

func _server_mode(t: PKeyTestContext) -> void:
	var rig = _rig(false)
	var saves: PKeySaves = rig["saves"]
	var data := _noise(5000)
	var out = await _write(rig, "slot1", data, {"playtime": 12, "chapter": "one"})
	t.check("write: done with the version the metadata set answered", out["state"] == "done" and out["id"] == "slot1" and out["version"] == 2, str(out))
	t.check("write: the Worker holds the plaintext file in server mode", rig["files"].puts.size() == 1 and rig["files"].puts[0] == data)
	var listed = await saves.list()
	t.check(
			"list: the save with its metadata and file",
			listed.ok
				and listed.detail.size() == 1
				and listed.detail[0]["id"] == "slot1"
				and _bare(listed.detail[0]["metadata"]) == {"playtime": 12, "chapter": "one"}
				and listed.detail[0]["file"]["size"] == 5000
				and not listed.detail[0]["newer_format"],
			str(listed.detail)
	)
	var read = await saves.read("slot1")
	t.check("read: the bytes and the metadata", read.ok and read.detail["bytes"] == data and read.detail["metadata"]["chapter"] == "one" and read.detail["file"]["format"] == "whole",
		str(read.detail.get("file")))
	var types := _types(rig["events"])
	t.check("events: progress then done for the write, progress then done for the read", types.has("transferProgress") and types.count("transferDone") == 2 and not types.has("transferFailed"),
		str(types))
	var ids := []
	for e: Dictionary in rig["events"]:
		ids.append(e["id"])
	t.check("events: the write's id is saves:<id>, the read's saves:read:<id>", ids.has("saves:slot1") and ids.has("saves:read:slot1"))
	t.check("transfers: empty once settled", saves.transfers().is_empty())
	var again = await _write(rig, "slot1", _noise(300), {"playtime": 13})
	t.check("write: a rewrite uses the record's version and keeps one slot", again["state"] == "done" and (await saves.list()).detail.size() == 1 and again["version"] == 4, str(again))
	var missing = await saves.read("nope")
	t.check("read: a save that does not exist is not-found", not missing.ok and missing.detail["reason"] == "not-found")
	var bad = await _write(rig, "bad id!", data)
	t.check("write: an id that is not a key is invalid-save", bad["state"] == "failed" and bad["error"]["code"] == "invalid-save")
	var reserved = await _write(rig, "r1", data, {"$file": {}})
	t.check("write: the reserved $file key is refused", reserved["state"] == "failed" and reserved["error"]["code"] == "invalid-save" and reserved["error"]["detail"] == "reserved-key")
	var tiny = await _write(rig, "r1", PackedByteArray([1, 2, 3]), {}, {})
	t.check("write: a tiny save is fine", tiny["state"] == "done")
	var capped = _rig(false, {"max_bytes": 100})
	var over = await _write(capped, "r1", _noise(101))
	t.check("write: over max_bytes is too-large, nothing sent", over["state"] == "failed" and over["error"]["code"] == "too-large" and capped["files"].calls.is_empty())
	var empty = await _write(capped, "r1", PackedByteArray())
	t.check("write: an empty save is invalid-save", empty["state"] == "failed" and empty["error"]["code"] == "invalid-save")
	var failed_events := _types(capped["events"])
	t.check("events: a failed write is transferFailed with its code", failed_events == ["transferFailed", "transferFailed"] and capped["events"][0]["code"] == "too-large", str(capped["events"]))
	# the 16-slot cap
	var full = _rig(false)
	for i in 16:
		await _write(full, "s%d" % i, _noise(10))
	var seventeenth = await _write(full, "s16", _noise(10))
	t.check("write: a 17th save is slots-full", seventeenth["state"] == "failed" and seventeenth["error"]["code"] == "slots-full")
	var existing = await _write(full, "s3", _noise(10))
	t.check("write: an existing save of 16 is still writable", existing["state"] == "done")


# ── end-to-end mode ─────────────────────────────────────────────────────────────────────────────

func _e2e(t: PKeyTestContext) -> void:
	var rig = _rig(true)
	var saves: PKeySaves = rig["saves"]
	var marker := "MARKER-plaintext-9f3a".to_utf8_buffer()
	var data := marker + _noise(2000)
	var out = await _write(rig, "slot1", data, {"progress": 0.5})
	t.check("e2e write: done", out["state"] == "done", str(out))
	var stored: PackedByteArray = rig["files"].puts[0]
	var sealed_ok := stored != data and stored.size() == PKeySyncFileStream.sealed_size(data.size())
	var leaks := false
	for i in range(0, stored.size() - marker.size()):
		if stored.slice(i, i + marker.size()) == marker:
			leaks = true
			break
	t.check("e2e write: the Worker holds ciphertext of the sealed size, not the plaintext", sealed_ok and not leaks)
	var wire = rig["records"].wire_id("slot1")
	var value: Dictionary = rig["files"].records[wire]["value"]
	t.check(
			"e2e write: the metadata carries the $file binding of the stored file",
			value.has("$file") and value["$file"]["sha256"] == rig["files"].records[wire]["file"]["sha256"] and value["$file"]["size"] == stored.size() and value["$file"]["format"] == "whole",
			str(value)
	)
	t.check("e2e write: the id travels blinded", wire.begins_with("x:") and not rig["files"].records.has("slot1"))
	var listed = await saves.list()
	t.check(
			"e2e list: the metadata without the binding, the file pointer",
			listed.ok and _bare(listed.detail[0]["metadata"]) == {"progress": 0.5} and listed.detail[0]["file"] != null,
			str(listed.detail)
	)
	var read = await saves.read("slot1")
	t.check("e2e read: the plaintext back", read.ok and read.detail["bytes"] == data)
	# a Worker that swaps the files of two slots is caught by the binding
	await _write(rig, "slot2", _noise(500), {"n": 2})
	var w1 = rig["records"].wire_id("slot1")
	var w2 = rig["records"].wire_id("slot2")
	var swap: Variant = rig["files"].records[w1]["revs"]
	rig["files"].records[w1]["revs"] = rig["files"].records[w2]["revs"]
	rig["files"].records[w1]["file"] = rig["files"].records[w2]["file"]
	var swapped = await saves.read("slot1")
	t.check("e2e read: a file swapped under another slot's metadata is sync-file-invalid", not swapped.ok and swapped.code == PKeyConstants.ErrorCode.SYNC_FILE_INVALID, str(swapped.detail))
	var swapped_list = await saves.list()
	var s1: Dictionary = {}
	for s: Dictionary in swapped_list.detail:
		if s["id"] == "slot1":
			s1 = s
	t.check("e2e list: the swapped file is not shown as the save's", s1.get("file") == null)
	rig["files"].records[w1]["revs"] = swap
	# a malformed binding is not an absent one
	rig["files"].records[w1]["value"]["$file"] = {"sha256": "nothex", "size": 5, "format": "whole"}
	var malformed = await saves.read("slot1")
	t.check("e2e read: a malformed binding is sync-file-invalid, not a save with no file", not malformed.ok and malformed.code == PKeyConstants.ErrorCode.SYNC_FILE_INVALID)
	rig["files"].records[w1]["value"].erase("$file")
	var none = await saves.read("slot1")
	t.check("e2e read: no binding means no file, whatever the Worker attaches", none.ok and none.detail["file"] == null and none.detail["bytes"].is_empty())
	# an older revision named by the binding is found in the kept revisions
	var rig2 = _rig(true)
	await _write(rig2, "a", _noise(100), {"v": 1})
	var wa = rig2["records"].wire_id("a")
	var first_binding: Dictionary = rig2["files"].records[wa]["value"]["$file"]
	var first_bytes: PackedByteArray = rig2["files"].records[wa]["revs"][0]["data"]
	await _write(rig2, "a", _noise(120), {"v": 2})
	rig2["files"].records[wa]["value"]["$file"] = first_binding
	var older = await rig2["saves"].read("a")
	t.check(
			"e2e read: the revision the binding names is read even when it is not the newest",
			older.ok and older.detail["bytes"].size() == 100 and rig2["files"].calls.has("revisions") and first_bytes.size() == PKeySyncFileStream.sealed_size(100),
			str(older.detail.get("reason"))
	)
	var revs = await rig2["saves"].revisions("a")
	t.check("revisions: newest first", revs.ok and revs.detail.size() == 2 and revs.detail[0]["version"] > revs.detail[1]["version"])
	var nope = await rig2["saves"].revisions("zzz")
	t.check("revisions: a save the Worker does not know is not-found", not nope.ok and nope.detail["reason"] == "not-found")


func _format_and_binding(t: PKeyTestContext) -> void:
	var rig = _rig(false, {"format_version": 2})
	await _write(rig, "old", _noise(50), {"formatVersion": 1})
	await _write(rig, "new", _noise(50), {"formatVersion": 3})
	await _write(rig, "none", _noise(50), {})
	var listed = await rig["saves"].list()
	var flags := {}
	for s: Dictionary in listed.detail:
		flags[s["id"]] = s["newer_format"]
	t.check("format: only a save above the app's version is newer_format", flags == {"old": false, "new": true, "none": false}, str(flags))
	var r = await rig["saves"].read("new")
	t.check(
			"format: read refuses a newer save with its versions, and downloads nothing",
			not r.ok and r.detail["reason"] == "newer-format" and r.detail["format_version"] == 3 and r.detail["supported"] == 2 and not rig["files"].calls.has("get_file"),
			str(r.detail)
	)
	var ok = await rig["saves"].read("old")
	t.check("format: an older save reads", ok.ok)
	var off = _rig(false)
	await _write(off, "new", _noise(50), {"formatVersion": 99})
	t.check("format: with no app version the check is off", (await off["saves"].read("new")).ok)


# ── conflicts and keep ───────────────────────────────────────────────────────────────────────

func _finalize_answer(t: PKeyTestContext) -> void:
	for e2e_mode: bool in [false, true]:
		var rig = _rig(e2e_mode)
		var first = await _write(rig, "a", _noise(3000), {"n": 1})
		var other = await _write(rig, "b", _noise(3100), {"n": 2})
		var listed_before: int = (await rig["saves"].list()).detail.size()
		rig["files"].finalize_answer = func(a: Dictionary) -> Dictionary: return a.merged({"size": other["file"]["size"], "sha256": other["file"]["sha256"]}, true)
		var out = await _write(rig, "a", _noise(3200), {"n": 3}, {"base_version": first["version"]})
		t.check("finalize answer naming another file fails the write (e2e %s)" % e2e_mode, out["state"] == "failed", str(out))
		var read = await rig["saves"].read("a")
		t.check("finalize answer naming another file adopts nothing: the save keeps its metadata (e2e %s)" % e2e_mode, read.ok and read.detail["metadata"]["n"] == 1, str(read))
		t.check("finalize answer: the other save is untouched (e2e %s)" % e2e_mode, (await rig["saves"].list()).detail.size() == listed_before)


## S1: open the request of a slot whose explicit base is stale (the server holds version 2 after one write).
func _stale_request(rig: Dictionary, id: String, meta: Dictionary) -> PKeyMergeRequest:
	var out: Dictionary = await _write(rig, id, _noise(100), meta, {"base_version": 1})
	return out.get("request")


func _conflicts(t: PKeyTestContext) -> void:
	var events: Array = []
	var reg := PKeyMergeRegistry.new({"event": func(e: Dictionary) -> void: events.append(e)})
	var rig = _rig(false, {"merge": reg})
	var saves: PKeySaves = rig["saves"]
	await _write(rig, "slot1", _noise(100), {"who": "a"})
	# another device wrote since: this device's explicit base is stale
	var stale = await _write(rig, "slot1", _noise(100), {"who": "b"}, {"base_version": 1})
	t.check("saveConflictOpensRequest: a stale base_version is a conflict outcome, not an error", stale["state"] == "conflict", str(stale))
	var req: PKeyMergeRequest = stale["request"]
	t.check(
			"saveConflictOpensRequest: one request per slot: id, cause, sides, choices",
			req.id == "w:saves/slot1" and req.cause == "write" and req.collection == "saves" and req.record == "slot1"
				and _bare(req.local["value"]) == {"who": "b"} and req.local["saved_at"] != null and req.local["version"] == 1 and req.local["file"]["size"] == 100
				and _bare(req.remote["value"]) == {"who": "a"} and req.remote["version"] == 2
				and req.choices == ["local", "remote", "both"] and req.state == "open" and req.error == null,
			"%s | %s" % [str(req.local), str(req.remote)]
	)
	t.check(
			"saveConflictOpensRequest: the registry lists it and announces it once",
			saves.conflicts() == [req] and reg.count() == 1 and events.size() == 1 and events[0]["type"] == "conflictOpened" and events[0]["request"] == req
	)
	var types := _types(rig["events"])
	t.check("saveConflictOpensRequest: the transfer ends with transferDone state conflict", types.back() == "transferDone" and rig["events"].back()["state"] == "conflict")
	# S3: while it is open a write with no base only replaces the local copy and sends nothing
	var calls_before: int = rig["files"].calls.size()
	var frozen: Dictionary = await _write(rig, "slot1", _noise(77), {"who": "c"})
	t.check(
			"saveRequestFreezesSlot: a write with no base settles conflict without uploading and replaces the local side",
			frozen["state"] == "conflict" and frozen["request"] == req and rig["files"].calls.size() == calls_before
				and _bare(req.local["value"]) == {"who": "c"} and req.local["file"]["size"] == 77 and reg.count() == 1,
			str(frozen)
	)
	var gone_delete: PKeyResult = await saves.delete("slot1")
	t.check(
			"saveRequestFreezesSlot: a delete defaults to the request's base, so it conflicts and the other copy survives",
			not gone_delete.ok and gone_delete.detail["reason"] == "conflict" and reg.count() == 0 and rig["files"].records.has("slot1"),
			str(gone_delete.detail)
	)
	t.check("saveRequestFreezesSlot: that delete closed the request as superseded", events.back()["type"] == "conflictClosed" and events.back()["how"] == "superseded")

	# keep remote: writes nothing, keeps the server's copy
	var r1: PKeyMergeRequest = await _stale_request(rig, "slot1", {"who": "b"})
	calls_before = rig["files"].calls.size()
	var kept: PKeyResult = await r1.keep("remote")
	t.check(
			"saveKeepRemote: sends nothing and answers the version held",
			kept.ok and kept.detail["kept"] == "remote" and kept.detail["version"] == 2 and rig["files"].calls.size() == calls_before
				and rig["files"].records[rig["records"].wire_id("slot1")]["version"] == 2 and reg.count() == 0,
			str(kept.detail)
	)
	t.check("saveKeepRemote: the request closed as remote", events.back()["type"] == "conflictClosed" and events.back()["how"] == "remote")
	var closed: PKeyResult = await r1.keep("remote")
	t.check(
			"saveKeepOnClosedRequest: keep on a closed request is sync-merge-closed",
			not closed.ok and closed.code == PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED and closed.detail["reopened"] == false,
			str(closed.detail)
	)

	# keep local: writes on top of the server's version
	var r2: PKeyMergeRequest = await _stale_request(rig, "slot1", {"who": "b"})
	var local: PKeyResult = await r2.keep("local")
	t.check(
			"saveKeepLocal: writes this device's save on the server's version",
			local.ok and local.detail["kept"] == "local" and _bare((await saves.read("slot1")).detail["metadata"]) == {"who": "b"} and reg.count() == 0 and events.back()["how"] == "local",
			str(local.detail)
	)
	var after: Dictionary = await _write(rig, "slot1", _noise(100), {"who": "d"})
	t.check("saveKeepLocal: a write after keeping does not repeat the conflict", after["state"] == "done", str(after))
	var bad: PKeyResult = await (await _stale_request(rig, "slot1", {"who": "e"})).keep("sideways")
	t.check("saveKeepOnClosedRequest: an answer that is not a choice is bad_request and opens nothing", not bad.ok and bad.code == PKeyConstants.ErrorCode.BAD_REQUEST and reg.count() == 1)
	await (saves.conflicts()[0] as PKeyMergeRequest).keep("remote")

	# keep both: a new save under <id>.copy, then the next free id
	var r3: PKeyMergeRequest = await _stale_request(rig, "slot1", {"who": "f"})
	var both: PKeyResult = await r3.keep("both")
	t.check("saveKeepBothNeedsFreeSlot: a new save under <id>.copy", both.ok and both.detail["copy_id"] == "slot1.copy" and (await saves.list()).detail.size() == 2, str(both.detail))
	var both2: PKeyResult = await (await _stale_request(rig, "slot1", {"who": "g"})).keep("both")
	t.check("saveKeepBothNeedsFreeSlot: the next free copy id", both2.ok and both2.detail["copy_id"] == "slot1.copy2", str(both2.detail))
	# full: no `both` among the choices, and a keep of it is refused
	var full = _rig(false)
	for n in 16:
		await _write(full, "s%d" % n, _noise(40), {"n": n})
	var fr: PKeyMergeRequest = (await _write(full, "s0", _noise(40), {"n": 99}, {"base_version": 1}))["request"]
	var none: PKeyResult = await fr.keep("both")
	t.check(
			"saveKeepBothNeedsFreeSlot: with the 16 slots in use `both` is not offered",
			fr.choices == ["local", "remote"] and not none.ok and none.code == PKeyConstants.ErrorCode.BAD_REQUEST,
			str(none.detail)
	)
	# a slot that filled after the request opened: the keep fails slots-full and the request reopens with the failure
	var late = _rig(false)
	await _write(late, "s0", _noise(40), {"n": 0})
	var lr: PKeyMergeRequest = (await _write(late, "s0", _noise(40), {"n": 1}, {"base_version": 1}))["request"]
	for n in range(1, 16):
		await _write(late, "s%d" % n, _noise(40), {"n": n})
	var filled: PKeyResult = await lr.keep("both")
	t.check(
			"saveKeepBothNeedsFreeSlot: a slot taken meanwhile is slots-full and the request reopens",
			not filled.ok and filled.detail["code"] == "slots-full" and filled.detail["reopened"] == true and lr.state == "open" and lr.error == "slots-full",
			str(filled.detail)
	)

	# a save deleted elsewhere: no remote, and keeping this device's save uses the must-not-exist precondition
	var gone = _rig(false)
	await _write(gone, "s", _noise(30), {"n": 1})
	var old_row: Dictionary = gone["records"].get_record("s")
	gone["files"].records.erase(gone["records"].wire_id("s"))
	gone["records"].stale_row = old_row
	var del: Dictionary = await _write(gone, "s", _noise(30), {"n": 2})
	var dr: PKeyMergeRequest = del["request"]
	t.check("saveKeepAfterDeleteCreates: a save deleted elsewhere has no remote and no `both`", del["state"] == "conflict" and dr.remote == null and dr.choices == ["local", "remote"], str(del))
	gone["records"].stale_row = null
	var kept_gone: PKeyResult = await dr.keep("local")
	t.check("saveKeepAfterDeleteCreates: keep local sends *", kept_gone.ok and gone["files"].bases.back() == "*", str(kept_gone.detail))

	# a conflict from the metadata set (not the file begin)
	var raced = _rig(false)
	await _write(raced, "s", _noise(30), {"n": 1})
	raced["records"].before_set = func() -> void:
		raced["files"].records[raced["records"].wire_id("s")]["version"] += 5
	var race: Dictionary = await _write(raced, "s", _noise(30), {"n": 2})
	t.check("saveConflictOpensRequest: a metadata set that finds a newer record opens a request with the server's copy", race["state"] == "conflict" and race["request"].remote != null, str(race))
	# the request describes the server's version, not this device's cached copy
	var two = _rig(false)
	await _write(two, "s", _noise(30), {"n": 1})
	var cached: Dictionary = two["records"].get_record("s")
	two["files"].records[two["records"].wire_id("s")]["version"] = 40
	two["records"].stale_row = cached
	var theirs: Dictionary = await _write(two, "s", _noise(30), {"n": 2}, {"base_version": cached["version"]})
	t.check(
			"saveConflictOpensRequest: the server's version wins over this device's cached copy",
			theirs["state"] == "conflict" and theirs["request"].remote["version"] == 40,
			str(theirs)
	)
	var kept_mine: PKeyResult = await theirs["request"].keep("local")
	t.check("saveKeepLocal: after another device's write succeeds", kept_mine.ok, str(kept_mine.detail))
	two["records"].stale_row = null
	var again: Dictionary = await _write(two, "s", _noise(30), {"n": 3})
	t.check("saveKeepLocal: a write after keeping does not repeat the conflict", again["state"] == "done", str(again))
	# a conflict and keeping the other version pull first; saves record when and where
	var pulled = _rig(false, {"device_label": func() -> String: return "Steam Deck", "now": func() -> int: return 1000})
	await _write(pulled, "s", _noise(30), {"n": 1})
	var old_cache: Dictionary = pulled["records"].get_record("s")
	var pw: String = pulled["records"].wire_id("s")
	pulled["files"].records[pw]["version"] = 40
	pulled["files"].records[pw]["value"] = {"n": 9}
	pulled["records"].stale_row = old_cache
	pulled["records"].on_pull = func() -> void: pulled["records"].stale_row = null
	var pc: Dictionary = await _write(pulled, "s", _noise(30), {"n": 2}, {"base_version": old_cache["version"]})
	var pr: PKeyMergeRequest = pc["request"]
	t.check("saveConflictOpensRequest: pulls first, so the other card is the server's copy", pulled["records"].pulls == 1 and pc["state"] == "conflict" and pr.remote["value"] == {"n": 9}, str(pc))
	t.check(
			"saveConflictOpensRequest: this device's card carries when and where it was saved, and which is newer",
			pr.local["saved_at"] == 1000 and pr.local["device"] == "Steam Deck" and pr.local["value"].get("deviceLabel") == "Steam Deck" and pr.newer == null,
			str(pr.local)
	)
	pulled["records"].stale_row = old_cache
	var pk: PKeyResult = await pr.keep("remote")
	t.check("saveKeepRemote: pulls again and answers the version held", pulled["records"].pulls == 2 and pk.ok and pk.detail["kept"] == "remote" and pk.detail["version"] == 40, str(pk.detail))
	# a save deleted elsewhere under a tombstone's version reads as deleted after the pull
	var tomb = _rig(false)
	await _write(tomb, "s", _noise(30), {"n": 1})
	var tomb_row: Dictionary = tomb["records"].get_record("s")
	tomb["records"].stale_row = tomb_row
	var tw: String = tomb["records"].wire_id("s")
	tomb["files"].records[tw]["version"] = 99
	tomb["records"].on_pull = func() -> void:
		tomb["files"].records.erase(tw)
		tomb["records"].stale_row = null
	var tc: Dictionary = await _write(tomb, "s", _noise(30), {"n": 2}, {"base_version": tomb_row["version"]})
	t.check("saveConflictOpensRequest: a tombstone's version after the pull is a deleted save", tc["state"] == "conflict" and tc["request"].remote == null, str(tc))
	# a rejected set
	var rej = _rig(false)
	rej["records"].rejected_code = "quota_exceeded"
	var denied = await _write(rej, "s", _noise(30))
	t.check("rejected: the code travels, no conflict", denied["state"] == "failed" and denied["error"]["code"] == "rejected" and denied["error"]["detail"] == "quota_exceeded", str(denied))
	await _seen_and_exact(t)


# ── the registry over the machine's record requests ─────────────────────────────────────────────

## A machine on a `revision` collection with a registry fed by its events, as the host does.
func _record_rig() -> Dictionary:
	var ids := ["c_000000000000000client1"]
	var m: Variant = Machine.new({
		"product": "demo", "catalog": {"settings": [], "collections": [{"name": "progress", "policy": "revision"}]}, "document": {"values": {}},
		"now": 1760000000000, "offsetMs": 0, "contacted": true, "subject": "sub_alice", "network": "online", "onSignOut": "clear",
		"encryption": "server", "hasRoot": false, "newClientId": func() -> String: return ids.pop_front(),
	})
	var rig := {"m": m, "events": [], "reg": null}
	rig["reg"] = PKeyMergeRegistry.new({
		"machine": func() -> Variant: return m,
		"poke": func() -> void: rig["reg"].feed(m.take_events()),
		"event": func(e: Dictionary) -> void: rig["events"].append(e),
	})
	m.take_requests()
	m.receive({"status": 200, "body": PULL})
	rig["reg"].feed(m.take_events())
	return rig


## Lets go of the registry's callbacks, which name the rig and the machine that hold the registry.
func _drop_rig(rig: Dictionary) -> void:
	(rig["reg"] as PKeyMergeRegistry)._d = {}


## Put on a stale base and answer the push with a conflict: one open request.
func _record_conflict(rig: Dictionary) -> void:
	var m: Variant = rig["m"]
	m.put("progress", "main", {"level": 4})
	m.take_requests()
	var body := PULL.duplicate(true)
	body["cursor"] = 10
	body["lastMutationId"] = 1
	body["changes"] = [{"record": ["progress", "main"], "value": {"level": 5}, "version": 8}]
	body["results"] = [{"mutationId": 1, "status": "conflict", "server": {"value": {"level": 5}, "version": 8}}]
	m.receive({"status": 200, "body": body})
	rig["reg"].feed(m.take_events())


func _record_requests(t: PKeyTestContext) -> void:
	var rig := _record_rig()
	var reg: PKeyMergeRegistry = rig["reg"]
	var m: Variant = rig["m"]
	_record_conflict(rig)
	var open: Array = reg.conflicts()
	t.check(
			"merge: a plain put that lost its compare-and-set opens one request, announced once",
			open.size() == 1 and rig["events"].size() == 1 and rig["events"][0]["type"] == "conflictOpened" and rig["events"][0]["request"] == open[0] and not reg.has_listeners()
	)
	var r: PKeyMergeRequest = open[0]
	t.check(
			"merge: the request reads both copies",
			r.id == "w:progress/main" and r.collection == "progress" and r.record == "main" and r.local["value"] == {"level": 4} and r.local["version"] == 7
				and r.remote["value"] == {"level": 5} and r.remote["version"] == 8 and r.choices == ["local", "remote", "value"] and r.state == "open" and r.newer == null,
			str(r.local)
	)
	var bad: PKeyResult = await r.keep("both")
	t.check("merge: a choice the request does not offer is bad_request", not bad.ok and bad.code == PKeyConstants.ErrorCode.BAD_REQUEST and r.state == "open")
	# keep local: applying until the set is answered, then closed
	var done := {"r": null}
	var run := func() -> void: done["r"] = await r.keep("local")
	run.call()
	t.check("merge: a keep is applying until its set is answered, and a second keep is refused", r.state == "applying" and (await r.keep("remote")).code == PKeyConstants.ErrorCode.BAD_REQUEST)
	var posts: Array = m.take_requests()
	var ok_body := PULL.duplicate(true)
	ok_body["cursor"] = 11
	ok_body["lastMutationId"] = 2
	ok_body["changes"] = [{"record": ["progress", "main"], "value": {"level": 4}, "version": 9}]
	ok_body["results"] = [{"mutationId": 2, "status": "ok", "version": 9}]
	m.receive({"status": 200, "body": ok_body})
	reg.feed(m.take_events())
	t.check(
			"merge: keep local sends one set on the remote version and settles with the new version",
			posts.size() == 1 and posts[0]["body"]["mutations"][0]["baseVersion"] == 8
				and done["r"] is PKeyResult and done["r"].ok and done["r"].detail == {"kept": "local", "version": 9} and reg.conflicts().is_empty(),
			str(done["r"])
	)
	t.check("merge: the close is announced with how", rig["events"].back() == {"type": "conflictClosed", "id": "w:progress/main", "how": "local"})
	var closed: PKeyResult = await r.keep("local")
	t.check("merge: keep on a closed request is sync-merge-closed", not closed.ok and closed.code == PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED)

	# a listener that returns a choice decides inline; one registered late is replayed what is open
	var inline := _record_rig()
	var seen: Array = []
	var off: Callable = inline["reg"].on_conflict(func(req: PKeyMergeRequest) -> Variant:
		seen.append(req.id)
		return "remote")
	_record_conflict(inline)
	t.check(
			"merge: a returned choice decides the request at once: nothing listed, closed as remote",
			seen == ["w:progress/main"] and inline["reg"].conflicts().is_empty() and inline["m"].conflicts().is_empty() and inline["events"].back()["how"] == "remote"
	)
	off.call()
	var late := _record_rig()
	_record_conflict(late)
	var replayed: Array = []
	late["reg"].on_conflict(func(req: PKeyMergeRequest) -> void: replayed.append(req.id))
	t.check("merge: a listener is replayed the requests already open", replayed == ["w:progress/main"] and late["reg"].count() == 1)
	var value_run := {"r": null}
	var req2: PKeyMergeRequest = late["reg"].conflicts()[0]
	var run2 := func() -> void: value_run["r"] = await req2.keep({"value": {"level": 9}})
	run2.call()
	var push: Array = late["m"].take_requests()
	t.check(
			"merge: keep with a value sends that value on the remote version",
			push.size() == 1 and push[0]["body"]["mutations"][0]["value"] == {"level": 9} and push[0]["body"]["mutations"][0]["baseVersion"] == 8
	)
	# the keep's set conflicts again: the request reopens and the keep settles as reopened
	var again := PULL.duplicate(true)
	again["cursor"] = 11
	again["lastMutationId"] = 2
	again["changes"] = [{"record": ["progress", "main"], "value": {"level": 6}, "version": 10}]
	again["results"] = [{"mutationId": 2, "status": "conflict", "server": {"value": {"level": 6}, "version": 10}}]
	late["m"].receive({"status": 200, "body": again})
	late["reg"].feed(late["m"].take_events())
	t.check(
			"merge: a keep that conflicts again reopens the request on the new remote",
			value_run["r"] is PKeyResult and not value_run["r"].ok and value_run["r"].detail["reopened"] == true and req2.state == "open" and req2.remote["version"] == 10,
			str(value_run["r"])
	)
	for dropped: Dictionary in [rig, inline, late]:
		_drop_rig(dropped)


## S2, the exact write that supersedes (S3) and S5 (memory only).
func _seen_and_exact(t: PKeyTestContext) -> void:
	var events: Array = []
	var reg := PKeyMergeRegistry.new({"event": func(e: Dictionary) -> void: events.append(e)})
	var rig = _rig(false, {"merge": reg})
	var first = await _write(rig, "slot1", _noise(100), {"who": "a"})
	# S2: a fresh session has seen nothing, so the write is create-only and meets the other device's save
	var fresh := PKeySaves.new(rig["deps"])
	var blind: Dictionary = await fresh.write("slot1", _noise(100), {"who": "b"}).wait()
	t.check(
			"saveBaseIsSeenVersion: a slot not seen this session is create-only and conflicts with an existing save",
			blind["state"] == "conflict" and blind["request"].local["version"] == null and blind["request"].remote["version"] == first["version"],
			str(blind)
	)
	await blind["request"].keep("remote")
	# listing (or reading) the slot makes its version the base
	var listing := PKeySaves.new(rig["deps"])
	await listing.list()
	var listed: Dictionary = await listing.write("slot1", _noise(100), {"who": "c"}).wait()
	t.check("saveBaseIsSeenVersion: a listed version is the base", listed["state"] == "done" and listed["version"] > first["version"], str(listed))
	var reading := PKeySaves.new(rig["deps"])
	await reading.read("slot1")
	var read_then: Dictionary = await reading.write("slot1", _noise(100), {"who": "d"}).wait()
	t.check(
			"saveBaseIsSeenVersion: a read version is the base, and this device's own write moves it",
			read_then["state"] == "done" and (await reading.write("slot1", _noise(100), {"who": "e"}).wait())["state"] == "done"
	)
	# another device writes behind this one: the seen version is stale, and a pull never refreshes it
	var wire: String = rig["records"].wire_id("slot1")
	rig["files"].records[wire]["version"] += 3
	var behind: Dictionary = await reading.write("slot1", _noise(100), {"who": "f"}).wait()
	t.check("saveBaseIsSeenVersion: another device's newer save is a conflict, not an overwrite", behind["state"] == "conflict", str(behind))
	# an exact write (a base) supersedes the open request and is sent as asked
	var req: PKeyMergeRequest = behind["request"]
	var current: int = rig["files"].records[wire]["version"]
	var exact: Dictionary = await reading.write("slot1", _noise(100), {"who": "g"}, {"base_version": current}).wait()
	t.check(
			"saveExactWriteSupersedes: a write with a base closes the request as superseded and is sent",
			exact["state"] == "done" and reading.conflicts().is_empty() and events.back()["type"] == "conflictClosed" and events.back()["id"] == req.id and events.back()["how"] == "superseded",
			str(exact)
	)
	var gone: PKeyResult = await req.keep("local")
	t.check("saveExactWriteSupersedes: keep on the superseded request is sync-merge-closed", not gone.ok and gone.code == PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED)
	# S5: a request is memory only
	var held: Dictionary = await _write(rig, "slot1", _noise(100), {"who": "h"}, {"base_version": 1})
	var journaled: Array = rig["journal"].list()
	t.check("saveRequestNotJournaled: the transfer journal holds no request", held["state"] == "conflict" and journaled.all(func(k: String) -> bool: return not k.begins_with("w:")), str(journaled))
	var fresh_deps: Dictionary = rig["deps"].duplicate()
	fresh_deps["merge"] = PKeyMergeRegistry.new()
	var relaunched := PKeySaves.new(fresh_deps)
	t.check(
			"saveRequestNotJournaled: a relaunch holds none, and the next write raises the conflict again through S2",
			relaunched.conflicts().is_empty() and (await relaunched.write("slot1", _noise(100), {"who": "i"}).wait())["state"] == "conflict"
	)


func _delete(t: PKeyTestContext) -> void:
	var rig = _rig(false)
	var saves: PKeySaves = rig["saves"]
	await _write(rig, "slot1", _noise(50))
	var stale = await saves.delete("slot1", 1)
	t.check("delete: a stale base is a conflict with the server's copy", not stale.ok and stale.detail["reason"] == "conflict" and stale.detail["server"]["id"] == "slot1", str(stale.detail))
	var gone = await saves.delete("nope")
	t.check("delete: a save that does not exist is rejected not_found", not gone.ok and gone.detail["reason"] == "rejected" and gone.detail["wire_code"] == "not_found")
	var ok = await saves.delete("slot1")
	t.check("delete: with no base, the current version", ok.ok and (await saves.list()).detail.is_empty(), str(ok.detail))
	var bad = await saves.delete("bad id!")
	t.check("delete: an id that is not a key is invalid", not bad.ok and bad.code == PKeyConstants.ErrorCode.INVALID_ARGUMENT)


# ── pause, resume, cancel ───────────────────────────────────────────────────────────────────────

func _pause_cancel(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# cancel while the metadata write waits: the waiting write settles as cancelled
	var rig = _rig(false)
	rig["records"].hold_set = true
	var h: PKeyTransfer = rig["saves"].write("slot1", _noise(100), {})
	var waited := 0
	while rig["records"].set_calls == 0 and waited < 600:
		await tree.process_frame
		waited += 1
	t.check("cancel: the write reached the metadata set and waits", rig["records"].set_calls == 1 and h.outcome == null and rig["saves"].transfers().size() == 1, str(h.state))
	await h.cancel()
	t.check("cancel: the waiting write settles as cancelled, not failed", h.outcome != null and h.outcome["state"] == "cancelled" and h.state == "cancelled")
	t.check(
			"cancel: transferDone with state cancelled, no transferFailed",
			_types(rig["events"]).has("transferDone") and rig["events"].back()["state"] == "cancelled" and not _types(rig["events"]).has("transferFailed")
	)
	t.check("cancel: the handle leaves transfers()", rig["saves"].transfers().is_empty())

	# pause between steps, resume carries on
	var rig2 = _rig(false)
	var gate := [false]
	rig2["files"].before_put = func() -> void:
		while not gate[0]:
			await tree.process_frame
	var p: PKeyTransfer = rig2["saves"].write("slot1", _noise(100), {"k": 1})
	var spins := 0
	while not rig2["files"].calls.has("put") and spins < 600:
		await tree.process_frame
		spins += 1
	p.pause()
	gate[0] = true
	spins = 0
	while p.state != "paused" and spins < 600:
		await tree.process_frame
		spins += 1
	t.check("pause: the transfer is paused and still listed", p.state == "paused" and rig2["saves"].transfers().size() == 1 and p.outcome == null, str(p.state))
	p.resume()
	var out = await p.wait()
	t.check("resume: the write carries on to done", out["state"] == "done" and (await rig2["saves"].list()).detail.size() == 1, str(out))

	# cancel in the engine's hands releases the upload
	var rig3 = _rig(false)
	var gate3 := [false]
	rig3["files"].before_put = func() -> void:
		while not gate3[0]:
			await tree.process_frame
	var c: PKeyTransfer = rig3["saves"].write("slot1", _noise(100), {})
	spins = 0
	while not rig3["files"].calls.has("put") and spins < 600:
		await tree.process_frame
		spins += 1
	var done := [false]
	var cancelling := func() -> void:
		await c.cancel()
		done[0] = true
	cancelling.call()
	gate3[0] = true
	spins = 0
	while not done[0] and spins < 600:
		await tree.process_frame
		spins += 1
	t.check("cancel mid-upload: cancelled, the Worker's upload is released", c.outcome != null and c.outcome["state"] == "cancelled" and rig3["files"].aborted.size() == 1, str(c.outcome))


# ── D-11: a journaled upload no live write holds is told once as transferFailed ─────────────────

func _journaled(id: String) -> Dictionary:
	return {"v": 1, "id": id, "kind": "upload", "collection": "saves", "record": "slot", "uploadId": "u1", "mode": "single",
			"partBytes": null, "done": [], "sha256": "0".repeat(64), "size": 10, "expiresAt": 9999999999, "state": "uploading"}


func _interrupted(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var rig = _rig(false)
	var saves: PKeySaves = rig["saves"]
	rig["journal"].put("saves:slot1", _journaled("saves:slot1"))
	rig["journal"].put("saves:slot2", _journaled("saves:slot2"))
	var told: Array = saves.surface_interrupted(rig["journal"].list())
	var failed: Array = rig["events"].filter(func(e: Dictionary) -> bool: return e["type"] == "transferFailed")
	t.check(
			"interrupted: each journaled upload is told as transferFailed",
			told.size() == 2 and failed.size() == 2 and failed[0]["code"] == "transfer-failed" and failed[0]["id"].begins_with("saves:"),
			str(failed)
	)
	t.check("interrupted: told once", saves.surface_interrupted(rig["journal"].list()).is_empty() and rig["events"].size() == 2)
	t.check("interrupted: no bytes or token in the event", str(failed).find("pkeyt_") < 0 and failed[0].keys().size() == 3)
	# a live write holds its own id: not told
	var rig2 = _rig(false)
	var gate := [false]
	rig2["files"].before_put = func() -> void:
		while not gate[0]:
			await tree.process_frame
	var h: PKeyTransfer = rig2["saves"].write("slot1", _noise(100), {})
	rig2["journal"].put("saves:slot1", _journaled("saves:slot1"))
	rig2["journal"].put("saves:slot9", _journaled("saves:slot9"))
	var told2: Array = rig2["saves"].surface_interrupted(rig2["journal"].list())
	t.check("interrupted: a live write is not told", told2 == ["saves:slot9"], str(told2))
	gate[0] = true
	await h.wait()
	# the retry is a plain write again
	var again = await _write(rig, "slot1", _noise(50), {})
	t.check("interrupted: write(id, bytes) again runs as normal", again["state"] == "done", str(again))


# ── cancel is terminal; a result computed off-thread under an old root is thrown away ───────────

func _stale_off_thread(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var gate := [false]
	# cancel, then pause: cancel still settles
	var rig = _rig(false)
	rig["files"].before_put = func() -> void:
		while not gate[0]:
			await tree.process_frame
	var h: PKeyTransfer = rig["saves"].write("a", _noise(100), {})
	var spins := 0
	while not rig["files"].calls.has("put") and spins < 600:
		await tree.process_frame
		spins += 1
	var done := [false]
	var cancelling := func() -> void:
		await h.cancel()
		done[0] = true
	cancelling.call()
	h.pause()
	h.resume()
	gate[0] = true
	spins = 0
	while not done[0] and spins < 600:
		await tree.process_frame
		spins += 1
	t.check("cancel then pause: the cancel settles", done[0] and h.outcome["state"] == "cancelled", str(h.outcome))

	# cancel a paused transfer, then resume in the same frame: still cancelled
	var rig2 = _rig(false)
	var gate2 := [false]
	rig2["files"].before_put = func() -> void:
		while not gate2[0]:
			await tree.process_frame
	var p: PKeyTransfer = rig2["saves"].write("a", _noise(100), {})
	spins = 0
	while not rig2["files"].calls.has("put") and spins < 600:
		await tree.process_frame
		spins += 1
	p.pause()
	gate2[0] = true
	spins = 0
	while p.state != "paused" and spins < 600:
		await tree.process_frame
		spins += 1
	var done2 := [false]
	var cancelling2 := func() -> void:
		await p.cancel()
		done2[0] = true
	cancelling2.call()
	p.resume()
	spins = 0
	while not done2[0] and spins < 600:
		await tree.process_frame
		spins += 1
	t.check("cancel of a paused transfer, then resume: cancelled", done2[0] and p.outcome["state"] == "cancelled", str(p.state))

	# purge with a paused transfer returns
	var rig3 = _rig(false)
	var gate3 := [false]
	rig3["files"].before_put = func() -> void:
		while not gate3[0]:
			await tree.process_frame
	var q: PKeyTransfer = rig3["saves"].write("a", _noise(100), {})
	spins = 0
	while not rig3["files"].calls.has("put") and spins < 600:
		await tree.process_frame
		spins += 1
	q.pause()
	gate3[0] = true
	spins = 0
	while q.state != "paused" and spins < 600:
		await tree.process_frame
		spins += 1
	await rig3["saves"].purge()
	t.check("purge with a paused transfer returns and the transfer is cancelled", q.outcome != null and q.outcome["state"] == "cancelled" and rig3["saves"].transfers().is_empty())

	# a seal queued before a lock is discarded
	var ring := Ring.new()
	var g := Codec.Guarded.new(Codec.E2e.new(ring.root, "saves"), func() -> bool: return ring.locked)
	var plain := _noise(200 * 1024)
	var out := [null]
	var sealing := func() -> void:
		out[0] = await Transfer.Support.codec_off(g, "seal_whole", [plain], plain.size(), PackedByteArray())
	sealing.call()
	ring.locked = true
	spins = 0
	while out[0] == null and spins < 2000:
		await tree.process_frame
		spins += 1
	t.check("seal started before a lock: the result is thrown away and the codec says why", out[0] != null and out[0].is_empty() and g.tripped)
	var ring2 := Ring.new()
	var g2 := Codec.Guarded.new(Codec.E2e.new(ring2.root, "saves"), func() -> bool: return ring2.locked)
	var sealed: PackedByteArray = g2.seal_whole(plain)
	var res := [null]
	var opening := func() -> void:
		res[0] = await Transfer.Support.codec_off(g2, "open_whole", [sealed], sealed.size(), {"ok": false, "reason": "locked"})
	opening.call()
	ring2.locked = true
	spins = 0
	while res[0] == null and spins < 2000:
		await tree.process_frame
		spins += 1
	t.check("open started before a lock: nothing is handed on", res[0] == {"ok": false, "reason": "locked"})
	# the sealed cache is keyed by the root generation
	t.check("sealed cache: a different generation is not reused", PKeySaves.sealed_gen_of([PackedByteArray([1]), 3]) == 3 and PKeySaves.sealed_gen_of([null]) == null)


# ── locked ──────────────────────────────────────────────────────────────────────────────────────

func _locked(t: PKeyTestContext) -> void:
	var rig = _rig(true)
	await _write(rig, "slot1", _noise(200), {"a": 1})
	rig["ring"].locked = true
	var listed = await rig["saves"].list()
	t.check("locked: list is sync-locked", not listed.ok and listed.code == PKeyConstants.ErrorCode.SYNC_LOCKED)
	var read = await rig["saves"].read("slot1")
	t.check("locked: read is sync-locked", not read.ok and read.code == PKeyConstants.ErrorCode.SYNC_LOCKED)
	var w = await _write(rig, "slot2", _noise(50))
	t.check("locked: a write is failed sync-locked, nothing sent", w["state"] == "failed" and w["error"]["code"] == "sync-locked" and rig["files"].puts.size() == 1, str(w))
	var d = await rig["saves"].delete("slot1", 2)
	t.check("locked: delete is sync-locked", not d.ok and d.code == PKeyConstants.ErrorCode.SYNC_LOCKED)

	# the ring locks in the middle of a transfer: nothing more is sealed or sent, and the error is sync-locked
	var mid = _rig(true)
	var inner: Callable = mid["saves"]._d["file_codec"]
	mid["saves"]._d["file_codec"] = func() -> Variant:
		var c: Variant = inner.call()
		mid["ring"].locked = true
		return c
	var out = await _write(mid, "slot1", _noise(300))
	t.check(
			"locked mid-transfer: the write fails sync-locked, nothing is uploaded and the metadata is never set",
			out["state"] == "failed" and out["error"]["code"] == "sync-locked" and mid["records"].set_calls == 0 and mid["files"].calls.is_empty(),
			str(out)
	)
	# the seal itself: a ring that locks after the codec was made gives nothing to upload
	var sealing = _rig(true)
	var guarded = sealing["saves"]._d["file_codec"].call()
	sealing["ring"].locked = true
	var nothing: PackedByteArray = await sealing["saves"]._seal(guarded, _noise(100))
	t.check("locked: a whole-file seal after the lock is empty and the codec says why", nothing.is_empty() and guarded.tripped)

	# a read whose ring locks while the file is fetched
	var rd = _rig(true)
	await _write(rd, "slot1", _noise(300))
	rd["files"].before_get = func() -> void:
		rd["ring"].locked = true
	var during = await rd["saves"].read("slot1")
	t.check("locked mid-read: the open refuses and the read is sync-locked, not a file error", not during.ok and during.code == PKeyConstants.ErrorCode.SYNC_LOCKED, str(during.detail))
	var failed := _types(rd["events"])
	t.check("locked mid-read: transferFailed carries sync-locked", failed.has("transferFailed") and rd["events"].back()["code"] == "sync-locked", str(rd["events"].back()))


# ── delta files ─────────────────────────────────────────────────────────────────────────────────

func _chunked(t: PKeyTestContext) -> void:
	var rig = _rig(false, {"delta": true})
	var data := _noise(MIB + 300000)
	var out = await _write(rig, "big", data, {"chapter": "x"})
	t.check("delta: a save over 1 MiB is sent as chunks", out["state"] == "done" and out["file"]["format"] == "chunks", str(out))
	var r = await rig["saves"].read("big")
	t.check("delta: it reads back byte for byte", r.ok and r.detail["bytes"] == data and r.detail["file"]["format"] == "chunks")


# ── unsupported platforms ───────────────────────────────────────────────────────────────────────

func _unsupported(t: PKeyTestContext) -> void:
	var rig = _rig(false, {"supported": func() -> bool: return false})
	var saves: PKeySaves = rig["saves"]
	var results: Array = [await saves.list(), await saves.read("a"), await saves.revisions("a"), await saves.delete("a")]
	var all := true
	for r: PKeyResult in results:
		all = all and not r.ok and r.code == &"unsupported"
	t.check("unsupported: list, read, revisions and delete answer the typed unsupported refusal", all, str(results[0].detail))
	var u: PKeyResult = results[0]
	t.check(
			"unsupported: it names sync.saves and the dependency reason",
			str(u.detail).contains("sync.saves") and str(u.detail).contains("dependency") and str(u.message).contains("native plugin"),
			str(u.detail)
	)
	var h: PKeyTransfer = saves.write("a", _noise(10), {})
	t.check(
			"unsupported: a write is over at once, failed unsupported, nothing sent",
			h.outcome != null and h.outcome["state"] == "failed" and h.outcome["error"]["code"] == "unsupported" and rig["files"].calls.is_empty()
	)
	var na: Array = PKeyConstants.capabilities()["sync.saves"].get("na", [])
	t.check("unsupported: the capability table has no N/A runtime for sync.saves", na.is_empty(), str(na))
	await _mobile_matrix(t)


## A native-lane stand-in: only its name and bound matter to the gate.
class GateLane:
	extends PKeyPeerCrypto

	func lane_name() -> String:
		return "gate-native"

	func sync_native() -> bool:
		return true

	func sync_max_bytes() -> int:
		return 1048576


## iOS and Android alike are `mobile_override = 1`; the lane is what differs (GM.3, D-2).
func _mobile_matrix(t: PKeyTestContext) -> void:
	for lane_on: bool in [false, true]:
		for os_name: String in ["ios", "android"]:
			var tag := "mobile %s %s" % [os_name, "native" if lane_on else "no plugin"]
			PKeySyncAead.mobile_override = 1
			PKeySyncAead.use_lane_for_tests(GateLane.new() if lane_on else null)
			var rig = _rig(false, {"supported": null})
			var saves: PKeySaves = rig["saves"]
			var supported := PKeySaves.runtime_supported()
			var r: PKeyResult = await saves.read("a")
			var w: PKeyTransfer = saves.write("a", _noise(10), {})
			var d: PKeyResult = await rig["engine"].download({"size": 0, "codec": Codec.Server.new()})
			if lane_on:
				t.check(tag + ": supported, the calls go through", supported and r.code != &"unsupported" and d.code != &"unsupported", str(r.detail))
			else:
				var det := str(r.detail)
				t.check(tag + ": typed unsupported, reason dependency", not supported and r.code == &"unsupported" and det.contains("dependency") and not det.contains("runtime"), det)
				t.check(tag + ": a write is over at once and sends nothing", w.outcome != null and w.outcome["error"]["code"] == "unsupported" and rig["files"].calls.is_empty())
				t.check(tag + ": the file engine says the same", d.code == &"unsupported" and str(d.detail).contains("dependency"), str(d.detail))
	PKeySyncAead.mobile_override = 0
	PKeySyncAead.use_lane_for_tests(null)
	t.check("mobile: a desktop runtime is supported with no lane", PKeySaves.runtime_supported())
	PKeySyncAead.mobile_override = -1


# ── sign-out: lock, purge the saves, then remove the pin ────────────────────────────────────────

class OrderRing:
	extends RefCounted
	var log: Array
	var locked := false

	func _init(p_log: Array) -> void:
		log = p_log

	func lock() -> void:
		locked = true
		log.append("lock")

	func forget() -> PKeyResult:
		log.append("forget")
		return PKeyResult.success()


func _purge_order(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("saves_purge")
	var log: Array = []
	var rig = _rig(false)
	var tree := Engine.get_main_loop() as SceneTree
	# a write waiting on the metadata set, a journal record, and a chunk-cache tree for two people
	rig["records"].hold_set = true
	var h: PKeyTransfer = rig["saves"].write("slot1", _noise(100), {})
	var spins := 0
	while rig["records"].set_calls == 0 and spins < 600:
		await tree.process_frame
		spins += 1
	var cache_root := dir.path_join(PKeyChunkCache.DIR_NAME)
	DirAccess.make_dir_recursive_absolute(cache_root.path_join("aaa").path_join("bbb"))
	var f := FileAccess.open(cache_root.path_join("aaa").path_join("bbb").path_join("x"), FileAccess.WRITE)
	f.store_string("x")
	f.close()
	var journal := Journal.Files.new(dir)
	journal.put("saves:other", {"id": "saves:other"})
	rig["saves"]._d["purge_files"] = func() -> void:
		log.append("purge-files")
		journal.clear()
		CloudSync._remove_tree(cache_root)
	var api := CloudSync.new()
	api.saves = rig["saves"]
	api._keyring = OrderRing.new(log)
	await api._forget()
	t.check("forget: lock the ring, then purge the saves, then remove the pin", log == ["lock", "purge-files", "forget"], str(log))
	t.check(
			"forget: the waiting write is settled as dropped and the transfer cancelled",
			rig["records"].dropped == 1 and h.outcome != null and h.outcome["state"] == "cancelled" and rig["saves"].transfers().is_empty(),
			str(h.outcome)
	)
	t.check("forget: the chunk cache tree is gone (every person's)", not DirAccess.dir_exists_absolute(cache_root))
	t.check("forget: the transfer journal is empty", journal.get_record("saves:other") == null)
	PKeyTestFixtures.remove_tree(dir)


# ── the records binding over a real host ────────────────────────────────────────────────────────

## A codec with a root, no encryption, and a record of what it was asked.
class SpyCodec:
	extends CodecPort
	var pulls: Array = []

	func locked() -> bool:
		return false

	func attach(_l: Callable) -> Callable:
		return func() -> void: pass

	func seal_push(body: Dictionary, _routes: Array) -> Dictionary:
		return {"ok": true, "body": body}

	func open_pull(body: Dictionary, _m: Variant, _a: Variant, _k: Array, record_keys: Array = []) -> Dictionary:
		pulls.append(record_keys.duplicate(true))
		var rows: Array = []
		for c in body.get("changes", []):
			rows.append({"sealed": false, "seq": c.get("version")} if c.has("record") else {"sealed": true})
		return {"ok": true, "body": body, "opened": {"changes": rows}}


func _make_host(tag: String, handler: Callable, codec: Object = null, encryption := "server") -> Dictionary:
	var server := PKeyTestFixtures.new_server(handler)
	var dir := PKeyTestFixtures.scratch_dir("saves_host_" + tag)
	var host: Node = Host.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var clock := [1760000000000]
	var deps := {
		"product": PRODUCT,
		"state_dir": dir,
		"sealer": PKeyFakeSealer.new(),
		"token": func() -> String: return "pkeyt_secret",
		"session_subject": func() -> Variant: return null,
		"headers": func(x: Dictionary) -> Dictionary: return x,
		"url": func(path: String) -> String: return server.base_url() + path,
		"discovery": func() -> Variant: return null,
		"fetch_schema": func() -> Variant: return null,
		"document": func() -> Dictionary: return {"values": {}, "locked": []},
		"clock": func() -> int: return clock[0],
	}
	if codec != null:
		deps["codec"] = codec
	host.configure(deps, {"encryption": encryption, "catalog": {"schemaVersion": 1, "entries": [], "cloudSync": {"collections": [{"name": "saves", "template": "saves"}]}}})
	return {"host": host, "server": server, "dir": dir}


func _free_host(c: Dictionary) -> void:
	c["host"].close()
	c["host"].queue_free()
	c["server"].stop()
	PKeyTestFixtures.remove_tree(c["dir"])


func _records_binding(t: PKeyTestContext) -> void:
	# The Worker: slot1 at version 3 with a file, a push answers per mutation.
	var state := {"slot1": 3}
	var pushes: Array = []
	var handler := func(req: Dictionary) -> Dictionary:
		if req["method"] == "GET":
			return {"status": 200, "body": JSON.stringify({"cursor": 1, "changes": [{"record": ["saves", "slot1"], "version": 3, "value": {"chapter": "one"}, "file": POINTER}, {"record": ["saves", "filesonly"], "version": 1, "file": POINTER}], "tombstones": [], "serverNow": 1760000000000})}
		var body: Dictionary = JSON.parse_string(req["body"].get_string_from_utf8())
		pushes.append(body)
		var results := []
		for m: Dictionary in body["mutations"]:
			var id: String = m["target"]["record"][1]
			var base: Variant = m.get("baseVersion")
			var create_only: bool = base is String and base == "*"
			var stale: bool = (create_only and state.has(id)) or (not create_only and (not state.has(id) or int(base) != state[id]))
			if id == "deny":
				results.append({"mutationId": m["mutationId"], "status": "rejected", "code": "quota_exceeded"})
			elif stale:
				results.append({"mutationId": m["mutationId"], "status": "conflict", "server": {"version": state.get(id, 9), "value": {"chapter": "theirs"}, "file": POINTER}})
			elif m["op"] == "delete":
				state.erase(id)
				results.append({"mutationId": m["mutationId"], "status": "ok", "version": int(base) + 1})
			else:
				state[id] = (0 if create_only else int(base)) + 1
				results.append({"mutationId": m["mutationId"], "status": "ok", "version": state[id]})
		return {"status": 200, "body": JSON.stringify({"results": results, "cursor": 2, "serverNow": 1760000000000})}
	var c = _make_host("records", handler)
	var host: Node = c["host"]
	await host.start()
	host.sign_in("sub_a")
	host.touch()
	await host.idle()
	var records := SavesRecords.new(host, func(_c: String, id: String) -> String: return id)
	var rows: Array = records.list()
	var ids := []
	for r: Dictionary in rows:
		ids.append(r["id"])
	t.check(
			"records: the machine's rows, by id, a file-only row with an empty value",
			ids == ["filesonly", "slot1"] and rows[0]["value"] == {} and rows[0]["file"]["version"] == 3 and rows[1]["value"] == {"chapter": "one"} and rows[1]["file"]["format"] == "whole",
			str(rows)
	)
	t.check("records: get finds one, or null", records.get_record("slot1")["version"] == 3 and records.get_record("zzz") == null)
	t.check("records: wire_id is the id in server mode", records.wire_id("slot1") == "slot1" and not records.e2e())
	var ok: Dictionary = await records.set_record("slot1", {"chapter": "two"}, 3)
	t.check("records: a write at the exact version is ok with the version the Worker answered", ok == {"ok": true, "version": 4}, str(ok))
	var sent: Dictionary = pushes.back()["mutations"][0]
	t.check("records: it went as an exact set, with no journal-only member", sent["op"] == "set" and sent["baseVersion"] == 3 and not sent.has("ticket"), str(sent))
	t.check("records: the machine's row is the acknowledged one, its file kept", host.machine().records("saves")[1]["version"] == 4 and host.machine().records("saves")[1]["file"]["version"] == 3)
	var stale: Dictionary = await records.set_record("slot1", {"chapter": "three"}, 3)
	t.check(
			"records: a stale base is a conflict with the server's copy",
			not stale["ok"] and stale["reason"] == "conflict" and stale["server"]["id"] == "slot1" and stale["server"]["value"] == {"chapter": "theirs"} and stale["server"]["file"]["version"] == 3,
			str(stale)
	)
	var denied: Dictionary = await records.set_record("deny", {"a": 1}, "*")
	t.check("records: a rejection carries its code", denied == {"ok": false, "reason": "rejected", "code": "quota_exceeded"}, str(denied))
	var created: Dictionary = await records.set_record("fresh", {"a": 1}, "*")
	t.check("records: create-only with * creates", created["ok"] and created["version"] == 1)
	var pointer := {"version": 1, "size": 7, "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "format": "whole"}
	var with_file: Dictionary = await records.set_record("fresh2", {"a": 1}, "*", null, pointer)
	t.check(
			"records: a write that gives the finalized pointer lists its file at once (no pull)",
			with_file["ok"] and records.get_record("fresh2")["file"] == pointer and records.list().any(func(r: Dictionary) -> bool: return r["id"] == "fresh2" and r["file"] == pointer),
			str(records.get_record("fresh2"))
	)
	t.check("records: the pointer is never sent", not pushes.back()["mutations"][0].has("file"), str(pushes.back()))
	t.check("records: without a pointer a new row has no file", records.get_record("fresh")["file"] == null)
	var gone: Dictionary = await records.delete_record("fresh", 1)
	t.check("records: remove_at deletes at the exact version and the row goes", gone["ok"] and records.get_record("fresh") == null, str(gone))

	# a cancel ends the wait; the late answer is ignored
	var held := [true]
	c["server"].handler = func(req: Dictionary) -> Dictionary:
		if req["method"] == "POST" and held[0]:
			return {"hang": true}
		return handler.call(req)
	var cancel := Transfer.Cancel.new()
	var waiting_result := [null]
	var runner := func() -> void:
		waiting_result[0] = await records.set_record("slot9", {"a": 1}, "*", cancel)
	runner.call()
	var spins := 0
	while pushes.size() < 3 and spins < 600:
		await (Engine.get_main_loop() as SceneTree).process_frame
		spins += 1
	cancel.cancelled = true
	spins = 0
	while waiting_result[0] == null and spins < 600:
		await (Engine.get_main_loop() as SceneTree).process_frame
		spins += 1
	t.check("records: a cancel ends the wait as aborted", waiting_result[0] == {"ok": false, "reason": "aborted"}, str(waiting_result[0]))
	# a sign-out drops a write that is waiting
	var dropped_result := [null]
	var runner2 := func() -> void:
		dropped_result[0] = await records.set_record("slot8", {"a": 1}, "*")
	runner2.call()
	spins = 0
	while host.machine().status()["pending"] < 1 and spins < 600:
		await (Engine.get_main_loop() as SceneTree).process_frame
		spins += 1
	host.machine().sign_out(true)
	host.deliver_events()
	spins = 0
	while dropped_result[0] == null and spins < 600:
		await (Engine.get_main_loop() as SceneTree).process_frame
		spins += 1
	t.check("records: a sign-out settles a waiting write as rejected signed-out", dropped_result[0] == {"ok": false, "reason": "rejected", "code": "signed-out"}, str(dropped_result[0]))
	t.check("records: signed out, the rows are empty", records.list().is_empty())
	var signed_out: Dictionary = await records.set_record("a", {}, "*")
	t.check("records: a write while signed out is rejected signed-out", signed_out == {"ok": false, "reason": "rejected", "code": "signed-out"}, str(signed_out))
	# drop_all settles whatever waits
	host.sign_in("sub_a")
	var dropped_all := [null]
	var runner3 := func() -> void:
		dropped_all[0] = await records.set_record("slot7", {"a": 1}, "*")
	runner3.call()
	await (Engine.get_main_loop() as SceneTree).process_frame
	records.drop_all()
	spins = 0
	while dropped_all[0] == null and spins < 600:
		await (Engine.get_main_loop() as SceneTree).process_frame
		spins += 1
	t.check("records: drop_all settles a waiting write as dropped", dropped_all[0] == {"ok": false, "reason": "rejected", "code": "signed-out"}, str(dropped_all[0]))
	held[0] = false
	_free_host(c)


func _host_record_keys(t: PKeyTestContext) -> void:
	var codec := SpyCodec.new()
	var handler := func(req: Dictionary) -> Dictionary:
		return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 1, "changes": [{"record": ["saves", "x:blindedid"], "version": 1, "file": POINTER}], "tombstones": [], "serverNow": 1760000000000})}
	var c = _make_host("keys", handler, codec, "e2e")
	var host: Node = c["host"]
	await host.start()
	host.sign_in("sub_a")
	host.touch()
	await host.idle()
	var m: Variant = host.machine()
	m.set_network("offline")
	m.set_network("online")
	host.touch()
	await host.idle()
	t.check(
			"host: every pull is opened with the records the machine holds",
			codec.pulls.size() >= 2 and codec.pulls[0] == [] and codec.pulls[codec.pulls.size() - 1] == [["saves", "x:blindedid"]],
			str(codec.pulls)
	)
	t.check(
			"host: the saves collection is declared to the machine",
			m.put_at("saves", "a", {}, "*")["ok"] and not m.put_at("other", "a", {}, "*")["ok"] and m.put_at("other", "a", {}, "*")["error"] == "collection-unknown"
	)
	_free_host(c)


# ── the whole stack: PolarisKey.cloud_sync.saves over a loopback Worker ─────────────────────────

## One record's file and metadata, served by a Worker that speaks the sync and the file routes.
class Worker:
	extends RefCounted
	var version := 0
	var value: Variant = null
	var file: Variant = null
	var data := PackedByteArray()
	var upload := {}
	var paths: Array = []

	func handle(req: Dictionary) -> Dictionary:
		var path: String = req["path"]
		paths.append("%s %s" % [req["method"], path])
		var base := "/diceroll/sync/files/saves/slot1"
		if path == "/diceroll/config/schema" and req["method"] == "GET":
			var schema := {"schemaVersion": 1, "entries": [], "cloudSync": {"collections": [{"name": "saves", "template": "saves"}]}}
			return {"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify(schema)}
		if path.begins_with("/diceroll/sync?"):
			var changes := []
			if version > 0:
				changes.append({"record": ["saves", "slot1"], "version": version, "value": value, "file": file})
			return {"status": 200, "body": JSON.stringify({"cursor": version + 1, "changes": changes, "tombstones": [], "serverNow": 1760000000000})}
		if path == "/diceroll/sync/ops":
			var body: Dictionary = JSON.parse_string(req["body"].get_string_from_utf8())
			var results := []
			for m: Dictionary in body["mutations"]:
				if int(m["baseVersion"]) != version:
					results.append({"mutationId": m["mutationId"], "status": "conflict", "server": {"version": version, "value": value, "file": file}})
				else:
					version += 1
					value = m.get("value")
					results.append({"mutationId": m["mutationId"], "status": "ok", "version": version})
			return {"status": 200, "body": JSON.stringify({"results": results, "cursor": version + 1, "serverNow": 1760000000000})}
		if path == base + "/begin":
			var b: Dictionary = JSON.parse_string(req["body"].get_string_from_utf8())
			var want: Variant = b.get("baseVersion")
			if (want is String and version != 0) or (not (want is String) and int(want) != version):
				return {"status": 409, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "revision_conflict"}, "server": {"version": version}})}
			upload = {"size": b["size"], "sha256": b["sha256"], "format": b["format"]}
			return {"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify({"uploadId": "up1", "mode": "single", "expiresAt": 1760086400000})}
		if path == base + "/upload/up1":
			data = req["body"]
			return {"status": 204}
		if path == base + "/finalize":
			version += 1
			file = {"version": version, "size": upload["size"], "sha256": upload["sha256"], "format": upload["format"]}
			return {"status": 200, "headers": {"content-type": "application/json"}, "body": JSON.stringify(file)}
		if path.begins_with(base) and req["method"] == "GET":
			var rng: String = req["headers"].get("range", "")
			var from := 0
			var to := data.size()
			if rng.begins_with("bytes="):
				var parts := rng.substr(6).split("-")
				from = int(parts[0])
				to = mini(data.size(), int(parts[1]) + 1)
			return {"status": 206, "headers": {"content-range": "bytes %d-%d/%d" % [from, to - 1, data.size()], "etag": "\"e\""}, "body": data.slice(from, to)}
		return {"status": 404}


func _through_the_sdk(t: PKeyTestContext) -> void:
	var worker := Worker.new()
	var server := PKeyTestFixtures.new_server(worker.handle)
	var dir := PKeyTestFixtures.scratch_dir("saves_sdk")
	var o := PKeyOptions.new()
	o.product_slug = PRODUCT
	o.version = "1.0.0"
	o.base_url = server.base_url()
	o.store = PKeyMemoryStore.new("", "pkeyt_cached")
	o.expected_services = PackedStringArray(["license", "config", "sync"])
	o.build_stamp_path = ""
	o.persist_settings = false
	o.store_root = dir
	o.cloud_sync_encryption = "server"
	o.cloud_sync_saves_delta = false
	o.cloud_sync_save_format_version = 2
	var sdk = PKeyTestFixtures.new_sdk()
	var events: Array = []
	sdk.event.connect(func(kind: String, data: Dictionary) -> void:
		if kind == "cloudSync":
			events.append(data))
	t.check("sdk: configure keeps the saves options", sdk.configure(o).ok)
	await sdk.start()
	var saves: PKeySaves = sdk.cloud_sync.saves
	t.check("sdk: cloud_sync.saves is a PKeySaves and transfers() starts empty", saves != null and sdk.cloud_sync.transfers().is_empty())
	sdk.core.cache.set_subject("ps_a")
	sdk.cloud_sync.on_identity("signedIn", "ps_a", "")
	await sdk.cloud_sync._drain()
	await sdk.cloud_sync.host.idle()
	var data := _noise(3000)
	var h: PKeyTransfer = saves.write("slot1", data, {"chapter": "two", "formatVersion": 1})
	t.check("sdk: the handle is listed while it runs", sdk.cloud_sync.transfers().size() == 1 and sdk.cloud_sync.transfers()[0] == h or h.outcome != null)
	var out := await h.wait()
	t.check(
			"sdk: the write is done at the record version the Worker answered",
			out["state"] == "done" and out["version"] == 2 and Types.json_equal(_bare(worker.value), {"chapter": "two", "formatVersion": 1}) and worker.value.has("savedAt") and worker.data == data,
			"%s | %s | %s" % [str(out), str(worker.value), worker.data == data]
	)
	# The acknowledged row takes the pointer finalize returned, so it lists its file before any pull.
	var before_pull = await saves.list()
	t.check(
			"sdk: the acknowledged row is listed at once with its new file, before any pull",
			before_pull.ok
				and before_pull.detail.size() == 1
				and before_pull.detail[0]["file"] != null
				and before_pull.detail[0]["file"]["size"] == out["file"]["size"]
				and before_pull.detail[0]["file"]["sha256"] == out["file"]["sha256"],
			str(before_pull.detail)
	)
	var machine = sdk.cloud_sync.host.machine()
	machine.set_network("offline")
	machine.set_network("online")
	sdk.cloud_sync.host.touch()
	await sdk.cloud_sync.host.idle()
	var listed = await saves.list()
	t.check(
			"sdk: list shows the save from the machine's rows",
			listed.ok
				and listed.detail.size() == 1
				and listed.detail[0]["metadata"]["chapter"] == "two"
				and listed.detail[0]["file"] != null
				and listed.detail[0]["file"]["size"] == 3000
				and not listed.detail[0]["newer_format"],
			"%s | %s | %s" % [str(listed.detail), str(sdk.cloud_sync.host.machine().records("saves")), str(worker.paths)]
	)
	var read = await saves.read("slot1")
	t.check("sdk: read downloads through the file transport", read.ok and read.detail["bytes"] == data, str(read.detail.get("reason")))
	var stale = await saves.write("slot1", _noise(10), {"chapter": "stale"}, {"base_version": 1}).wait()
	t.check("sdk: a stale base is a conflict outcome with the server's copy", stale["state"] == "conflict" and stale["request"].remote["value"]["chapter"] == "two", str(stale))
	var types := _types(events)
	t.check("sdk: the transfer events reach the cloudSync stream", types.has("transferProgress") and types.has("transferDone") and events.back()["state"] == "conflict", str(types))
	t.check(
			"sdk: every file request stayed on the product's file routes",
			worker.paths.all(func(p: String) -> bool: return p.contains("/diceroll/sync") or p == "GET /diceroll/config/schema"),
			str(worker.paths)
	)
	t.check("sdk: no timeout, no leftover transfer", sdk.cloud_sync.transfers().is_empty())
	sdk.cloud_sync.close()
	sdk.queue_free()
	server.stop()
	PKeyTestFixtures.remove_tree(dir)


# ── off the main thread ─────────────────────────────────────────────────────────────────────────

func _off_thread(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var before := Engine.get_process_frames()
	var ring := Ring.new()
	var codec := Codec.Guarded.new(Codec.E2e.new(ring.root, "saves"), func() -> bool: return ring.locked)
	var plain := _noise(512 * 1024)
	var sealed: PackedByteArray = await Transfer.Support.off_thread(func() -> PackedByteArray: return codec.seal_whole(plain), plain.size())
	var frames := Engine.get_process_frames() - before
	t.check("off_thread: a large seal runs while the game keeps drawing frames", frames > 1 and not sealed.is_empty(), "%d frames" % frames)
	var opened: Dictionary = await Transfer.Support.off_thread(func() -> Dictionary: return codec.open_whole(sealed), sealed.size())
	t.check("off_thread: the open is the same bytes back", opened["ok"] and opened["plain"] == plain)
	var small: PackedByteArray = await Transfer.Support.off_thread(func() -> PackedByteArray: return PackedByteArray([1]), 10)
	t.check("off_thread: a small job runs inline", small == PackedByteArray([1]))
	await tree.process_frame
