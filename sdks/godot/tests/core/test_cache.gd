extends RefCounted
# PKeyCache's load procedure (WIRE-CONTRACT-V3 §4.1) over hand-edited records: whatever does not
# re-verify loads as ABSENT, never as trusted, and nothing derived is read from the file. The
# artifacts are the inner documents of the corpus bundle `bundle-valid-full` (a licence signed
# by the pinned key, a config signed by a rotated key only the manifest publishes).


func run(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.bundle_case("bundle-valid-full")
	if not t.check("cache: fixture bundle-valid-full present", c is Dictionary):
		return
	var v = PKeyJws.verify(c["bundleJws"], c["pinned"], PKeyClaims.TYP_BUNDLE, PKeyClaims.MAX_BUNDLE_BYTES)
	if not t.check("cache: fixture bundle verifies", v is Dictionary):
		return
	var b: Dictionary = v["payload"]
	var lic: String = b["docs"]["license"]
	var cfg: String = b["docs"]["config"]
	var good := {"v": 3, "trustJws": b["trust"], "docs": {"license": lic, "config": cfg}, "etags": {"license": "\"e1\""}}

	var r := await _load(c, good)
	t.check("cache: an intact record loads both documents", r.license != null and r.config != null)
	t.check("cache: the floor is the newest verified issuedAt", r.clock.high_water() == 1700000000.0, str(r.clock.high_water()))
	t.check("cache: last_verified_at is derived from the documents", r.last_verified_at == 1700000000.0, str(r.last_verified_at))
	t.check("cache: the ETag is kept", r.etag("license") == "\"e1\"")

	var tampered := good.duplicate(true)
	tampered["docs"]["license"] = _flip_payload_byte(lic)
	r = await _load(c, tampered)
	t.check("cache: a changed payload byte loads as absent", r.license == null and r.config != null)
	t.check("cache: the failed slice and its ETag leave the record", not r.record()["docs"].has("license") and r.etag("license") == "", str(r.record()))

	for v_bad in [2, 2.0, "3", null, 4]:
		var old := good.duplicate(true)
		old["v"] = v_bad
		r = await _load(c, old)
		t.check("cache: a record with v=%s loads as absent" % JSON.stringify(v_bad), r.license == null and r.config == null and r.record() == null)
	var three_float := good.duplicate(true)
	three_float["v"] = 3.0
	r = await _load(c, three_float)
	t.check("cache: v=3.0 is v 3 (numbers are floats)", r.license != null)

	var foreign := good.duplicate(true)
	foreign.erase("trustJws")
	r = await _load(c, foreign)
	t.check("cache: a document under a kid outside the effective set loads as absent", r.config == null and r.license != null)

	var bad_trust := good.duplicate(true)
	bad_trust["trustJws"] = _flip_payload_byte(b["trust"])
	r = await _load(c, bad_trust)
	t.check("cache: a tampered trust manifest is dropped and publishes no keys", r.config == null and not r.record().has("trustJws"))

	var other_device := good.duplicate(true)
	r = await _load(c, other_device, "someone-else")
	t.check("cache: documents bound to another device load as absent", r.license == null and r.config == null)

	var counters := good.duplicate(true)
	counters["highWaterMark"] = 9999999999
	counters["lastVerifiedAt"] = 9999999999999
	counters["floor"] = 9999999999
	counters["lastAcceptedIssuedAt"] = {"license": 9999999999}
	r = await _load(c, counters)
	t.check("cache: derived counters are never read from disk", r.clock.high_water() == 1700000000.0 and r.last_verified_at == 1700000000.0 and r.license != null)
	t.check("cache: unknown fields are dropped from the record", not r.record().has("highWaterMark") and not r.record().has("floor"))

	var hints := good.duplicate(true)
	hints["blocked"] = {"reason": "ok"}
	hints["lastSyncUnauthorized"] = "yes"
	r = await _load(c, hints)
	t.check("cache: a block hint with an unknown reason is dropped, not turned into a status", r.blocked == null)
	t.check("cache: lastSyncUnauthorized must be the boolean true", r.last_sync_unauthorized == false)
	hints["blocked"] = {"reason": "version-too-old", "allowedRange": {"min": "2.0.0", "x": 1}}
	hints["lastSyncUnauthorized"] = true
	r = await _load(c, hints)
	t.check("cache: a valid block hint loads", r.blocked == {"reason": "version-too-old", "allowedRange": {"min": "2.0.0"}}, str(r.blocked))
	t.check("cache: a recorded hard 401 loads", r.last_sync_unauthorized)

	# One whole-record write: two staged slices and both hints land in a single write.
	var store := PKeyMemoryStore.new(c["deviceId"])
	var cache := PKeyCache.new(store, PKeyTrust.new(c["pinned"]), PKeyClock.new(func(): return c["now"]), c["expectedAud"], c["deviceId"])
	await cache.load_record()
	var lic_doc = await PKeyVerify.verify_license_doc(lic, {"trust": c["pinned"], "expected_aud": "djdl", "device_id": c["deviceId"], "check_freshness": false, "last_accepted_issued_at": null})
	cache.apply_license(lic, lic_doc, "\"x\"")
	t.check("cache: staging does not write", store.cache_writes == 0)
	cache.flush({"lastSyncUnauthorized": true, "blocked": {"reason": "version-too-new"}})
	t.check("cache: flush is one write of the whole record", store.cache_writes == 1 and store.cache["docs"]["license"] == lic and PKeyClaims.is_true(store.cache["lastSyncUnauthorized"]) and store.cache["blocked"]["reason"] == "version-too-new")
	cache.flush({"lastSyncUnauthorized": null, "blocked": null})
	t.check("cache: null removes a hint", store.cache_writes == 2 and not store.cache.has("lastSyncUnauthorized") and not store.cache.has("blocked") and cache.blocked == null)


static func _load(c: Dictionary, record: Dictionary, device := "") -> PKeyCache:
	var store := PKeyMemoryStore.new(device if device != "" else c["deviceId"])
	store.cache = record.duplicate(true)
	var cache := PKeyCache.new(store, PKeyTrust.new(c["pinned"]), PKeyClock.new(func(): return c["now"]), c["expectedAud"], store.device_id)
	await cache.load_record()
	return cache


## The same JWS with one payload byte changed (the signature no longer matches).
static func _flip_payload_byte(jws: String) -> String:
	var parts := jws.split(".")
	var p: PackedByteArray = PKeyB64Url.decode_strict(parts[1])
	p[p.size() / 2] = p[p.size() / 2] ^ 0x01
	parts[1] = PKeyB64Url.encode(p)
	return ".".join(parts)
