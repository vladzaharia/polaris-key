extends SceneTree
## Writes the UI kit's committed themes from `PKeyUiTheme.build()` (the Polaris Key design system's
## tokens, `PKeyBrand`, and the bundled Rubik): addons/polaris_key/ui/theme/pkey_theme.tres (dark,
## the default every scene file uses) and pkey_theme_light.tres. Editor only:
##
##   godot --headless --path sdks/godot --script tools/gen_theme.gd
##
## The .tres files are committed; regenerate them after changing PKeyUiTheme or the tokens. The
## `brand` suite fails when either drifts from `build()`. UIDs are left out of the files (the
## fonts are referenced by path), so every supported engine reads the same bytes.

const OUT := {
	PKeyUiTheme.DARK_PATH: true,
	PKeyUiTheme.LIGHT_PATH: false,
}


func _initialize() -> void:
	var ok := true
	for path in OUT:
		var t := PKeyUiTheme.build(OUT[path])
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
