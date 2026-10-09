extends RefCounted
# The local-trust set: the anti-replay floor is a required option, a hard 401
# or a 403 build block removes the document it answered for in the same write as the hint, the
# licence gate follows the build and discovery can only switch it on, network verification runs
# on the effective clock, a desktop file store's device id is re-derived from the platform anchor
# at every start, and the keyring switch and secret-tool follow the shipped-build rules.

var F: Dictionary
var plan := {}
var server: PKeyFakeServer


func run(t: PKeyTestContext) -> void:
	F = PKeyTestFixtures.sync_docs()
	if not t.check("local trust: fixtures present", not F.is_empty()):
		return
	server = PKeyTestFixtures.new_server(_answer)
	_required_floor(t)
	await _revocation_removes_the_slice(t)
	await _block_removes_the_licence(t)
	_gate_follows_the_build(t)
	await _effective_clock(t)
	server.queue_free()
	await _binding(t)
	_keyring_rules(t)


func _answer(req: Dictionary) -> Dictionary:
	for suffix in plan:
		if String(req["path"]).ends_with(suffix):
			var q: Array = plan[suffix]
			return q[0] if q.size() == 1 else q.pop_front()
	return {"status": 404}


func _ok(jws: String, etag := "") -> Dictionary:
	return {"status": 200, "headers": {"ETag": etag} if etag != "" else {}, "body": jws}


func _sdk(store: PKeyMemoryStore, clock: Array, services := PackedStringArray()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], F["version"])
	opts.expected_services = services
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _synced(clock: Array) -> Array:
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [_ok(F["license"], F["license_etag"])],
		"/config/document": [_ok(F["config"], F["config_etag"])],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var sdk = await _sdk(store, clock)
	await sdk.sync()
	return [sdk, store]


# The anti-replay floor is a required option

func _required_floor(t: PKeyTestContext) -> void:
	var opts := {"trust": F["trust"], "expected_aud": F["product"], "device_id": F["device_id"], "now": F["now"], "check_freshness": false}
	t.check("floor: a verification that omits last_accepted_issued_at is refused", await PKeyVerify.verify_license_doc(F["license"], opts) == null)
	opts["last_accepted_issued_at"] = null
	t.check("floor: an explicit null means no floor", await PKeyVerify.verify_license_doc(F["license"], opts) != null)


# A hard refusal deletes the document it answered for

func _revocation_removes_the_slice(t: PKeyTestContext) -> void:
	var clock := [F["now"]]
	var made := await _synced(clock)
	var sdk = made[0]
	var store: PKeyMemoryStore = made[1]
	t.check("revocation: precondition, both documents and ETags are held", store.cache["docs"].has("license") and store.cache["docs"].has("config") and store.cache["etags"].size() == 2, str(store.cache.keys()))
	var refused := {"status": 401, "body": "{\"error\":\"unauthorized\"}"}
	plan = {"polaris-trust.jws": [_ok(F["trust_jws"])], "/license/document": [refused], "/config/document": [refused]}
	sdk.core.tokens.set_reacquire(func(_c: PKeyCore, _current: String) -> String: return "")
	var writes := store.cache_writes
	await sdk.sync(true)
	t.check("revocation: a hard 401 removes both documents and ETags in the write that sets the hint", store.cache_writes == writes + 1 and PKeyClaims.is_true(store.cache.get("lastSyncUnauthorized")) \
			and not store.cache.has("docs") and not store.cache.has("etags"), str(store.cache))
	t.check("revocation: the token is kept and the gate says revoked", store.token == F["token"] and sdk.status()["status"] == "revoked", str(sdk.status()))
	t.check("revocation: the held documents are gone from memory", sdk.core.cache.license == null and sdk.core.cache.config == null)
	# The hint is display-only: clearing it leaves nothing usable.
	sdk.core.cache.flush({"lastSyncUnauthorized": null})
	t.check("revocation: clearing the hint gives needs-activation, not a usable document", sdk.status()["status"] == "needs-activation", str(sdk.status()))
	sdk.queue_free()


func _block_removes_the_licence(t: PKeyTestContext) -> void:
	var clock := [F["now"]]
	var made := await _synced(clock)
	var sdk = made[0]
	var store: PKeyMemoryStore = made[1]
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [{"status": 403, "body": "{\"error\":{\"code\":\"version_blocked\",\"reason\":\"version-too-old\"},\"allowedRange\":{\"min\":\"2.0.0\"}}"}],
		"/config/document": [{"status": 304}],
	}
	var writes := store.cache_writes
	await sdk.sync()
	t.check("block: a 403 removes the licence document and ETag in the write that sets blocked", store.cache_writes == writes + 1 and store.cache.get("blocked", {}).get("reason") == "version-too-old" \
			and not store.cache["docs"].has("license") and not store.cache["etags"].has("license"), str(store.cache))
	t.check("block: the config document stays", store.cache["docs"].has("config") and sdk.core.cache.config != null)
	t.check("block: the token is kept and the gate reports the block", store.token == F["token"] and sdk.status()["status"] == "version-too-old", str(sdk.status()))
	sdk.core.cache.flush({"blocked": null})
	t.check("block: clearing the hint gives needs-activation", sdk.status()["status"] == "needs-activation", str(sdk.status()))
	sdk.queue_free()


# The licence gate input

func _gate_follows_the_build(t: PKeyTestContext) -> void:
	var opts := PKeyOptions.new()
	opts.product = F["product"]
	opts.build_stamp_path = ""
	var core: PKeyCore = PKeyCore.create(opts, null, "0").detail
	t.check("gate: the default build has the licence gate", core.license_gate_enabled())
	core._discovered_services = PKeyDiscovery.services_from_list(PackedStringArray(["config"]))
	t.check("gate: discovery cannot switch the gate off", core.license_gate_enabled() and not core.enabled("license"))
	opts.expected_services = PackedStringArray(["config"])
	var cfg: PKeyCore = PKeyCore.create(opts, null, "0").detail
	t.check("gate: a build without licence has no gate", not cfg.license_gate_enabled())
	cfg._discovered_services = PKeyDiscovery.services_from_list(PackedStringArray(["license", "config"]))
	t.check("gate: discovery loaded this session can switch it on", cfg.license_gate_enabled())
	var off := PKeyOptions.new()
	off.product = F["product"]
	off.build_stamp_path = ""
	off.expected_services = PackedStringArray(["license", "config"])
	var forged: PKeyCore = PKeyCore.create(off, null, "0").detail
	forged._discovered_services = PKeyDiscovery.services_from_list(PackedStringArray(["config"]))
	var st := forged.license_state()
	t.check("gate: a forged discovery that disables licensing leaves a licensed product gated", st["status"] == "needs-activation", str(st))


# The effective clock

func _effective_clock(t: PKeyTestContext) -> void:
	# The cached trust manifest raises the floor on load; the system clock then reads far behind
	# it. Verification on the network path runs on the effective clock, so the licence (issued
	# at about the manifest's time) is not "from the future".
	var clock := [F["now"]]
	plan = {
		"polaris-trust.jws": [_ok(F["trust_jws"])],
		"/license/document": [_ok(F["license"], F["license_etag"])],
		"/config/document": [_ok(F["config"], F["config_etag"])],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	store.cache = {"v": 3, "trustJws": F["trust_jws"]}
	var sdk = await _sdk(store, clock)
	var floor_at: float = sdk.core.clock.high_water()
	var license_issued: float = float(PKeyJws.verify(F["license"], F["trust"], PKeyClaims.TYP_LICENSE)["payload"]["issuedAt"])
	clock[0] = floor_at - 10 * 86400
	var precondition: bool = license_issued > clock[0] + PKeyClaims.CLOCK_SKEW_SECONDS and license_issued <= floor_at + PKeyClaims.CLOCK_SKEW_SECONDS
	t.check("clock: precondition, the raw clock would refuse the licence and the floor would not", precondition, "floor %d issued %d" % [floor_at, license_issued])
	var r: PKeySyncResult = await sdk.sync()
	t.check("clock: a document is verified on the effective clock", r.documents.get("license") == "applied", str(r.documents))
	sdk.queue_free()


# Device binding to the hardware anchor

func _binding(t: PKeyTestContext) -> void:
	var product := "diceroll"
	var root := PKeyTestFixtures.scratch_dir("binding")
	var anchor_id := PKeyDeviceId.from_raw(product, "anchor-A")
	var feeds := {"stable": "jws.feed"}
	var records := {"abc": "jws.record"}
	var seed_store := func(id: String) -> PKeyFileStore:
		var s := PKeyFileStore.new(product, root)
		s.set_device_id(id)
		s.set_token("pkeyt_stored")
		s.write_cache({"v": 3, "trustJws": "t", "docs": {"license": "l"}, "etags": {"license": "\"e\""}, "bundle": "b.jws", "pinRevocations": {"k": "r.jws"},
				"lastSyncUnauthorized": true, "blocked": {"reason": "version-too-old"}, "feeds": feeds, "releaseRecords": records})
		return s

	# No anchor: the stored id stands, nothing is cleared.
	PKeyDeviceId.set_anchor_source(func() -> String: return "")
	var other_id := PKeyDeviceId.from_raw(product, "other-machine")
	var s: PKeyFileStore = seed_store.call(other_id)
	t.check("binding: no anchor keeps the stored id and the token", await PKeyDeviceBinding.bind(s, product, other_id) == other_id and s.get_token() == "pkeyt_stored" and s.read_cache().has("docs"))
	# Agreement: nothing changes.
	PKeyDeviceId.set_anchor_source(func() -> String: return "anchor-A")
	s = seed_store.call(anchor_id)
	t.check("binding: an id that agrees with the anchor changes nothing", await PKeyDeviceBinding.bind(s, product, anchor_id) == anchor_id and s.get_token() == "pkeyt_stored" and s.read_cache().has("docs"))
	# Disagreement: the copied state is discarded except the update slices.
	s = seed_store.call(other_id)
	var bound := await PKeyDeviceBinding.bind(s, product, other_id)
	var rec = s.read_cache()
	t.check("binding: a stored id that disagrees is replaced by the derived one", bound == anchor_id and PKeyFileStore.new(product, root).get_device_id() == anchor_id)
	t.check("binding: the token is discarded", s.get_token() == "")
	t.check("binding: only the update slices and the pin evidence survive", rec is Dictionary and rec.keys().size() == 4 and rec.get("feeds") == feeds and rec.get("releaseRecords") == records and rec.get("pinRevocations") == {"k": "r.jws"} and not rec.has("docs") and not rec.has("trustJws") \
			and not rec.has("lastSyncUnauthorized") and not rec.has("blocked") and not rec.has("bundle") and not rec.has("etags"), str(rec))
	# Nothing to keep: the cache is cleared.
	s = PKeyFileStore.new(product, root)
	s.set_device_id(other_id)
	s.write_cache({"v": 3, "docs": {"license": "l"}})
	await PKeyDeviceBinding.bind(s, product, other_id)
	t.check("binding: with no update slices the cache is cleared", s.read_cache() == null)
	# A store that is not a copyable desktop file keeps its id.
	var mem := PKeyMemoryStore.new(other_id, "pkeyt_mem")
	t.check("binding: the in-memory store keeps its stored id", await PKeyDeviceBinding.bind(mem, product, other_id) == other_id and mem.token == "pkeyt_mem")
	# The keyring store binds through its files and clears its keyring token.
	var kr := PKeyFakeKeyring.new()
	var ks := PKeyKeyringStore.new(product, kr, PKeyTestFixtures.scratch_dir("binding-kr"))
	ks.set_device_id(other_id)
	ks.set_token("pkeyt_kr")
	t.check("binding: the keyring store is bindable", ks.bindable())
	t.check("binding: the keyring store's id is replaced and its keyring token cleared", await PKeyDeviceBinding.bind(ks, product, other_id) == anchor_id and ks.get_token() == "" and kr.entries.is_empty())
	PKeyDeviceId.set_anchor_source(Callable())
	PKeyTestFixtures.remove_tree(root)

	# The anchor probes are absolute: no Windows without a SystemRoot falls back to PATH.
	t.check("binding: the anchor is empty where no desktop anchor is readable", PKeyFingerprint.device_anchor(_NoHost.new()) == "")


class _NoHost:
	extends PKeyHostIo

	func platform() -> String:
		return "windows"

	func env(_name: String) -> String:
		return ""

	func run(program: String, _args: PackedStringArray) -> Variant:
		assert(false, "a probe ran: %s" % program)
		return null


# The keyring switch and secret-tool follow the shipped-build rules

func _keyring_rules(t: PKeyTestContext) -> void:
	var p := PKeyHeaders.platform()
	var desktop: bool = p in ["macos", "windows", "linux"]
	if desktop:
		var saved := OS.get_environment(PKeyKeyringStore.ENV_SWITCH)
		OS.set_environment(PKeyKeyringStore.ENV_SWITCH, "0")
		PKeyKeyringStore.debug_build_source = func() -> bool: return false
		var release := PKeyKeychainStore.preferred("diceroll", PKeyTestFixtures.scratch_dir("kr-release")) as PKeyKeyringStore
		t.check("keyring: a release build ignores PKEY_DESKTOP_KEYRING=0", release != null and release.disabled == "")
		PKeyKeyringStore.debug_build_source = func() -> bool: return true
		var debug := PKeyKeychainStore.preferred("diceroll", PKeyTestFixtures.scratch_dir("kr-debug")) as PKeyKeyringStore
		t.check("keyring: a debug build honours PKEY_DESKTOP_KEYRING=0", debug != null and debug.disabled.contains("PKEY_DESKTOP_KEYRING=0"))
		PKeyKeyringStore.debug_build_source = Callable()
		OS.set_environment(PKeyKeyringStore.ENV_SWITCH, saved)
	# secret-tool is /usr/bin/secret-tool, never a PATH lookup.
	var planted := PKeyTestFixtures.scratch_dir("planted")
	var f := FileAccess.open(planted.path_join("secret-tool"), FileAccess.WRITE)
	f.store_string("#!/bin/sh\n")
	f.close()
	var saved_path := OS.get_environment("PATH")
	OS.set_environment("PATH", ProjectSettings.globalize_path(planted))
	var program := PKeySecretServiceBackend.new()._program()
	OS.set_environment("PATH", saved_path)
	t.check("keyring: secret-tool is /usr/bin/secret-tool, not found through PATH", PKeySecretServiceBackend.DEFAULT_TOOL == "/usr/bin/secret-tool" and (program == "" or program == "/usr/bin/secret-tool"), program)
	PKeyTestFixtures.remove_tree(planted)
