extends RefCounted
# @pkey-feature sync.e2e.recovery
# The Cloud Sync root in the platform backup (U-40.R; iCloud Keychain on Apple, Block Store on Android) over a
# fake platform store: the item written for the subject and the ring, the silent rung on a new device before the
# recovery code, the developer's off switch, reset replacing the item, sign-out keeping it, the explicit removal,
# an unreadable store and a root that does not unwrap the ring being refused, and no key material in a result,
# a message or a string. The real stores are an owner device step.

const Ring := preload("res://tests/suite_sync_ring.gd")
const PRODUCT := "demo"
const SUBJECT_A := "ps_AAAAAAAAAAAAAAAAAAAAAA"
const SUBJECT_B := "ps_BBBBBBBBBBBBBBBBBBBBBB"


## A platform store in memory with the real item logic above it: Apple keeps one item per product, subject and ring,
## Android one entry per product. `mode` "fail" answers every call as unsupported, "broken" as a refused call.
class FakeStore extends PKeyPlatformBackup:
	var items := {}
	var as_android := false
	var mode := ""
	var log: Array = []

	func _init(p_android := false) -> void:
		apple = null
		as_android = p_android

	func is_available() -> bool:
		return mode != "fail"

	func _uses_android() -> bool:
		return as_android

	func _key(item: String, product: String, subject: String, ring_id: String) -> String:
		return "%s|%s" % [item, product] if as_android else "%s|%s|%s|%s" % [item, product, subject, ring_id]

	func _transport(verb: String, item: String, product: String, subject: String, ring_id: String, value: String) -> PKeyResult:
		log.append(verb)
		if mode == "fail":
			return PKeyResult.unsupported(FEATURE, PKeyConstants.UnsupportedReason.RUNTIME)
		if mode == "broken":
			return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The backup refused the request.")
		var k := _key(item, product, subject, ring_id)
		match verb:
			"get":
				return PKeyResult.success({"value": items.get(k)})
			"set":
				items[k] = value
			_:
				items.erase(k)
		return PKeyResult.success()

	func only() -> Variant:
		return JSON.parse_string(items.values()[0]) if items.size() == 1 else null


class SubjectBox extends RefCounted:
	var value: Variant = SUBJECT_A

	func get_subject() -> Variant:
		return value


var _n := 0


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _written(t)
	await _new_device(t)
	await _refused(t)
	await _switch_and_store(t)
	await _reset_and_removal(t)
	await _android(t)
	await _facade(t)
	return true


func _device(worker: Ring.FakeWorker, id: String, store: FakeStore, box: SubjectBox) -> Dictionary:
	_n += 1
	var keys := PKeyDeviceKeyStore.for_tests(PRODUCT, PKeyTestFixtures.scratch_dir("ringbk-k-%d" % _n))
	var vault := PKeySyncRingVault.for_tests(PRODUCT, PKeyTestFixtures.scratch_dir("ringbk-v-%d" % _n), true)
	var ring := PKeySyncRing.new(PRODUCT, id, worker.client(id), keys, vault)
	ring.backup = store
	ring.subject_now = Callable(box, "get_subject")
	return {"ring": ring, "vault": vault, "keys": keys}


static func _root_text(ring: PKeySyncRing) -> String:
	return Marshalls.raw_to_base64(ring._memory.held.root) if ring._memory.held != null else "no-root"


func _written(t: PKeyTestContext) -> void:
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new()
	var box := SubjectBox.new()
	var a := _device(w, "dev_a", store, box)
	var ring: PKeySyncRing = a["ring"]
	t.check("backup: the state is platform with a store", ring.backup_state() == "platform")
	var c := await ring.create()
	t.check("backup: create is ok", c.ok, str(c))
	var rec: Variant = store.only()
	var ring_id: String = c.detail["ring_id"]
	t.check("backup: one Apple item, for the product, the subject and the ring", store.items.keys() == ["sync|%s|%s|%s" % [PRODUCT, SUBJECT_A, ring_id]], str(store.items.keys()))
	var ok: bool = rec is Dictionary and rec.keys().size() == 5 and int(rec["v"]) == 1 and rec["ringId"] == ring_id and int(rec["epoch"]) == 1 and rec["kid"] == c.detail["root_kid"]
	t.check("backup: the record is exactly {v, ringId, epoch, kid, root}", ok, str(rec.keys() if rec is Dictionary else rec))
	var root: Variant = PKeyB64Url.decode_strict(rec["root"]) if rec is Dictionary else null
	t.check("backup: its root is the ring's root", root is PackedByteArray and root == ring._memory.held.root)
	var text: String = store.items.values()[0]
	t.check("backup: the recovery code is not in it", not text.replace("-", "").contains(String(c.detail["recovery_code"]).replace("-", "")))
	t.check("backup: the Worker never sees the root", not JSON.stringify(w.requests).contains(rec["root"]))
	# The same record is not written twice.
	var sets := store.log.count("set")
	await ring.forget()
	await ring.unlock()
	t.check("backup: an unlock with the same record already there writes nothing", store.log.count("set") == sets)
	t.check("backup: sign-out (forget) keeps the item (R-11)", store.items.size() == 1)
	t.check("backup: no key material in the ring, the result or the store log", _quiet([str(ring), str(c), str(store.log)], [_root_text(ring), rec["root"]]))


func _new_device(t: PKeyTestContext) -> void:
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new()
	var box := SubjectBox.new()
	var a := _device(w, "dev_a", store, box)
	var c := await (a["ring"] as PKeySyncRing).create()
	var env := (a["ring"] as PKeySyncRing).codec.seal("$settings", "theme", "dark")
	var b := _device(w, "dev_b", store, box)
	var rb: PKeySyncRing = b["ring"]
	t.check("new device: it has no wrap on the Worker", not w.wraps.has("dev_b"))
	var recovery_reads := w.requests.filter(func(r: Dictionary) -> bool: return String(r["path"]).ends_with("/recovery")).size()
	var u := await rb.unlock()
	t.check("new device: unlock opens from the backup before the recovery code is asked for", u.ok and u.detail["kind"] == "unlocked" and rb.unlocked(), str(u))
	t.check("new device: no recovery code was read", w.requests.filter(func(r: Dictionary) -> bool: return String(r["path"]).ends_with("/recovery")).size() == recovery_reads)
	t.check("new device: it holds the same root", rb.codec.kid() == c.detail["root_kid"] and rb.codec.open("$settings", "theme", env)["ok"])
	t.check("new device: it pins the ring and stores the root", (await rb.pin()).detail["ring_id"] == c.detail["ring_id"] and (await rb.status()).detail["root_stored"])
	t.check("new device: it deposits its own wrap", w.wraps.has("dev_b") and w.wraps["dev_b"]["by"] == "dev_b")
	# The next start no longer depends on the backup.
	store.items.clear()
	var vault: PKeySyncRingVault = b["vault"]
	vault.clear()
	var again := PKeySyncRing.new(PRODUCT, "dev_b", w.client("dev_b"), b["keys"], vault)
	t.check("new device: with the backup gone its own wrap still opens the ring", (await again.unlock()).detail["kind"] == "unlocked")
	# A wrap that stands is not deposited again.
	var w2 := Ring.FakeWorker.new()
	var store2 := FakeStore.new()
	var a2 := _device(w2, "dev_a", store2, box)
	await (a2["ring"] as PKeySyncRing).create()
	var puts := w2.requests.filter(func(r: Dictionary) -> bool: return r["method"] == "PUT").size()
	var a2b := _device(w2, "dev_a", store2, box)
	(a2b["keys"] as PKeyDeviceKeyStore).ensure()
	var again2 := await (a2b["ring"] as PKeySyncRing).unlock()
	var puts_after := w2.requests.filter(func(r: Dictionary) -> bool: return r["method"] == "PUT").size()
	t.check("new device: a device whose wrap stands unlocks from the backup and deposits nothing", again2.detail["kind"] == "unlocked" and puts_after == puts)


func _refused(t: PKeyTestContext) -> void:
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new()
	var box := SubjectBox.new()
	var a := _device(w, "dev_a", store, box)
	var c := await (a["ring"] as PKeySyncRing).create()
	var key: String = store.items.keys()[0]
	var good: Dictionary = store.only()
	var other_root := Crypto.new().generate_random_bytes(32)

	var wrong := good.duplicate()
	wrong["root"] = PKeyB64Url.encode(other_root)
	store.items[key] = JSON.stringify(wrong)
	var b := _device(w, "dev_b", store, box)
	var r := await (b["ring"] as PKeySyncRing).unlock()
	var locked: bool = r.ok and r.detail["kind"] == "locked" and r.detail["reason"] == "no-wrap"
	t.check("refused: a root that does not derive the ring's kid is never trusted", locked and not (b["ring"] as PKeySyncRing).unlocked())
	t.check("refused: and nothing was pinned or stored", (await (b["ring"] as PKeySyncRing).pin()).detail == null and (b["vault"] as PKeySyncRingVault).read_root().detail == null)

	var short := good.duplicate()
	short["root"] = PKeyB64Url.encode(other_root.slice(0, 31))
	store.items[key] = JSON.stringify(short)
	t.check("refused: a root of the wrong length is refused", (await (_device(w, "dev_b", store, box)["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked")

	for name: String in ["v", "ringId", "kid", "epoch", "root"]:
		var bad := good.duplicate()
		match name:
			"v": bad["v"] = 2
			"ringId": bad["ringId"] = "rg_" + "Z".repeat(22)
			"kid": bad["kid"] = "0".repeat(32)
			"epoch": bad["epoch"] = 9
			_: bad.erase("root")
		store.items[key] = JSON.stringify(bad)
		t.check("refused: an item with a wrong %s is a miss" % name, (await (_device(w, "dev_b", store, box)["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked")
	store.items[key] = "not json {"
	t.check("refused: an item that does not parse is a miss", (await (_device(w, "dev_b", store, box)["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked")
	store.items[key] = JSON.stringify(good)
	t.check("refused: the good item opens", (await (_device(w, "dev_b", store, box)["ring"] as PKeySyncRing).unlock()).detail["kind"] == "unlocked")

	# Another person's item is not read (Apple: another account name; the ring never sees it).
	box.value = SUBJECT_B
	var other := _device(w, "dev_c", store, box)
	t.check("refused: another subject reads nothing", (await (other["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked" and store.items.size() == 1)
	box.value = null
	var gets := store.log.count("get")
	var none := _device(w, "dev_d", store, box)
	var nobody := await (none["ring"] as PKeySyncRing).unlock()
	t.check("refused: with no signed-in subject nothing is read or written", nobody.detail["kind"] == "locked" and store.log.count("get") == gets)
	box.value = SUBJECT_A
	t.check("refused: the recovery code still works on a device the backup refused", (await (other["ring"] as PKeySyncRing).recover(c.detail["recovery_code"])).ok)


func _switch_and_store(t: PKeyTestContext) -> void:
	var box := SubjectBox.new()
	# The developer's off switch: nothing written, nothing read.
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new()
	var a := _device(w, "dev_a", store, box)
	(a["ring"] as PKeySyncRing).backup_enabled = false
	t.check("switch: the state is off", (a["ring"] as PKeySyncRing).backup_state() == "off")
	await (a["ring"] as PKeySyncRing).create()
	t.check("switch: off writes nothing", store.items.is_empty() and store.log.is_empty())
	# An item an earlier build wrote is not read while off, and a removal still reaches it.
	var w2 := Ring.FakeWorker.new()
	var s2 := FakeStore.new()
	var first := _device(w2, "dev_a", s2, box)
	await (first["ring"] as PKeySyncRing).create()
	var off := _device(w2, "dev_b", s2, box)
	(off["ring"] as PKeySyncRing).backup_enabled = false
	t.check("switch: off does not read the item either", (await (off["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked")
	# Removal ignores the switch; it needs the ring known to this client (pinned, held or served).
	await (off["ring"] as PKeySyncRing).read()
	var del := await (off["ring"] as PKeySyncRing).delete_backup()
	t.check("switch: delete_backup removes what an earlier build wrote, whatever the switch", del.ok and s2.items.is_empty())

	# No store here (Linux, Windows, web): unavailable, and every call still works.
	var w3 := Ring.FakeWorker.new()
	var lone := _device(w3, "dev_a", null, box)
	var lone_status := await (lone["ring"] as PKeySyncRing).status()
	t.check("none: a ring with no store says unavailable", (lone["ring"] as PKeySyncRing).backup_state() == "unavailable" and lone_status.detail["root_backup"] == "unavailable")
	t.check("none: create still works", (await (lone["ring"] as PKeySyncRing).create()).ok)
	t.check("none: delete_backup has nothing to remove", (await (lone["ring"] as PKeySyncRing).delete_backup()).ok)

	# A store that answers unsupported (no entitlement, no Play services) or refuses: a miss, never a failure.
	for mode: String in ["fail", "broken"]:
		var wf := Ring.FakeWorker.new()
		var bad := FakeStore.new()
		bad.mode = mode
		var d := _device(wf, "dev_a", bad, box)
		var made_r := await (d["ring"] as PKeySyncRing).create()
		t.check("store %s: create is ok" % mode, made_r.ok, str(made_r))
		var d2 := _device(wf, "dev_b", bad, box)
		var u := await (d2["ring"] as PKeySyncRing).unlock()
		t.check("store %s: a new device stays locked (the code is asked for) and the unlock is not a failure" % mode, u.ok and u.detail["kind"] == "locked" and u.detail["reason"] == "no-wrap")
		t.check("store %s: the recovery code opens it" % mode, (await (d2["ring"] as PKeySyncRing).recover(made_r.detail["recovery_code"])).ok)
		if mode == "broken":
			t.check("store broken: the state is platform and delete_backup is a failure that names no key", (await (d["ring"] as PKeySyncRing).delete_backup()).code == PKeyErrors.STORE_FAILED)


func _reset_and_removal(t: PKeyTestContext) -> void:
	var box := SubjectBox.new()
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new()
	var a := _device(w, "dev_a", store, box)
	var ring: PKeySyncRing = a["ring"]
	var c := await ring.create()
	var old_key: String = store.items.keys()[0]
	var r := await ring.reset()
	t.check("reset: ok", r.ok, str(r))
	var written: Dictionary = store.only()
	var replaced: bool = store.items.size() == 1 and not store.items.has(old_key)
	t.check("reset: the old ring's item is gone and the new ring's is written", replaced and written["ringId"] == r.detail["ring_id"] and written["ringId"] != c.detail["ring_id"])
	t.check("reset: the new item is the new root", PKeyB64Url.decode_strict(store.only()["root"]) == ring._memory.held.root)
	# A restart of a device that holds the root: an unlock from the stored root ensures the item.
	store.items.clear()
	var ring2 := PKeySyncRing.new(PRODUCT, "dev_a", w.client("dev_a"), a["keys"], a["vault"])
	ring2.backup = store
	ring2.subject_now = Callable(box, "get_subject")
	await ring2.unlock()
	t.check("ensure: a device that held the root before the backup existed writes it at its next unlock", store.items.size() == 1)
	var del := await ring2.delete_backup()
	t.check("removal: delete_backup removes the item", del.ok and store.items.is_empty())
	store.log.clear()
	t.check("removal: forget never touches the store", (await ring2.forget()).ok and store.log.is_empty())


func _android(t: PKeyTestContext) -> void:
	var box := SubjectBox.new()
	var w := Ring.FakeWorker.new()
	var store := FakeStore.new(true)
	var a := _device(w, "dev_a", store, box)
	var c := await (a["ring"] as PKeySyncRing).create()
	var rec: Variant = store.only()
	t.check("android: one entry per product", store.items.keys() == ["sync|%s" % PRODUCT], str(store.items.keys()))
	t.check("android: the value carries the subject and the ring", rec is Dictionary and rec["subject"] == SUBJECT_A and rec["ringId"] == c.detail["ring_id"] and rec["kid"] == c.detail["root_kid"])
	var b := _device(w, "dev_b", store, box)
	t.check("android: a new device unlocks from the entry", (await (b["ring"] as PKeySyncRing).unlock()).detail["kind"] == "unlocked")
	# Another person on the same device: the entry is not theirs and is left alone.
	box.value = SUBJECT_B
	var c2 := _device(w, "dev_c", store, box)
	t.check("android: another subject does not read the entry", (await (c2["ring"] as PKeySyncRing).unlock()).detail["kind"] == "locked")
	var before: String = store.items.values()[0]
	await (c2["ring"] as PKeySyncRing).recover(c.detail["recovery_code"])
	t.check("android: another person's entry is left alone by their write", store.items.values()[0] == before)
	box.value = SUBJECT_A
	# reset replaces the one entry.
	var r := await (a["ring"] as PKeySyncRing).reset()
	t.check("android: reset replaces the entry", r.ok and store.items.size() == 1 and store.only()["ringId"] == r.detail["ring_id"])
	t.check("android: delete_backup removes it", (await (a["ring"] as PKeySyncRing).delete_backup()).ok and store.items.is_empty())


func _facade(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	var store_mem := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA")
	var opts := PKeyTestFixtures.options("http://127.0.0.1:1", store_mem, [1700000000], PRODUCT, {}, "1.0.0")
	opts.device_keys = PKeyDeviceKeyStore.for_tests(PRODUCT, PKeyTestFixtures.scratch_dir("ringbk-facade"))
	opts.ring_vault = PKeySyncRingVault.new(PRODUCT, "user://pkey", true)
	var fake := FakeStore.new()
	opts.ring_backup = fake
	t.check("facade: the options default the backup on", opts.cloud_sync_root_backup)
	t.check("facade: configure is ok", sdk.configure(opts).ok)
	t.check("facade: the key ring gets the given store and it is on", sdk.keyring.backup == fake and sdk.keyring.backup_enabled)
	opts.cloud_sync_root_backup = false
	sdk.configure(opts)
	t.check("facade: the developer's switch reaches the ring", not sdk.keyring.backup_enabled and sdk.keyring.backup_state() == "off")
	opts.ring_backup = null
	sdk.configure(opts)
	var desktop := not (OS.has_feature("ios") or OS.has_feature("macos") or OS.has_feature("android"))
	t.check("facade: where the platform has no store the ring says unavailable", not desktop or sdk.keyring.backup_state() == "unavailable")
	sdk.queue_free()


## True when none of `secrets` appears in any of `texts`.
static func _quiet(texts: Array, secrets: Array) -> bool:
	for x in texts:
		for s in secrets:
			if s != "" and String(x).contains(String(s)):
				return false
	return true
