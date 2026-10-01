extends RefCounted
# config_changed fires once per sync with exactly the keys whose effective value changed, over the
# signed documents recorded in sync-etag-304 (ui.theme enforced dark, then light); nothing on a
# 304 pass; a store write that cannot change an enforced key is silent; and PKeyConfigBinding
# applies on bind and re-applies on change, converting numbers to the property's type.

const S := preload("res://tests/config/support.gd")

var F: Dictionary
var plan := {}


func run(t: PKeyTestContext) -> void:
	F = PKeyTestFixtures.sync_docs()
	if not t.check("changed: fixtures present", not F.is_empty()):
		return
	var server := PKeyTestFixtures.new_server(func(req: Dictionary) -> Dictionary:
		for suffix in plan:
			if String(req["path"]).ends_with(suffix):
				return plan[suffix]
		return {"status": 404})
	plan = {
		"polaris-trust.jws": {"status": 200, "body": F["trust_jws"]},
		"/license/document": {"status": 200, "headers": {"ETag": F["license_etag"]}, "body": F["license"]},
		"/config/document": {"status": 200, "headers": {"ETag": F["config_etag"]}, "body": F["config"]},
	}
	var clock := [F["now"]]
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(PKeyTestFixtures.options(server.base_url(), PKeyMemoryStore.new(F["device_id"], F["token"]), clock, F["product"], F["trust"], F["version"]))
	await sdk.start()
	var cfg: PKeyConfig = sdk.config
	cfg.env = S.env_from({})
	var store := PKeyOverrideStore.new({"dice.animSpeed": 1.5, "ui.theme": "player-choice"})
	cfg.set_override_store(store)

	var label := Label.new()
	var spin := Node2D.new()
	var lines := Label.new()
	var holder := Node.new()
	for n in [label, spin, lines]:
		holder.add_child(n)
	(Engine.get_main_loop() as SceneTree).root.add_child(holder)
	var b_theme := cfg.bind_property(label, "text", "ui.theme", "unset")
	var b_speed := PKeyConfigBinding.bind_property(spin, "rotation", "dice.animSpeed", 1, cfg)
	cfg.bind_property(lines, "max_lines_visible", "ui.lines", 3.0)
	t.check("changed: a binding applies at once", label.text == "player-choice" and spin.rotation == 1.5 and lines.max_lines_visible == 3, "%s %s %s" % [label.text, spin.rotation, lines.max_lines_visible])

	var seen: Array = []
	cfg.config_changed.connect(func(keys): seen.append(keys))
	var finished_after := [false]
	sdk.sync_finished.connect(func(_r): finished_after[0] = not seen.is_empty())

	var r: PKeySyncResult = await sdk.sync()
	t.check("changed: the sync applied the config document", r.documents.get("config") == "applied", str(r.documents))
	t.check("changed: once, with exactly the changed key", seen == [PackedStringArray(["ui.theme"])], str(seen))
	t.check("changed: emitted before sync_finished", finished_after[0])
	t.check("changed: the binding re-applied", label.text == "dark")

	seen.clear()
	plan["/license/document"] = {"status": 304}
	plan["/config/document"] = {"status": 304}
	clock[0] = F["now"] + 60
	r = await sdk.sync()
	t.check("changed: nothing on a 304 pass", r.documents.get("config") == "unchanged" and seen.is_empty(), str(seen))

	store.set_override("ui.theme", "another-choice")
	t.check("changed: a saved value for an enforced key changes nothing", seen.is_empty() and label.text == "dark", str(seen))
	store.set_override("dice.animSpeed", 2)
	t.check("changed: a store write emits its key", seen == [PackedStringArray(["dice.animSpeed"])], str(seen))
	t.check("changed: an int value lands in a float property", spin.rotation == 2.0 and typeof(spin.rotation) == TYPE_FLOAT)
	store.set_override("dice.animSpeed", 2.0)
	t.check("changed: 2 -> 2.0 is not a change", seen.size() == 1, str(seen))

	seen.clear()
	plan["/config/document"] = {"status": 200, "headers": {"ETag": "\"newer\""}, "body": F["config_newer"]}
	clock[0] = F["now"] + 120
	r = await sdk.sync()
	t.check("changed: the newer document applied", r.documents.get("config") == "applied", str(r.documents))
	t.check("changed: once more, exactly ui.theme", seen == [PackedStringArray(["ui.theme"])], str(seen))
	t.check("changed: the binding followed", label.text == "light")

	store.set_override("ui.lines", 7.0)
	t.check("changed: a float value lands in an int property", lines.max_lines_visible == 7)

	seen.clear()
	b_speed.unbind()
	store.set_override("dice.animSpeed", 5)
	t.check("changed: an unbound property is left alone", spin.rotation == 2.0 and seen.size() == 1)
	label.free()
	store.set_override("ui.theme", "x")
	cfg.refresh()
	t.check("changed: a freed node's binding is dropped", b_theme.target() == null and not cfg._bindings.has(b_theme))
	holder.queue_free()
	sdk.queue_free()
	server.queue_free()
