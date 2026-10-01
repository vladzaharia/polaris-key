extends RefCounted
# The local-only profile (core.local, sdk-node `local/`): nothing dials, everything offline still
# works. A bundle import provisions the install all-or-nothing, and a restart over the written
# record reaches the same state through the normal load path.


func run(t: PKeyTestContext) -> void:
	var c = PKeyTestFixtures.bundle_case("bundle-valid-full")
	if not t.check("local: fixture bundle-valid-full present", c is Dictionary):
		return
	var server := PKeyTestFixtures.new_server(func(_r): return {"status": 200, "body": "{}"})
	var root := PKeyTestFixtures.scratch_dir("local")
	var device_dir := root.path_join("djdl")
	DirAccess.make_dir_recursive_absolute(device_dir)
	var f := FileAccess.open(device_dir.path_join("device"), FileAccess.WRITE)
	f.store_string(c["deviceId"].rpad(32, "0"))
	f.close()

	# The bundle is bound to `dev_7c1e2d`, which is not a 32-character stored id, so the device id
	# comes from a memory store here and the file store is exercised in the restart below.
	var store := PKeyMemoryStore.new(c["deviceId"], "pkeyt_held")
	var clock := [c["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, c["expectedAud"], c["pinned"])
	opts.local_only = true
	opts.refresh_interval_seconds = 30.0
	var sdk := PKeyTestFixtures.new_sdk()
	t.check("local: configure", sdk.configure(opts).ok)
	var started: PKeyResult = await sdk.start()
	t.check("local: start works offline", started.ok)
	t.check("local: no refresh timer is started", sdk._timer == null)

	var r: PKeySyncResult = await sdk.sync()
	t.check("local: sync is refused with local-only", not r.ok and r.code == PKeyErrors.LOCAL_ONLY, str(r))
	var d: PKeyResult = await sdk.discover()
	t.check("local: discover is refused with local-only", not d.ok and d.code == PKeyErrors.LOCAL_ONLY, str(d))
	var q: PKeyResult = await sdk.core.request("GET", "license/document", null, true)
	t.check("local: a service request is refused with local-only", not q.ok and q.code == PKeyErrors.LOCAL_ONLY, str(q))
	t.check("local: nothing reached the network", server.requests.is_empty())

	# A refused bundle writes nothing.
	var wrong = PKeyTestFixtures.bundle_case("bundle-deviceId-mismatches-local")
	var refused: PKeyResult = await sdk.import_bundle(wrong["bundleJws"])
	t.check("local: a refused bundle names its step", not refused.ok and refused.code == &"bundle-claims-rejected", str(refused))
	t.check("local: a refused bundle writes nothing", store.cache_writes == 0 and store.cache == null)

	store.token = ""
	sdk.core.tokens.load_token()
	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s["status"]))
	var imported: PKeyResult = await sdk.import_bundle(c["bundleJws"] + "\n")
	t.check("local: a bundle imports offline", imported.ok and imported.detail["imported"] == ["license", "config"], str(imported))
	t.check("local: the import is one whole-record write", store.cache_writes == 1 and store.cache["importedBundle"]["bundleId"] == imported.detail["bundle_id"] \
			and store.cache.has("trustJws") and store.cache["docs"].size() == 2 and not store.cache.has("etags"), str(store.cache.keys()))
	t.check("local: the import activates by bundle", sdk.core.activation() == "bundle" and sdk.status()["status"] == "ok", str(sdk.status()))
	t.check("local: state_changed reports the activation", states == ["ok"], str(states))
	t.check("local: no token is created", store.token == "")
	t.check("local: the rotated-key config document came in through the bundle's manifest", sdk.core.cache.config != null)
	sdk.queue_free()

	# Restart over the same record: the normal load path reaches the same state.
	var again := PKeyTestFixtures.new_sdk()
	var opts2 := PKeyTestFixtures.options(server.base_url(), store, clock, c["expectedAud"], c["pinned"])
	opts2.local_only = true
	again.configure(opts2)
	await again.start()
	t.check("local: a restart reloads the imported install", again.core.activation() == "bundle" and again.status()["status"] == "ok" and again.core.cache.config != null, str(again.status()))
	clock[0] = 1702592000 + 1
	t.check("local: past graceUntil the imported licence is expired", again.status()["status"] == "expired", str(again.status()))
	again.queue_free()

	# The file store path: a restart from disk, local-only.
	var fs := PKeyFileStore.new("djdl", root)
	fs.write_cache(store.cache)
	var disk := PKeyTestFixtures.new_sdk()
	var opts3 := PKeyTestFixtures.options(server.base_url(), null, [c["now"]], c["expectedAud"], c["pinned"])
	opts3.store = null
	opts3.store_root = root
	opts3.local_only = true
	disk.configure(opts3)
	await disk.start()
	t.check("local: a file-store restart re-verifies against its own device id (documents for another device load as absent)", disk.core.cache.license == null and disk.status()["status"] == "needs-activation", str(disk.status()))
	disk.queue_free()
	server.queue_free()
	PKeyTestFixtures.remove_tree(root)
