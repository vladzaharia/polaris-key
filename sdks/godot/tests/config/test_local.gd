extends RefCounted
# @pkey-feature config.local
# Device-local overrides through the public API (SDK parity §3.11, S-17 §5.11): set_value,
# clear, clear_all and setting(key) over the persisted PKeyConfigFileStore. A write persists and
# survives a restart, a value is checked against the catalog's declared type (Godot's numbers
# are typed by the catalog, not by the Variant), an admin-managed key is refused
# (`managed_by_admin`), and every write emits config_changed exactly once.

const S := preload("res://tests/config/support.gd")
const CATALOG := preload("res://tests/config/catalog_generated.gd")


func run(t: PKeyTestContext) -> void:
	await _persist_and_reload(t)
	await _clear(t)
	await _type_mismatch(t)
	await _admin_managed(t)
	await _one_signal_per_write(t)
	await _memory_when_not_persisted(t)


func _options(path: String) -> PKeyOptions:
	var o := S.options()
	o.persist_settings = true
	o.settings_path = path
	o.config_catalog = CATALOG
	return o


func _sdk(path: String) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(_options(path))
	await sdk.start()
	sdk.config.env = S.env_from({})
	return sdk


func _persist_and_reload(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfglocal")
	var path := dir.path_join("pkey_settings.cfg")
	var sdk: Node = await _sdk(path)
	var cfg: PKeyConfig = sdk.config
	var r := cfg.set_value("dice.animSpeed", 2.0)
	t.check("local: set_value succeeds and returns the stored value", r.ok and r.detail == 2.0, str(r))
	t.check("local: the value is live, sourced local", cfg.get_value("dice.animSpeed") == 2.0 and cfg.get_source("dice.animSpeed") == &"local")
	t.check("local: it is written to the settings file", _read(path, "dice", "animSpeed") == 2.0)
	# An integer key given a whole float (what Godot's JSON hands back) is stored as an int, at
	# the catalog accessor's location.
	r = cfg.set_value("audio.musicVolume", 40.0)
	var saved = _read(path, "audio", "music_volume")
	t.check("local: an integer key takes 40.0 and stores 40", r.ok and typeof(r.detail) == TYPE_INT and typeof(saved) == TYPE_INT and saved == 40, "%s %s" % [r, saved])
	r = cfg.set_value("ui.theme", &"light")
	t.check("local: a StringName is stored as a String", r.ok and typeof(_read(path, "ui", "theme")) == TYPE_STRING)
	sdk.queue_free()

	var again: Node = await _sdk(path)
	t.check("local: the overrides survive a restart", again.config.get_value("dice.animSpeed") == 2.0 and again.config.get_source("dice.animSpeed") == &"local" and again.config.get_value("audio.musicVolume") == 40 and again.config.get_value("ui.theme") == "light")
	var h: PKeyConfigSetting = again.config.setting("dice.animSpeed")
	t.check("local: setting(key) reads the persisted value", h.value == 2.0 and h.source == &"local" and h.is_local() and not h.locked)
	t.check("local: setting(key) is one handle per key", again.config.setting("dice.animSpeed") == h)
	again.queue_free()
	PKeyTestFixtures.remove_tree(dir)


func _clear(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfglocalclr")
	var path := dir.path_join("settings.cfg")
	# The game keeps its own settings in the same file; clear_all must leave them alone.
	var game := ConfigFile.new()
	game.set_value("video", "vsync", true)
	game.save(path)
	var sdk: Node = await _sdk(path)
	var cfg: PKeyConfig = sdk.config
	S.inject(sdk, {"dice.animSpeed": S.entry("default", 1.25)})
	cfg.set_value("dice.animSpeed", 3.0)
	cfg.set_value("audio.musicVolume", 10)
	cfg.set_value("ui.theme", "light")
	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))

	var r := cfg.clear("dice.animSpeed")
	t.check("clear: the override is gone and the remote default answers", r.ok and cfg.get_value("dice.animSpeed") == 1.25 and cfg.get_source("dice.animSpeed") == &"remote-default")
	t.check("clear: removed from the file", not _has(path, "dice", "animSpeed"))
	t.check("clear: one config_changed", seen == [PackedStringArray(["dice.animSpeed"])], str(seen))
	r = cfg.clear("dice.animSpeed")
	t.check("clear: clearing a key with no override succeeds silently", r.ok and seen.size() == 1, str(seen))
	t.check("clear: an empty key is refused", cfg.clear("").code == PKeyErrors.INVALID_OPTIONS)

	r = cfg.clear_all()
	t.check("clear_all: every known override is cleared", r.ok and r.detail == PackedStringArray(["audio.musicVolume", "ui.theme"]), str(r.detail))
	t.check("clear_all: one config_changed for all of them", seen.size() == 2 and seen[1] == PackedStringArray(["audio.musicVolume", "ui.theme"]), str(seen))
	t.check("clear_all: the values fall back", cfg.get_source("audio.musicVolume") == &"fallback" and cfg.get_value("audio.musicVolume") == 80 and cfg.get_value("ui.theme") == "dark")
	t.check("clear_all: the game's own settings stay in the file", _read(path, "video", "vsync") == true and not _has(path, "audio", "music_volume") and not _has(path, "ui", "theme"))
	r = cfg.clear_all()
	t.check("clear_all: nothing to clear is silent", r.ok and r.detail.is_empty() and seen.size() == 2, str(seen))
	t.check("clear: set_value(key, null) clears", cfg.set_value("ui.theme", "light").ok and cfg.set_value("ui.theme", null).ok and cfg.get_source("ui.theme") == &"fallback")
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(dir)


func _type_mismatch(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfglocaltype")
	var path := dir.path_join("settings.cfg")
	var sdk: Node = await _sdk(path)
	var cfg: PKeyConfig = sdk.config
	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))
	var cases := [
		["a string for a number", "dice.animSpeed", "fast"],
		["a bool for a number", "dice.animSpeed", true],
		["below the minimum", "dice.animSpeed", 0.1],
		["above the maximum", "dice.animSpeed", 5],
		["a fraction for an integer", "audio.musicVolume", 2.5],
		["out of range for an integer", "audio.musicVolume", 101],
		["a value outside the enum", "ui.theme", "blue"],
		["a number for a string", "ui.theme", 1],
		["a string for a boolean", "extras.diceSkins", "yes"],
		["a secret", "leaderboard.apiKey", "abc"],
		["a non-JSON value", "dice.animSpeed", Vector2(1, 2)],
		["NaN", "dice.animSpeed", NAN],
		["an object holding a node", "dice.animSpeed", {"n": Node}],
	]
	for c in cases:
		var r := cfg.set_value(c[1], c[2])
		t.check("type: %s is refused invalid-options" % c[0], not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and r.message.contains(c[1]), str(r))
	t.check("type: nothing was written", not FileAccess.file_exists(path) and cfg.get_source("dice.animSpeed") == &"fallback")
	t.check("type: a refusal emits nothing", seen.is_empty(), str(seen))
	t.check("type: the boundaries are inclusive", cfg.set_value("dice.animSpeed", 4).ok and cfg.set_value("dice.animSpeed", 0.25).ok and cfg.set_value("audio.musicVolume", 0).ok)
	t.check("type: an integer is a valid number", cfg.set_value("dice.animSpeed", 2).ok and cfg.get_value("dice.animSpeed") == 2)

	# With no catalog entry, the document's value types the key.
	cfg.set_compiled_catalog(null)
	S.inject(sdk, {"hud.scale": S.entry("default", 1), "hud.label": S.entry("default", "x")})
	var r := cfg.set_value("hud.scale", "big")
	t.check("type: without a catalog the document's type applies", r.code == PKeyErrors.INVALID_OPTIONS, str(r))
	t.check("type: an int document value takes a float", cfg.set_value("hud.scale", 1.5).ok and cfg.get_value("hud.scale") == 1.5)
	t.check("type: a string document value refuses a number", cfg.set_value("hud.label", 3).code == PKeyErrors.INVALID_OPTIONS)
	t.check("type: a key nothing types takes any JSON value", cfg.set_value("free.form", {"a": [1, "b", null]}).ok and S.same(cfg.get_value("free.form"), {"a": [1, "b", null]}))
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(dir)


func _admin_managed(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfglocaladm")
	var path := dir.path_join("settings.cfg")
	var sdk: Node = await _sdk(path)
	var cfg: PKeyConfig = sdk.config
	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))

	# Before any document: the catalog's managementDefault locks the key.
	var r := cfg.set_value("game.killSwitch", true)
	t.check("admin: a catalog-enforced key is refused managed_by_admin", not r.ok and r.code == PKeyErrors.MANAGED_BY_ADMIN and r.detail.get("state") == "enforced", str(r))
	t.check("admin: a catalog-hidden key is refused", cfg.set_value("difficulty.tuning", {"easy": 1}).code == PKeyErrors.MANAGED_BY_ADMIN)
	t.check("admin: is_locked says so", cfg.is_locked("game.killSwitch") and not cfg.is_locked("dice.animSpeed"))

	S.inject(sdk, {
		"ui.theme": S.entry("enforced", "dark"),
		"dice.animSpeed": S.entry("hidden", 1.0),
		"game.killSwitch": S.entry("default", false),
	})
	seen.clear()
	var h: PKeyConfigSetting = cfg.setting("ui.theme")
	t.check("admin: setting(key).locked for a document-enforced key", h.locked and h.source == &"enforced")
	r = h.set_value("light")
	t.check("admin: a document-enforced key is refused", r.code == PKeyErrors.MANAGED_BY_ADMIN and r.message.contains("ui.theme"), str(r))
	t.check("admin: a document-hidden key is refused", cfg.set_value("dice.animSpeed", 2.0).code == PKeyErrors.MANAGED_BY_ADMIN)
	t.check("admin: nothing was written and nothing emitted", not FileAccess.file_exists(path) and seen.is_empty(), str(seen))
	t.check("admin: the document beats the catalog's managementDefault", cfg.set_value("game.killSwitch", true).ok and cfg.get_value("game.killSwitch") == true)
	# The operator relaxes ui.theme: writes are accepted again.
	S.inject(sdk, {"ui.theme": S.entry("default", "dark")})
	t.check("admin: relaxed, the handle unlocks", not h.locked and h.set_value("light").ok and h.value == "light")
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(dir)


func _one_signal_per_write(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cfglocalsig")
	var path := dir.path_join("settings.cfg")
	var sdk: Node = await _sdk(path)
	var cfg: PKeyConfig = sdk.config
	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))
	var h: PKeyConfigSetting = cfg.setting("dice.animSpeed")
	var handle_seen: Array = []
	h.changed.connect(func(v, src): handle_seen.append([v, src]))

	cfg.set_value("dice.animSpeed", 2.0)
	t.check("signal: one config_changed for one write", seen == [PackedStringArray(["dice.animSpeed"])], str(seen))
	t.check("signal: the handle emits the new value and source", handle_seen.size() == 1 and handle_seen[0][0] == 2.0 and handle_seen[0][1] == &"local" and h.value == 2.0, str(handle_seen))
	cfg.set_value("dice.animSpeed", 3.0)
	cfg.set_value("audio.musicVolume", 55)
	t.check("signal: each write emits once with its key", seen.size() == 3 and seen[1] == PackedStringArray(["dice.animSpeed"]) and seen[2] == PackedStringArray(["audio.musicVolume"]), str(seen))
	t.check("signal: a write to another key leaves the handle quiet", handle_seen.size() == 2, str(handle_seen))
	cfg.set_value("dice.animSpeed", 3)
	t.check("signal: rewriting the same value emits nothing", seen.size() == 3 and handle_seen.size() == 2, str(seen))
	cfg.clear("dice.animSpeed")
	t.check("signal: a clear emits once", seen.size() == 4 and seen[3] == PackedStringArray(["dice.animSpeed"]) and handle_seen.size() == 3 and h.source == &"fallback" and h.value == 1.25, str(handle_seen))
	sdk.queue_free()
	PKeyTestFixtures.remove_tree(dir)


## persist_settings off and no store of the game's own: a write still applies, in memory.
func _memory_when_not_persisted(t: PKeyTestContext) -> void:
	var o := S.options()
	o.persist_settings = false
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(o)
	await sdk.start()
	sdk.config.env = S.env_from({})
	t.check("memory: no store before the first write", sdk.config.get_override_store() == null)
	var r: PKeyResult = sdk.config.set_value("dice.animSpeed", 2.0)
	t.check("memory: the write applies for the session", r.ok and sdk.config.get_value("dice.animSpeed") == 2.0 and sdk.config.get_source("dice.animSpeed") == &"local")
	t.check("memory: in a memory table, not a file", sdk.config.get_override_store() != null and not (sdk.config.get_override_store() is PKeyConfigFileStore))
	sdk.queue_free()


static func _read(path: String, section: String, key: String) -> Variant:
	var c := ConfigFile.new()
	c.load(path)
	return c.get_value(section, key, null)


static func _has(path: String, section: String, key: String) -> bool:
	var c := ConfigFile.new()
	c.load(path)
	return c.has_section_key(section, key)
