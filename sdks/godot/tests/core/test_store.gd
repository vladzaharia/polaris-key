extends RefCounted
# PKeyFileStore: the three files, atomic owner-only writes, the write-once device id, and
# failures that are surfaced (`failed`, then `store_error` / `last_store_error` on the root)
# rather than swallowed.

const RAW := "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6"


func run(t: PKeyTestContext) -> void:
	PKeyDeviceId.set_raw_source(func(): return RAW)
	await _files(t)
	await _device_write_failure(t)
	_namespace(t)
	_caller_overrides_survive_reattach(t)
	_status(t)
	PKeyDeviceId.set_raw_source(Callable())

func _files(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store")
	var s := PKeyFileStore.new("djdl", root)
	var errors: Array = []
	s.failed.connect(func(e): errors.append(e))
	var id := s.get_device_id()
	t.check("store: the device id is derived from the raw source", id == PKeyDeviceId.from_raw("djdl", RAW), id)
	t.check("store: the device id is written", FileAccess.get_file_as_string(s.path_of("device")) == id)
	PKeyDeviceId.set_raw_source(func(): return "another-machine")
	var again := PKeyFileStore.new("djdl", root)
	t.check("store: the device id is write-once (a new raw source does not replace it)", again.get_device_id() == id)
	PKeyDeviceId.set_raw_source(func(): return RAW)

	t.check("store: no token at first", s.get_token() == "")
	t.check("store: set_token", s.set_token("pkeyt_abc"))
	t.check("store: get_token", PKeyFileStore.new("djdl", root).get_token() == "pkeyt_abc")
	t.check("store: write_cache", s.write_cache({"v": 3, "docs": {"license": "a.b.c"}}))
	var rec = PKeyFileStore.new("djdl", root).read_cache()
	t.check("store: read_cache round-trips", rec is Dictionary and rec.get("v") == 3.0 and rec["docs"]["license"] == "a.b.c", str(rec))
	t.check("store: the cache file is managed.json", FileAccess.file_exists(s.path_of("managed.json")))
	var leftovers := Array(DirAccess.get_files_at(s.dir)).filter(func(f): return String(f).contains(".tmp-"))
	t.check("store: no temporary file is left behind", leftovers.is_empty(), str(leftovers))
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		var rw := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER
		for f in ["device", "token", "managed.json"]:
			var mode := FileAccess.get_unix_permissions(s.path_of(f))
			t.check("store: %s is 0600" % f, (mode & 511) == rw, "mode %o" % mode)
	var garbage := FileAccess.open(s.path_of("managed.json"), FileAccess.WRITE)
	garbage.store_string("{\"v\":3,\"v\":3}")
	garbage.close()
	t.check("store: a duplicate-key record reads as absent", s.read_cache() == null)
	t.check("store: clear_token", s.clear_token() and s.get_token() == "")
	t.check("store: clear_cache", s.clear_cache() and s.read_cache() == null)
	t.check("store: no failure was reported on the happy path", errors.is_empty(), str(errors))
	PKeyTestFixtures.remove_tree(root)


## The device id cannot be written: the failure reaches `store_error` and `last_store_error`,
## the session keeps a derived id, and the next start derives the SAME id (never a new random
## one).
func _device_write_failure(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("devfail")
	var dir := root.path_join("djdl")
	DirAccess.make_dir_recursive_absolute(dir.path_join("device"))  # a directory where the file goes
	var ids: Array = []
	for start in 2:
		var sdk := PKeyTestFixtures.new_sdk()
		var seen: Array = []
		sdk.store_error.connect(func(e): seen.append(e))
		var opts := PKeyOptions.new()
		opts.product = "djdl"
		opts.version = "1.0.0"
		opts.store_root = root
		var cr: PKeyResult = sdk.configure(opts)
		var sr: PKeyResult = await sdk.start()
		ids.append(sdk.core.device_id if sdk.core != null else "")
		t.check("store: start %d with an unwritable device id still starts" % start, cr.ok and sr.ok, "%s %s" % [cr, sr])
		t.check("store: start %d surfaces the failed write on store_error" % start, seen.size() >= 1 and seen[0].get("path", "").ends_with("device"), str(seen))
		t.check("store: start %d sets last_store_error" % start, sdk.last_store_error.get("op", "") in ["write", "rename"], str(sdk.last_store_error))
		sdk.queue_free()
	t.check("store: no new id is minted on the next start", ids.size() == 2 and ids[0] == ids[1] and ids[0] == PKeyDeviceId.from_raw("djdl", RAW), str(ids))
	PKeyTestFixtures.remove_tree(root)


func _namespace(t: PKeyTestContext) -> void:
	var production := PKeyCore.store_namespace_for("djdl", "https://KEY.PLRS.IM:443/")
	var development := PKeyCore.store_namespace_for("djdl", "http://localhost:8787")
	t.check("store namespace: production keeps its historical product name", production == "djdl", production)
	t.check("store namespace: local host and port are deterministic", development == "djdl@localhost_8787", development)
	var root := PKeyTestFixtures.scratch_dir("store-namespace")
	var prod := PKeyFileStore.new(production, root)
	var dev := PKeyFileStore.new(development, root)
	prod.set_token("pkeyt_production")
	dev.set_token("pkeyt_development")
	prod.write_cache({"v": 3, "docs": {"license": "production"}})
	dev.write_cache({"v": 3, "docs": {"license": "development"}})
	var prod_device := prod.get_device_id()
	var dev_device := dev.get_device_id()
	t.check("store namespace: credentials, cache and device identities do not share files", \
		prod.get_token() == "pkeyt_production" and dev.get_token() == "pkeyt_development" \
		and prod.read_cache()["docs"]["license"] == "production" and dev.read_cache()["docs"]["license"] == "development" \
		and prod_device != dev_device and prod.dir != dev.dir, "%s %s" % [prod.dir, dev.dir])
	PKeyTestFixtures.remove_tree(root)

func _caller_overrides_survive_reattach(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store-namespace-overrides")
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyOptions.new()
	opts.product = "djdl"
	opts.version = "1.0.0"
	opts.base_url = "http://localhost:8787"
	opts.store_root = root
	opts.persist_settings = false
	var first: PKeyResult = sdk.configure(opts)
	var custom_root := root.path_join("custom-packs")
	var custom_cache := root.path_join("custom-presentation")
	sdk.update.packs.root = custom_root
	sdk.presentation_source.cache_dir = custom_cache
	var second: PKeyResult = sdk.configure(opts)
	t.check(
		"store namespace: caller pack and presentation roots survive reconfigure",
		first.ok and second.ok and sdk.update.packs.root == custom_root and sdk.presentation_source.cache_dir == custom_cache,
		"%s %s" % [sdk.update.packs.root, sdk.presentation_source.cache_dir],
	)
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(root)


func _status(t: PKeyTestContext) -> void:
	var s := PKeyFileStore.new("djdl", "user://pkey-test/status")
	var st := s.status()
	t.check("store: status names the backend", st.get("backend") == ("indexeddb" if OS.has_feature("web") else "file"), str(st))
	t.check("store: status is degraded exactly when user:// is not persistent", st.has("degraded") == (not OS.is_userfs_persistent()), str(st))
	t.check("store: the memory store reports memory", PKeyMemoryStore.new().status() == {"backend": "memory"})
