extends RefCounted
# The local-override layer over the game's own ConfigFile (PKeyConfigFileStore): where a key
# lives (accessor, explicit table, the key), reads at call time, writes through, and the rule
# that an enforced or hidden key IGNORES the saved value without deleting it — across a real sync
# against recorded, signed documents.

const S := preload("res://tests/config/support.gd")

var _plan := {}


func run(t: PKeyTestContext) -> void:
	_locate(t)
	await _live_file(t)
	await _locked_keeps_file(t)
	await _persisted_default(t)


func _locate(t: PKeyTestContext) -> void:
	var s := PKeyConfigFileStore.new("user://x.cfg", {"audio.vol": ["sound", "volume"], "gfx.fps": "video.max_fps"})
	t.check("store: an accessor splits at the first dot", s.locate("anything", "audio.music.volume") == PackedStringArray(["audio", "music.volume"]))
	t.check("store: the accessor beats the explicit table", s.locate("audio.vol", "a.b") == PackedStringArray(["a", "b"]))
	t.check("store: the explicit table, as an array", s.locate("audio.vol") == PackedStringArray(["sound", "volume"]))
	t.check("store: the explicit table, as a dotted string", s.locate("gfx.fps") == PackedStringArray(["video", "max_fps"]))
	t.check("store: else the key itself", s.locate("dice.animSpeed") == PackedStringArray(["dice", "animSpeed"]))
	t.check("store: a name without a dot goes in the default section", s.locate("volume") == PackedStringArray(["settings", "volume"]) and s.locate(".x") == PackedStringArray(["settings", ".x"]))


func _live_file(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfgstore")
	var path := dir.path_join("settings.cfg")
	var sdk: Node = await S.sdk_with({"dice.animSpeed": S.entry("default", 1.0)})
	var cfg: PKeyConfig = sdk.config
	cfg.set_compiled_catalog({"CATALOG_VERSION": 1, "ENTRIES": [{"key": "audio.musicVolume", "kind": "config", "accessor": "audio.music_volume"}], "DEFAULTS": {}})
	var store := PKeyConfigFileStore.new(path)
	cfg.set_override_store(store)
	t.check("store: a missing file means no overrides", cfg.get_source("dice.animSpeed") == &"remote-default" and not FileAccess.file_exists(path))

	# The game's own settings code writes the file; the next read sees it.
	var game := ConfigFile.new()
	game.set_value("dice", "animSpeed", 2.5)
	game.set_value("audio", "music_volume", 40)
	game.save(path)
	t.check("store: a value the game saved is read at call time", cfg.get_value("dice.animSpeed", 0.0) == 2.5 and cfg.get_source("dice.animSpeed") == &"local")
	t.check("store: the catalog accessor locates the value", cfg.get_value("audio.musicVolume", 0) == 40)
	# Reads never emit; the game announces its own write with reload().
	store.reload()

	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))
	t.check("store: writing through the store saves the file", store.set_override("dice.animSpeed", 3.0) and _read(path, "dice", "animSpeed") == 3.0)
	t.check("store: a write through the store emits config_changed", seen == [PackedStringArray(["dice.animSpeed"])], str(seen))
	t.check("store: and the value is live", cfg.get_value("dice.animSpeed", 0.0) == 3.0)

	# Same second, external write: `reload()` is the explicit refresh.
	game = ConfigFile.new()
	game.load(path)
	game.set_value("dice", "animSpeed", 0.5)
	game.save(path)
	store.reload()
	t.check("store: reload() picks up an external write and emits", cfg.get_value("dice.animSpeed", 0.0) == 0.5 and seen.size() == 2 and seen[1] == PackedStringArray(["dice.animSpeed"]), str(seen))

	t.check("store: clear_override removes it from the file", store.clear_override("dice.animSpeed") and not _has(path, "dice", "animSpeed") and cfg.get_source("dice.animSpeed") == &"remote-default")
	t.check("store: clearing a missing key is fine and silent", store.clear_override("nope") and seen.size() == 3, str(seen.size()))
	t.check("store: a null override clears", store.set_override("audio.musicVolume", null, "audio.music_volume") and not _has(path, "audio", "music_volume"))
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(dir)


## A saved value for an enforced key is ignored, never deleted, and comes back when the operator
## relaxes the state; a real sync leaves settings.cfg byte for byte as it was.
func _locked_keeps_file(t: PKeyTestContext) -> void:
	var F := PKeyTestFixtures.sync_docs()
	if not t.check("store: sync fixtures present", not F.is_empty()):
		return
	var dir := PKeyTestFixtures.scratch_dir("cfglock")
	var path := dir.path_join("settings.cfg")
	var game := ConfigFile.new()
	game.set_value("ui", "theme", "light")
	game.set_value("dice", "animSpeed", 2.0)
	game.save(path)
	var before := FileAccess.get_file_as_bytes(path)

	var server := PKeyTestFixtures.new_server(func(req: Dictionary) -> Dictionary:
		var p := String(req["path"])
		if p.ends_with("polaris-trust.jws"):
			return {"status": 200, "body": F["trust_jws"]}
		if p.ends_with("/license/document"):
			return {"status": 200, "headers": {"ETag": F["license_etag"]}, "body": F["license"]}
		if p.ends_with("/config/document"):
			return {"status": 200, "headers": {"ETag": F["config_etag"]}, "body": F["config"]}
		return {"status": 404})
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var clock := [F["now"]]
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], F["version"]))
	await sdk.start()
	sdk.config.env = S.env_from({})
	sdk.config.set_override_store(PKeyConfigFileStore.new(path))
	t.check("store: before the document arrives, the saved theme applies", sdk.config.get_value("ui.theme") == "light" and sdk.config.get_source("ui.theme") == &"local")
	var r: PKeySyncResult = await sdk.sync()
	t.check("store: the sync applied the signed config document", r.documents.get("config") == "applied", str(r.documents))
	t.check("store: enforced ui.theme ignores the saved value", sdk.config.get_value("ui.theme") == "dark" and sdk.config.get_source("ui.theme") == &"enforced")
	t.check("store: a default key still reads the saved value", sdk.config.get_value("dice.animSpeed", 1.0) == 2.0)
	t.check("store: settings.cfg is untouched by the sync", FileAccess.get_file_as_bytes(path) == before and _read(path, "ui", "theme") == "light")
	# The operator relaxes the state: the player's choice is back.
	var doc: Dictionary = sdk.core.cache.config["doc"].duplicate(true)
	doc["config"]["ui.theme"]["state"] = "default"
	sdk.core.cache.config = {"jws": "", "doc": doc}
	t.check("store: relaxed to default, the saved value returns", sdk.config.get_value("ui.theme") == "light" and sdk.config.get_source("ui.theme") == &"local")
	sdk.queue_free()
	server.queue_free()
	PKeyTestFixtures.remove_tree(dir)


## SDK parity §3.11: without a store of the game's own, the settings layer persists by default in
## a PKeyConfigFileStore at PKeyOptions.settings_path, survives a restart (a new configure), never
## replaces a store the game installed, and persist_settings = false keeps it in memory.
func _persisted_default(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfgdefault")
	var path := dir.path_join("pkey_settings.cfg")
	t.check("persist: the documented default path", PKeyOptions.new().settings_path == "user://pkey_settings.cfg" and PKeyOptions.new().persist_settings)
	var o := PKeyTestFixtures.options("http://127.0.0.1:1", PKeyMemoryStore.new("dev_x"), [S.NOW])
	o.persist_settings = true
	o.settings_path = path
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(o)
	var store = sdk.config.get_override_store()
	t.check("persist: configure installs the file store", store is PKeyConfigFileStore and store.path == path and sdk.config.is_default_override_store())
	store.set_override("dice.animSpeed", 3.0)
	sdk.queue_free()
	var again := PKeyTestFixtures.new_sdk()
	again.configure(o)
	t.check("persist: the saved setting survives a restart", again.config.get_value("dice.animSpeed") == 3.0 and again.config.get_source("dice.animSpeed") == &"local")
	var own := PKeyOverrideStore.new({"dice.animSpeed": 9.0})
	again.config.set_override_store(own)
	again.configure(o)
	t.check("persist: a store the game installed is never replaced", again.config.get_override_store() == own and not again.config.is_default_override_store())
	again.queue_free()
	var off := PKeyTestFixtures.new_sdk()
	o.persist_settings = false
	off.configure(o)
	t.check("persist: persist_settings = false keeps no file store", off.config.get_override_store() == null and off.config.get_value("dice.animSpeed") == null)
	off.queue_free()
	PKeyTestFixtures.remove_tree(dir)


static func _read(path: String, section: String, key: String) -> Variant:
	var c := ConfigFile.new()
	c.load(path)
	return c.get_value(section, key, null)


static func _has(path: String, section: String, key: String) -> bool:
	var c := ConfigFile.new()
	c.load(path)
	return c.has_section_key(section, key)
