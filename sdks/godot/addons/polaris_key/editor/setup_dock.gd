@tool
extends VBoxContainer
## The Polaris Key setup dock: product slug, base URL, pinned trust keys (pasted from
## `pkey trust`), the editor channel. "Check" verifies the live trust manifest against the pasted
## pins (PKeySetupCheck.check) and lists each published kid with a key fingerprint; "Save" writes
## res://polaris_key.tres, outside addons/ so an addon update never overwrites it.
##
## Pins are compiled in, never learned: "Fill from discovery" only pre-fills candidates, and Save
## stays disabled until the confirmation box says the pins match `pkey trust` or the console.

const Check := preload("res://addons/polaris_key/editor/setup_check.gd")
const CONFIG_PATH := "res://polaris_key.tres"

var _product: LineEdit
var _base_url: LineEdit
var _pins: TextEdit
var _channel: LineEdit
var _confirm: CheckBox
var _check_button: Button
var _fill_button: Button
var _save_button: Button
var _status: RichTextLabel
var _candidates: Dictionary = {}
var _busy := false


func _ready() -> void:
	if get_child_count() > 0:
		return
	custom_minimum_size = Vector2(240, 0)
	_product = _field("Product slug", "diceroll")
	_base_url = _field("Base URL", "https://key.plrs.im")
	add_child(_label("Pinned trust keys (paste the output of `pkey trust`)"))
	_pins = TextEdit.new()
	_pins.custom_minimum_size = Vector2(0, 96)
	_pins.placeholder_text = "const PINNED_TRUST_KEYS := {\"kid\": \"base64url key\"}"
	_pins.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_pins.text_changed.connect(_on_pins_changed)
	add_child(_pins)
	_channel = _field("Editor channel (stamp-less runs)", "dev")
	var row := HBoxContainer.new()
	_check_button = _button("Check", _on_check)
	_fill_button = _button("Fill from discovery", _on_fill)
	_fill_button.disabled = true
	row.add_child(_check_button)
	row.add_child(_fill_button)
	add_child(row)
	_confirm = CheckBox.new()
	_confirm.text = "These pins match `pkey trust` or the console"
	_confirm.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_confirm.toggled.connect(func(_on): _update_buttons())
	add_child(_confirm)
	_save_button = _button("Save res://polaris_key.tres", _on_save)
	add_child(_save_button)
	_status = RichTextLabel.new()
	_status.fit_content = true
	_status.selection_enabled = true
	_status.custom_minimum_size = Vector2(0, 64)
	add_child(_status)
	_load()
	_update_buttons()


func _field(label: String, placeholder: String) -> LineEdit:
	add_child(_label(label))
	var e := LineEdit.new()
	e.placeholder_text = placeholder
	add_child(e)
	return e


static func _label(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return l


func _button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.pressed.connect(cb)
	return b


func _load() -> void:
	if not ResourceLoader.exists(CONFIG_PATH):
		_base_url.text = PKeyCore.DEFAULT_BASE
		return
	var opts = ResourceLoader.load(CONFIG_PATH, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (opts is PKeyOptions):
		_say("[color=orange]%s is not a PKeyOptions resource.[/color]" % CONFIG_PATH)
		return
	_product.text = opts.product
	_base_url.text = opts.base_url
	_channel.text = opts.default_channel
	if not opts.pinned_trust_keys.is_empty():
		_pins.text = JSON.stringify(opts.pinned_trust_keys, "  ", true)


func _on_pins_changed() -> void:
	# Any edit to the pins withdraws the confirmation.
	_confirm.button_pressed = false
	_update_buttons()


func _update_buttons() -> void:
	_check_button.disabled = _busy
	_fill_button.disabled = _busy or _candidates.is_empty()
	_save_button.disabled = _busy or not _confirm.button_pressed


func _say(bbcode: String) -> void:
	_status.clear()
	_status.append_text(bbcode)


func _on_check() -> void:
	var pins: Dictionary = {}
	var p := Check.parse_pins(_pins.text)
	if p["ok"]:
		pins = p["pins"]
	elif _pins.text.strip_edges() != "":
		_say("[color=red]%s[/color]" % p["message"])
		return
	_busy = true
	_update_buttons()
	_say("Checking…")
	var r: Dictionary = await Check.check(self, _base_url.text.strip_edges(), _product.text.strip_edges(), pins)
	_busy = false
	_candidates = r["candidates"]
	var lines := PackedStringArray()
	lines.append("[color=%s]%s[/color]" % ["green" if r["ok"] else "red", r["message"]])
	for k in r["keys"]:
		lines.append("%s [code]%s[/code] %s%s" % ["•", k["kid"], k["fingerprint"], " (pinned)" if k["pinned"] else ""])
	if not r["ok"] and not _candidates.is_empty():
		lines.append("Discovery lists %d candidate key%s. Fill them only if they match `pkey trust` or the console." % [_candidates.size(), "" if _candidates.size() == 1 else "s"])
	_say("\n".join(lines))
	_update_buttons()


func _on_fill() -> void:
	if _candidates.is_empty():
		return
	_pins.text = JSON.stringify(_candidates, "  ", true)
	_on_pins_changed()
	_say("Filled from discovery. Compare every key with `pkey trust` or the console, then confirm.")


func _on_save() -> void:
	var pins: Dictionary = {}
	if _pins.text.strip_edges() != "":
		var p := Check.parse_pins(_pins.text)
		if not p["ok"]:
			_say("[color=red]%s[/color]" % p["message"])
			return
		pins = p["pins"]
	var r := Check.save(CONFIG_PATH, _product.text.strip_edges(), _base_url.text.strip_edges(), pins, _channel.text.strip_edges(), _confirm.button_pressed)
	_say("[color=%s]%s[/color]" % ["green" if r["ok"] else "red", r["message"]])
	if r["ok"] and Engine.is_editor_hint():
		var fs = Engine.get_singleton("EditorInterface").get_resource_filesystem() if Engine.has_singleton("EditorInterface") else null
		if fs != null:
			fs.update_file(CONFIG_PATH)
