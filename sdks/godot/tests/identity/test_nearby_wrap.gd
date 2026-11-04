extends RefCounted
# @pkey-feature identity.nearby sync.keyring
# The key ring's part of nearby approval (I-48.16; WIRE-CONTRACT-V5 section 13.11.3 and 15.6.1): M seals the root to the
# new device (`seal_wrap_to`), sends it, and only then stores it (`put_wrap`); D reads the `KEYRING_WRAP` record with a
# strict parser and adopts it (`adopt_wrap`) after the person confirmed the account, never before, and drops it on a
# decline. The ring suite's scripted Worker keeps the ring and the wraps the way the real one does.

const R := preload("res://tests/suite_sync_ring.gd")
const N := preload("res://tests/identity/test_nearby.gd")
const B := preload("res://tests/identity/support.gd")


func run(t: PKeyTestContext) -> void:
	await _seal_and_put(t)
	_parser(t)
	await _adopt(t)
	await _session(t)


func _record(wrap: Dictionary) -> PackedByteArray:
	return PKeySyncRing.wrap_record(wrap)


func _mutated(record: PackedByteArray, edit: Callable) -> PackedByteArray:
	var d: Dictionary = JSON.parse_string(record.get_string_from_utf8())
	edit.call(d)
	return JSON.stringify(d).to_utf8_buffer()


# -- M: seal, then put -------------------------------------------------------------------------------


func _seal_and_put(t: PKeyTestContext) -> void:
	var h := R.new()
	var w := R.FakeWorker.new()
	var a := h._device(w, "dev_a")
	var b := h._device(w, "dev_b")
	var ra: PKeySyncRing = a["ring"]
	var locked := ra.seal_wrap_to("dev_b", "AAAA")
	t.check("seal: locked, nothing is sealed", not locked.ok and locked.code == &"sync-locked")
	await ra.create(false)
	var pub: String = (b["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"]
	var sealed := ra.seal_wrap_to("dev_b", pub)
	t.check("seal: answers the wrap and stores nothing", sealed.ok
		and not w.wraps.has("dev_b")
		and w.requests.filter(func(r: Dictionary) -> bool: return r["method"] == "PUT" and String(r["path"]).contains("wraps")).is_empty(), str(sealed))
	t.check("seal: the wrap names the ring, the epoch and the root's kid", sealed.detail["ring_id"] == w.ring["ringId"]
		and sealed.detail["epoch"] == 1
		and sealed.detail["kid"] == w.ring["rootKid"]
		and int(sealed.detail["kem"]) == 32)
	var bad := ra.seal_wrap_to("dev_b", "AAAA")
	t.check("seal: a short agreement key is refused", not bad.ok and bad.code == &"invalid-argument")
	var put := await ra.put_wrap("dev_b", sealed.detail)
	t.check("put: stores the same bytes the channel carries", put.ok
		and w.wraps["dev_b"]["ct"] == sealed.detail["ct"]
		and w.wraps["dev_b"]["enc"] == sealed.detail["enc"]
		and w.wraps["dev_b"]["by"] == "dev_a")
	var junk := await ra.put_wrap("dev_b", {"ring_id": "x"})
	t.check("put: not a wrap is refused before any request", not junk.ok and junk.code == &"invalid-argument")
	var parsed: Variant = PKeySyncRing.parse_wrap_record(_record(sealed.detail))
	t.check("record: what M sends is what D parses", parsed is Dictionary
		and parsed["ring_id"] == sealed.detail["ring_id"]
		and parsed["ct"] == sealed.detail["ct"]
		and parsed["kid"] == sealed.detail["kid"])


# -- D: the strict parser ----------------------------------------------------------------------------


func _parser(t: PKeyTestContext) -> void:
	var good := {"ring_id": "rg_AAAAAAAAAAAAAAAAAAAAAA", "epoch": 1, "kid": "00112233445566778899aabbccddeeff", "kem": 32, "enc": "A".repeat(43), "ct": "B".repeat(64)}
	var rec := _record(good)
	t.check("parser: the exact members, sizes in range", PKeySyncRing.parse_wrap_record(rec) is Dictionary)
	var cases := {
		"a missing member": func(d: Dictionary) -> void: d.erase("ct"),
		"an extra member": func(d: Dictionary) -> void: d["by"] = "dev_a",
		"a wrong kem": func(d: Dictionary) -> void: d["kem"] = 33,
		"a kem as text that is not x25519": func(d: Dictionary) -> void: d["kem"] = "p256",
		"a short enc": func(d: Dictionary) -> void: d["enc"] = "A".repeat(42),
		"a long ct": func(d: Dictionary) -> void: d["ct"] = "B".repeat(65),
		"a ct that is not base64url": func(d: Dictionary) -> void: d["ct"] = "+".repeat(64),
		"epoch zero": func(d: Dictionary) -> void: d["epoch"] = 0,
		"a fractional epoch": func(d: Dictionary) -> void: d["epoch"] = 1.5,
		"an epoch as text": func(d: Dictionary) -> void: d["epoch"] = "1",
		"an upper-case kid": func(d: Dictionary) -> void: d["kid"] = "AA".repeat(16),
		"a short kid": func(d: Dictionary) -> void: d["kid"] = "aa".repeat(15),
		"a ring id of another shape": func(d: Dictionary) -> void: d["ring_id"] = "rg_short",
		"a member of the wrong type": func(d: Dictionary) -> void: d["enc"] = 5,
	}
	for name: String in cases:
		var bytes := _wire(good, cases[name])
		t.check("parser: refuses %s" % name, PKeySyncRing.parse_wrap_record(bytes) == null)
	t.check("parser: refuses a body that is not an object", PKeySyncRing.parse_wrap_record("[1]".to_utf8_buffer()) == null)
	t.check("parser: refuses text that is not JSON", PKeySyncRing.parse_wrap_record("not json".to_utf8_buffer()) == null)
	t.check("parser: refuses a duplicate member", PKeySyncRing.parse_wrap_record(rec.get_string_from_utf8().replace('"epoch":1', '"epoch":1,"epoch":2').to_utf8_buffer()) == null)
	t.check("parser: refuses a trailing comma", PKeySyncRing.parse_wrap_record(rec.get_string_from_utf8().replace("}", ",}").to_utf8_buffer()) == null)
	var big := PackedByteArray()
	big.resize(PKeySyncRing.WRAP_RECORD_MAX + 1)
	big.fill(32)
	t.check("parser: refuses an oversized body before parsing", PKeySyncRing.parse_wrap_record(big) == null)
	t.check("parser: refuses a body that is not bytes", PKeySyncRing.parse_wrap_record("x") == null)


## The record with the wrap's members under the wire names, after `edit`.
func _wire(good: Dictionary, edit: Callable) -> PackedByteArray:
	var d := good.duplicate()
	edit.call(d)
	var wire := {}
	var names := {"ring_id": "ringId", "epoch": "epoch", "kid": "kid", "kem": "kem", "enc": "enc", "ct": "ct"}
	for k: String in d:
		wire[names.get(k, k)] = d[k]
	return JSON.stringify(wire).to_utf8_buffer()


# -- D: adopt ---------------------------------------------------------------------------------------


func _adopt(t: PKeyTestContext) -> void:
	var h := R.new()
	var w := R.FakeWorker.new()
	var a := h._device(w, "dev_a")
	var b := h._device(w, "dev_b")
	var c := h._device(w, "dev_c")
	var ra: PKeySyncRing = a["ring"]
	var rb: PKeySyncRing = b["ring"]
	await ra.create(false)
	var sealed := ra.seal_wrap_to("dev_b", (b["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var rec := _record(sealed.detail)
	var seen := w.requests.size()
	var junk := await rb.adopt_wrap("not a wrap".to_utf8_buffer())
	t.check("adopt: a record that is not a wrap is locked, with no request", junk.ok and junk.detail["kind"] == "locked" and junk.detail["reason"] == "unusable-wrap" and w.requests.size() == seen)
	var u := await rb.adopt_wrap(rec)
	t.check("adopt: the channel copy opens, with no server copy for this device", u.ok
		and u.detail["kind"] == "unlocked"
		and rb.unlocked()
		and not w.wraps.has("dev_b")
		and rb.codec.kid() == ra.codec.kid(), str(u))
	var env := ra.codec.seal("$settings", "volume", 7)
	t.check("adopt: D reads what M sealed", rb.codec.open("$settings", "volume", env).get("value") == 7.0)
	var held_kid := rb.codec.kid()
	var more := await rb.adopt_wrap(rec)
	t.check("adopt: a root already held for the ring and epoch stays", more.ok and more.detail["kind"] == "unlocked" and rb.codec.kid() == held_kid)

	# A record naming another ring, epoch or kid than the served one is unusable.
	var rc: PKeySyncRing = c["ring"]
	var csealed := ra.seal_wrap_to("dev_c", (c["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var crec := _record(csealed.detail)
	for pair: Array in [["ringId", "rg_BBBBBBBBBBBBBBBBBBBBBB"], ["epoch", 2], ["kid", "11".repeat(16)]]:
		var forged := _mutated(crec, func(d: Dictionary) -> void: d[pair[0]] = pair[1])
		var fr := await rc.adopt_wrap(forged)
		t.check("adopt: a record with another %s is unusable and holds nothing" % pair[0], fr.ok and fr.detail["kind"] == "locked" and fr.detail["reason"] == "unusable-wrap" and not rc.unlocked(), str(fr))
	# A wrap sealed to another device's key does not open.
	var wrong := await rc.adopt_wrap(rec)
	t.check("adopt: a wrap sealed to another device does not open", wrong.ok and wrong.detail["kind"] == "locked" and wrong.detail["reason"] == "unusable-wrap" and not rc.unlocked())
	# Tampered bytes.
	var tampered := _mutated(crec, func(d: Dictionary) -> void:
		var ct := PKeyB64Url.decode_strict(d["ct"]) as PackedByteArray
		ct[0] ^= 1
		d["ct"] = PKeyB64Url.encode(ct))
	var tr := await rc.adopt_wrap(tampered)
	t.check("adopt: a tampered wrap leaves the device locked", tr.ok and tr.detail["kind"] == "locked" and not rc.unlocked())
	var good := await rc.adopt_wrap(crec)
	t.check("adopt: the right wrap still opens after the refusals", good.ok and good.detail["kind"] == "unlocked" and rc.unlocked())

	# A pinned ring that is not the served one is ring-changed and is not opened.
	var w2 := R.FakeWorker.new()
	var a2 := h._device(w2, "dev_a")
	var b2 := h._device(w2, "dev_b")
	await (a2["ring"] as PKeySyncRing).create(false)
	var s1 := (a2["ring"] as PKeySyncRing).seal_wrap_to("dev_b", (b2["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	await (b2["ring"] as PKeySyncRing).adopt_wrap(_record(s1.detail))
	await (a2["ring"] as PKeySyncRing).reset(false)
	var s2 := (a2["ring"] as PKeySyncRing).seal_wrap_to("dev_b", (b2["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var before := (b2["ring"] as PKeySyncRing).codec.kid()
	var changed := await (b2["ring"] as PKeySyncRing).adopt_wrap(_record(s2.detail))
	t.check("adopt: a wrap for a ring that is not the pinned one is ring-changed and replaces nothing", changed.ok
		and changed.detail["kind"] == "ring-changed"
		and (b2["ring"] as PKeySyncRing).codec.kid() == before, str(changed))


# -- D: the session adopts it after the confirmation ---------------------------------------------------


func _session(t: PKeyTestContext) -> void:
	var held := PackedByteArray([7, 8, 9])
	var r := N.Rig.new()
	await r.up()
	r.sdk.core.cache.set_explicit_sign_out(true)
	var ring := N.FakeRing.new()
	r.sdk.identity.nearby_keyring = ring
	r.bed.starts_n = [N.started_answer()]
	r.bed.polls_n = [N.ready_answer()]
	var s: PKeyNearbySignIn = (await r.sdk.identity.sign_in.start_nearby()).detail
	await s.wait()
	var states: Array = []
	s.wrap_changed.connect(func(st: String) -> void: states.append(st))
	r.lan.req.record.emit(0x0030, held)
	for i in 5:
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("session: before the confirmation the wrap is held, not adopted", ring.adopted.is_empty() and s.wrap == "none")
	var c: PKeyResult = await s.confirm_account()
	t.check("session: the confirmation adopts it, once", c.ok and ring.adopted == [held] and s.wrap == "applied" and states == ["applied"], str(states))
	t.check("session: the wrap is not kept after it was taken", s.take_wrap_record().is_empty())
	r.sdk.queue_free()
	r.free_all()

	# A ring that refuses leaves the confirmation as it is.
	var rf := N.Rig.new()
	await rf.up()
	var fring := N.FakeRing.new()
	fring.kind = "locked"
	rf.sdk.identity.nearby_keyring = fring
	rf.bed.starts_n = [N.started_answer()]
	rf.bed.polls_n = [N.ready_answer()]
	var fs: PKeyNearbySignIn = (await rf.sdk.identity.sign_in.start_nearby()).detail
	await fs.wait()
	rf.lan.req.record.emit(0x0030, held)
	var fc: PKeyResult = await fs.confirm_account()
	t.check("session: a ring that refuses it leaves the sign-in confirmed and the wrap refused", fc.ok and fs.wrap == "refused" and fs.is_confirmed())
	rf.sdk.queue_free()
	rf.free_all()

	# A decline drops it: nothing is adopted, now or later.
	var d := N.Rig.new()
	await d.up()
	var dring := N.FakeRing.new()
	d.sdk.identity.nearby_keyring = dring
	d.bed.starts_n = [N.started_answer()]
	d.bed.polls_n = [N.ready_answer()]
	var ds: PKeyNearbySignIn = (await d.sdk.identity.sign_in.start_nearby()).detail
	await ds.wait()
	d.lan.req.record.emit(0x0030, held)
	d.bed.signouts = [B.json(200, {"released": true})]
	await ds.decline_account()
	var late: PKeyResult = await ds.confirm_account()
	for i in 5:
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("session: a decline drops the wrap and nothing is adopted", dring.adopted.is_empty() and not late.ok and ds.take_wrap_record().is_empty() and ds.wrap == "none")
	d.sdk.queue_free()
	d.free_all()
