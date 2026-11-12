extends RefCounted
# @pkey-feature ui.kit
# The Pair with a Code screens (PKeyLocalPairing, PKeyPairedDevices) driven over a scripted
# `local_links` and a virtual clock. The structural snapshots, the focus walks and the copy and header
# checks of every ui-matrix `local` row are suite_ui's, and the layout at every size is suite_ui_matrix's
# (tests/ui/scenarios.gd, `local_pairing` and `paired_devices`). This pins what those cannot see: one
# method per screen, the QR behind one swappable node, the first focus and what Escape does on the
# prompt, the 250 ms guard, a busy Pair, the field, and the list's rename, forget and switches.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_local_screens

const Fake := preload("res://tests/support/fake_local_links.gd")
const CATS := ["crates", "cues"]

var _guard := 0


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	TranslationServer.set_locale("en")
	PKeyUiTheme.reset()
	PKeyUiTheme.use_presentation(null)
	PKeyUiTheme.product_name = ""
	PKeyUiTheme.reduce_motion_mode = "on"
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	await _show_screen(t)
	await _swappable_visual(t)
	await _prompt(t)
	await _field(t)
	await _paired(t)
	await _list(t)
	await _list_edits(t)
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reset()
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _settle() -> void:
	for i in 3:
		await _tree().process_frame


func _pairing(f, options := {}) -> PKeyLocalPairing:
	var v := PKeyLocalPairing.new()
	v.auto_sdk = false
	v.size = Vector2(900, 1400)
	v.category_labels = {"crates": "Crates", "cues": "Cues"}
	v.ticks_source = func() -> int: return _guard
	_tree().root.add_child(v)
	var o := {"categories": CATS, "now": Callable(f, "now"), "timer": Callable(f, "timer")}
	o.merge(options, true)
	v.attach(f, o)
	await _settle()
	return v


static func _drop(v: Control) -> void:
	v.get_parent().remove_child(v)
	v.queue_free()


static func _texts(v: Control) -> Array:
	var out: Array = []
	for n in v.find_children("*", "Control", true, false):
		var c := n as Control
		if not c.is_visible_in_tree():
			continue
		if c is Label:
			out.append((c as Label).text)
		elif c is Button:
			out.append((c as Button).text)
		elif c is RichTextLabel:
			out.append((c as RichTextLabel).get_parsed_text())
	return out


## The text drawn after `node` in the tree's order (what sits under it in one column).
static func _texts_after(v: Control, node: Node) -> Array:
	var out: Array = []
	var seen := false
	for n in v.find_children("*", "Control", true, false):
		if n == node:
			seen = true
		elif seen and not node.is_ancestor_of(n) and (n as Control).is_visible_in_tree():
			if n is Label:
				out.append((n as Label).text)
			elif n is Button:
				out.append((n as Button).text)
	return out


static func _has_status(texts: Array) -> bool:
	for x in texts:
		if String(x).begins_with("Expires in") and String(x).contains("Waiting for the other device"):
			return true
	return false


static func _button(v: Control, key: String) -> Button:
	for b in v.find_children("*", "Button", true, false):
		if b.get_meta(&"pkey_key", "") == key and (b as Button).is_visible_in_tree():
			return b
	return null


func _opened(f) -> void:
	f.last_pair["on_code"].call(Fake.code("4812 3456", "opened", f.now() + 300.0))
	await _settle()


# ── One method per screen ────────────────────────────────────────────────────────────────────


func _show_screen(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var v := await _pairing(f)
	t.check(
		"pairing screen: starts on the entry with both ways, neither the primary",
		(
			v.model["state"] == "choose"
			and _button(v, "localPairing.show") != null
			and _button(v, "localPairing.enter") != null
			and v.model["decisions"]["primary"] == null
		)
	)
	_button(v, "localPairing.show").pressed.emit()
	await _settle()
	t.check(
		"pairing screen: the window opens with a placeholder tile",
		(
			v.model["state"] == "opening"
			and f.pairs == 1
			and v.find_child("Code", true, false).plain() == "···· ····"
		)
	)
	await _opened(f)
	var code := v.find_child("Code", true, false) as PKeyPairCode
	var visual := v.find_child("PairVisual", true, false)
	t.check(
		"code view: the default shows the eight digits and no QR",
		code.plain() == "4812 3456" and code.visible and not visual.visible
	)
	var shown := _texts(v)
	t.check(
		"code view: the time and the waiting line are there",
		_has_status(shown)
	)
	t.check(
		"code view: Cancel and one quiet link to the QR view, never a way to the field",
		(
			_button(v, "common.cancel") != null
			and _button(v, PKeyLocalPairing.TO_QR_KEY) != null
			and _button(v, PKeyLocalPairing.TO_QR_KEY).theme_type_variation == &"PKeyLink"
			and _button(v, "localPairing.toEnter") == null
			and _button(v, "localPairing.enter") == null
			and not v.find_child("Entry", true, false).visible
		)
	)
	t.check(
		"code view: the link is not the first focus",
		v.get_viewport().gui_get_focus_owner() != _button(v, PKeyLocalPairing.TO_QR_KEY)
	)
	# The QR view: the same window, no digits, no renewal.
	_button(v, PKeyLocalPairing.TO_QR_KEY).pressed.emit()
	await _settle()
	await _settle()
	shown = _texts(v)
	t.check(
		"QR view: the QR and no digits",
		(
			visual.visible
			and visual.payload().begins_with("PKP1:")
			and not code.visible
			and shown.filter(func(x): return String(x).contains("4812")).is_empty()
		)
	)
	t.check(
		"QR view: the time and the waiting line stay",
		_has_status(shown)
	)
	t.check(
		"QR view: Cancel and one quiet link back to the code",
		(
			_button(v, "common.cancel") != null
			and _button(v, PKeyLocalPairing.TO_CODE_KEY) != null
			and _button(v, PKeyLocalPairing.TO_QR_KEY) == null
		)
	)
	t.check(
		"switching views does not renew the code",
		f.pairs == 1 and f.window.renew_calls == 0 and f.window.stops == 0
	)
	var focus := v.get_viewport().gui_get_focus_owner()
	t.check(
		"QR view: after the switch focus stays on the switch slot, so a second press switches back",
		focus != null and focus == _button(v, PKeyLocalPairing.TO_CODE_KEY)
	)
	# A renewal updates whichever view is open: the QR changes, the view stays.
	f.last_pair["on_code"].call(Fake.code("4873 3456", "wrong-code", f.now() + 290.0))
	await _settle()
	t.check(
		"QR view: a rotation keeps the QR view, with the new QR and still no digits",
		(
			v.model["state"] == "show-qr"
			and visual.visible
			and not code.visible
			and _texts(v).filter(func(x): return String(x).contains("4873")).is_empty()
		)
	)
	var notice := v.find_child("Notice", true, false) as PKeyPairNotice
	_button(v, PKeyLocalPairing.TO_CODE_KEY).pressed.emit()
	await _settle()
	await _settle()
	t.check(
		"code view: back from the QR view shows the changed code, lit where it changed, and no QR",
		(
			code.visible
			and code.plain() == "4873 3456"
			and code.lit == [2, 3]
			and not visual.visible
			and f.pairs == 1
			and f.window.renew_calls == 0
		)
	)
	t.check(
		"code view: the notice offers Show a new code",
		(
			notice.visible
			and notice.action_button() != null
			and notice.action_button().text == "Show a new code"
		)
	)
	t.check(
		"show screen: Cancel returns to the entry and withdraws the window", _cancel_to_entry(v, f)
	)
	await _settle()
	_button(v, "localPairing.enter").pressed.emit()
	await _settle()
	var entry := v.find_child("Entry", true, false) as LineEdit
	t.check(
		"enter screen: the field is the only method, with no code and no QR",
		(
			v.model["state"] == "enter"
			and entry.visible
			and not v.find_child("Code", true, false).visible
			and not v.find_child("PairVisual", true, false).visible
		)
	)
	_drop(v)
	t.check("pairing screen: leaving the tree stops everything it started", f.pending_timers() == 0)
	await _settle()


func _cancel_to_entry(v: PKeyLocalPairing, f) -> bool:
	_button(v, "common.cancel").pressed.emit()
	return v.model["state"] == "choose" and f.window.stops == 1


func _swappable_visual(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var log := []
	var v := PKeyLocalPairing.new()
	v.auto_sdk = false
	v.size = Vector2(900, 1400)
	v.visual_factory = func() -> Control: return _Stand.new(log)
	_tree().root.add_child(v)
	v.attach(f, {"categories": CATS, "now": Callable(f, "now"), "timer": Callable(f, "timer")})
	await _settle()
	v.flow.show()
	await _settle()
	await _opened(f)
	t.check(
		"visual: the code view draws no QR through it",
		log.filter(func(x): return String(x).begins_with("present:PKP1")).is_empty()
	)
	v.flow.set_view("qr")
	await _settle()
	t.check(
		"visual: the QR view draws the QR through the swapped node alone",
		(
			log.has("present:PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y")
			and v.find_child("Stand", true, false) != null
			and v.find_child("PairVisual", true, false) == null
		)
	)
	t.check("visual: and sizes it", log.any(func(x): return String(x).begins_with("side:")))
	_drop(v)
	await _settle()


class _Stand:
	extends PanelContainer
	var log: Array

	func _init(p_log: Array) -> void:
		name = "Stand"
		log = p_log

	func present(payload: String) -> void:
		log.append("present:" + payload)

	func set_side(px: float) -> void:
		log.append("side:%d" % int(px))


# ── The prompt ───────────────────────────────────────────────────────────────────────────────


func _prompt(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var v := await _pairing(f)
	v.flow.show()
	await _settle()
	await _opened(f)
	var offer := Fake.Offer.new("LAPTOP-7QH3RX", CATS)
	_guard = 1000
	f.last_pair["on_confirm"].call(offer)
	await _settle()
	var focus := v.get_viewport().gui_get_focus_owner()
	var said := _texts(v)
	t.check(
		"prompt: it names the device and lists what is shared before Pair",
		(
			v.model["state"] == "confirm"
			and said.has("Pair with \u2068LAPTOP-7QH3RX\u2069?")
			and said.has("Each of you shares")
			and said.any(
				func(x): return String(x).contains("Crates") and String(x).contains("Cues")
			)
		),
		str(said)
	)
	t.check(
		"prompt: the first focus is Not now, never Pair",
		focus != null and focus.get_meta(&"pkey_key", "") == "common.notNow"
	)
	var pair := _button(v, "localPairing.pair")
	_guard = 1100
	pair.pressed.emit()
	t.check("prompt: Pair ignores a press in the first 250 ms", offer.confirms == 0)
	_guard = 1300
	pair.pressed.emit()
	await _settle()
	t.check(
		"prompt: after the guard Pair is the yes, answered at once",
		(
			offer.confirms == 1
			and v.model["disabled"] == ["common.notNow", "localPairing.pair"]
			and pair.modulate.a < 1.0
		)
	)
	pair.pressed.emit()
	t.check("prompt: a repeat press is ignored", offer.confirms == 1)
	_drop(v)
	# Escape is Not now.
	f = Fake.new()
	v = await _pairing(f)
	v.flow.show()
	await _settle()
	await _opened(f)
	offer = Fake.Offer.new("Studio PC", CATS)
	f.last_pair["on_confirm"].call(offer)
	await _settle()
	t.check("prompt: Escape (a pad's B) is Not now", v._cancel() and offer.declines == 1)
	_drop(v)
	await _settle()


# ── The field ────────────────────────────────────────────────────────────────────────────────


func _field(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var v := await _pairing(f)
	_button(v, "localPairing.enter").pressed.emit()
	await _settle()
	var entry := v.find_child("Entry", true, false) as LineEdit
	t.check(
		"field: Enter a code shows the 8-digit field with Pair unavailable",
		(
			entry.visible
			and v.model["disabled"] == ["localPairing.pair"]
			and _button(v, "localPairing.pair").modulate.a < 1.0
		)
	)
	t.check(
		"field: the field takes the first focus on a desktop",
		v.get_viewport().gui_get_focus_owner() == entry
	)
	entry.text = "48123"
	entry.text_changed.emit("48123")
	await _settle()
	t.check("field: typing is grouped as it goes", entry.text == "4812 3")
	entry.text = "4812 3456"
	entry.text_changed.emit("4812 3456")
	await _settle()
	t.check("field: eight digits make Pair ready", not v.model.has("disabled"))
	f.join_result = Fake.fail("pairing-code-failed", {"reason": "wrong"})
	_button(v, "localPairing.pair").pressed.emit()
	await _settle()
	await _settle()
	var texts := _texts(v)
	t.check(
		"field: a wrong code keeps two digits and says so under the field",
		(
			entry.text == "48"
			and texts.has("That code didn’t work. Enter the code the other device shows now.")
		)
	)
	t.check(
		"field: switching method is a link, 'Show a code instead'",
		_button(v, "localPairing.toShow") != null and _button(v, "common.back") != null
	)
	entry.text = "4812 3456"
	entry.text_changed.emit("4812 3456")
	await _settle()
	_button(v, "localPairing.pair").pressed.emit()
	await _settle()
	t.check("field: the very code that failed answers its reason and sends nothing", f.joins == 1)
	t.check("field: Escape is Back", v._cancel() and v.model["state"] == "choose")
	_drop(v)
	await _settle()


func _paired(t: PKeyTestContext) -> void:
	var f := Fake.new()
	f.links = [Fake.row("L9", "Studio PC")]
	var v := await _pairing(f)
	_button(v, "localPairing.enter").pressed.emit()
	await _settle()
	var entry := v.find_child("Entry", true, false) as LineEdit
	entry.text_changed.emit("48123456")
	await _settle()
	_button(v, "localPairing.pair").pressed.emit()
	await _settle()
	await _settle()
	t.check(
		"paired: the name starts as the one the device sent, in a field of its own",
		(
			v.model["state"] == "paired"
			and (v.find_child("NameEdit", true, false) as LineEdit).text == "Studio PC"
		)
	)
	var name_edit := v.find_child("NameEdit", true, false) as LineEdit
	name_edit.text = "Desk"
	name_edit.text_changed.emit("Desk")
	var closed := [false]
	v.closed.connect(func() -> void: closed[0] = true)
	_button(v, "common.done").pressed.emit()
	await _settle()
	t.check(
		"paired: Done saves the new name here and leaves",
		f.renamed == [["L9", "Desk"]] and closed[0]
	)
	_drop(v)
	await _settle()


# ── Paired devices ───────────────────────────────────────────────────────────────────────────


func _devices(f) -> PKeyPairedDevices:
	var v := PKeyPairedDevices.new()
	v.auto_sdk = false
	v.size = Vector2(900, 1400)
	v.now_source = Callable(f, "now")
	_tree().root.add_child(v)
	v.attach(f)
	await _settle()
	return v


func _list(t: PKeyTestContext) -> void:
	var f := Fake.new()
	f.links = [
		Fake.row("L1", "Device 1", f.now() - 86400.0 * 3),
		Fake.row("L2", "Device 2", null),
		Fake.row("L3", "\u2066Rtl\u2069", f.now(), false)
	]
	var v := await _devices(f)
	t.check(
		"list: the rows read once, the title and the lede",
		v.model["state"] == "list" and _texts(v).has("Paired devices") and f.listeners() == 1
	)
	t.check(
		"list: last seen is relative, and absent for a device never seen",
		(
			_texts(v).has("Last seen 3 days ago")
			and _texts(v).filter(func(s): return String(s).begins_with("Last seen")).size() == 2
		)
	)
	t.check(
		"list: one off brings the Can connect column and a switch per row",
		(
			_texts(v).has("Can connect")
			and v.find_children("Switch", "CheckButton", true, false).size() == 3
		)
	)
	t.check(
		"list: Pair with a Code is the one primary",
		(
			_button_by_text(v, "Pair with a Code") != null
			and v.model["decisions"]["primary"] == "pairedDevices.pair"
		)
	)
	var asked := [false]
	v.pair_requested.connect(func() -> void: asked[0] = true)
	_button_by_text(v, "Pair with a Code").pressed.emit()
	t.check("list: Pair with a Code is the host's to open", asked[0])
	f.links.append(Fake.row("L4", "Device 4"))
	f.notify()
	await _settle()
	t.check(
		"list: a change elsewhere shows without a refresh",
		v.find_children("Switch", "CheckButton", true, false).size() == 4
	)
	_drop(v)
	t.check("list: leaving the tree unsubscribes", f.listeners() == 0)
	await _settle()
	# The first read has not answered: nothing is said about what is paired.
	f = Fake.new()
	var w := PKeyPairedDevices.new()
	w.auto_sdk = false
	_tree().root.add_child(w)
	w.apply_snapshot({"step": "loading", "devices": []})
	await _settle()
	t.check(
		"list: loading says nothing of 'none yet'",
		w.model["state"] == "loading" and not _texts(w).has("No paired devices yet.")
	)
	w.apply_snapshot({"step": "list", "devices": []})
	await _settle()
	t.check(
		"list: an empty list says so, with Pair with a Code",
		_texts(w).has("No paired devices yet.") and _button_by_text(w, "Pair with a Code") != null
	)
	_drop(w)
	await _settle()


static func _button_by_text(v: Control, text: String) -> Button:
	for b in v.find_children("*", "Button", true, false):
		if (b as Button).text == text and (b as Button).is_visible_in_tree():
			return b
	return null


func _list_edits(t: PKeyTestContext) -> void:
	var f := Fake.new()
	f.links = [Fake.row("L1", "Device 1"), Fake.row("L2", "Device 2"), Fake.row("L3", "Device 3")]
	var v := await _devices(f)
	var row2: Dictionary = v._row_nodes["L2"]
	(row2["rename"] as Button).pressed.emit()
	await _settle()
	var field := v._row_nodes["L2"]["field"] as LineEdit
	t.check(
		"edit: Rename works in the row, the field starting with the name held, and takes focus",
		field.text == "Device 2" and v.get_viewport().gui_get_focus_owner() == field
	)
	field.text = ""
	field.text_changed.emit("")
	v._row_nodes["L2"]["save"].pressed.emit()
	await _settle()
	t.check(
		"edit: an empty name keeps the row open and says why",
		v.model["state"] == "renaming" and _texts(v).has("Enter a name.")
	)
	field = v._row_nodes["L2"]["field"]
	field.text = "Desk"
	field.text_changed.emit("Desk")
	field.text_submitted.emit("Desk")
	await _settle()
	t.check(
		"edit: Enter saves; the list shows the new name and focus returns to the row",
		(
			f.renamed.back() == ["L2", "Desk"]
			and v.model["state"] == "list"
			and _texts(v).has("\u2068Desk\u2069")
		)
	)
	await _settle()
	(v._row_nodes["L2"]["forget"] as Button).pressed.emit()
	await _settle()
	t.check(
		"edit: Forget asks inside the row, Cancel first",
		(
			v.model["state"] == "forgetting"
			and _texts(v).has("Forget \u2068Desk\u2069?")
			and v.get_viewport().gui_get_focus_owner() == v._row_nodes["L2"]["cancel"]
		)
	)
	t.check("edit: Escape cancels the question", v._cancel() and v.model["state"] == "list")
	await _settle()
	await _settle()
	t.check(
		"edit: and focus returns to that row's Forget, not to Pair with a Code",
		v.get_viewport().gui_get_focus_owner() == v._row_nodes["L2"]["forget"]
	)
	var chain: Array = v._focus_chain()
	var row1: Dictionary = v._row_nodes["L1"]
	t.check(
		"focus: a row reads Rename then Forget and the chain follows, row by row",
		(
			chain.find(row1["rename"]) < chain.find(row1["forget"])
			and chain.find(row1["forget"]) < chain.find(v._row_nodes["L2"]["rename"])
		)
	)
	t.check(
		"focus: up and down keep to the same control of the next row, left and right walk the row",
		(
			row1["rename"].get_node(row1["rename"].focus_neighbor_bottom) == v._row_nodes["L2"]["rename"]
			and row1["rename"].get_node(row1["rename"].focus_neighbor_right) == row1["forget"]
		)
	)
	(v._row_nodes["L2"]["rename"] as Button).pressed.emit()
	await _settle()
	v._cancel()
	await _settle()
	await _settle()
	t.check(
		"edit: Escape in a Rename returns focus to that row's Rename",
		v.get_viewport().gui_get_focus_owner() == v._row_nodes["L2"]["rename"]
	)
	(v._row_nodes["L2"]["forget"] as Button).pressed.emit()
	await _settle()
	(v._row_nodes["L2"]["forget"] as Button).pressed.emit()
	await _settle()
	await _settle()
	t.check(
		"edit: Forget removes it here and moves focus to the next row",
		(
			f.removed == ["L2"]
			and not v._row_nodes.has("L2")
			and v.get_viewport().gui_get_focus_owner() != null
			and v._row_nodes["L3"].values().has(v.get_viewport().gui_get_focus_owner())
		)
	)
	f.remove_result = Fake.fail("storage-failed")
	(v._row_nodes["L3"]["forget"] as Button).pressed.emit()
	await _settle()
	(v._row_nodes["L3"]["forget"] as Button).pressed.emit()
	await _settle()
	t.check(
		"edit: a store that cannot forget says so and keeps the question",
		_texts(v).any(func(s): return String(s).begins_with("Couldn’t forget"))
	)
	_drop(v)
	await _settle()
	# Eight on and more paired: the off switches wait with their reason on screen.
	f = Fake.new()
	for i in 9:
		f.links.append(Fake.row("D%d" % i, "D%d" % i, 1, i < 8))
	v = await _devices(f)
	var stuck := v._row_nodes["D8"]["switch"] as CheckButton
	var order: Array = v._focus_chain()
	t.check(
		"switches: a row reads its switch, then Rename, then Forget",
		(
			order.find(v._row_nodes["D0"]["switch"]) < order.find(v._row_nodes["D0"]["rename"])
			and order.find(v._row_nodes["D0"]["rename"]) < order.find(v._row_nodes["D0"]["forget"])
		)
	)
	t.check(
		"switches: eight on and a ninth paired: the reason is on screen and the off switch waits",
		_texts(v).has("Up to 8 can connect") and bool(stuck.get_meta(&"pkey_unavailable"))
	)
	stuck.button_pressed = true
	t.check(
		"switches: turning the ninth on goes back and asks the SDK nothing",
		not stuck.button_pressed and f.reachable_calls.is_empty()
	)
	(v._row_nodes["D0"]["switch"] as CheckButton).button_pressed = false
	await _settle()
	t.check(
		"switches: turning one off asks the SDK and makes room",
		f.reachable_calls == [["D0", false]] and not _texts(v).has("Up to 8 can connect")
	)
	_drop(v)
	await _settle()
