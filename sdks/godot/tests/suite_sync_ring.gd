extends RefCounted
# The Cloud Sync key ring client (U-40.6; WIRE-CONTRACT-V5 §13.10, §13.11) against a scripted Worker
# that keeps the ring, the wraps, the recovery blob and the adopted candidates the way the real one
# does, in memory. The ring rules Swift and Kotlin applied: a served ring that differs from the pin is
# never opened; no root is held without a pin; the stored root is used only while it matches the
# pin; a wrap is accepted only when kid(R) is the ring's rootKid; a bad recovery code is refused
# before any request; nothing prints key material. The `keyring-*` transcripts replay is U-40.7.

const PRODUCT := "demo"


## A Worker that answers the key ring routes. `client(device_id)` is the requester one device uses.
class FakeWorker extends RefCounted:
	var ring: Variant = null
	var wraps := {}
	var recovery: Variant = null
	var adopted: Array = []
	var requests: Array = []
	var conflict := false

	func client(device_id: String) -> Callable:
		return func(method: String, path: String, body: Variant) -> PKeyResult: return _handle(device_id, method, path, body)

	func _ok(v: Variant) -> PKeyResult:
		return PKeyResult.success({"status": 200, "body": JSON.stringify(v).to_utf8_buffer()})

	func _fail(code: String, status: int) -> PKeyResult:
		return PKeyResult.failure(StringName(code), "refused", {"status": status})

	func _handle(device: String, method: String, path: String, body: Variant) -> PKeyResult:
		requests.append({"method": method, "path": path, "body": body, "device": device})
		match [method, path]:
			["GET", "devices/keyring"]:
				return _ok({"ring": _ring_json(), "wrap": _wrap_json(device)})
			["POST", "devices/keyring"]:
				if ring != null:
					return _fail("keyring_conflict", 409)
				_make(device, body, false)
				return _ok({})
			["POST", "devices/keyring/reset"]:
				_make(device, body, true)
				return _ok({})
			["GET", "devices/keyring/recovery"]:
				return _ok(recovery) if recovery != null else _fail("not_found", 404)
			["PUT", "devices/keyring/recovery"]:
				recovery = {"ct": body["ct"], "epoch": body["epoch"], "kid": body["kid"]}
				ring["recovery"] = {"set": true}
				return _ok({})
			["POST", "devices/keyring/adopt"]:
				adopted.append({"ringId": body["fromRingId"], "epoch": body["epoch"], "kid": body["kid"], "ct": body["ct"]})
				ring["adopted"] = adopted
				return _ok({})
		if path.begins_with("devices/keyring/wraps/"):
			var id := path.get_slice("/", 3).uri_decode()
			if method == "PUT":
				if ring == null or int(body["epoch"]) != int(ring["epoch"]) or body["kid"] != ring["rootKid"]:
					return _fail("bad_request", 400)
				wraps[id] = {"epoch": body["epoch"], "kid": body["kid"], "kem": body["kem"], "enc": body["enc"], "ct": body["ct"], "by": device}
				return _ok({})
			if method == "DELETE":
				if id != device:
					return _fail("forbidden", 403)
				wraps.erase(id)
				return _ok({})
		return _fail("not_found", 404)

	func _make(device: String, body: Dictionary, is_reset: bool) -> void:
		var prev: Variant = null
		if is_reset and ring != null:
			prev = {"ringId": ring["ringId"], "kid": ring["rootKid"], "until": 1800000000}
		ring = {"ringId": body["ringId"], "epoch": 1, "rootKid": body["rootKid"], "state": "active", "createdAt": 1700000000, "recovery": {"set": body.has("recovery")}, "adopted": [], "previous": prev}
		adopted = []
		wraps = {device: {"epoch": 1, "kid": body["rootKid"], "kem": body["wrap"]["kem"], "enc": body["wrap"]["enc"], "ct": body["wrap"]["ct"], "by": device}}
		recovery = {"ct": body["recovery"]["ct"], "epoch": 1, "kid": body["rootKid"]} if body.has("recovery") else null

	func _ring_json() -> Variant:
		return ring

	func _wrap_json(device: String) -> Variant:
		return wraps.get(device)

	func count(method: String, suffix: String) -> int:
		return requests.filter(func(r: Dictionary) -> bool: return r["method"] == method and String(r["path"]).ends_with(suffix)).size()


## A vault whose pin cannot be written.
class NoPinVault extends PKeySyncRingVault:
	func write_pin(_pin: Dictionary) -> PKeyResult:
		return PKeyResult.failure(PKeyDeviceKeyStore.STORE_FAULT, "no pin")


var _n := 0


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _lifecycle(t)
	await _devices(t)
	await _ring_changed(t)
	await _recovery(t)
	await _guards(t)
	await _adopt(t)
	_vault_files(t)
	await _facade(t)
	return true


func _dir(tag: String) -> String:
	_n += 1
	return PKeyTestFixtures.scratch_dir("ring-%s-%d" % [tag, _n])


## A device: its key store, a vault (memory unless `root` is given) and a ring over `worker`.
func _device(worker: FakeWorker, id: String, root := "") -> Dictionary:
	var keys := PKeyDeviceKeyStore.new(PRODUCT, root if root != "" else _dir("keys"), false, false)
	var vault := PKeySyncRingVault.for_tests(PRODUCT, root if root != "" else _dir("vault"), root == "")
	return {"id": id, "keys": keys, "vault": vault, "ring": PKeySyncRing.new(PRODUCT, id, worker.client(id), keys, vault), "worker": worker, "root": root}


## A restart: a new ring over the same keys and vault.
func _restart(d: Dictionary) -> PKeySyncRing:
	return PKeySyncRing.new(PRODUCT, d["id"], (d["worker"] as FakeWorker).client(d["id"]), d["keys"], d["vault"])


func _lifecycle(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var ring: PKeySyncRing = a["ring"]
	var st := await ring.status()
	t.check("ring: a new device is locked, nothing stored", st.ok and not st.detail["unlocked"] and st.detail["pinned"] == null and not st.detail["root_stored"], str(st.detail))
	var t0 := Time.get_ticks_usec()
	var c := await ring.create()
	t.info("ring: create (X25519 wrap, recovery blob, 2 requests) %.0f ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	t.check("ring: create is ok", c.ok, str(c))
	if not c.ok:
		return
	var code: String = c.detail["recovery_code"]
	t.check("ring: create returns the recovery code once, 8 groups of 4", code.length() == 39 and code.count("-") == 7, str(code.length()))
	t.check("ring: the ring id is rg_ and 22 characters", String(c.detail["ring_id"]).begins_with("rg_") and String(c.detail["ring_id"]).length() == 25)
	t.check("ring: create holds the root and pins the ring", ring.unlocked() and (await ring.pin()).detail["ring_id"] == c.detail["ring_id"] and (await ring.pin()).detail["root_kid"] == c.detail["root_kid"])
	var posted: Dictionary = (w.requests.filter(func(r: Dictionary) -> bool: return r["method"] == "POST")[0])["body"]
	t.check("ring: the request carries a wrap and a recovery blob, and the Worker never sees the root", posted.has("wrap") and posted.has("recovery") and not JSON.stringify(posted).contains(_root_hex(ring)))
	var again := await ring.create()
	t.check("ring: create when a ring exists is keyring_conflict and changes nothing", not again.ok and again.code == &"keyring_conflict" and (await ring.pin()).detail["ring_id"] == c.detail["ring_id"])

	# Values sealed with the ring's codec.
	var env := ring.codec.seal("$settings", "theme", "dark")
	t.check("ring: the codec seals and opens", env.size() == 113 and ring.codec.open("$settings", "theme", env)["ok"])
	t.check("ring: the codec blinds a name", ring.codec.blind("setting", "$settings", "theme").begins_with("x:"))

	# A restart is unlocked offline from the stored root and pin.
	var before: int = w.requests.size()
	var ring2 := _restart(a)
	var st2 := await ring2.status()
	t.check("ring: a restart is unlocked offline from the stored root", st2.detail["unlocked"] and st2.detail["root_stored"] and w.requests.size() == before, str(st2.detail))
	t.check("ring: the restarted ring opens the first one's envelope", ring2.codec.open("$settings", "theme", env)["ok"])

	# lock() and unlock() use the stored root, no wrap needed.
	var seen: Array = []
	var detach := ring2.attach(func(present: bool) -> void: seen.append(present))
	ring2.lock()
	t.check("ring: lock forgets the root in memory and tells listeners", not ring2.unlocked() and seen == [true, false], str(seen))
	t.check("ring: the codec refuses while locked", ring2.codec.seal("$settings", "theme", "x").is_empty() and ring2.codec.open("$settings", "theme", env).get("reason") == "locked")
	var u := await ring2.unlock()
	t.check("ring: unlock takes the stored root", u.ok and u.detail["kind"] == "unlocked" and ring2.unlocked() and seen == [true, false, true])
	detach.call()

	# forget(): sign-out drops the root and the pin.
	var f := await ring2.forget()
	var st3 := await ring2.status()
	t.check("ring: forget drops the root and the pin", f.ok and not ring2.unlocked() and st3.detail["pinned"] == null and not st3.detail["root_stored"])
	# S-4: a sign-out has begun: no verb takes a root back before the sign-out call, and a verb in flight
	# when `forget` runs cannot re-store it.
	ring2.begin_sign_out()
	var refused := await ring2.unlock()
	t.check("ring: after begin_sign_out an unlock holds and stores nothing", not refused.ok and not ring2.unlocked() and a["vault"].read_root().detail == null and a["vault"].read_pin().detail == null, str(refused))
	ring2.allow_holds()
	var racing := func() -> void: await ring2.unlock()
	racing.call()
	await ring2.forget()
	await PKeyTestFixtures.frames(3)
	t.check("ring: a forget that overtakes an unlock leaves nothing held or stored", not ring2.unlocked() and a["vault"].read_root().detail == null and a["vault"].read_pin().detail == null)
	# After forget the device opens its own wrap through the key store's dh and pins again.
	var u2 := await ring2.unlock()
	t.check("ring: unlock opens this device's own wrap", u2.ok and u2.detail["kind"] == "unlocked", str(u2))
	t.check("ring: and pins the ring and stores the root", (await ring2.pin()).detail["ring_id"] == c.detail["ring_id"] and (await ring2.status()).detail["root_stored"])
	t.check("ring: the same root comes back (same kid)", ring2.codec.kid() == c.detail["root_kid"] and ring2.codec.open("$settings", "theme", env)["ok"])
	t.check("ring: nothing prints key material", _quiet(t, [str(ring), str(ring2), str(ring.codec), str(ring._memory), str(ring._memory.held), str(c), str(a["vault"]), str(a["keys"])], [_root_hex(ring), Marshalls.raw_to_base64(ring._memory.held.root), code.replace("-", "")]))


func _devices(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var b := _device(w, "dev_b")
	var ra: PKeySyncRing = a["ring"]
	var rb: PKeySyncRing = b["ring"]
	var c := await ra.create(false)
	t.check("devices: create without recovery returns no code and sends no blob", c.ok and c.detail["recovery_code"] == "" and w.recovery == null)
	var u0 := await rb.unlock()
	t.check("devices: a device with no wrap stays locked", u0.ok and u0.detail["kind"] == "locked" and u0.detail["reason"] == "no-wrap" and not rb.unlocked())
	var pub: String = (b["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"]
	var wr := await ra.wrap_to("dev_b", pub)
	t.check("devices: wrap_to puts a wrap for the other device", wr.ok and w.wraps.has("dev_b") and w.wraps["dev_b"]["by"] == "dev_a" and int(w.wraps["dev_b"]["kem"]) == 32)
	var u1 := await rb.unlock()
	t.check("devices: the other device unlocks with the wrap and holds the same root", u1.ok and u1.detail["kind"] == "unlocked" and rb.codec.kid() == ra.codec.kid())
	var env := ra.codec.seal("$settings", "volume", 7)
	t.check("devices: the other device opens this device's envelope", rb.codec.open("$settings", "volume", env).get("value") == 7.0)
	var wrong_dev := await ra.wrap_to("dev_c/x", pub)
	t.check("devices: a device id with a slash is refused", not wrong_dev.ok and wrong_dev.code == &"invalid-argument")
	var bad_key := await ra.wrap_to("dev_c", "AAAA")
	t.check("devices: a short agreement key is refused", not bad_key.ok and bad_key.code == &"invalid-argument")
	var low := await ra.wrap_to("dev_c", PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
	t.check("devices: a low-order agreement key is refused", not low.ok)
	var rm := await rb.remove_wrap("dev_b")
	t.check("devices: remove_wrap deletes this device's own wrap", rm.ok and not w.wraps.has("dev_b"))
	var rm2 := await ra.remove_wrap("")
	t.check("devices: remove_wrap with no id is refused", not rm2.ok and rm2.code == &"invalid-argument")

	# A wrap whose root does not derive the ring's rootKid is never accepted (rootKid altered).
	var w2 := FakeWorker.new()
	var a2 := _device(w2, "dev_a")
	var b2 := _device(w2, "dev_b")
	await (a2["ring"] as PKeySyncRing).create(false)
	await (a2["ring"] as PKeySyncRing).wrap_to("dev_b", (b2["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var good_ct: String = w2.wraps["dev_b"]["ct"]
	var tampered := PKeyB64Url.decode_strict(good_ct) as PackedByteArray
	tampered[0] ^= 1
	w2.wraps["dev_b"]["ct"] = PKeyB64Url.encode(tampered)
	var ut := await (b2["ring"] as PKeySyncRing).unlock()
	t.check("devices: a tampered wrap leaves the device locked (unusable-wrap)", ut.ok and ut.detail["kind"] == "locked" and ut.detail["reason"] == "unusable-wrap" and not (b2["ring"] as PKeySyncRing).unlocked())
	w2.wraps["dev_b"]["ct"] = good_ct
	w2.wraps["dev_b"]["kid"] = "00".repeat(16)
	var uk := await (b2["ring"] as PKeySyncRing).unlock()
	t.check("devices: a wrap naming another kid is unusable", uk.ok and uk.detail["kind"] == "locked" and uk.detail["reason"] == "unusable-wrap")
	w2.wraps["dev_b"]["kid"] = w2.ring["rootKid"]
	# A wrap that opens to a root whose kid is not rootKid: serve a ring whose rootKid is another value.
	var real_kid: String = w2.ring["rootKid"]
	w2.ring["rootKid"] = "11".repeat(16)
	w2.wraps["dev_b"]["kid"] = "11".repeat(16)
	var um := await (b2["ring"] as PKeySyncRing).unlock()
	t.check("devices: a wrap whose root is not the ring's rootKid is refused", um.ok and um.detail["kind"] == "locked" and um.detail["reason"] == "unusable-wrap" and not (b2["ring"] as PKeySyncRing).unlocked())
	w2.ring["rootKid"] = real_kid
	# A body that is not in the contract shape.
	var shaped := FakeWorker.new()
	shaped.ring = {"ringId": 5}
	var d := _device(shaped, "dev_a")
	var rd := await (d["ring"] as PKeySyncRing).read()
	t.check("devices: a ring answer that is not in the contract shape is bad_response", not rd.ok and rd.code == &"bad_response")


func _ring_changed(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var ra: PKeySyncRing = a["ring"]
	var c := await ra.create(false)
	var env := ra.codec.seal("$settings", "theme", "dark")
	var pin1: Dictionary = (await ra.pin()).detail
	# Another person's device makes a different ring, wrapped to A as well (a hostile or confused Worker).
	var w_other := FakeWorker.new()
	var x := _device(w_other, "dev_x")
	await (x["ring"] as PKeySyncRing).create(false)
	await (x["ring"] as PKeySyncRing).wrap_to("dev_a", (a["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var served_ring: Dictionary = w_other.ring.duplicate(true)
	var served_wrap: Dictionary = w_other.wraps["dev_a"].duplicate(true)
	w.ring = served_ring
	w.wraps = {"dev_a": served_wrap}
	var u := await ra.unlock()
	t.check("changed: a different served ring answers ring-changed", u.ok and u.detail["kind"] == "ring-changed" and u.detail["pinned"]["ring_id"] == pin1["ring_id"] and u.detail["served"]["ring_id"] == served_ring["ringId"], str(u.detail))
	t.check("changed: nothing was opened or replaced", ra.codec.kid() == c.detail["root_kid"] and (await ra.pin()).detail == pin1 and ra.codec.open("$settings", "theme", env)["ok"])
	# A restart does not open it either: the stored root is for the pinned ring.
	var ra2 := _restart(a)
	await ra2.status()
	var u2 := await ra2.unlock()
	t.check("changed: a restart reports the change too and the root stays the pinned one", u2.ok and u2.detail["kind"] == "ring-changed" and ra2.codec.kid() == c.detail["root_kid"])
	# Accepting a ring the person was not shown (a pin that differs from what is served) is refused again.
	var stale := {"ring_id": pin1["ring_id"], "epoch": 1, "root_kid": "22".repeat(16)}
	var us := await ra2.accept_ring_change(stale)
	t.check("changed: accepting a ring that is not the served one answers ring-changed", us.ok and us.detail["kind"] == "ring-changed" and (await ra2.pin()).detail == pin1)
	var shown: Dictionary = u2.detail["served"]
	var ok := await ra2.accept_ring_change(shown)
	t.check("changed: accepting the served ring opens the wrap and re-pins", ok.ok and ok.detail["kind"] == "unlocked" and (await ra2.pin()).detail["ring_id"] == served_ring["ringId"] and ra2.codec.kid() == served_ring["rootKid"])
	t.check("changed: the new root is stored for the next start", (await _restart(a).status()).detail["unlocked"])
	t.check("changed: a malformed confirmation is refused", not (await ra2.accept_ring_change({"ring_id": 5})).ok)
	# A wrap that does not open (no wrap for the new ring) leaves the old pin and root alone.
	var w3 := FakeWorker.new()
	var b := _device(w3, "dev_b")
	await (b["ring"] as PKeySyncRing).create(false)
	var pin_b: Dictionary = (await (b["ring"] as PKeySyncRing).pin()).detail
	w3.ring = {"ringId": "rg_" + "A".repeat(22), "epoch": 1, "rootKid": "33".repeat(16), "state": "active", "createdAt": 1, "recovery": {"set": false}, "adopted": [], "previous": null}
	w3.wraps = {}
	var accept_nowrap := await (b["ring"] as PKeySyncRing).accept_ring_change({"ring_id": w3.ring["ringId"], "epoch": 1, "root_kid": w3.ring["rootKid"]})
	t.check("changed: accepting a ring with no wrap for this device changes nothing", accept_nowrap.ok and accept_nowrap.detail["kind"] == "locked" and (await (b["ring"] as PKeySyncRing).pin()).detail == pin_b and (b["ring"] as PKeySyncRing).codec.kid() == pin_b["root_kid"])


func _recovery(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var ra: PKeySyncRing = a["ring"]
	var c := await ra.create()
	var code: String = c.detail["recovery_code"]
	var env := ra.codec.seal("$settings", "theme", "dark")
	var d := _device(w, "dev_d")
	var rd: PKeySyncRing = d["ring"]
	var n: int = w.requests.size()
	var bad := await rd.recover(code.substr(0, 38) + ("0" if code[38] != "0" else "1"))
	t.check("recover: a bad checksum is refused before any request", not bad.ok and bad.code == &"recovery-code-invalid" and w.requests.size() == n)
	t.check("recover: text that is not a code is refused before any request", not (await rd.recover("hello")).ok and w.requests.size() == n)
	var other := PKeySyncRecoveryCode.encode(PackedByteArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
	var wrong := await rd.recover(other)
	t.check("recover: a valid code for no ring is recovery-code-invalid and holds nothing", not wrong.ok and wrong.code == &"recovery-code-invalid" and not rd.unlocked() and (await rd.pin()).detail == null)
	var got := await rd.recover(code.to_lower().replace("-", " "))
	t.check("recover: the code opens the root, holds and pins it", got.ok and rd.unlocked() and rd.codec.kid() == c.detail["root_kid"] and (await rd.pin()).detail["ring_id"] == c.detail["ring_id"], str(got))
	t.check("recover: this device deposits its own wrap", got.ok and got.detail["wrap_deposited"] and w.wraps.has("dev_d") and w.wraps["dev_d"]["by"] == "dev_d")
	t.check("recover: the recovered root opens the first device's values", rd.codec.open("$settings", "theme", env)["ok"])
	var rd2 := _restart(d)
	rd2.lock()
	t.check("recover: the next start unlocks without the code", (await rd2.unlock()).detail["kind"] == "unlocked")
	# set_recovery_code: a new code, the old one stops working.
	var fresh := await ra.set_recovery_code()
	t.check("recover: set_recovery_code returns a new code", fresh.ok and fresh.detail != code and String(fresh.detail).length() == 39)
	var e := _device(w, "dev_e")
	var old := await (e["ring"] as PKeySyncRing).recover(code)
	t.check("recover: the previous code stops working", not old.ok and old.code == &"recovery-code-invalid")
	var neu := await (e["ring"] as PKeySyncRing).recover(fresh.detail)
	t.check("recover: the new code works", neu.ok and (e["ring"] as PKeySyncRing).unlocked())
	t.check("recover: set_recovery_code while locked is sync-locked", (await _device(w, "dev_z")["ring"].set_recovery_code()).code == &"sync-locked")
	# A ring with no recovery blob.
	var w2 := FakeWorker.new()
	var a2 := _device(w2, "dev_a")
	await (a2["ring"] as PKeySyncRing).create(false)
	var nr := await (_device(w2, "dev_q")["ring"] as PKeySyncRing).recover(code)
	t.check("recover: a ring with no recovery code is not_found", not nr.ok and nr.code == &"not_found")
	t.check("recover: the code is kept nowhere", _quiet(t, [str(ra), str(rd), str(got)], [code.replace("-", ""), String(fresh.detail).replace("-", "")]))


func _guards(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var ra: PKeySyncRing = a["ring"]
	var locked_wrap := await ra.wrap_to("dev_b", PackedByteArray())
	t.check("guards: wrap_to while locked is sync-locked", not locked_wrap.ok and locked_wrap.code == &"sync-locked")
	t.check("guards: adopt while locked is sync-locked", (await ra.adopt("rg_" + "A".repeat(22))).code == &"sync-locked")
	t.check("guards: open_adopted while locked is sync-locked", (await ra.open_adopted()).code == &"sync-locked")
	# No device keys: create is a result, not an assert.
	var nokeys := PKeySyncRing.new(PRODUCT, "dev_a", w.client("dev_a"), null, PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	var nk := await nokeys.create()
	t.check("guards: create without device keys is device_keys_required", not nk.ok and nk.code == &"device_keys_required" and w.requests.is_empty())
	# No root without a pin: a pin that cannot be written leaves nothing held.
	var nopin_vault := NoPinVault.new(PRODUCT, "user://pkey", true)
	var np := PKeySyncRing.new(PRODUCT, "dev_a", w.client("dev_a"), a["keys"], nopin_vault)
	var r := await np.create()
	t.check("guards: a pin that cannot be written leaves no root held", not r.ok and not np.unlocked() and not (await np.status()).detail["root_stored"])
	# A stored root with no pin is never taken back.
	var w2 := FakeWorker.new()
	var b := _device(w2, "dev_b")
	var c := await (b["ring"] as PKeySyncRing).create(false)
	var v: PKeySyncRingVault = b["vault"]
	var rec: Dictionary = v.read_root().detail
	var v2 := PKeySyncRingVault.new(PRODUCT, "user://pkey", true)
	v2.write_root(rec["ring_id"], rec["epoch"], rec["kid"].hex_decode(), rec["root"])
	var orphan := PKeySyncRing.new(PRODUCT, "dev_b", w2.client("dev_b"), b["keys"], v2)
	var so := await orphan.status()
	t.check("guards: a stored root with no pin is not used", so.ok and not so.detail["unlocked"] and so.detail["root_stored"])
	# A stored root for another ring than the pinned one is not used.
	v2.write_pin({"ring_id": "rg_" + "B".repeat(22), "epoch": 1, "root_kid": rec["kid"]})
	var so2 := await orphan.status()
	t.check("guards: a stored root that does not match the pin is not used", so2.ok and not so2.detail["unlocked"])
	v2.write_pin({"ring_id": rec["ring_id"], "epoch": rec["epoch"], "root_kid": rec["kid"]})
	t.check("guards: it is used once the pin matches", (await orphan.status()).detail["unlocked"])
	# A stored root whose bytes do not derive its own kid is not used.
	var v3 := PKeySyncRingVault.new(PRODUCT, "user://pkey", true)
	var bad_root: PackedByteArray = rec["root"].duplicate()
	bad_root[0] ^= 1
	v3.write_root(rec["ring_id"], rec["epoch"], rec["kid"].hex_decode(), bad_root)
	v3.write_pin({"ring_id": rec["ring_id"], "epoch": rec["epoch"], "root_kid": rec["kid"]})
	var tampered := PKeySyncRing.new(PRODUCT, "dev_b", w2.client("dev_b"), b["keys"], v3)
	t.check("guards: a stored root that does not derive its kid is not used", not (await tampered.status()).detail["unlocked"])
	# A Worker that fails: a failure result with the Worker's code, nothing held.
	var down := PKeySyncRing.new(PRODUCT, "dev_a", func(_m: String, _p: String, _b: Variant) -> PKeyResult: return PKeyResult.failure(&"network-error", "down"), a["keys"], PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	var ud := await down.unlock()
	t.check("guards: a failing Worker is a failure result", not ud.ok and ud.code == &"network-error" and not down.unlocked())
	var cd := await down.create()
	t.check("guards: a failed create holds nothing and pins nothing", not cd.ok and not down.unlocked() and (await down.pin()).detail == null)
	# Two verbs at once are serialised.
	var order: Array = []
	var slow := func(_m: String, p: String, _b: Variant) -> PKeyResult:
		order.append(p)
		await (Engine.get_main_loop() as SceneTree).process_frame
		order.append("done " + p)
		return PKeyResult.success({"status": 200, "body": "{\"ring\":null,\"wrap\":null}".to_utf8_buffer()})
	var ser := PKeySyncRing.new(PRODUCT, "dev_a", slow, null, PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	ser.read.call()
	ser.read.call()
	for _i in 6:
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("guards: verbs are serialised", order == ["devices/keyring", "done devices/keyring", "devices/keyring", "done devices/keyring"], str(order))
	t.check("guards: c is unused", c.ok)


func _adopt(t: PKeyTestContext) -> void:
	var w := FakeWorker.new()
	var a := _device(w, "dev_a")
	var ra: PKeySyncRing = a["ring"]
	var c1 := await ra.create(false)
	var old_env := ra.codec.seal("$settings", "theme", "dark")
	var c2 := await ra.reset(false)
	t.check("adopt: reset makes a new ring and root", c2.ok and c2.detail["ring_id"] != c1.detail["ring_id"] and ra.codec.kid() == c2.detail["root_kid"] and w.ring["previous"]["ringId"] == c1.detail["ring_id"])
	t.check("adopt: the pin follows the reset", (await ra.pin()).detail["ring_id"] == c2.detail["ring_id"])
	t.check("adopt: the old root stays readable in memory through the codec", ra.codec.open("$settings", "theme", old_env)["ok"])
	var bad := await ra.adopt("rg_" + "Z".repeat(22))
	t.check("adopt: a ring whose root is not held is refused", not bad.ok and bad.code == &"invalid-argument")
	var ad := await ra.adopt(c1.detail["ring_id"])
	t.check("adopt: adopt sends the old root sealed under the current one", ad.ok and w.adopted.size() == 1 and w.adopted[0]["ringId"] == c1.detail["ring_id"] and w.adopted[0]["kid"] == c1.detail["root_kid"])
	# A second device that only has the new root reads the old data through open_adopted.
	var b := _device(w, "dev_b")
	await ra.wrap_to("dev_b", (b["keys"] as PKeyDeviceKeyStore).ensure().detail["agree_key"])
	var rb: PKeySyncRing = b["ring"]
	await rb.unlock()
	t.check("adopt: before open_adopted the old envelope is a kid mismatch", rb.codec.open("$settings", "theme", old_env).get("reason") == "kid")
	var oa := await rb.open_adopted()
	t.check("adopt: open_adopted opens the candidates and keeps the roots", oa.ok and oa.detail == [c1.detail["ring_id"]] and rb.codec.open("$settings", "theme", old_env)["ok"], str(oa))
	# A candidate that does not open is skipped.
	w.adopted[0]["ct"] = PKeyB64Url.encode(_flip(PKeyB64Url.decode_strict(w.adopted[0]["ct"])))
	var rb2 := _restart(b)
	rb2.lock()
	await rb2.unlock()
	var oa2 := await rb2.open_adopted()
	t.check("adopt: a candidate that does not open is skipped", oa2.ok and oa2.detail.is_empty())
	# A host-supplied root.
	var fresh_root := Crypto.new().generate_random_bytes(32)
	var hr := await ra.adopt_root("rg_" + "H".repeat(22), 2, fresh_root)
	t.check("adopt: adopt_root sends a root the host holds", hr.ok and w.adopted.back()["epoch"] == 2)
	t.check("adopt: adopt_root refuses a root that is not 32 bytes", (await ra.adopt_root("rg_" + "H".repeat(22), 2, PackedByteArray([1]))).code == &"invalid-argument")


func _vault_files(t: PKeyTestContext) -> void:
	var root := _dir("files")
	var kid := PKeySyncHkdf.derive_kid(PackedByteArray([7]))
	var secret := Crypto.new().generate_random_bytes(32)
	# Engine-encrypted file.
	var enc := PKeySyncRingVault.new(PRODUCT, root, false, true, null)
	enc.sealer = null
	enc.unique_id = "unit-test-machine"
	t.check("vault: encrypted file protection", enc.protection() == "encrypted-file" and enc.persistence() == "durable")
	t.check("vault: nothing stored yet", enc.read_root().ok and enc.read_root().detail == null and enc.read_pin().detail == null)
	t.check("vault: writes the root", enc.write_root("rg_" + "A".repeat(22), 1, kid, secret).ok)
	var rec: Dictionary = enc.read_root().detail
	t.check("vault: reads it back", rec["root"] == secret and rec["epoch"] == 1 and rec["kid"] == kid.hex_encode() and rec["ring_id"] == "rg_" + "A".repeat(22))
	t.check("vault: the file does not hold the root in the clear", not _file_has(root.path_join(PRODUCT).path_join("sync-root"), secret))
	var other := PKeySyncRingVault.new(PRODUCT, root, false, true, null)
	other.unique_id = "another-machine"
	var un := other.read_root()
	t.check("vault: another machine's id cannot open it (unreadable, never replaced)", not un.ok and un.code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	t.check("vault: the pin is plain JSON with no secret", enc.write_pin({"ring_id": "rg_" + "A".repeat(22), "epoch": 1, "root_kid": kid.hex_encode()}).ok and enc.read_pin().detail["epoch"] == 1 and not _file_has(root.path_join(PRODUCT).path_join("sync-ring-pin.json"), secret))
	# S-5: a crash between write and rename leaves a temporary sibling; clear sweeps it.
	for stray in ["sync-root.tmp-abc123", "sync-ring-pin.json.tmp-def456", "sync-root.salt.tmp-0"]:
		var sf := FileAccess.open(root.path_join(PRODUCT).path_join(stray), FileAccess.WRITE)
		sf.store_string("x")
		sf.close()
	t.check("vault: clear removes both and a later read finds none", enc.clear().ok and enc.read_root().detail == null and enc.read_pin().detail == null)
	var left := DirAccess.get_files_at(root.path_join(PRODUCT))
	t.check("vault: clear sweeps the temporary siblings too", Array(left).filter(func(n: String) -> bool: return n.contains(".tmp-")).is_empty(), str(left))
	# S-6: no sealer and no device id: the file key would rest on public inputs, so the root stays in memory.
	var noid := PKeySyncRingVault.new(PRODUCT, _dir("noid"), false, true, null)
	noid.sealer = null
	noid.unique_id = ""
	var wrote := noid.write_root("rg_" + "A".repeat(22), 1, kid, secret)
	t.check("vault: with no sealer and no device id the root is kept in memory only", wrote.ok and noid.persistence() == "memory" and noid.protection() == "memory" and not FileAccess.file_exists(_dir("noid").path_join(PRODUCT).path_join("sync-root")) and noid.read_root().detail["root"] == secret)
	# Native sealer.
	var sealer := PKeyFakeSealer.new("keystore")
	var sv := PKeySyncRingVault.new(PRODUCT, _dir("sealed"), false, true, sealer)
	t.check("vault: a sealer reports keystore-sealed", sv.protection() == "keystore-sealed")
	t.check("vault: seals through the sealer", sv.write_root("rg_" + "A".repeat(22), 3, kid, secret).ok and sealer.calls.has("seal"))
	var r2 := sv.read_root()
	t.check("vault: opens through the sealer", r2.ok and r2.detail["root"] == secret and r2.detail["epoch"] == 3 and sealer.calls.has("open"))
	sealer.key = PackedByteArray()
	var gone := sv.read_root()
	t.check("vault: a lost platform key is unreadable, not empty", not gone.ok and gone.code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	sealer.fault_seal = true
	t.check("vault: a sealer fault is a store fault", sv.write_root("rg_" + "A".repeat(22), 3, kid, secret).code == PKeyDeviceKeyStore.STORE_FAULT)
	_vault_plain_refused(t, kid, secret)
	t.check("vault: a root outside user:// is kept in memory", PKeySyncRingVault.new(PRODUCT, "/tmp/x", false, false).persistence() == "memory")
	t.check("vault: clear leaves the platform key (the device keys share it)", not sealer.calls.has("destroy") and sv.clear().ok and not sealer.calls.has("destroy"))


## The root is never written as a plain file: a vault made with `encrypted = false` refuses it with a
## typed error, and only `for_tests` keeps one.
func _vault_plain_refused(t: PKeyTestContext, kid: PackedByteArray, secret: PackedByteArray) -> void:
	var plain_dir := _dir("plain")
	var plain_file := plain_dir.path_join(PRODUCT).path_join("sync-root")
	var refused := PKeySyncRingVault.new(PRODUCT, plain_dir, false, false)
	var w := refused.write_root("rg_" + "A".repeat(22), 1, kid, secret)
	t.check("vault: encrypted = false is refused for the root with invalid-options", not w.ok and w.code == PKeyConstants.ErrorCode.INVALID_OPTIONS, str(w))
	t.check("vault: the refusal wrote nothing", not FileAccess.file_exists(plain_file))
	var r := refused.read_root()
	t.check("vault: and it refuses a read too", not r.ok and r.code == PKeyConstants.ErrorCode.INVALID_OPTIONS)
	t.check("vault: it reports refused", refused.protection() == "refused" and str(refused) == "PKeySyncRingVault(refused)")
	t.check("vault: the message carries no root", not w.message.contains(secret.hex_encode()) and not str(w).contains(secret.hex_encode()))
	var pin := {"ring_id": "rg_" + "A".repeat(22), "epoch": 1, "root_kid": kid.hex_encode()}
	t.check("vault: the pin holds no secret and is still kept", refused.write_pin(pin).ok and refused.read_pin().detail["epoch"] == 1)
	# A memory vault never touches a file, so the flag does not matter there.
	var mem := PKeySyncRingVault.new(PRODUCT, "user://pkey", true, false)
	var mem_ok := mem.write_root("rg_" + "A".repeat(22), 1, kid, secret).ok
	t.check("vault: a memory vault with encrypted = false keeps the root in memory", mem_ok and mem.protection() == "memory" and mem.read_root().detail["root"] == secret)
	# The test constructor is the one way to a plain file, and the file shows why it is test only.
	var tv := PKeySyncRingVault.for_tests(PRODUCT, plain_dir)
	var tv_ok := tv.write_root("rg_" + "A".repeat(22), 1, kid, secret).ok
	t.check("vault: for_tests keeps a plain file", tv_ok and tv.protection() == "file" and tv.read_root().detail["root"] == secret and _file_has(plain_file, secret))
	t.check("vault: a refused vault still clears a plain file a test vault left", refused.clear().ok and not FileAccess.file_exists(plain_file))


# ── helpers ──────────────────────────────────────────────────────────────────────────────

func _root_hex(ring: PKeySyncRing) -> String:
	return ring._memory.held.root.hex_encode() if ring._memory.held != null else "ffffffffffffffffffffffff"


static func _flip(b: PackedByteArray) -> PackedByteArray:
	var c := b.duplicate()
	c[c.size() - 1] ^= 1
	return c


static func _file_has(path: String, needle: PackedByteArray) -> bool:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return false
	var raw := f.get_buffer(8192)
	f.close()
	return raw.hex_encode().contains(needle.hex_encode())


## True when none of `secrets` (text) appears in any of `texts`.
func _quiet(_t: PKeyTestContext, texts: Array, secrets: Array) -> bool:
	for x in texts:
		for s in secrets:
			if String(x).contains(String(s)):
				return false
	return true


## PolarisKey.keyring: null until configure(), built by PKeySyncRing.for_core over the options' device
## keys and vault, and forgotten by the sign-out hook.
func _facade(t: PKeyTestContext) -> void:
	var sdk := PKeyTestFixtures.new_sdk()
	t.check("facade: keyring is null before configure", sdk.keyring == null)
	var store := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_L7Z_jTR0YsyzhMxHLBdEwKZ4yW2Uu4m6CANM1oHQiUA")
	var opts := PKeyTestFixtures.options("http://127.0.0.1:1", store, [1700000000], PRODUCT, {}, "1.0.0")
	opts.device_keys = PKeyDeviceKeyStore.new(PRODUCT, _dir("facade-keys"), false, false)
	opts.ring_vault = PKeySyncRingVault.new(PRODUCT, "user://pkey", true)
	t.check("facade: configure is ok", sdk.configure(opts).ok)
	var ring: PKeySyncRing = sdk.keyring
	t.check("facade: keyring is a PKeySyncRing for this product and device", ring != null and ring.product == PRODUCT and ring.device_id == sdk.core.device_id)
	var root := Crypto.new().generate_random_bytes(32)
	var kid := PKeySyncHkdf.derive_kid(root)
	var vault: PKeySyncRingVault = opts.ring_vault
	vault.write_pin({"ring_id": "rg_" + "A".repeat(22), "epoch": 1, "root_kid": kid.hex_encode()})
	vault.write_root("rg_" + "A".repeat(22), 1, kid, root)
	t.check("facade: a stored root is taken back offline", (await ring.status()).detail["unlocked"])
	t.check("facade: the sign-out hook is registered once, even after a second configure", sdk.identity._before_sign_out.size() == 1)
	sdk.configure(opts)
	t.check("facade: and still once after a second configure", sdk.identity._before_sign_out.size() == 1 and sdk.keyring != null)
	for hook in sdk.identity._before_sign_out:
		await hook.call()
	t.check("facade: sign-out forgets the root and the pin", not sdk.keyring.unlocked() and vault.read_pin().detail == null and vault.read_root().detail == null)
	sdk.queue_free()
