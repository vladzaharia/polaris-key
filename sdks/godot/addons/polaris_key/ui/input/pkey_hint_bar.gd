class_name PKeyHintBar
extends HFlowContainer
## The input hint bar (UI-KITS.md §1.5 rule 5, §4.3 "Input"): one glyph and its bare verb per item
## for the device the player used last: "[A] Select   [B] Back". The glyph names the key, so the
## words are only the verb (catalog keys: `part.hint.select`, `common.back`, a screen's own dismiss
## label such as `update.later`), read through the catalog in the running locale. It follows a
## remapped `ui_accept` or `ui_cancel`, leaves out an item whose button has no glyph, and shows for
## a keyboard (or a mouse) or a pad, on a pad-only device before any input, never for touch.
##
## One place everywhere: a footer at the bottom right of the title-safe area, outside the panel
## (`PKeyUiView` places it). Where the footer would sit on the panel (a screen smaller than its
## card) or on a phone, it is the last row of the panel instead, and on a short screen with no room
## for either it is left out. It takes no focus.
##
##   bar.items = [{"action": PKeyInputGlyphs.CONFIRM, "key": {"keyboard": "core.gate.needs-activation.title", "pad": "part.hint.select"}},
##                {"action": PKeyInputGlyphs.BACK, "key": "common.back"}]

## The least logical screen height that has room for a bar as a panel's last row.
const MIN_SCREEN_HEIGHT := 480.0
## The hint's least size at 720p (UI-KITS §1.5 rule 5); it scales with the screen.
const LABEL_FLOOR := 17.0

## [{action: StringName, key: String or {kind: String}}], `key` a catalog key.
var items: Array = []:
	set(value):
		items = value
		_rebuild()
## The view whose copy, scale and pad-only state the bar follows (set by `PKeyUiView.hint_bar()`).
var view: PKeyUiView = null
## A screen that has no use for the bar now (no key field) turns it off.
var enabled := true:
	set(value):
		enabled = value
		_rebuild()
## Where the bar lives while it is a panel's row; the footer reparents it and back.
var home: Node = null
var _kind: StringName = &""
var _sig := ""
var _wanted := false


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	focus_mode = Control.FOCUS_NONE


func _ready() -> void:
	if home == null:
		home = get_parent()
	_rebuild()


func _input(event: InputEvent) -> void:
	var k: StringName = &""
	var pad_only := view != null and PKeyUiView.pad_only()
	if event is InputEventKey:
		# A pad-only device's on-screen keyboard is not a keyboard to hint for.
		k = &"" if pad_only else &"keyboard"
	elif event is InputEventJoypadButton or (event is InputEventJoypadMotion and absf((event as InputEventJoypadMotion).axis_value) > 0.5):
		k = &"pad"
	elif event is InputEventScreenTouch:
		k = &"touch"
	elif event is InputEventMouseButton:
		k = &"mouse"
	elif event is InputEventMouseMotion and not pad_only and not OS.has_feature("mobile") and (event as InputEventMouseMotion).relative.length() > 2.0:
		# Moving the mouse is the keyboard and mouse's hint, as on Steam's big picture.
		k = &"keyboard"
	if k != &"" and k != _kind and not (k == &"mouse" and _kind == &"keyboard"):
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
	return &"pad" if view != null and PKeyUiView.pad_only() else &""


## What the bar says now, for the device: [[action, catalog key], …] (empty: nothing to say).
func parts() -> Array:
	var k := kind()
	var out: Array = []
	if not enabled or not (k in [&"keyboard", &"pad", &"mouse"]):
		return out
	var dev := &"pad" if k == &"pad" else &"keyboard"
	for it in items:
		var act := StringName(it["action"])
		if not PKeyInputGlyphs.has_glyph(act, dev):
			continue
		var key = it["key"]
		if key is Dictionary:
			key = (key as Dictionary).get(String(dev), "")
		if String(key) != "":
			out.append([act, String(key)])
	return out


func _rebuild() -> void:
	if not is_inside_tree():
		return
	var k := kind()
	var dev := &"pad" if k == &"pad" else &"keyboard"
	var p := parts()
	var tight := int(view.role("tight_gap")) if view != null else 8
	var wide := int(view.role("section_gap")) if view != null else 24
	add_theme_constant_override("h_separation", wide)
	add_theme_constant_override("v_separation", tight)
	var scale := float(view.layout_metrics().get("scale", 1.0)) if view != null else 1.0
	var sig := "%s|%s|%s|%s|%s|%s" % [enabled, k, p, TranslationServer.get_locale(), PKeyInputGlyphs.pad_family(), scale]
	_wanted = not p.is_empty()
	if sig == _sig:
		return
	_sig = sig
	for ch in get_children():
		remove_child(ch)
		ch.queue_free()
	var size_px := int(roundf(LABEL_FLOOR * scale))
	for part in p:
		var row := HBoxContainer.new()
		row.mouse_filter = Control.MOUSE_FILTER_IGNORE
		row.add_theme_constant_override("separation", tight)
		var g := PKeyInputGlyphs.new()
		g.action = part[0]
		g.kind = dev
		g.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(g)
		var l := Label.new()
		l.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		l.add_theme_font_size_override("font_size", size_px)
		l.text = _words(part[1])
		l.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(l)
		add_child(row)
	# `PKeyUiView._place_hints()` owns where the bar is and whether it shows.
	if not _wanted:
		visible = false
	if view != null:
		view.queue_layout()


## The verb for catalog `key` in the running locale (the game's `PKeyUiCopy.overrides` win).
func _words(key: String) -> String:
	if view != null:
		var o = view.c().overrides.get(key)
		if o is String:
			return o
	return String(PKeyUiView.catalog().format(key))


## The size of the bar on one row: its items side by side (the flow container's own minimum is one
## item wide, which would wrap it).
func natural_size() -> Vector2:
	var w := 0.0
	var h := 0.0
	var n := 0
	for ch in get_children():
		var c := ch as Control
		if c == null or not c.visible:
			continue
		var ms := c.get_combined_minimum_size()
		w += ms.x
		h = maxf(h, ms.y)
		n += 1
	return Vector2(w + float(maxi(n - 1, 0) * get_theme_constant("h_separation")), h)


## Re-read the words and the pad (a locale or theme change).
func refresh() -> void:
	_sig = ""
	_rebuild()
