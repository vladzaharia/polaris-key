extends RefCounted
## The Godot equivalent of the modernity lint (UI-KITS.md §7.3, §1.5 rule 6): "no engine-default
## bitmap controls". Every icon the engine's default theme draws for a control type the kit uses
## must be set by the brand theme, so no stock arrow, check box tick, radio dot, spin-box chevron
## or tree arrow ever shows through. UK-11 (the Godot kit) calls this on its themes in its own
## acceptance; suite_ui_lint.gd proves the helper.
##
##   var missing := UiLint.unthemed_icons(theme)        # PackedStringArray of "Type/icon"
##   var missing := UiLint.unthemed_icons(theme, ["CheckButton", "OptionButton"])
##
## The design-language runtime checks (UK-55; the source half is packages/ui-qa/bin/kit-lint.mjs):
##   var tone := UiLint.refusal_tone(screen, patterns)  # DL6: a refusal is a neutral callout
##   var why := UiLint.initial_focus(screen)            # DL9: focus starts inside the screen
## `patterns` are the regex sources of the refusal copy (packages/ui-qa refusalPatterns(), or the
## corpus), matched against the visible text of every Label, RichTextLabel and Button.

## The engine controls a Polaris Key screen can contain (the kit's scenes are built from these).
const KIT_TYPES: PackedStringArray = [
	"Button", "CheckButton", "CheckBox", "OptionButton", "MenuButton", "PopupMenu", "LineEdit",
	"TextEdit", "SpinBox", "HSlider", "VSlider", "HScrollBar", "VScrollBar", "ScrollContainer",
	"TabBar", "TabContainer", "Tree", "ItemList", "ProgressBar", "ColorPickerButton", "Window",
]


## Every "Type/icon" the default theme defines for `types` that `theme` (or its own base types,
## followed through type variations) does not set.
static func unthemed_icons(theme: Theme, types: PackedStringArray = KIT_TYPES) -> PackedStringArray:
	var stock := ThemeDB.get_default_theme()
	var out := PackedStringArray()
	for type in types:
		# A kit type variation ("PKeySwitch" over CheckButton) draws its base type's icons.
		var base: StringName = type
		var guard := 0
		while stock.get_icon_list(base).is_empty() and theme.get_type_variation_base(base) != &"" and guard < 8:
			base = theme.get_type_variation_base(base)
			guard += 1
		for icon in stock.get_icon_list(base):
			if not _has_icon(theme, icon, type):
				out.append("%s/%s" % [type, icon])
	return out


static func _has_icon(theme: Theme, icon: StringName, type: StringName) -> bool:
	var t := type
	var guard := 0
	while t != &"" and guard < 8:
		if theme.has_icon(icon, t):
			return true
		t = theme.get_type_variation_base(t)
		guard += 1
	return false


## The theme variations the kit draws a danger-role text and an invalid field with.
const DANGER_TEXT := &"PKeyError"
const INVALID_FIELD := &"PKeyFieldError"


## DL6: every control whose visible text is a refusal (device limit, revoked, expired, version,
## channel) draws in the neutral role: no `PKeyError` text, and no `PKeyFieldError` field beside it
## (a refusal of a well-formed key is not invalid input). Also fails any `danger` colour (an Array of
## Color) as the text's font colour. Returns one line per finding.
static func refusal_tone(root: Node, patterns: PackedStringArray, danger: Array = []) -> PackedStringArray:
	var res: Array[RegEx] = []
	for p in patterns:
		var r := RegEx.create_from_string(p)
		if r != null and r.is_valid():
			res.append(r)
	var out := PackedStringArray()
	for n in _descendants(root):
		var text := _visible_text(n)
		if text == "" or not _is_refusal(res, text):
			continue
		var c := n as Control
		if c.theme_type_variation == DANGER_TEXT:
			out.append("%s is a refusal drawn as %s (a neutral callout, DL6): %s" % [c.name, DANGER_TEXT, text.left(40)])
		for color in danger:
			if c.get_theme_color("font_color", c.get_class()).is_equal_approx(color) or (
					c is RichTextLabel and c.get_theme_color("default_color").is_equal_approx(color)):
				out.append("%s draws a refusal in the danger colour (DL6): %s" % [c.name, text.left(40)])
				break
		var parent := n.get_parent()
		if parent != null:
			for sib in parent.get_children():
				if sib is Control and (sib as Control).theme_type_variation == INVALID_FIELD:
					out.append("%s sits beside the invalid field %s (DL6)" % [c.name, sib.name])
	return out


## DL9: once the screen is shown, the viewport's focus owner is the screen or inside it. "" when it
## is; otherwise the reason. The screen must be in the tree.
static func initial_focus(screen: Control) -> String:
	var focused := screen.get_viewport().gui_get_focus_owner()
	if focused == null:
		return "%s has no focus; _initial_focus() should grab it (DL9)" % screen.name
	if focused != screen and not screen.is_ancestor_of(focused):
		return "focus is on %s, outside %s (DL9)" % [focused.name, screen.name]
	return ""


static func _descendants(root: Node) -> Array:
	var out: Array = []
	var stack: Array = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n is Control and n != root:
			out.append(n)
		stack.append_array(n.get_children())
	return out


static func _visible_text(n: Node) -> String:
	if n is Label or n is Button:
		return String(n.get("text")).strip_edges()
	if n is RichTextLabel:
		return (n as RichTextLabel).get_parsed_text().strip_edges()
	return ""


static func _is_refusal(res: Array[RegEx], text: String) -> bool:
	for r in res:
		if r.search(text) != null:
			return true
	return false
