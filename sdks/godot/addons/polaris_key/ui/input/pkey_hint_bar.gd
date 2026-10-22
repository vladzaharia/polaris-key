class_name PKeyHintBar
extends HFlowContainer
## The input hint bar (UI-KITS.md §4.3 "Input"): one glyph and its verb per item, for the device the
## player used last: "[A] to select   [B] to go back". The glyph names the key, so the words are only
## the verb (catalog keys `part.hint.*`): never "A to select" beside an A glyph, and never the
## wrong button (a game that remaps `ui_accept` is followed). It shows for a keyboard or a pad, on a
## pad-only device before any input, and not for touch or a mouse; an item whose button has no
## glyph is left out, and the bar with it when none is left. It updates itself from input and
## takes no focus.
##
##   bar.items = [{"action": PKeyInputGlyphs.CONFIRM, "copy": {"keyboard": "hint_activate", "pad": "hint_select"}},
##                {"action": PKeyInputGlyphs.BACK, "copy": "hint_back"}]

## The least logical screen height that has room for a bar line (a 360 px canvas has none).
const MIN_SCREEN_HEIGHT := 480.0

## [{action: StringName, copy: String or {kind: String}}].
var items: Array = []:
	set(value):
		items = value
		_rebuild()
## The view whose copy and pad-only state the bar follows (set by `PKeyUiView.hint_bar()`).
var view: PKeyUiView = null
## A screen that has no use for the bar now (no key field) turns it off.
var enabled := true:
	set(value):
		enabled = value
		_rebuild()
var _kind: StringName = &""
var _sig := ""


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	focus_mode = Control.FOCUS_NONE


func _ready() -> void:
	_rebuild()


func _input(event: InputEvent) -> void:
	var k: StringName = &""
	if event is InputEventKey:
		k = &"keyboard"
	elif event is InputEventJoypadButton or (event is InputEventJoypadMotion and absf((event as InputEventJoypadMotion).axis_value) > 0.5):
		k = &"pad"
	elif event is InputEventScreenTouch:
		k = &"touch"
	elif event is InputEventMouseButton:
		k = &"mouse"
	if k != &"" and k != _kind:
		_kind = k
		_rebuild()


## Follow `k` (&"keyboard", &"pad", &"touch", &"mouse") as the last input, for a view that already
## tracks it (the bar also hears input itself).
func follow(k: StringName) -> void:
	if k != &"" and k != _kind:
		_kind = k
		_rebuild()


## The device the hint follows: the last input, else a pad-only device reads as a pad.
func kind() -> StringName:
	if _kind != &"":
		return _kind
	return &"pad" if view != null and view.pad_only() else &""


func _rebuild() -> void:
	if not is_inside_tree():
		return
	var k := kind()
	var parts: Array = []
	if enabled and k in [&"keyboard", &"pad"]:
		for it in items:
			var act := StringName(it["action"])
			if not PKeyInputGlyphs.has_glyph(act, k):
				continue
			var key = it["copy"]
			if key is Dictionary:
				key = (key as Dictionary).get(String(k), "")
			if String(key) == "":
				continue
			parts.append([act, String(key)])
	var copy: PKeyUiCopy = view.c() if view != null else PKeyUiCopy.shared()
	var tight := int(view.role("tight_gap")) if view != null else 8
	var wide := int(view.role("section_gap")) if view != null else 24
	add_theme_constant_override("h_separation", wide)
	add_theme_constant_override("v_separation", tight)
	var sig := "%s|%s|%s|%s|%s" % [enabled, k, parts, TranslationServer.get_locale(), PKeyInputGlyphs.pad_family()]
	if sig == _sig:
		return
	_sig = sig
	for ch in get_children():
		remove_child(ch)
		ch.queue_free()
	visible = not parts.is_empty()
	for p in parts:
		var row := HBoxContainer.new()
		row.mouse_filter = Control.MOUSE_FILTER_IGNORE
		row.add_theme_constant_override("separation", tight)
		var g := PKeyInputGlyphs.new()
		g.action = p[0]
		g.kind = k
		g.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(g)
		var l := Label.new()
		l.theme_type_variation = &"PKeyMuted"
		l.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		l.text = copy.text(p[1])
		l.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(l)
		add_child(row)


## Re-read the copy and the pad (a locale or theme change): the view calls it from its render.
func refresh() -> void:
	_sig = ""
	_rebuild()
