extends RefCounted
# @pkey-feature connect.protocol
# `PKeyTrust.accept_peer` (CC-14.5; WIRE-CONTRACT-V5 section 15.8): a trust manifest a peer pushed is
# verified against the usable pins and tombstones only, must be newer than the held one, raises the
# clock floor and answers the refusal reason. Mirrors Node's `acceptPeer` (core/trust.ts) and the
# Python and Kotlin tests. Manifests are the corpus's `trustCases` where one fits, and are minted
# with the corpus's TEST keys where the rows need an `issuedAt` the corpus does not hold.

const CASES := "res://tests/corpus/v2/cases.json"
const PRODUCT := "djdl"
const PROD_KID := "pkey-test-prod-2026"
const EXTRA_KID := "extra-test-2026"
const EXTRA_KEY := "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"
const NOW := 1700000100.0

var _cases := {}
var _keys := {}
var _minted := {}


func run(t: PKeyTestContext) -> void:
	var corpus: Variant = PKeyTestFixtures.read_json(CASES)
	if not t.check("cases.json parses", corpus is Dictionary):
		return
	for c in corpus["trustCases"]:
		_cases[c["id"]] = c
	for k in corpus["keys"]:
		_keys[k["kid"]] = k
	await _newer_is_applied(t)
	await _invalid_changes_nothing(t)
	await _revoked_pin(t)
	await _concurrent(t)
	_redaction(t)


func _clock(at := NOW) -> PKeyClock:
	return PKeyClock.new(func(): return at)


## A `pkey-trust+jws` for the product signed by `signer`, issued at `issued`, listing `keys`
## ([{kid, publicKey, status}]). Signatures are cached; they are slow (the reference Ed25519).
func _mint(signer: String, issued: int, keys: Array, aud := PRODUCT) -> String:
	var rows := PackedStringArray()
	for k in keys:
		var row := "{\"kid\":\"%s\",\"alg\":\"EdDSA\",\"kty\":\"OKP\",\"crv\":\"Ed25519\"," % k["kid"]
		rows.append(row + "\"publicKey\":\"%s\",\"status\":\"%s\"}" % [k["publicKey"], k["status"]])
	var text := "{\"schemaVersion\":1,\"aud\":\"%s\",\"iss\":\"key.plrs.im\",\"issuedAt\":%d,\"expiresAt\":%d,\"keys\":[%s]}" % [aud, issued, issued + 300, ",".join(rows)]
	var id := signer + " " + text
	if not _minted.has(id):
		_minted[id] = PKeyTestSigner.sign_jws(text, PKeyTestSigner.seed_from_pem(_keys[signer]["privateKeyPkcs8Pem"]), signer, "pkey-trust+jws")
	return _minted[id]


func _prod_row() -> Dictionary:
	return {"kid": PROD_KID, "publicKey": _keys[PROD_KID]["publicKeyRaw"], "status": "active"}


func _extra_row() -> Dictionary:
	return {"kid": EXTRA_KID, "publicKey": EXTRA_KEY, "status": "staged"}


func _trust() -> PKeyTrust:
	return PKeyTrust.new({PROD_KID: _keys[PROD_KID]["publicKeyRaw"]})


func _newer_is_applied(t: PKeyTestContext) -> void:
	var trust := _trust()
	var clock := _clock()
	var first: String = _cases["trust-learn-rotated-key"]["manifestJws"]
	var r := await trust.accept_peer(first, PRODUCT, clock)
	t.check("accept: a manifest signed by a usable pin is applied", r == {"applied": true})
	t.check("accept: it is held, and its keys are learned", trust.manifest()["issuedAt"] == 1700000000 and trust.effective().has("djdl-test-2026"))
	t.check("accept: it raised the clock floor", clock.high_water() == 1700000000.0)

	# It must be newer than the held one.
	r = await trust.accept_peer(first, PRODUCT, clock)
	t.check("newer: the same manifest again is not_newer", r == {"applied": false, "reason": "not_newer"})
	var m10 := _mint(PROD_KID, 1700000010, [_prod_row(), _extra_row()])
	r = await trust.accept_peer(m10, PRODUCT, clock)
	t.check("newer: a later issuedAt is applied", r == {"applied": true} and trust.manifest()["issuedAt"] == 1700000010)
	t.check("newer: the floor follows it", clock.high_water() == 1700000010.0)
	t.check("newer: the learned tier is replaced, not merged", trust.effective().has(EXTRA_KID) and not trust.effective().has("djdl-test-2026"))
	var before := trust.effective()
	for old in [first, m10]:
		r = await trust.accept_peer(old, PRODUCT, clock)
		var held_at: Variant = trust.manifest()["issuedAt"]
		t.check("newer: an equal or older manifest is refused and changes nothing",
				r == {"applied": false, "reason": "not_newer"} and trust.effective() == before and held_at == 1700000010)
	var m11 := _mint(PROD_KID, 1700000011, [_prod_row()])
	r = await trust.accept_peer(m11, PRODUCT, clock)
	t.check("newer: absence is revocation, so the next one drops the learned key", r == {"applied": true} and not trust.effective().has(EXTRA_KID) and trust.effective().has(PROD_KID))
	t.check("newer: nothing was revoked", trust.revoked_pins().is_empty() and trust.pin_revocations().is_empty())


func _invalid_changes_nothing(t: PKeyTestContext) -> void:
	var trust := _trust()
	var clock := _clock()
	await trust.accept_peer(_cases["trust-learn-rotated-key"]["manifestJws"], PRODUCT, clock)
	var effective := trust.effective()
	var held: Dictionary = trust.manifest()
	var floor_at := clock.high_water()
	var bad := {
		"not a jws": "not.a.jws",
		"empty": "",
		"a signer that is not pinned": _cases["trust-signed-by-non-pinned-key"]["manifestJws"],
		"another product": _cases["trust-aud-mismatch"]["manifestJws"],
		"a pinned kid with other bytes": _cases["trust-pinned-substitution"]["manifestJws"],
		"a self revocation": _cases["pin-self-revocation-refused"]["manifestJws"],
	}
	for what in bad:
		var r := await trust.accept_peer(bad[what], PRODUCT, clock)
		t.check("invalid: %s" % what, r == {"applied": false, "reason": "invalid"} and trust.effective() == effective and trust.manifest() == held and clock.high_water() == floor_at)
	# Not fresh: a manifest past its expiry on the effective clock.
	var late := await _trust().accept_peer(_cases["trust-expired-manifest"]["manifestJws"], PRODUCT, _clock(1700000601.0))
	t.check("invalid: an expired manifest", late == {"applied": false, "reason": "invalid"})
	# A manifest for this product is refused under another product name (the audience).
	var other := await _trust().accept_peer(_cases["trust-learn-rotated-key"]["manifestJws"], "other-product", _clock())
	t.check("invalid: the audience is the product that asked", other == {"applied": false, "reason": "invalid"})
	# A newer manifest signed by an unpinned key is invalid, not merely not_newer.
	var stranger := _mint("djdl-test-2026", 1700000050, [_prod_row()])
	var s := await trust.accept_peer(stranger, PRODUCT, clock)
	t.check("invalid: a newer manifest from an unpinned signer", s == {"applied": false, "reason": "invalid"} and trust.manifest() == held)


func _revoked_pin(t: PKeyTestContext) -> void:
	var c: Dictionary = _cases["pin-revoked-by-other-pin"]
	var trust := PKeyTrust.new(c["pinned"])
	var clock := _clock()
	var revoke: String = c["manifestJws"]
	var r := await trust.accept_peer(revoke, PRODUCT, clock)
	t.check("revoked: a pushed manifest that revokes another pin is applied", r == {"applied": true})
	t.check("revoked: the pin is tombstoned, with the manifest as evidence", trust.revoked_pins() == [PROD_KID] and trust.pin_revocations() == {PROD_KID: revoke})
	t.check("revoked: the pin is out of the effective set", not trust.effective().has(PROD_KID) and trust.effective().has("djdl-test-2026"))
	# The tombstoned pin's signature is no longer enough, even on a manifest the corpus calls valid.
	var again := await trust.accept_peer(_cases["manifest-signed-by-tombstoned-pin-refused"]["manifestJws"], PRODUCT, clock)
	t.check("revoked: the tombstoned pin no longer signs a pushed manifest", again == {"applied": false, "reason": "invalid"})
	var newer := _mint(PROD_KID, 1700000060, [_prod_row()])
	again = await trust.accept_peer(newer, PRODUCT, clock)
	t.check("revoked: nor does a newer one", again == {"applied": false, "reason": "invalid"} and trust.revoked_pins() == [PROD_KID])

	# Tombstones re-derived from evidence bind a pushed manifest the same way (a restart).
	var held_case: Dictionary = _cases["pin-revocation-sticky"]
	var restarted := PKeyTrust.new(held_case["pinned"])
	await restarted.load_evidence(held_case["pinRevocations"], PRODUCT)
	var sticky := await restarted.accept_peer(_cases["manifest-signed-by-tombstoned-pin-refused"]["manifestJws"], PRODUCT, clock)
	t.check("revoked: a tombstone loaded from evidence refuses its signer", sticky == {"applied": false, "reason": "invalid"})


func _concurrent(t: PKeyTestContext) -> void:
	var m10 := _mint(PROD_KID, 1700000010, [_prod_row(), _extra_row()])
	var trust := _trust()
	var clock := _clock()
	var results: Array = []
	# Six pushes and two network refreshes of one manifest at once, each verified off the main
	# thread: the lock lets exactly one install it.
	for i in 6:
		_push(trust, m10, clock, results)
	for i in 2:
		_network(trust, m10, clock, results)
	var tree := Engine.get_main_loop() as SceneTree
	var frames := 0
	while results.size() < 8 and frames < 6000:
		await tree.process_frame
		frames += 1
	var applied := 0
	var refused := 0
	for r in results:
		applied += int(r == "applied")
		refused += int(r == "not_newer" or r == "refused")
	t.check("concurrent: all eight finished", results.size() == 8, "%d in %d frames" % [results.size(), frames])
	t.check("concurrent: exactly one applied, the rest were refused", applied == 1 and refused == 7, str(results))
	t.check("concurrent: the floor is the one manifest's issuedAt", clock.high_water() == 1700000010.0)


func _push(trust: PKeyTrust, jws: String, clock: PKeyClock, results: Array) -> void:
	var r := await trust.accept_peer(jws, PRODUCT, clock, true)
	results.append("applied" if r["applied"] else String(r["reason"]))


func _network(trust: PKeyTrust, jws: String, clock: PKeyClock, results: Array) -> void:
	var issued := await trust.accept_network(jws, PRODUCT, clock.now(), true)
	results.append("applied" if issued >= 0.0 else "refused")


func _redaction(t: PKeyTestContext) -> void:
	var r := await _trust().accept_peer(_cases["trust-learn-rotated-key"]["manifestJws"], PRODUCT, _clock())
	var text := JSON.stringify(r)
	t.check("the answer names no key, product or document", not text.contains(PRODUCT) and not text.contains("pkey") and not text.contains(PROD_KID) and text.length() < 40, text)
