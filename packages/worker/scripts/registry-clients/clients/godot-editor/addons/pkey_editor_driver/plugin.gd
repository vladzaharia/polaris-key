@tool
extends EditorPlugin
## F-09's manual editor check, automated: drive the REAL editor (headless) through the install flow
## a person performs in the AssetLib tab, against the feed in editor settings
## (asset_library/available_urls on <= 4.6, asset_store/available_urls on 4.7+).
##
##   Go Online -> the editor lists the feed -> open the addon -> Download (the editor compares
##   download_hash on <= 4.6) -> the installer dialog -> Install -> the files on disk -> enable.
##
## Environment: PKEY_EXPECT_VERSION (plugin.cfg version after install), PKEY_ADDON (folder name),
## PKEY_TITLE (list title), PKEY_IGNORE_ROOT ("1" keeps the installer's default of stripping the
## archive's first folder; "0" unticks it; 4.7's installer has no such option and never strips). Prints STEP lines and ends with "RESULT ok" or
## "RESULT FAIL <why>", exiting 0 or 1.

var _done := false


func _findc(n: Node, cls: String, out: Array) -> void:
	if n.get_class() == cls:
		out.append(n)
	for c in n.get_children():
		_findc(c, cls, out)


func _buttons(n: Node, out: Array) -> void:
	if n is BaseButton and (n as BaseButton).is_visible_in_tree():
		out.append(n)
	for c in n.get_children():
		_buttons(c, out)


func _windows(n: Node, out: Array) -> void:
	if n is Window and (n as Window).visible and n != get_tree().root:
		out.append(n)
	for c in n.get_children():
		_windows(c, out)


func _enter_tree() -> void:
	# A script error in the driver would leave a headless editor running forever.
	get_tree().create_timer(90.0).timeout.connect(func(): _fail("driver timeout (90 s)"))
	_run.call_deferred()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _fail(why: String) -> void:
	if _done:
		return
	_done = true
	print("RESULT FAIL ", why)
	get_tree().quit(1)


func _run() -> void:
	var info := Engine.get_version_info()
	var store: bool = int(info.major) > 4 or (int(info.major) == 4 and int(info.minor) >= 7)
	var addon := OS.get_environment("PKEY_ADDON")
	var title := OS.get_environment("PKEY_TITLE")
	var expect := OS.get_environment("PKEY_EXPECT_VERSION")
	var ignore_root := OS.get_environment("PKEY_IGNORE_ROOT") != "0"
	print("STEP editor ", info.string, " shape=", "asset_store (4.7+)" if store else "asset_library (<=4.6)")
	var settings := EditorInterface.get_editor_settings()
	var key := "asset_store/available_urls" if store else "asset_library/available_urls"
	print("STEP setting ", key, " = ", settings.get_setting(key))

	EditorInterface.set_main_screen_editor("Asset Store" if store else "AssetLib")
	await _wait(1.0)
	var libs := []
	_findc(EditorInterface.get_base_control(), "EditorAssetLibrary", libs)
	if libs.is_empty():
		return _fail("no EditorAssetLibrary node")
	var lib: Node = libs[0]
	var bs := []
	_buttons(lib, bs)
	for b in bs:
		if "text" in b and b.text == "Go Online":
			print("STEP pressing Go Online")
			b.pressed.emit()

	# The listing: wait for the editor to render the feed's addon.
	var item: Node = null
	for i in 30:
		await _wait(0.5)
		var items := []
		_findc(lib, "EditorAssetLibraryItem", items)
		if items.size() > 0:
			item = items[0]
			break
	if item == null:
		return _fail("the editor listed no asset")
	var links := []
	_findc(item, "LinkButton", links)
	var labels := []
	_findc(item, "Label", labels)
	print("STEP listed links: ", links.map(func(l): return l.text), " labels: ", labels.map(func(l): return l.text))
	var open_link: BaseButton = null
	for l in links:
		if l.text == title:
			open_link = l  # <= 4.6: the title is a LinkButton
	if open_link == null:
		var has_label := false
		for l in labels:
			has_label = has_label or l.text == title
		if has_label and item.get_child(0) is BaseButton:
			open_link = item.get_child(0)  # 4.7+: the title is a Label; the whole card is a button
	if open_link == null:
		_dump(item, 0)
		return _fail("no listed asset titled '%s'" % title)
	print("STEP opening '", title, "' via ", open_link.get_class())
	open_link.pressed.emit()

	var pressed := {}
	var installed := false
	var stripped := false  # the installer stripped the archive's first folder (<= 4.6's default)
	for round in 60:
		await _wait(0.5)
		var ws := []
		_windows(get_tree().root, ws)
		for w in ws:
			if not (w is AcceptDialog):
				continue
			var ok: Button = (w as AcceptDialog).get_ok_button()
			var kind: String = w.get_class() + "|" + ok.text
			if ok.disabled or pressed.has(kind):
				continue
			if w.get_class() == "EditorAssetInstaller":
				var cbs := []
				_findc(w, "CheckBox", cbs)
				for cb in cbs:
					if cb.text == "Ignore asset root":
						cb.button_pressed = ignore_root
						stripped = ignore_root
						print("STEP installer: Ignore asset root = ", ignore_root)
				var trees := []
				_findc(w, "Tree", trees)
				print("STEP installer tree: ", _tree(trees[0].get_root()) if trees.size() > 0 else "(none)")
			if w.get_class() == "EditorAssetLibraryItemDescription":
				var obs := []
				_findc(w, "OptionButton", obs)
				for o in obs:
					var items := []
					for i in o.item_count:
						items.append(o.get_item_text(i))
					print("STEP description dropdown: ", items, " selected=", o.selected)
			if w.get_class() == "EditorAssetLibraryItemDescription" or w.get_class() == "EditorAssetInstaller":
				print("STEP pressing ", w.get_class(), " '", ok.text, "'")
				pressed[kind] = true
				ok.pressed.emit()
			elif w.title == "Success!":
				print("STEP success dialog")
				installed = true
				pressed[kind] = true
			elif w.title == "Error!" or w.title == "Download Error" or w.title.contains("rror"):
				return _fail("editor error dialog '%s': %s" % [w.title, (w as AcceptDialog).dialog_text])
		if installed:
			break
	if not installed:
		return _fail("no Success! dialog (pressed: %s)" % [pressed.keys()])

	# The files, the version, and the plugin enables like an installed addon.
	await _wait(1.5)
	var cfg_path := ("res://%s/plugin.cfg" if stripped else "res://addons/%s/plugin.cfg") % addon
	print("STEP expecting ", cfg_path)
	var cfg := ConfigFile.new()
	if cfg.load(cfg_path) != OK:
		return _fail("not installed at " + cfg_path)
	var got := str(cfg.get_value("plugin", "version", ""))
	print("STEP installed plugin.cfg version=", got)
	if expect != "" and got != expect:
		return _fail("version %s != %s" % [got, expect])
	if not stripped:
		EditorInterface.get_resource_filesystem().scan()
		await _wait(1.5)
		EditorInterface.set_plugin_enabled(addon, true)
		await _wait(1.0)
		print("STEP plugin enabled: ", EditorInterface.is_plugin_enabled(addon))
		if not EditorInterface.is_plugin_enabled(addon):
			return _fail("installed plugin did not enable")
	_done = true
	print("RESULT ok")
	get_tree().quit(0)


func _tree(it: TreeItem) -> String:
	if it == null:
		return ""
	var r := it.get_text(0)
	var c := it.get_first_child()
	while c:
		r += " (" + _tree(c) + ")"
		c = c.get_next()
	return r


func _dump(n: Node, d: int) -> void:
	var extra := ""
	if n is Label or n is BaseButton or n is RichTextLabel:
		extra = str(n.text)
	print("STEP   ", "  ".repeat(d), n.get_class(), " ", extra)
	for c in n.get_children():
		_dump(c, d + 1)
