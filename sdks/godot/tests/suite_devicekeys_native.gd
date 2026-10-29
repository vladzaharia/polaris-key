extends RefCounted
# @pkey-feature core.devicekeys
# The device key store with a native sealer (CC-26.7; plans/CC-01.md R-5, Q12): selection and the
# fallback, the sealed record on disk, the unreadable-is-an-error rule (never replaced, only wipe()
# resets it), a fault that is not "gone", a missing lane that is unsupported and not unreadable, wipe
# destroying the platform key, and the three lane adapters (Apple, Android, Windows) over fake natives:
# request shapes, the product binding and the reply mapping. The real Keychain, Keystore and DPAPI are
# exercised by the lanes' own builds (Swift DeviceKeySealerTests, Kotlin SealerCommandsTest).

const PRODUCT := "djdl"


## A stand-in for the PolarisKeyApple / PolarisKeyAndroid `cmd(json)` surface, sealing with a keyed
## transform like PKeyFakeSealer. `prefix` is "dk" (Apple) or "ks" (Android).
class FakeLane:
	extends RefCounted
	var prefix := "dk"
	var inner := PKeyFakeSealer.new()
	var requests: Array[Dictionary] = []
	## Answer every op with this reply instead (empty: behave).
	var force := {}

	func cmd(json: String) -> String:
		var q: Dictionary = JSON.parse_string(json)
		requests.append(q)
		if not force.is_empty():
			return JSON.stringify(force)
		var ctx := Marshalls.base64_to_raw(str(q.get("context", "")))
		var op := str(q.get("op", ""))
		if op == prefix + "_seal" or op == "ks_seal":
			var r := inner.seal(Marshalls.base64_to_raw(str(q["plain"])), ctx)
			return JSON.stringify({"ok": true, "blob": Marshalls.raw_to_base64(r.detail)})
		if op == prefix + "_open" or op == "ks_open":
			var r := inner.open(Marshalls.base64_to_raw(str(q["blob"])), ctx)
			if not r.ok:
				return JSON.stringify({"ok": false, "error": "unopenable"})
			return JSON.stringify({"ok": true, "plain": Marshalls.raw_to_base64(r.detail)})
		if op == prefix + "_destroy" or op == "ks_destroy":
			inner.destroy()
			return JSON.stringify({"ok": true})
		return JSON.stringify({"ok": false, "error": "unknown_op"})


## A stand-in for PKeyWinDpapiNative.
class FakeDpapi:
	extends RefCounted
	var inner := PKeyFakeSealer.new("dpapi")
	var win32_fault := 0
	var calls: Array[String] = []

	func protect(data: PackedByteArray, entropy: PackedByteArray) -> Dictionary:
		calls.append("protect")
		if win32_fault != 0:
			return {"ok": false, "error": "CryptProtectData failed", "win32": win32_fault, "unopenable": false}
		return {"ok": true, "blob": inner.seal(data, entropy).detail}

	func unprotect(blob: PackedByteArray, entropy: PackedByteArray) -> Dictionary:
		calls.append("unprotect")
		if win32_fault != 0:
			return {"ok": false, "error": "CryptUnprotectData failed", "win32": win32_fault, "unopenable": false}
		var r := inner.open(blob, entropy)
		if not r.ok:
			return {"ok": false, "error": "CryptUnprotectData failed", "win32": 13, "unopenable": true}
		return {"ok": true, "plain": r.detail}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_selection(t)
	_sealed_record(t)
	_unreadable(t)
	_faults(t)
	_missing_lane(t)
	_wipe(t)
	_lanes(t)
	return true


static func _dir(tag: String) -> String:
	return PKeyTestFixtures.scratch_dir("dkn-" + tag)


static func _store(root: String, sealer: PKeyRecordSealer) -> PKeyDeviceKeyStore:
	return PKeyDeviceKeyStore.new(PRODUCT, root, false, true, sealer)


static func _bytes(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path)


static func _record(root: String) -> String:
	return root.path_join(PRODUCT).path_join(PKeyDeviceKeyStore.RECORD_FILE)


func _selection(t: PKeyTestContext) -> void:
	var fake := PKeyFakeSealer.new("keystore")
	var s := _store(_dir("sel"), fake)
	t.check("selection: a sealer is used and reported", s.protection() == "keystore-sealed" and not s.best_effort() and s.persistence() == "durable")
	t.check("selection: hardware_backed follows what the sealer knows", not s.hardware_backed())
	fake.hardware = true
	t.check("selection: a key that reports secure hardware is hardware-backed", s.hardware_backed())
	var kc := _store(_dir("sel2"), PKeyFakeSealer.new("keychain"))
	t.check("selection: a keychain sealer is not hardware by its name", kc.protection() == "keychain-sealed" and not kc.hardware_backed())
	var login := PKeyAppleSealer.new(PRODUCT, PKeyApple.new(), true)
	var ios := PKeyAppleSealer.new(PRODUCT, PKeyApple.new(), false)
	t.check("selection: the macOS login keychain is not hardware, the iOS data-protection keychain is", not login.hardware_backed() and ios.hardware_backed())
	var bad := PKeyDeviceKeyStore.new("Bad Slug", _dir("sel5"))
	var br := bad.ensure()
	t.check("selection: a non-slug product is refused up front as invalid-options", not br.ok and br.code == PKeyErrors.INVALID_OPTIONS
			and bad.public_keys().code == PKeyErrors.INVALID_OPTIONS and bad.sign(PackedByteArray()).code == PKeyErrors.INVALID_OPTIONS and bad.wipe().code == PKeyErrors.INVALID_OPTIONS)
	var dp := _store(_dir("sel3"), PKeyFakeSealer.new("dpapi"))
	t.check("selection: dpapi is sealed but not claimed as hardware", dp.protection() == "dpapi-sealed" and not dp.hardware_backed() and not dp.best_effort())
	var mem := PKeyDeviceKeyStore.new(PRODUCT, "user://pkey", true, true, fake)
	t.check("selection: a memory store never uses a sealer", mem.sealer == null and mem.protection() == "memory")
	var plain := PKeyDeviceKeyStore.new(PRODUCT, _dir("sel4"), false, false, fake)
	t.check("selection: a plain-file store never uses a sealer, and is refused", plain.sealer == null and plain.protection() == "refused" and plain.ensure().code == PKeyErrors.INVALID_OPTIONS)
	t.check("selection: a test-only plain-file store has no sealer", PKeyDeviceKeyStore.for_tests(PRODUCT, _dir("sel4t")).sealer == null)
	var outside := PKeyDeviceKeyStore.new(PRODUCT, "/tmp/x", false, true, fake)
	t.check("selection: a root outside user:// gets no sealer (and still refuses to write)", outside.sealer == null and not outside.ensure().ok)
	# No native lane in this run: the platform's choice is the fallback, unchanged.
	t.check("fallback: no lane, no sealer", PKeyRecordSealer.for_platform(PRODUCT, "linux") == null and PKeyRecordSealer.for_platform(PRODUCT, "windows") == null \
			and PKeyRecordSealer.for_platform(PRODUCT, "") == null)
	var fb := PKeyDeviceKeyStore.new(PRODUCT, _dir("fb"))
	var e := fb.ensure()
	t.check("fallback: the store is the CC-26.6 encrypted file", e.ok and fb.sealer == null and fb.protection() == "encrypted-file"
			and _bytes(_record(fb.dir.get_base_dir())).slice(0, 4).get_string_from_ascii() == "GDEC", str(e))
	t.check("fallback: the base sealer is unavailable and answers unsupported", PKeyRecordSealer.new().unavailable() != ""
			and PKeyRecordSealer.new().seal(PackedByteArray(), PackedByteArray()).code == &"unsupported")


func _sealed_record(t: PKeyTestContext) -> void:
	var root := _dir("rec")
	var fake := PKeyFakeSealer.new()
	var s := _store(root, fake)
	var e := s.ensure()
	if not t.check("sealed: ensure ok", e.ok, str(e)):
		return
	var raw := _bytes(_record(root))
	t.check("sealed: the file is PKSL v1 + the blob, not the record", raw.slice(0, 4).get_string_from_ascii() == "PKSL" and raw[4] == 1 and raw.size() > 5
			and raw.slice(0, 4).get_string_from_ascii() != "PKDK")
	var salt := FileAccess.file_exists(root.path_join(PRODUCT).path_join(PKeyDeviceKeyStore.SALT_FILE))
	t.check("sealed: no install salt is made (the sealer replaces the passphrase)", not salt)
	t.check("sealed: one key made", fake.made == 1)
	# The record reads back through a second store and signs and agrees.
	var s2 := _store(root, fake)
	var pk := s2.public_keys()
	t.check("sealed: a second store reads the same keys", pk.ok and pk.detail != null and pk.detail["sign_key"] == e.detail["sign_key"] and pk.detail["generation"] == 1)
	var msg := "hello".to_utf8_buffer()
	var sig := s2.sign(msg)
	var sign_pub: PackedByteArray = PKeyB64Url.decode_strict(e.detail["sign_key"])
	t.check("sealed: it signs", sig.ok and PKeyEd25519.verify(sig.detail, msg, sign_pub))
	var peer_priv := Crypto.new().generate_random_bytes(32)
	var dh := s2.dh(PKeyCurve25519.x25519_public(peer_priv))
	t.check("sealed: it agrees", dh.ok and dh.detail == PKeyCurve25519.x25519(peer_priv, PKeyB64Url.decode_strict(e.detail["agree_key"]) as PackedByteArray))
	var rot := s2.rotate()
	t.check("sealed: rotate bumps the generation under the same platform key", rot.ok and rot.detail["generation"] == 2 and fake.made == 1)
	t.check("sealed: no secret in a result or in str()", not (str(e) + str(sig) + str(rot) + str(s2)).contains(_hex_of_record(fake, root)))


## The hex of the record's seed, opened through the fake (for a leak check).
static func _hex_of_record(fake: PKeyFakeSealer, root: String) -> String:
	var raw := _bytes(root.path_join(PRODUCT).path_join(PKeyDeviceKeyStore.RECORD_FILE))
	var r := fake.open(raw.slice(5), ("pkey-device-keys/1/%s" % PRODUCT).to_utf8_buffer())
	return (r.detail as PackedByteArray).slice(13, 45).hex_encode() if r.ok else "no-record"


func _unreadable(t: PKeyTestContext) -> void:
	var root := _dir("unr")
	var fake := PKeyFakeSealer.new()
	var s := _store(root, fake)
	s.ensure()
	var path := _record(root)
	var before := _bytes(path)
	var made := fake.made
	# The platform key is gone (a new device, a restore, an invalidated key).
	fake.key = PackedByteArray()
	var peer := PKeyCurve25519.x25519_public(Crypto.new().generate_random_bytes(32))
	var calls := [["public_keys", s.public_keys()], ["ensure", s.ensure()], ["rotate", s.rotate()], ["sign", s.sign("x".to_utf8_buffer())], ["dh", s.dh(peer)]]
	for pair in calls:
		var r: PKeyResult = pair[1]
		t.check("unreadable: %s with the platform key gone is KEYS_UNREADABLE" % pair[0], not r.ok and r.code == PKeyDeviceKeyStore.KEYS_UNREADABLE, str(r))
	t.check("unreadable: the record is untouched and no key was made", _bytes(path) == before and fake.made == made and fake.key.is_empty())
	# Tampering.
	var t2 := _dir("unr2")
	var f2 := PKeyFakeSealer.new()
	var s2 := _store(t2, f2)
	s2.ensure()
	var p2 := _record(t2)
	var raw := _bytes(p2)
	raw[raw.size() - 1] ^= 1
	var w := FileAccess.open(p2, FileAccess.WRITE)
	w.store_buffer(raw)
	w.close()
	var r2 := s2.ensure()
	t.check("unreadable: a flipped byte fails the tag, ensure does not replace it", not r2.ok and r2.code == PKeyDeviceKeyStore.KEYS_UNREADABLE and _bytes(p2) == raw, str(r2))
	# A sealed record for another product does not open as this one.
	var other := PKeyDeviceKeyStore.new("other", t2, false, true, f2)
	DirAccess.make_dir_recursive_absolute(other.dir)
	var cp := FileAccess.open(other.dir.path_join(PKeyDeviceKeyStore.RECORD_FILE), FileAccess.WRITE)
	cp.store_buffer(before)
	cp.close()
	t.check("unreadable: a record copied to another product is unreadable (the context binds the product)", other.public_keys().code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	# A short, wrong-version or empty-blob file.
	for bad in [PackedByteArray([0x50, 0x4b, 0x53, 0x4c, 1]), PackedByteArray([0x50, 0x4b, 0x53, 0x4c, 9, 1, 2, 3])]:
		var t3 := _dir("unr3")
		var s3 := _store(t3, PKeyFakeSealer.new())
		DirAccess.make_dir_recursive_absolute(s3.dir)
		var bf := FileAccess.open(_record(t3), FileAccess.WRITE)
		bf.store_buffer(bad)
		bf.close()
		t.check("unreadable: a truncated or wrong-version sealed file is unreadable", s3.ensure().code == PKeyDeviceKeyStore.KEYS_UNREADABLE and _bytes(_record(t3)) == bad)
	# A sealer that returns a record of the wrong shape.
	var t4 := _dir("unr4")
	var f4 := PKeyFakeSealer.new()
	var s4 := _store(t4, f4)
	DirAccess.make_dir_recursive_absolute(s4.dir)
	var junk := f4.seal(PackedByteArray([1, 2, 3]), ("pkey-device-keys/1/%s" % PRODUCT).to_utf8_buffer()).detail as PackedByteArray
	var framed := "PKSL".to_ascii_buffer()
	framed.append(1)
	framed.append_array(junk)
	var jf := FileAccess.open(_record(t4), FileAccess.WRITE)
	jf.store_buffer(framed)
	jf.close()
	t.check("unreadable: a sealed record of the wrong shape is unreadable, not replaced", s4.ensure().code == PKeyDeviceKeyStore.KEYS_UNREADABLE and _bytes(_record(t4)) == framed)
	# A record written before the lane existed (CC-26.6's file), met by a store with a sealer.
	var t5 := _dir("unr5")
	var legacy := PKeyDeviceKeyStore.new(PRODUCT, t5)
	legacy.ensure()
	var lraw := _bytes(_record(t5))
	var sealed_store := _store(t5, PKeyFakeSealer.new())
	var lr := sealed_store.ensure()
	t.check("unreadable: a record that is not sealed is not read through the weaker path or replaced", not lr.ok and lr.code == PKeyDeviceKeyStore.KEYS_UNREADABLE
			and _bytes(_record(t5)) == lraw, str(lr))
	t.check("unreadable: wipe() clears it and the next ensure seals", sealed_store.wipe().ok and sealed_store.ensure().ok and _bytes(_record(t5)).slice(0, 4).get_string_from_ascii() == "PKSL")


func _faults(t: PKeyTestContext) -> void:
	var root := _dir("flt")
	var fake := PKeyFakeSealer.new()
	var s := _store(root, fake)
	var e := s.ensure()
	var path := _record(root)
	var before := _bytes(path)
	fake.fault_open = true
	for pair in [["public_keys", s.public_keys()], ["ensure", s.ensure()], ["rotate", s.rotate()], ["sign", s.sign("x".to_utf8_buffer())]]:
		var r: PKeyResult = pair[1]
		t.check("fault: %s on a sealer fault is STORE_FAULT, never unreadable or no keys" % pair[0], not r.ok and r.code == PKeyDeviceKeyStore.STORE_FAULT, str(r))
	t.check("fault: nothing changed", _bytes(path) == before and fake.made == 1)
	fake.fault_open = false
	var again := s.public_keys()
	t.check("fault: the keys come back when the fault passes", again.ok and again.detail["sign_key"] == e.detail["sign_key"])
	fake.fault_seal = true
	var rot := s.rotate()
	t.check("fault: a seal fault leaves the old record in place", not rot.ok and rot.code == PKeyDeviceKeyStore.STORE_FAULT and _bytes(path) == before)
	var fresh := _store(_dir("flt2"), fake)
	t.check("fault: a seal fault on first use writes nothing", fresh.ensure().code == PKeyDeviceKeyStore.STORE_FAULT and not FileAccess.file_exists(_record(fresh.dir.get_base_dir())))


func _missing_lane(t: PKeyTestContext) -> void:
	var root := _dir("lane")
	var s := _store(root, PKeyFakeSealer.new())
	s.ensure()
	var path := _record(root)
	var before := _bytes(path)
	var bare := _store(root, null)
	t.check("lane: this runtime has no lane to hand over", bare.sealer == null)
	for pair in [["public_keys", bare.public_keys()], ["ensure", bare.ensure()], ["rotate", bare.rotate()], ["sign", bare.sign("x".to_utf8_buffer())]]:
		var r: PKeyResult = pair[1]
		t.check("lane: %s on a sealed record without its lane is unsupported, never unreadable" % pair[0], not r.ok and r.code == &"unsupported", str(r))
	t.check("lane: the sealed record is left alone", _bytes(path) == before)
	# The lane that cannot seal answers unsupported on a write.
	var gone := PKeyRecordSealer.new()
	var g := _store(_dir("lane2"), gone)
	var r2 := g.ensure()
	t.check("lane: a sealer that answers unsupported makes the store unsupported", not r2.ok and r2.code == &"unsupported", str(r2))
	bare.wipe()
	t.check("lane: wipe() still clears the record", not FileAccess.file_exists(path))


func _wipe(t: PKeyTestContext) -> void:
	var root := _dir("wipe")
	var fake := PKeyFakeSealer.new()
	var s := _store(root, fake)
	s.ensure()
	fake.key = PackedByteArray()
	var w := s.wipe()
	t.check("wipe: clears an unreadable record and calls destroy", w.ok and not FileAccess.file_exists(_record(root)) and fake.calls.has("destroy"))
	var e := s.ensure()
	t.check("wipe: the next ensure starts at generation 1 under a new platform key", e.ok and e.detail["generation"] == 1 and fake.made == 2)
	fake.fault_destroy = true
	var w2 := s.wipe()
	t.check("wipe: a destroy fault is surfaced; the record is already gone", not w2.ok and w2.code == PKeyDeviceKeyStore.STORE_FAULT and not FileAccess.file_exists(_record(root)))
	fake.fault_destroy = false
	var w3 := s.wipe()
	t.check("wipe: a retry finishes", w3.ok and fake.key.is_empty())
	t.check("wipe: nothing left to read", s.public_keys().ok and s.public_keys().detail == null)


func _lanes(t: PKeyTestContext) -> void:
	var ctx := ("pkey-device-keys/1/%s" % PRODUCT).to_utf8_buffer()
	var plain := Crypto.new().generate_random_bytes(141)
	# Apple (iOS: data-protection keychain; macOS: the login keychain).
	for flavor in ["ios", "macos"]:
		var lane := FakeLane.new()
		var apple := PKeyApple.new()
		apple.platform = flavor
		apple.native = lane
		var sealer := PKeyAppleSealer.new(PRODUCT, apple, flavor == "macos")
		t.check("apple %s: available with the plugin" % flavor, sealer.unavailable() == "" and sealer.id() == "keychain")
		var sealed := sealer.seal(plain, ctx)
		var opened := sealer.open(sealed.detail, ctx) if sealed.ok else sealed
		t.check("apple %s: seal and open round trip" % flavor, sealed.ok and opened.ok and opened.detail == plain, str(sealed))
		var q: Dictionary = lane.requests[0]
		t.check("apple %s: the request names the op, the product and the context" % flavor, q["op"] == "dk_seal" and q["product"] == PRODUCT and Marshalls.base64_to_raw(q["context"]) == ctx)
		t.check("apple %s: the login keychain is asked for on macOS only" % flavor, (q.get("keychain") == "login") == (flavor == "macos"))
		var bad := sealer.open(sealed.detail, "other".to_utf8_buffer())
		t.check("apple %s: another context is unreadable" % flavor, not bad.ok and bad.code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
		t.check("apple %s: destroy" % flavor, sealer.destroy().ok and lane.inner.key.is_empty() and lane.requests.back()["op"] == "dk_destroy")
		lane.force = {"ok": false, "error": "keychain", "status": -25308}
		var fault := sealer.open(sealed.detail, ctx)
		t.check("apple %s: an OSStatus fault is STORE_FAULT with the status only" % flavor, not fault.ok and fault.code == PKeyDeviceKeyStore.STORE_FAULT
				and fault.message.contains("-25308") and not fault.message.contains(Marshalls.raw_to_base64(plain)), str(fault))
		lane.force = {"ok": false, "unsupported": true, "reason": "runtime", "detail": "no keychain"}
		var un := sealer.seal(plain, ctx)
		t.check("apple %s: unsupported stays unsupported" % flavor, not un.ok and un.code == &"unsupported", str(un))
	var off := PKeyAppleSealer.new(PRODUCT, PKeyApple.new())
	off.apple.platform = "linux"
	t.check("apple: off Apple the sealer is unavailable", off.unavailable() != "")
	t.check("apple: no facade, unavailable", PKeyAppleSealer.new(PRODUCT, null).unavailable() != "")
	# Android.
	var alane := FakeLane.new()
	alane.prefix = "ks"
	var android := PKeyAndroid.new()
	android.platform = "android"
	android.native = alane
	var asl := PKeyAndroidSealer.new(PRODUCT, android)
	var asealed := asl.seal(plain, ctx)
	var aopen := asl.open(asealed.detail, ctx) if asealed.ok else asealed
	t.check("android: available, round trip over ks_seal / ks_open", asl.unavailable() == "" and asl.id() == "keystore" and asealed.ok and aopen.ok and aopen.detail == plain
			and alane.requests[0]["op"] == "ks_seal" and alane.requests[0]["product"] == PRODUCT)
	alane.force = {"ok": false, "error": "keystore", "reason": "keystore-provider", "message": "x"}
	var af := asl.open(asealed.detail, ctx)
	t.check("android: a Keystore provider fault is STORE_FAULT, not unreadable", not af.ok and af.code == PKeyDeviceKeyStore.STORE_FAULT and af.message.contains("keystore-provider"), str(af))
	alane.force = {"ok": false, "error": "unopenable"}
	t.check("android: unopenable is unreadable", asl.open(asealed.detail, ctx).code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	var no_android := PKeyAndroid.new()
	no_android.platform = "linux"
	t.check("android: off Android the sealer is unavailable", PKeyAndroidSealer.new(PRODUCT, no_android).unavailable() != "")
	# Windows.
	var dp := FakeDpapi.new()
	var ws := PKeyWinSealer.new(PRODUCT, dp)
	var wsealed := ws.seal(plain, ctx)
	var wopen := ws.open(wsealed.detail, ctx) if wsealed.ok else wsealed
	t.check("windows: round trip, the context is the entropy", ws.unavailable() == "" and ws.id() == "dpapi" and wsealed.ok and wopen.ok and wopen.detail == plain)
	var wbad := ws.open(wsealed.detail, "other".to_utf8_buffer())
	t.check("windows: another entropy (or user) is unreadable", wbad.code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	dp.win32_fault = 8
	var wf := ws.open(wsealed.detail, ctx)
	t.check("windows: any other failure is STORE_FAULT with the Win32 number", not wf.ok and wf.code == PKeyDeviceKeyStore.STORE_FAULT and wf.message.contains("8"), str(wf))
	t.check("windows: destroy has no key to delete", ws.destroy().ok)
	t.check("windows: without the DLL class the sealer is unavailable", PKeyWinSealer.new(PRODUCT).unavailable() != "" or ClassDB.class_exists(PKeyWinSealer.NATIVE_CLASS))
	# The whole store over the Windows fake.
	var st := _store(_dir("win"), PKeyWinSealer.new(PRODUCT, FakeDpapi.new()))
	var se := st.ensure()
	t.check("windows: a store over DPAPI", se.ok and st.protection() == "dpapi-sealed" and st.sign("m".to_utf8_buffer()).ok)
