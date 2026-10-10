extends SceneTree
## Writes the UI kit's committed themes from PKeyUiTheme, in addons/polaris_key/ui/theme/:
## pkey_theme.tres (the neutral stock theme every scene file references, built over the engine's
## default theme by `neutral_default()`), rubik_500.tres and rubik_600.tres (the variable Rubik at
## the button and heading weights), and pkey_brand_dark.tres / pkey_brand_light.tres (the
## opt-in Polaris Key theme from `build()`: PKeyBrand tokens and the bundled Rubik). Editor only:
##
##   godot --headless --path sdks/godot --script tools/gen_theme.gd
##
## The .tres files are committed; regenerate them after changing PKeyUiTheme or the tokens. The
## `brand` suite fails when any of them drifts. UIDs are left out of the files (the
## fonts are referenced by path), so every supported engine reads the same bytes.



func _initialize() -> void:
	var ok := true
	# The weights the brand theme draws headings (600) and buttons (500) at, first: the themes
	# reference them by path.
	for w in [500, 600]:
		var path := PKeyUiTheme.weight_path(w)
		var werr := ResourceSaver.save(PKeyUiTheme.weight_variation(w), path)
		if werr == OK:
			werr = _strip_uids(path)
		print("gen_theme: wrote %s (%s)" % [path, error_string(werr)])
		ok = ok and werr == OK
	var out := {
		PKeyUiTheme.NEUTRAL_PATH: PKeyUiTheme.neutral_default(),
		PKeyUiTheme.DARK_PATH: PKeyUiTheme.build(true),
		PKeyUiTheme.LIGHT_PATH: PKeyUiTheme.build(false),
	}
	for path in out:
		var t: Theme = out[path]
		var err := ResourceSaver.save(t, path)
		if err == OK:
			err = _strip_uids(path)
		print("gen_theme: wrote %s (%s)" % [path, error_string(err)])
		ok = ok and err == OK
	quit(0 if ok else 1)


## Remove the `uid="uid://…"` attributes the saver writes, keeping path references only.
static func _strip_uids(path: String) -> Error:
	var text := FileAccess.get_file_as_string(path)
	var re := RegEx.create_from_string(" uid=\"uid://[a-z0-9]+\"")
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	f.store_string(re.sub(text, "", true))
	return OK
