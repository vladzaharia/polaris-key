extends RefCounted
## The Godot equivalent of the modernity lint (UI-KITS.md §7.3, §1.5 rule 6): "no engine-default
## bitmap controls". Every icon the engine's default theme draws for a control type the kit uses
## must be set by the brand theme, so no stock arrow, check box tick, radio dot, spin-box chevron
## or tree arrow ever shows through. UK-11 (the Godot kit) calls this on its themes in its own
## acceptance; suite_ui_lint.gd proves the helper.
##
##   var missing := UiLint.unthemed_icons(theme)        # PackedStringArray of "Type/icon"
##   var missing := UiLint.unthemed_icons(theme, ["CheckButton", "OptionButton"])

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
