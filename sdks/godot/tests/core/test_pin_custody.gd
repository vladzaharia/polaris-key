extends RefCounted
# Key custody (WIRE-CONTRACT-V4 §1, §2.3, §4.1, §7): a tombstoned pin and its evidence ride the
# same write as the manifest and survive a restart, a deactivation and a bundle import; the signer
# retry asks each usable pin once; an imported bundle is stored verbatim as `bundle`, activates
# only through the cached licence, is a no-op when imported again and may not roll a document
# back. The old `importedBundle` marker is neither read nor written.

var server: PKeyFakeServer
var manifest := ""
var paths: Array = []


func run(t: PKeyTestContext) -> void:
	server = PKeyTestFixtures.new_server(_answer)
	await _evidence_rides_the_manifest_write(t)
	await _signer_retry(t)
	await _bundle_import(t)
	await _bundle_activation(t)
	await _tombstoned_signer_bundle(t)
	server.queue_free()


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	if path.contains("polaris-trust.jws"):
		paths.append(path)
		return {"status": 200, "body": manifest}
	return {"status": 404}


func _sdk(store: PKeyMemoryStore, clock: Array, c: Dictionary, local_only := false) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, "djdl", c["pinned"])
	opts.local_only = local_only
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _evidence_rides_the_manifest_write(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.trust_case("pin-revoked-by-other-pin")
	var pin: String = "pkey-test-prod-2026"
	manifest = c["manifestJws"]
	var clock := [c["now"]]
	var store := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_held")
	var sdk = await _sdk(store, clock, c)
	var writes := store.cache_writes
	await sdk.sync()
	t.check("custody: the manifest and its evidence are one write", store.cache_writes == writes + 1 and store.cache["trustJws"] == manifest and store.cache["pinRevocations"] == {pin: manifest}, str(store.cache.keys()))
	t.check("custody: the revoked pin is out of the effective set", sdk.core.trust.revoked_pins() == [pin] and not sdk.core.trust.effective().has(pin) and sdk.core.trust.effective().has("djdl-test-2026"))
	sdk.queue_free()

	# A restart re-derives the tombstone from the evidence, and a deactivation keeps it.
	var again = await _sdk(store, clock, c)
	t.check("custody: a restart re-derives the tombstone", again.core.trust.revoked_pins() == [pin] and not again.core.trust.effective().has(pin))
	again.core.cache.clear()
	t.check("custody: clear() keeps the evidence and nothing else", store.cache == {"v": 3, "pinRevocations": {pin: manifest}}, str(store.cache.keys()))
	again.queue_free()

	# Evidence that does not verify, or that revokes another kid, is no tombstone and is dropped.
	for forged in [{pin: "a.b.c"}, {"djdl-test-2026": manifest}, {pin: 7}]:
		var s2 := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_held")
		s2.cache = {"v": 3, "pinRevocations": forged}
		var sdk2 = await _sdk(s2, clock, c)
		t.check("custody: forged evidence %s tombstones nothing" % JSON.stringify(forged).left(40), sdk2.core.trust.revoked_pins() == [] and sdk2.core.trust.pin_revocations() == {})
		sdk2.queue_free()


func _signer_retry(t: PKeyTestContext) -> void:
	# Signed by a usable pin and refused (it revokes its own signer): never retried.
	var c = PKeyTestFixtures.trust_case("pin-self-revocation-refused")
	manifest = c["manifestJws"]
	paths.clear()
	var store := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_held")
	var sdk = await _sdk(store, [c["now"]], c)
	await sdk.sync()
	t.check("retry: a refused manifest signed by a usable pin is asked for once", paths.size() == 1, str(paths))
	sdk.queue_free()

	# Signed by a tombstoned pin: not usable, so each usable pin is asked for, in order.
	c = PKeyTestFixtures.trust_case("manifest-signed-by-tombstoned-pin-refused")
	manifest = c["manifestJws"]
	paths.clear()
	store = PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", "pkeyt_held")
	store.cache = {"v": 3, "pinRevocations": c["pinRevocations"]}
	sdk = await _sdk(store, [c["now"]], c)
	await sdk.sync()
	t.check("retry: the usable pins are asked for with ?signer=, then it stops", paths.size() == 2 and String(paths[1]).ends_with("polaris-trust.jws?signer=djdl-test-2026"), str(paths))
	t.check("retry: nothing was accepted, so nothing was written", not store.cache.has("trustJws"))
	sdk.queue_free()

	t.check("retry: the order is ascending UTF-8 bytes and capped", PKeyTrust.signer_order({"b": "x", "a": "x", "é": "x", "Z": "x", "c": "x"}, "other") == ["Z", "a", "b", "c"] \
			and PKeyTrust.signer_order({"a": "x"}, "a") == [] and PKeyTrust.compare_kid_bytes("é", "z") > 0)


func _bundle_import(t: PKeyTestContext) -> void:
	var full = PKeyTestFixtures.bundle_case("bundle-valid-full")
	var only = PKeyTestFixtures.bundle_case("bundle-valid-license-only")
	var store := PKeyMemoryStore.new(full["deviceId"], "")
	var clock := [full["now"]]
	var sdk = await _sdk(store, clock, full, true)
	var imported: PKeyResult = await sdk.import_bundle(full["bundleJws"])
	t.check("bundle: imports", imported.ok and imported.detail["imported"] == ["license", "config"], str(imported))
	t.check("bundle: the JWS is stored verbatim and no marker is written", store.cache["bundle"] == full["bundleJws"] and not store.cache.has("importedBundle") and not store.cache.has("etags"), str(store.cache.keys()))
	t.check("bundle: the cache holds the re-verified bundle", sdk.core.cache.bundle != null and sdk.core.cache.bundle["activates"] and sdk.core.activation() == "bundle")
	var writes := store.cache_writes
	var again: PKeyResult = await sdk.import_bundle(full["bundleJws"])
	t.check("bundle: a byte-identical re-import is a success with no write", again.ok and again.detail["imported"] == ["license", "config"] and store.cache_writes == writes, str(again))
	var older: PKeyResult = await sdk.import_bundle(only["bundleJws"])
	t.check("bundle: a document that is not newer than the cached one refuses the import", not older.ok and older.code == &"inner-doc-rejected" and store.cache_writes == writes, str(older))
	sdk.queue_free()


func _bundle_activation(t: PKeyTestContext) -> void:
	var full = PKeyTestFixtures.bundle_case("bundle-valid-full")
	# The old marker alone grants nothing and is dropped.
	var store := PKeyMemoryStore.new(full["deviceId"], "")
	store.cache = {"v": 3, "importedBundle": {"bundleId": "b", "importedAt": 1}}
	var sdk = await _sdk(store, [full["now"]], full, true)
	t.check("activation: the old marker is not read", sdk.core.cache.bundle == null and sdk.core.activation() == "" and not sdk.core.cache.record().has("importedBundle"))
	sdk.queue_free()
	# A re-verified bundle whose licence is not the cached one does not activate.
	store = PKeyMemoryStore.new(full["deviceId"], "")
	var seed := PKeyMemoryStore.new(full["deviceId"], "")
	var s1 = await _sdk(seed, [full["now"]], full, true)
	await s1.import_bundle(full["bundleJws"])
	var rec: Dictionary = seed.cache.duplicate(true)
	s1.queue_free()
	rec["docs"].erase("license")
	store.cache = rec
	var s2 = await _sdk(store, [full["now"]], full, true)
	t.check("activation: a bundle whose licence is not cached does not activate", s2.core.cache.bundle != null and not s2.core.cache.bundle["activates"] and s2.core.activation() == "")
	s2.queue_free()


func _tombstoned_signer_bundle(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.bundle_case("bundle-signed-by-tombstoned-pin-refused")
	var store := PKeyMemoryStore.new(c["deviceId"], "")
	store.cache = {"v": 3, "pinRevocations": c["pinRevocations"]}
	var sdk = await _sdk(store, [c["now"]], c, true)
	var r: PKeyResult = await sdk.import_bundle(c["bundleJws"])
	t.check("bundle: one signed by a tombstoned pin is refused at step 1", not r.ok and r.code == &"bundle-jws-rejected", str(r))
	sdk.queue_free()
