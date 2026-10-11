extends RefCounted
# PKeyFileStore: the three files, atomic owner-only writes, the write-once device id, and
# failures that are surfaced (`failed`, then `store_error` / `last_store_error` on the root)
# rather than swallowed; and the state namespace (`djdl` on the production origin, `djdl@<host>`
# on any other) that every SDK-owned location a configure() derives is named after.

const RAW := "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6"
const LOCAL_URL := "http://localhost:8787"
## Well-formed device ids (32 base64url characters) that say which origin wrote them.
const LOCAL_DEVICE := "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"
const PRODUCTION_DEVICE := "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP"


func run(t: PKeyTestContext) -> void:
	PKeyDeviceId.set_raw_source(func(): return RAW)
	await _files(t)
	await _device_write_failure(t)
	_namespace(t)
	_derived_locations(t)
	_reconfigure_follows_the_host(t)
	_caller_overrides_survive_reattach(t)
	_default_store_follows_the_host(t)
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
	# The names the Node SDK derives (packages/sdk-node/test/storeNamespace.test.ts) and the Swift
	# SDK's DirectoriesTests pin too: the bare product on key.plrs.im, the host (with a non-default
	# port) elsewhere.
	for c in [
		["https://key.plrs.im", "djdl"],
		["https://key.plrs.im/", "djdl"],
		["http://127.0.0.1:8787", "djdl@127.0.0.1_8787"],
		["https://key.example.com", "djdl@key.example.com"],
		["https://key.plrs.im:8443", "djdl@key.plrs.im_8443"],
		["http://localhost", "djdl@localhost"],
		["http://[::1]:8787", "djdl@___1__8787"],
	]:
		var got := PKeyCore.store_namespace_for("djdl", c[0])
		t.check("store namespace: %s names the state %s" % [c[0], c[1]], got == c[1], got)
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


## Options with every location at its default except the store root (a scratch directory, so the
## test never writes the developer's `user://pkey`). `base_url` "" keeps the production origin
## PKeyOptions ships with.
static func _options(root: String, base_url := "") -> PKeyOptions:
	var opts := PKeyOptions.new()
	opts.product = "djdl"
	opts.version = "1.0.0"
	opts.store_root = root
	opts.build_stamp_path = ""
	if base_url != "":
		opts.base_url = base_url
	return opts


## The file store under a default store, whichever platform store wraps it.
static func _files_of(store: PKeyStore) -> PKeyFileStore:
	if store is PKeyFileStore:
		return store
	if store is PKeyKeyringStore or store is PKeyKeychainStore or store is PKeyKeystoreStore:
		return store.files
	return null


## Every SDK-owned location a configure() settled on, as the SDK reports it (not as this test would
## compute it): the default store's directory, the pack root, the presentation cache, the update
## slots and the settings file.
static func _actual(sdk: Node) -> Dictionary:
	var files := _files_of(sdk.core.store)
	var settings = sdk.config.get_override_store()
	return {
		"namespace": sdk.core.storage_namespace,
		"state directory": files.dir if files != null else "",
		"pack root": sdk.update.packs.root,
		"presentation cache": sdk.presentation_source.cache_dir,
		"update slots": sdk.update.updater.slots.root,
		"settings file": settings.path if settings is PKeyConfigFileStore else "",
	}


## What a configure() derives when nothing is customised, as literals: against production
## (`local` false) the historical names, against LOCAL_URL (`local` true) the same names with the
## host's namespace appended.
static func _expected(root: String, local: bool) -> Dictionary:
	var ns := "djdl@localhost_8787" if local else "djdl"
	return {
		"namespace": ns,
		"state directory": root.path_join(ns),
		"pack root": "user://pkey/djdl@localhost_8787" if local else "user://pkey",
		"presentation cache": "user://polaris_key/presentation/djdl@localhost_8787" if local else "user://polaris_key/presentation",
		"update slots": root.path_join(ns).path_join("updates"),
		"settings file": "user://pkey_settings@djdl@localhost_8787.cfg" if local else "user://pkey_settings.cfg",
	}


## One check per location, so a failure names the one that moved. A platform keyring store also
## names its OS entry after the namespace (`pkey:<namespace>`).
static func _check_locations(t: PKeyTestContext, label: String, sdk: Node, want: Dictionary) -> void:
	var got := _actual(sdk)
	for key in want:
		var ok: bool = got.get(key) == want[key]
		t.check("%s: %s" % [label, key], ok, str(got.get(key)) if ok else "%s, want %s" % [got.get(key), want[key]])
	if sdk.core.store is PKeyKeyringStore:
		var service: String = sdk.core.store.service
		t.check("%s: the keyring entry is named for the namespace" % label, service == "pkey:" + String(want["namespace"]), service)


## A first configure() with every location at its default: production keeps the historical names
## (the default base_url, and the same origin spelled another way), a local control plane gets its
## own. Nothing is customised, so each location must come from the namespace alone.
func _derived_locations(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store-derived")
	for c in [
		["production, the default base_url", "", false],
		["production, upper case with its port", "https://KEY.PLRS.IM:443/", false],
		["local control plane", LOCAL_URL, true],
	]:
		var sdk := PKeyTestFixtures.new_sdk()
		var r: PKeyResult = sdk.configure(_options(root, c[1]))
		if t.check("store locations (%s): configure succeeds" % c[0], r.ok, str(r)):
			_check_locations(t, "store locations (%s)" % c[0], sdk, _expected(root, c[2]))
		sdk.queue_free()
	PKeyTestFixtures.remove_tree(root)


## One SDK configured again and again: local, production, local, production. Each configure()
## derives every location from its own base_url, so a generated name neither sticks to the host it
## was made for nor leaks into the next one.
func _reconfigure_follows_the_host(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store-reconfigure")
	var sdk := PKeyTestFixtures.new_sdk()
	for c in [
		["local", LOCAL_URL, true],
		["production", "", false],
		["local again", LOCAL_URL, true],
		["production again", "https://key.plrs.im", false],
	]:
		var r: PKeyResult = sdk.configure(_options(root, c[1]))
		if not t.check("store reconfigure (%s): configure succeeds" % c[0], r.ok, str(r)):
			break
		_check_locations(t, "store reconfigure (%s)" % c[0], sdk, _expected(root, c[2]))
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(root)


## A pack root, a presentation cache and a settings file the caller chose stay the caller's through
## every reconfigure, local to production and back, while the locations the caller left alone keep
## following the host. The SDK tells a caller's value from its own by what it generated last, so the
## choice is made both after the first configure() (the generated names are in place) and before it.
func _caller_overrides_survive_reattach(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store-namespace-overrides")
	var packs := root.path_join("custom-packs")
	var cache := root.path_join("custom-presentation")
	var settings := root.path_join("custom-settings.cfg")
	for chosen in ["before the first configure", "after the first configure"]:
		var sdk := PKeyTestFixtures.new_sdk()
		var custom: bool = chosen.begins_with("before")
		if custom:
			sdk.update.packs.root = packs
			sdk.presentation_source.cache_dir = cache
		var step := 0
		for c in [["local", LOCAL_URL, true], ["local, reattached", LOCAL_URL, true], ["production", "", false], ["local again", LOCAL_URL, true]]:
			var opts := _options(root, c[1])
			opts.settings_path = settings
			var r: PKeyResult = sdk.configure(opts)
			var label := "store overrides (%s, %s)" % [chosen, c[0]]
			if not t.check("%s: configure succeeds" % label, r.ok, str(r)):
				break
			var want := _expected(root, c[2])
			want["settings file"] = settings
			if custom:
				want["pack root"] = packs
				want["presentation cache"] = cache
			_check_locations(t, label, sdk, want)
			if not custom and step == 0:
				sdk.update.packs.root = packs
				sdk.presentation_source.cache_dir = cache
				custom = true
			step += 1
		sdk.queue_free()
	PKeyTestFixtures.remove_tree(root)


static func _write_state(sdk: Node, device: String, license: String) -> bool:
	var store: PKeyStore = sdk.core.store
	var slots: PKeySlots = sdk.update.updater.slots
	return store.set_device_id(device) and store.write_cache({"v": 3, "docs": {"license": license}}) and slots.save_state(PKeySlots.empty_state())


static func _has_state(dir: String) -> bool:
	return FileAccess.file_exists(dir.path_join("device")) and FileAccess.file_exists(dir.path_join("managed.json")) \
		and FileAccess.file_exists(dir.path_join("updates").path_join("state.json"))


## The default store, the update slots and the settings file are real consumers of those names:
## what they write lands under the host's own directory and file, never production's, and a
## restart on each origin reads back only what that origin wrote.
func _default_store_follows_the_host(t: PKeyTestContext) -> void:
	var root := PKeyTestFixtures.scratch_dir("store-files")
	var local_dir := root.path_join("djdl@localhost_8787")
	var production_dir := root.path_join("djdl")
	var local_settings := "user://pkey_settings@djdl@localhost_8787.cfg"
	DirAccess.remove_absolute(local_settings)
	var sdk := PKeyTestFixtures.new_sdk()
	var r: PKeyResult = sdk.configure(_options(root, LOCAL_URL))
	if not t.check("store files (local): configure succeeds", r.ok, str(r)):
		sdk.queue_free()
		PKeyTestFixtures.remove_tree(root)
		return
	t.check("store files (local): the default store and the update slots write under the host's directory", \
		_write_state(sdk, LOCAL_DEVICE, "local") and _has_state(local_dir), local_dir)
	t.check("store files (local): the production directory is not created", not DirAccess.dir_exists_absolute(production_dir), production_dir)
	sdk.config.get_override_store().set_override("dice.animSpeed", 3.0)
	t.check("store files (local): a persisted setting lands in the host's settings file", FileAccess.file_exists(local_settings), local_settings)
	DirAccess.remove_absolute(local_settings)

	r = sdk.configure(_options(root))
	if not t.check("store files (production): configure succeeds", r.ok, str(r)):
		sdk.queue_free()
		PKeyTestFixtures.remove_tree(root)
		return
	t.check("store files (production): the default store and the update slots write under the historical directory", \
		_write_state(sdk, PRODUCTION_DEVICE, "production") and _has_state(production_dir), production_dir)
	t.check("store files (production): what the local origin wrote is untouched", \
		FileAccess.get_file_as_string(local_dir.path_join("device")) == LOCAL_DEVICE \
		and PKeyFileStore.new("djdl@localhost_8787", root).read_cache()["docs"]["license"] == "local", local_dir)
	sdk.queue_free()

	for c in [["local", LOCAL_URL, LOCAL_DEVICE], ["production", "", PRODUCTION_DEVICE]]:
		var again := PKeyTestFixtures.new_sdk()
		var rr: PKeyResult = again.configure(_options(root, c[1]))
		var store: PKeyStore = again.core.store if rr.ok else null
		var rec = store.read_cache() if store != null else null
		t.check("store files (%s): a restart reads back its own device id and cache" % c[0], \
			store != null and store.get_device_id() == c[2] and rec is Dictionary and rec["docs"]["license"] == c[0], str(rec))
		again.queue_free()
	PKeyTestFixtures.remove_tree(root)


func _status(t: PKeyTestContext) -> void:
	var s := PKeyFileStore.new("djdl", "user://pkey-test/status")
	var st := s.status()
	t.check("store: status names the backend", st.get("backend") == ("indexeddb" if OS.has_feature("web") else "file"), str(st))
	t.check("store: status is degraded exactly when user:// is not persistent", st.has("degraded") == (not OS.is_userfs_persistent()), str(st))
	t.check("store: the memory store reports memory", PKeyMemoryStore.new().status() == {"backend": "memory"})
