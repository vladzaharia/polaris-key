extends RefCounted
# The generated GDScript mirror (tools/gen-mirrors.ts --lang gdscript), committed at
# tests/config/catalog_generated.gd from tests/config/catalog.json (a tools test keeps it
# fresh): it loads, its constants match the catalog value for value (escaped quotes and
# non-ASCII labels included), entry_by_key and entries_by_kind work, a secret's default is not
# compiled in, and its DEFAULTS back get_value through set_compiled_catalog and
# PKeyOptions.config_catalog.

const S := preload("res://tests/config/support.gd")
const MIRROR := "res://tests/config/catalog_generated.gd"


func run(t: PKeyTestContext) -> void:
	var script = load(MIRROR)
	if not t.check("mirror: catalog_generated.gd loads", script is GDScript and script.can_instantiate()):
		return
	var catalog = PKeyTestFixtures.read_json("res://tests/config/catalog.json")
	if not t.check("mirror: the fixture catalog loads", catalog is Dictionary):
		return
	var m: Dictionary = (script as GDScript).get_script_constant_map()
	t.check("mirror: CATALOG_VERSION", m.get("CATALOG_VERSION") == 3 and m["CATALOG_VERSION"] is int)
	var keys: Array = catalog["entries"].map(func(e): return e["key"])
	t.check("mirror: KEYS in catalog order", m.get("KEYS") == keys, str(m.get("KEYS")))
	var mismatched: Array = []
	for i in catalog["entries"].size():
		var want: Dictionary = catalog["entries"][i].duplicate(true)
		if want["kind"] == "secret":
			want.erase("default")
		if not S.same(m["ENTRIES"][i], want):
			mismatched.append(want["key"])
	t.check("mirror: ENTRIES equal the catalog, value for value", mismatched.is_empty() and m["ENTRIES"].size() == keys.size(), str(mismatched))
	t.check("mirror: escaped quotes and non-ASCII decode", script.entry_by_key("audio.musicVolume")["label"] == "Música \"principal\"" \
			and script.entry_by_key("ui.theme")["label"] == "Theme 🎲" and script.entry_by_key("ui.theme")["ui"]["optionLabels"]["dark"] == "Dunkel ☾" \
			and script.entry_by_key("dice.animSpeed")["ui"]["unit"] == "×")
	t.check("mirror: control characters decode", script.entry_by_key("audio.musicVolume")["description"] == "Line one.\nLine two, with a back\\slash and a tab\there.")
	t.check("mirror: entry_by_key misses with {}", script.entry_by_key("nope") == {})
	t.check("mirror: entries_by_kind", script.entries_by_kind("config").size() == 5 and script.entries_by_kind("flag")[0]["key"] == "extras.diceSkins")
	t.check("mirror: a secret's default is not compiled in", not script.entry_by_key("leaderboard.apiKey").has("default") and not FileAccess.get_file_as_string(MIRROR).contains("never-a-default"))
	var defaults: Dictionary = m.get("DEFAULTS", {})
	t.check("mirror: DEFAULTS holds config keys only", defaults.keys() == ["audio.musicVolume", "dice.animSpeed", "difficulty.tuning", "game.killSwitch", "ui.theme"], str(defaults.keys()))
	t.check("mirror: DEFAULTS keep their JSON types", defaults["audio.musicVolume"] is int and defaults["dice.animSpeed"] is float and defaults["game.killSwitch"] == false \
			and S.same(defaults["difficulty.tuning"], {"easy": 0.5, "hard": [1, 2.5, 3], "none": null}))
	var users: Dictionary = m.get("USER_SETTINGS", {})
	# U-01b: every Editable config key is a setting a person chooses, in catalog order; a locked key
	# (enforced, hidden) is not, and a `user` block only tunes the defaults.
	t.check("mirror: USER_SETTINGS names every Editable key, defaults applied (U-01b)", users.keys() == ["dice.animSpeed", "audio.musicVolume", "ui.theme"] \
			and S.same(users["dice.animSpeed"], {"sync": "user", "conflict": "lastWrite", "listed": true}) \
			and S.same(users["audio.musicVolume"], {"sync": "user", "conflict": "max", "listed": true}) \
			and S.same(users["ui.theme"], {"sync": "local", "conflict": "lastWrite", "listed": false}), str(users))

	var sdk: Node = await S.sdk_with({"ui.theme": S.entry("enforced", "light")})
	sdk.config.set_compiled_catalog(script)
	t.check("mirror: get_value without a fallback uses DEFAULTS", sdk.config.get_value("dice.animSpeed") == 1.25 and sdk.config.get_source("dice.animSpeed") == &"fallback")
	t.check("mirror: the document still wins", sdk.config.get_value("ui.theme") == "light")
	var tuning: Dictionary = sdk.config.get_value("difficulty.tuning")
	tuning["easy"] = 9
	t.check("mirror: a default container is a writable copy", not tuning.is_read_only() and sdk.config.get_value("difficulty.tuning")["easy"] == 0.5)
	t.check("mirror: catalog() is the compiled one until a fetch", sdk.config.catalog().get("schemaVersion") == 3 and sdk.config.catalog_entry("audio.musicVolume").get("accessor") == "audio.music_volume")
	sdk.queue_free()

	var o := S.options()
	o.config_catalog = script
	var sdk2 := PKeyTestFixtures.new_sdk()
	sdk2.configure(o)
	t.check("mirror: PKeyOptions.config_catalog is applied at configure()", sdk2.config.get_value("ui.theme") == "dark")
	sdk2.queue_free()
