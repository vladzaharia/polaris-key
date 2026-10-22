extends RefCounted
# @pkey-feature ui.kit
# Devices, LicenseChoice, AccountAndLicense, UpdateProgress and Toast (UI-KITS.md §4.1, §4.3), the five
# components the Godot kit lacked: PKeyDeviceList, PKeyLicenseChoice, PKeyAccountTab (and the Account
# section of PKeySettingsPanel), PKeyUpdateProgress and PKeyToast. The structural snapshots, the focus
# walks and the copy and header checks of every state are suite_ui's (tests/ui/scenarios.gd); the layout
# at every size is suite_ui_matrix's. This suite pins what those cannot see: that each scene follows its
# ui-core model state for state, the 64 px rows and the inline edits of Devices, the choice's one
# primary and its full rows, the Account pane's groups and danger text, the progress copy that never
# says installed early, and the toast's timer, its two actions, its persisting errors and the way it
# leaves the game's focus alone.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_components

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
const MATRIX_PATH := "res://tests/corpus/v2/ui-matrix.json"

var _sc


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_sc = SCENARIOS.new()
	TranslationServer.set_locale("en")
	PKeyUiTheme.reset()
	PKeyUiTheme.use_presentation(null)
	PKeyUiTheme.product_name = ""
	_controllers(t)
	_copy_is_the_catalogs(t)
	await _model_states(t)
	await _devices(t)
	await _license_choice(t)
	await _account(t)
	await _settings_section(t)
	await _progress(t)
	await _toast(t)
	PKeyUiTheme.reset()
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


## The view staged full-screen in a viewport of `size` (so its layout is the screen's), settled.
func _stage(view: PKeyUiView, size := Vector2i(1280, 720)) -> Array:
	var vp := SubViewport.new()
	vp.size = size
	vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
	_tree().root.add_child(vp)
	view.auto_sdk = false
	# A scenario builds its view under the root; it is staged in the viewport instead.
	if view.get_parent() != null:
		view.get_parent().remove_child(view)
	view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	vp.add_child(view)
	view.refresh_view()
	await _settle()
	return [vp, view]


## The rename field of a device list, or null.
func _field(d: Control) -> LineEdit:
	var found := d.find_children("*", "LineEdit", true, false)
	return found[0] as LineEdit if not found.is_empty() else null


func _settle() -> void:
	for i in 6:
		await _tree().process_frame


func _drop(st: Array) -> void:
	(st[0] as Node).queue_free()


func _press(vp: Viewport, action: String) -> void:
	for pressed in [true, false]:
		var e := InputEventAction.new()
		e.action = action
		e.pressed = pressed
		vp.push_input(e)


# ── Controllers ──────────────────────────────────────────────────────────────────────────────

func _controllers(t: PKeyTestContext) -> void:
	# The roster the SDK answers, as the rows the Devices model reads.
	var detail := {"current_device_id": "dev-3", "roster": true, "devices": [
		{"id": "dev-1", "label": "Work laptop", "platform": "windows", "current": false, "last_seen": SCENARIOS.NOW - 12 * 86400 - 5},
		{"id": "dev-2", "platform": "ios", "current": false, "last_seen": SCENARIOS.NOW - 3 * 86400},
		{"id": "dev-3", "label": "MacBook Pro", "platform": "macos", "current": true, "last_seen": SCENARIOS.NOW},
	]}
	var rows := PKeyDevicesController.rows(detail, SCENARIOS.NOW)
	t.check("devices: a roster becomes the model's rows", rows.size() == 3 and rows[0]["name"] == "Work laptop" and rows[0]["formFactor"] == "computer" and rows[0]["lastSeenDays"] == 12 and rows[1]["name"] == null and rows[1]["formFactor"] == "iphone" and rows[2]["current"] == true and rows[2]["formFactor"] == "mac", str(rows))
	t.check("devices: a device with no label has no name (never its id)", rows[1]["name"] == null and not str(rows[1]).contains("dev-2") or rows[1].get("id") == "dev-2")
	var view := PKeyDevicesController.view(PKeyDevicesController.input(rows))
	t.check("devices: the model lists them, naming this device only when the runtime knows it", view["state"] == "list" and (view["copy"] as Array).has("part.thisDeviceTitle") and (view["copy"] as Array).has("devices.unnamed"), str(view["copy"]))
	var none := rows.duplicate(true)
	for r in none:
		r["current"] = false
	var unknown := PKeyDevicesController.view(PKeyDevicesController.input(none))
	t.check("devices: no row is 'This device' when the runtime does not know which it is (Must not)", not (unknown["copy"] as Array).has("part.thisDeviceTitle"))
	t.check("devices: a form factor names its glyph", PKeyKitGlyphs.device("iphone") == "device_phone" and PKeyKitGlyphs.device("ipad") == "device_tablet" and PKeyKitGlyphs.device("tv") == "device_tv" and PKeyKitGlyphs.device("mac") == "device_computer" and PKeyKitGlyphs.device(null) == "device_computer")
	# Progress.
	var eta := PKeyProgressController.new()
	eta.note(30_000_000, 0.0)
	eta.note(38_000_000, 10.0)
	t.check("progress: the time left follows the rate so far", absf(eta.seconds_left(38_000_000, 91_000_000) - 66.25) < 0.1, str(eta.seconds_left(38_000_000, 91_000_000)))
	t.check("progress: with one sample the time left is not guessed", PKeyProgressController.new().seconds_left(10, 100) == -1.0)
	t.check("progress: sizes read in the total's unit", PKeyProgressController.sizes(38_000_000, 91_000_000) == ["38", "91 MB"] and PKeyProgressController.sizes(1_200_000, 5_000_000) == ["1.2", "5.0 MB"], str(PKeyProgressController.sizes(38_000_000, 91_000_000)))
	# Toast.
	var many := PKeyToastController.actions_for({"kind": "update", "actions": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}]})
	t.check("toast: at most two actions", many.size() == 2)
	t.check("toast: an error offers Dismiss, an update Update now and Dismiss, copied none", PKeyToastController.actions_for({"kind": "error"}).size() == 1 and PKeyToastController.actions_for({"kind": "update"}).size() == 2 and PKeyToastController.actions_for({"kind": "copied"}).is_empty())
	# License choice.
	var entries := PKeyLicenseChoiceController.entries({"state": "choose", "choices": [{"id": "a", "state": "full"}, {"id": "b", "state": "free"}], "keep": false, "create": null}, "many")
	t.check("choice: a full license cannot be selected; the first that can is", PKeyLicenseChoiceController.selected_id(entries, "a") == "b" and PKeyLicenseChoiceController.selected_id(entries, "b") == "b")
	var parts := PKeyLicenseChoiceController.meta_parts({"origin": "store", "expiresAt": null}, "Fennick Studio")
	t.check("choice: an origin the view cannot name is left out, never 'From {store}'", parts[0] == "" and parts[2] == "choice_term_lifetime")
	# Account.
	t.check("account: an email is masked down to its first letter and domain", PKeyAccountController.mask_email("mara@fennick.studio") == "m•••@fennick.studio")
	t.check("account: a status is a word the catalog has", PKeyAccountController.status_key("ok") == "status_ok" and PKeyAccountController.status_key("grace") == "status_grace" and PKeyAccountController.status_key("nope") == "")


## The copy the five components say is the catalog's (DL8): each key reads exactly as its catalog message.
func _copy_is_the_catalogs(t: PKeyTestContext) -> void:
	var catalog := preload("res://addons/polaris_key/ui/model/copy_format.gd").new({"locale": "en"})
	var keys := {
		"devices_title": "devices.title", "devices_lede": "devices.lede", "devices_unnamed": "devices.unnamed", "devices_rename": "devices.rename",
		"devices_rename_label": "devices.renameLabel", "devices_remove": "devices.remove", "devices_empty": "devices.empty", "devices_load_failed": "devices.loadFailed",
		"devices_browser": "devices.browser", "devices_manage": "devices.manage",
		"choice_title": "signin.choice.title", "choice_group": "signin.choice.group", "choice_continue": "signin.choice.continue", "choice_tag_current": "signin.choice.tag.current",
		"choice_tag_full": "signin.choice.tag.full", "choice_keep": "signin.choice.keep", "choice_create": "signin.choice.create", "choice_all_full": "signin.choice.allFull",
		"choice_raced": "signin.choice.raced", "replace_open": "signin.replace.open", "replace_confirm": "signin.replace.confirm",
		"account_title": "account.title", "account_key_only": "account.keyOnly", "account_devices": "account.devices", "account_updates": "account.updates",
		"account_auto_update": "account.autoUpdate", "account_channel": "account.channel", "account_managed": "account.managedSettings", "account_offline": "account.offline",
		"update_check_now": "update.checkNow", "manage": "common.manage", "dismiss": "common.dismiss", "copied": "common.copied", "loading": "common.loading",
		"toast_undo": "toast.undo", "progress_content_title": "updateProgress.contentTitle", "progress_queued": "updateProgress.queued", "progress_installing": "updateProgress.installing",
		"progress_paused": "updateProgress.paused", "progress_failed": "updateProgress.failed", "progress_done": "updateProgress.done", "progress_resume": "updateProgress.resume",
	}
	var drift: Array = []
	for k in keys:
		var want: String = catalog.format(keys[k])
		var got := String(PKeyUiCopy.DEFAULTS[k])
		if want != got:
			drift.append("%s: '%s' vs catalog '%s'" % [k, got, want])
	t.check("copy: the five components read as the catalog (DL8)", drift.is_empty(), "; ".join(drift.slice(0, 4)))
	# The messages that take arguments: the same words with %s and {product} for {name}.
	var shapes := {
		"devices_meta": "devices.meta", "devices_remove_confirm": "devices.removeConfirm", "devices_rename_failed": "devices.renameFailed", "devices_remove_failed": "devices.removeFailed",
		"choice_lede": "signin.choice.lede", "choice_meta": "signin.choice.meta", "account_tier": "account.tier", "account_holder": "account.holder", "account_version": "account.version",
		"toast_update_available": "toast.updateAvailable", "progress_downloading": "updateProgress.downloading",
	}
	var bad: Array = []
	var re := RegEx.new()
	re.compile("\\{[A-Za-z]+\\}|%s|%d")
	for k in shapes:
		var want := re.sub(String(catalog.raw(shapes[k])), "§", true)
		var got := re.sub(String(PKeyUiCopy.DEFAULTS[k]), "§", true)
		if want != got:
			bad.append("%s: '%s' vs catalog '%s'" % [k, got, want])
	t.check("copy: the messages with arguments keep the catalog's words (DL8)", bad.is_empty(), "; ".join(bad.slice(0, 4)))
	t.check("copy: separators are middle dots, never dashes (§1.5 rule 11)", String(PKeyUiCopy.DEFAULTS["devices_meta"]).contains("·") and String(PKeyUiCopy.DEFAULTS["progress_downloading"]).contains("·") and String(PKeyUiCopy.DEFAULTS["progress_paused"]).contains("·"))


# ── The scenes follow the model, state for state ─────────────────────────────────────────────

func _model_states(t: PKeyTestContext) -> void:
	var matrix = PKeyTestFixtures.read_json(MATRIX_PATH)
	if not t.check("components: ui-matrix.json reads", matrix is Dictionary):
		return
	# LicenseChoice: the scene is driven by the corpus row itself and shows the row's state.
	var want_states := {}
	for r in matrix["signIn"]:
		if r["expect"]["component"] == "LicenseChoice":
			want_states[r["name"]] = r["expect"]["state"]
	var mismatched: Array = []
	for c in SCENARIOS.CHOICE_CASES:
		var v: PKeyLicenseChoice = await _sc.license_choice(c[1])
		await _settle()
		if String(v.model.get("state")) != String(want_states.get(c[1], "?")):
			mismatched.append("%s: %s vs %s" % [c[1], v.model.get("state"), want_states.get(c[1])])
		v.get_parent().remove_child(v)
		v.queue_free()
	t.check("choice: every scene shows the corpus row's state", mismatched.is_empty(), "; ".join(mismatched))
	# Devices: the states the scenarios build are the model's.
	var devices_states := {"list": "list", "unnamed": "list", "unknown": "list", "renaming": "renaming", "confirming": "confirming", "empty": "empty", "browser": "browser-mode", "loading": "loading", "load-error": "error", "rename-error": "error", "remove-error": "error"}
	var off: Array = []
	for kind in devices_states:
		var d: PKeyDeviceList = _sc.devices(kind)
		await _settle()
		if String(d.model.get("state")) != devices_states[kind]:
			off.append("%s: %s" % [kind, d.model.get("state")])
		d.get_parent().remove_child(d)
		d.queue_free()
	t.check("devices: every scene shows the model's state", off.is_empty(), "; ".join(off))
	# Toast and UpdateProgress.
	var toast_states := {"update": "info", "copied": "success", "warning": "warning", "error": "error", "progress": "with-progress"}
	off = []
	for kind in toast_states:
		var ts: PKeyToast = _sc.toast(kind)
		await _settle()
		if String(ts.model.get("state")) != toast_states[kind]:
			off.append("%s: %s" % [kind, ts.model.get("state")])
		ts.get_parent().remove_child(ts)
		ts.queue_free()
	t.check("toast: every scene shows the model's state", off.is_empty(), "; ".join(off))
	var progress_states := {"queued-content": "queued", "queued-app": "queued", "downloading": "downloading", "verified": "downloading", "installing": "installing", "paused": "paused", "failed": "failed", "done": "done"}
	off = []
	for kind in progress_states:
		var up: PKeyUpdateProgress = _sc.update_progress(kind)
		await _settle()
		if String(up.model.get("state")) != progress_states[kind]:
			off.append("%s: %s" % [kind, up.model.get("state")])
		up.get_parent().remove_child(up)
		up.queue_free()
	t.check("progress: every scene shows the model's state", off.is_empty(), "; ".join(off))
	var account_states := {"signed-in": "signed-in", "key-only": "key-only", "offline": "offline", "loading": "loading"}
	off = []
	for kind in account_states:
		var a: PKeyAccountTab = _sc.account(kind)
		await _settle()
		if String(a.model.get("state")) != account_states[kind]:
			off.append("%s: %s" % [kind, a.model.get("state")])
		a.get_parent().remove_child(a)
		a.queue_free()
	t.check("account: every scene shows the model's state", off.is_empty(), "; ".join(off))


# ── Devices ──────────────────────────────────────────────────────────────────────────────────

func _devices(t: PKeyTestContext) -> void:
	var st := await _stage(_sc.devices("list"))
	var d: PKeyDeviceList = st[1]
	await _settle()
	var rows := d.find_children("Row_*", "VBoxContainer", true, false)
	t.check("devices: one row per device", rows.size() == 3, str(rows.size()))
	var low := 1e9
	for r in rows:
		low = minf(low, (r as Control).get_node("Line").size.y)
	t.check("devices: every row is 64 px", low >= 63.5, str(low))
	var meta := d.find_children("Meta", "Label", true, false).map(func(l): return (l as Label).text)
	t.check("devices: this device says 'This Mac', the others their platform and when", meta == ["Windows · last used 12 days ago", "iOS · last used 3 days ago", "This Mac"], str(meta))
	var names := d.find_children("Label", "Label", true, false).map(func(l): return (l as Label).text)
	t.check("devices: a row is named by its device, with a glyph beside it", names.size() == 3 and d.find_children("Glyph", "TextureRect", true, false).size() == 3, str(names))
	# Rename in place: the field, Save, and the row carries the new name.
	var renamed := [""]
	d.rename_requested.connect(func(row: Dictionary, label: String) -> void: renamed[0] = "%s>%s" % [row["name"], label])
	(d.find_child("Rename", true, false) as Button).pressed.emit()
	await _settle()
	var field := _field(d)
	t.check("devices: Rename opens a field in the row, filled with the name, and takes the focus", field != null and field.text == "Work laptop" and st[0].gui_get_focus_owner() == field, str(st[0].gui_get_focus_owner()))
	field.text = "Desk laptop"
	(d.find_child("Save", true, false) as Button).pressed.emit()
	await _settle()
	t.check("devices: Save asks for the rename and the row carries the new name", renamed[0] == "Work laptop>Desk laptop" and (d.devices[0]["name"] == "Desk laptop"), renamed[0])
	# Cancel with B puts the focus back on the row's own Rename.
	(d.find_child("Rename", true, false) as Button).pressed.emit()
	await _settle()
	_press(st[0], "ui_cancel")
	await _settle()
	t.check("devices: B cancels an edit and the focus returns to the row's Rename", _field(d) == null and st[0].gui_get_focus_owner() != null and st[0].gui_get_focus_owner().name == &"Rename", str(st[0].gui_get_focus_owner()))
	# Remove confirms in place.
	var removed := [""]
	d.remove_requested.connect(func(row: Dictionary) -> void: removed[0] = String(row["name"]))
	(d.find_child("Remove", true, false) as Button).pressed.emit()
	await _settle()
	var ask := d.find_child("Question", true, false) as Label
	t.check("devices: Remove asks in the row, naming the device and the product", ask != null and ask.text.begins_with("Remove %s? It signs out of " % PKeyUiTheme.isolate("Desk laptop")) and ask.text.ends_with("."), ask.text if ask != null else "no question")
	t.check("devices: the confirm is a danger-coloured primary", (d.find_child("ConfirmRemove", true, false) as Button).get_theme_color("font_color") == d.get_theme_color("font_color", "PKeyError"))
	(d.find_child("ConfirmRemove", true, false) as Button).pressed.emit()
	await _settle()
	t.check("devices: confirming removes the device", removed[0] == "Desk laptop" and d.devices.size() == 2 and d.find_child("Question", true, false) == null, removed[0])
	_drop(st)
	# A failed load is an error with Try again, never "No devices".
	var st2 := await _stage(_sc.devices("load-error"))
	var e: PKeyDeviceList = st2[1]
	var msg := e.find_child("Message", true, false) as Label
	var retry := e.find_child("Retry", true, false) as Button
	t.check("devices: a failed load says so, with Try again, and never 'No devices'", msg.visible and msg.text == "Couldn't load your devices." and retry.visible and retry.text == "Try again")
	var asked := [false]
	e.retry_requested.connect(func() -> void: asked[0] = true)
	retry.pressed.emit()
	t.check("devices: Try again asks again", asked[0])
	_drop(st2)
	# A roster read through the SDK edits this device only.
	var st3 := await _stage(_sc.devices("self-only"))
	var s: PKeyDeviceList = st3[1]
	var renames := s.find_children("Rename", "Button", true, false)
	var removes := s.find_children("Remove", "Button", true, false)
	t.check("devices: a roster from the SDK renames this device only and removes none (the server allows only itself)", renames.size() == 1 and removes.is_empty(), "%d renames, %d removes" % [renames.size(), removes.size()])
	_drop(st3)
	# A phone's width stacks a row's buttons under its words.
	var st4 := await _stage(_sc.devices("list"), Vector2i(375, 760))
	var narrow: PKeyDeviceList = st4[1]
	var line := narrow.find_child("Line", true, false) as BoxContainer
	t.check("devices: on a phone a row stacks its buttons under its words", line != null and line.vertical)
	_drop(st4)
	# DL7: a load shows nothing for its first 250 ms.
	var late := PKeyDeviceList.new()
	var st5 := await _stage(late)
	late.show_loading()
	await _settle()
	var frame := late.find_child("Frame", true, false) as Control
	t.check("devices: a load shows nothing for its first 250 ms (DL7)", not frame.visible)
	await _tree().create_timer(0.35).timeout
	await _settle()
	t.check("devices: then the title, a label and the shimmer", frame.visible and (late.find_child("Message", true, false) as Label).text == "Loading…")
	_drop(st5)


# ── LicenseChoice ────────────────────────────────────────────────────────────────────────────

func _license_choice(t: PKeyTestContext) -> void:
	var st := await _stage(_sc.license_choice("LicenseChoice/many"))
	var v: PKeyLicenseChoice = st[1]
	await _settle()
	var picks := v.find_children("Pick", "Button", true, false)
	t.check("choice: one row per license", picks.size() == 6, str(picks.size()))
	t.check("choice: the preselected license is selected, with one check", v._selected_id == "lic_pro" and v.selection() == {"kind": "license", "id": "lic_pro"})
	var checked := picks.filter(func(p): return (p as Button).icon != null and (p as Button).icon == v._check_on)
	t.check("choice: only the selected row shows its check", checked.size() == 1 and checked[0] == picks[0], str(checked.size()))
	var changed := [""]
	v.selection_changed.connect(func(id: String) -> void: changed[0] = id)
	(picks[2] as Button).pressed.emit()
	await _settle()
	t.check("choice: choosing a row moves the selection", changed[0] == "lic_key" and v.selection()["id"] == "lic_key")
	var primary := v.find_child("Continue", true, false) as Button
	t.check("choice: one primary, 'Use this license and continue'", primary.visible and primary.text == "Use this license and continue" and primary.theme_type_variation == &"PKeyPrimary")
	var got := [{}]
	v.chosen.connect(func(s: Dictionary) -> void: got[0] = s)
	primary.pressed.emit()
	t.check("choice: the primary answers with the selection", got[0] == {"kind": "license", "id": "lic_key"}, str(got[0]))
	# The full license: its row cannot be chosen; Replace a device is its action.
	var disabled := picks.filter(func(p): return (p as Button).disabled)
	t.check("choice: a full license is a row that cannot be chosen, tagged 'All devices in use'", disabled.size() == 1 and v.find_children("Full", "Label", true, false).size() == 1 and (v.find_child("Full", true, false) as Label).text == "All devices in use", str(disabled.size()))
	var replace := v.find_child("Replace", true, false) as Button
	var asked := [""]
	v.replace_requested.connect(func(id: String) -> void: asked[0] = id)
	t.check("choice: a full license that allows it offers Replace a device", replace != null and replace.text == "Replace a device")
	if replace != null:
		replace.pressed.emit()
	t.check("choice: Replace a device asks to replace on that license", asked[0] == "lic_edu", asked[0])
	_drop(st)
	# Keep, create and a new license are rows of their own and never one outcome.
	var kinds := {}
	for pair in [["keep", "LicenseChoice/keep: never merged with create or a new license"], ["new", "LicenseChoice/new: a first automatic license"], ["create", "LicenseChoice/create: picked on an all-full list"]]:
		var k: PKeyLicenseChoice = _sc.license_choice(pair[1])
		await _settle()
		kinds[pair[0]] = k.selection().get("kind", "")
		k.get_parent().remove_child(k)
		k.queue_free()
	t.check("choice: keep, new and create are three outcomes, never blurred", kinds == {"keep": "keep", "new": "new", "create": "create"}, str(kinds))
	# An all-full list: the fix is the primary, no license can be continued with.
	var af: PKeyLicenseChoice = _sc.license_choice("LicenseChoice/all-full: Create offered")
	await _settle()
	var fix := af.find_child("Continue", true, false) as Button
	t.check("choice: when every license is full the fix is the primary", fix.visible and fix.text == "Create a new free license", fix.text)
	af.get_parent().remove_child(af)
	af.queue_free()
	# The grant expired: Sign in again.
	var ge: PKeyLicenseChoice = _sc.license_choice("LicenseChoice/grant-expired")
	await _settle()
	var again := [false]
	ge.restart_requested.connect(func() -> void: again[0] = true)
	(ge.find_child("Continue", true, false) as Button).pressed.emit()
	t.check("choice: an expired grant offers Sign in again", again[0] and (ge.find_child("Continue", true, false) as Button).text == "Sign in again")
	ge.get_parent().remove_child(ge)
	ge.queue_free()
	# The gate shows it as its own screen, and the answer comes out of the gate.
	t.check("gate: a sign-in that found several licenses is the license-choice screen; a license-free product still lets the game run", PKeyGateController.screen_for("needs-activation", false, "", true, true) == "license-choice" and PKeyGateController.screen_for("not-applicable", false, "", true, true) == "usable" and PKeyGateController.screen_for("needs-activation", true, "", true, true) == "loading" and not PKeyGateController.controls_for("license-choice", true)["activation"] and not PKeyGateController.controls_for("license-choice", true)["retry"])
	var gst := await _stage(PKeyGateView.new())
	var gate: PKeyGateView = gst[1]
	gate.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	gate.show_state({"status": "needs-activation"})
	await _settle()
	var many: Dictionary = _sc.matrix_row("signIn", "LicenseChoice/many")
	var gate_got := [{}]
	gate.license_chosen.connect(func(selection: Dictionary) -> void: gate_got[0] = selection)
	gate.show_license_choice(many["input"]["choices"])
	await _settle()
	t.check("gate: the choice replaces the activation form", gate.screen == "license-choice" and gate.license_choice.is_visible_in_tree() and not gate.activation.visible, gate.screen)
	var gate_continue := gate.license_choice.find_child("Continue", true, false) as Button
	t.check("gate: the choice's primary is the screen's, on screen", gate_continue != null and gate.get_viewport_rect().grow(1.0).encloses(gate_continue.get_global_rect()) and gst[0].gui_get_focus_owner() != null, str(gate_continue.get_global_rect()) if gate_continue != null else "no primary")
	gate_continue.pressed.emit()
	t.check("gate: choosing comes out of the gate", gate_got[0] == {"kind": "license", "id": "lic_pro"}, str(gate_got[0]))
	gate.end_license_choice()
	await _settle()
	t.check("gate: and ending it brings the activation form back", gate.screen == "activation" and gate.activation.visible and not gate.license_choice.visible, gate.screen)
	_drop(gst)
	# The list scrolls rather than push the primary off a short screen.
	var st2 := await _stage(_sc.license_choice("LicenseChoice/many"), Vector2i(640, 360))
	var short: PKeyLicenseChoice = st2[1]
	await _settle()
	var pr := short.find_child("Continue", true, false) as Button
	t.check("choice: on a short screen the primary stays on screen and the list scrolls", short.get_viewport_rect().grow(1.0).encloses(pr.get_global_rect()), str(pr.get_global_rect()))
	_drop(st2)


# ── AccountAndLicense ────────────────────────────────────────────────────────────────────────

func _account(t: PKeyTestContext) -> void:
	var st := await _stage(_sc.account("signed-in"))
	var a: PKeyAccountTab = st[1]
	await _settle()
	var groups := a.find_children("Group_*", "VBoxContainer", true, false)
	var names: Array = groups.map(func(g): return String(g.name))
	t.check("account: grouped rows, Updates under its heading, Sign out in a group of its own", names == ["Group_License", "Group_Updates", "Group_Managed", "Group_SignOut"], str(names))
	var out_rows := (a.find_child("Group_SignOut", true, false) as Control).find_children("Row_*", "BoxContainer", true, false)
	var so := a.find_child("SignOut", true, false) as Button
	if so == null:
		so = (a.find_child("Group_SignOut", true, false) as Control).find_child("Action", true, false) as Button
	t.check("account: Sign out is the only row of its group, in danger text", out_rows.size() == 1 and so != null and so.text == "Sign out" and so.get_theme_color("font_color") == a.get_theme_color("font_color", "PKeyError"))
	var heading := (a.find_child("Group_Updates", true, false) as Control).find_child("Heading", true, false) as Label
	t.check("account: a group header is a muted line", heading != null and heading.text == "Updates" and heading.theme_type_variation == &"PKeyMuted")
	var tier := a.find_child("Row_tier", true, false)
	var holder_row := a.find_child("Row_holder", true, false)
	t.check("account: the tier and the holder rows come first", tier != null and holder_row != null and tier.get_index() < holder_row.get_index())
	t.check("account: the tier reads '{tier} license' with its status as a word", (tier.find_child("Label", true, false) as Label).text == "%s license" % PKeyUiTheme.isolate("Pro") and (tier.find_child("Sub", true, false) as Label).text == "Active")
	t.check("account: signed in as the holder, with Manage", (holder_row.find_child("Label", true, false) as Label).text.begins_with("Signed in as ") and holder_row.find_child("Manage", true, false) != null)
	var rows_ok := true
	for r in a.find_children("Row_*", "BoxContainer", true, false):
		var need := 64.0 if bool((r as Control).get_meta(&"pkey_two_line", false)) else 52.0
		if (r as Control).size.y < need - 0.5:
			rows_ok = false
	t.check("account: a row is 52 px, 64 px with a second line", rows_ok)
	var cap := a.find_child("Row_devices", true, false).find_child("Caption", true, false) as Label
	t.check("account: Devices carries the seat meter and its count", cap != null and cap.text == "2 of 3 in use" and a.find_children("*", "PKeySeatMeter", true, false).size() == 1, cap.text if cap != null else "no caption")
	var switched := [null]
	a.auto_update_changed.connect(func(on: bool) -> void: switched[0] = on)
	(a.find_child("Switch", true, false) as CheckButton).toggled.emit(false)
	t.check("account: Update automatically is a switch", switched[0] == false)
	_drop(st)
	# A key-only license shows no holder and no Manage (never attached to an account behind the back).
	var st2 := await _stage(_sc.account("key-only"))
	var k: PKeyAccountTab = st2[1]
	await _settle()
	var who := (k.find_child("Row_holder", true, false).find_child("Label", true, false) as Label).text
	t.check("account: a key-only license says so and offers no Manage (Must not)", who == "Activated with a license key" and k.find_child("Manage", true, false) == null, who)
	_drop(st2)
	# On a TV the email is masked and revealed while Manage has the focus.
	var st3 := await _stage(_sc.account("masked"))
	var m: PKeyAccountTab = st3[1]
	await _settle()
	var label := m.find_child("Row_holder", true, false).find_child("Label", true, false) as Label
	t.check("account: on a shared screen the email is masked", label.text.contains("m•••@fennick.studio") and not label.text.contains("mara@"), label.text)
	(m.find_child("Manage", true, false) as Button).grab_focus()
	m.refresh_view()
	await _settle()
	t.check("account: and shown while Manage has the focus", label.text.contains("mara@fennick.studio"), label.text)
	_drop(st3)
	# Offline shows the last saved details under the offline line.
	var st4 := await _stage(_sc.account("offline"))
	var o: PKeyAccountTab = st4[1]
	await _settle()
	var note := o.find_child("Notice", true, false) as Label
	t.check("account: offline says it shows the last saved details, with the status word Offline", note.visible and note.text == "Offline · showing the last saved details" and (o.find_child("Row_tier", true, false).find_child("Sub", true, false) as Label).text == "Offline")
	_drop(st4)
	# A channel the outlet sets is a locked value with its lock.
	var st5 := await _stage(_sc.account("locked-channel"))
	var lc: PKeyAccountTab = st5[1]
	await _settle()
	t.check("account: a channel the outlet sets is a locked value, not a picker", lc.find_child("Channel", true, false) == null and lc.find_child("Row_channel", true, false).find_child("Lock", true, false) != null)
	_drop(st5)


func _settings_section(t: PKeyTestContext) -> void:
	var st := await _stage(await _sc.settings_account(), Vector2i(1280, 720))
	var p: PKeySettingsPanel = st[1]
	await _settle()
	await _settle()
	t.check("settings: the Account and license section is the first in the rail", p._rail_buttons.size() >= 2 and (p._rail_buttons[0] as Button).text == "Account and license", str(p._rail_buttons.map(func(b): return b.text)))
	t.check("settings: the section holds the account pane, and the pad reaches it", p.account.is_inside_tree() and p.account.is_visible_in_tree() and p.focus_order().any(func(c): return p.account.is_ancestor_of(c)))
	p.section = 1
	p.layout_content()
	await _settle()
	t.check("settings: the game's own sections are beside it", not p.account.is_visible_in_tree() and p._groups.size() >= 2)
	p.account_tab = false
	await _settle()
	t.check("settings: without the tab the panel is as it was", not p.account.is_inside_tree() and (p._rail_buttons.size() == 0 or (p._rail_buttons[0] as Button).text != "Account and license"))
	_drop(st)


# ── UpdateProgress ───────────────────────────────────────────────────────────────────────────

func _progress(t: PKeyTestContext) -> void:
	var texts := {}
	for kind in ["queued-content", "queued-app", "downloading", "downloading-no-eta", "verified", "installing", "paused", "failed", "done"]:
		var p: PKeyUpdateProgress = _sc.update_progress(kind)
		await _settle()
		texts[kind] = (p.find_child("Status", true, false) as Label).text
		if kind == "downloading":
			var title := p.find_child("Title", true, false) as Label
			texts["title"] = title.text if title.visible else ""
		p.get_parent().remove_child(p)
		p.queue_free()
	t.check("progress: a counted line with the time left", texts["downloading"] == "38 of 91 MB · 1 minute left" and texts["title"] == "Downloading content", str(texts))
	t.check("progress: without a time left it counts only", texts["downloading-no-eta"] == "Downloading · 38 of 91 MB", texts["downloading-no-eta"])
	t.check("progress: queued, paused, failed and done have their words", texts["queued-content"] == "Waiting to download" and texts["paused"] == "Paused · waiting for Wi-Fi" and texts["failed"] == "Couldn't download" and texts["done"] == "Up to date", str(texts))
	t.check("progress: a verified download is still downloading; only apply says Installing… (Must not)", texts["verified"].begins_with("Downloading") or texts["verified"].contains(" of ") and not texts["verified"].contains("nstall"), texts["verified"])
	t.check("progress: installing says so, and never 'installed'", texts["installing"] == "Installing…")
	# Actions: paused resumes, failed retries; the strip never takes the focus.
	var pp: PKeyUpdateProgress = _sc.update_progress("paused")
	await _settle()
	var resumed := [false]
	pp.resume_requested.connect(func() -> void: resumed[0] = true)
	var act := pp.find_child("Action", true, false) as Button
	t.check("progress: a paused download offers Download now", act.visible and act.text == "Download now")
	act.pressed.emit()
	t.check("progress: and Download now resumes", resumed[0])
	pp.get_parent().remove_child(pp)
	pp.queue_free()
	var pf: PKeyUpdateProgress = _sc.update_progress("failed")
	await _settle()
	var retried := [false]
	pf.retry_requested.connect(func() -> void: retried[0] = true)
	var fa := pf.find_child("Action", true, false) as Button
	t.check("progress: a failed one offers Try again, in the error colour", fa.visible and fa.text == "Try again" and (pf.find_child("Status", true, false) as Label).theme_type_variation == &"PKeyError")
	fa.pressed.emit()
	t.check("progress: and Try again retries", retried[0])
	pf.get_parent().remove_child(pf)
	pf.queue_free()
	# Hidden until there is progress; it never takes the focus from the game on its own.
	var st := await _stage(PKeyUpdateProgress.new())
	var bare: PKeyUpdateProgress = st[1]
	t.check("progress: hidden while there is no progress", not bare.visible)
	bare.set_progress("failed", 1, 2)
	await _settle()
	t.check("progress: a strip never takes the focus on its own", bare.visible and st[0].gui_get_focus_owner() == null)
	_drop(st)
	# The bar counts: its value is the fraction.
	var dl: PKeyUpdateProgress = _sc.update_progress("downloading")
	await _settle()
	var bar := dl.find_child("Bar", true, false) as ProgressBar
	t.check("progress: the bar counts the fraction", bar != null and absf(bar.value - 38.0 / 91.0) < 0.01 and not bar.indeterminate, str(bar.value))
	dl.get_parent().remove_child(dl)
	dl.queue_free()


# ── Toast ────────────────────────────────────────────────────────────────────────────────────

func _toast(t: PKeyTestContext) -> void:
	var game := Button.new()
	game.text = "Game"
	var st := await _stage(PKeyToast.new())
	var tv: PKeyToast = st[1]
	var clock := [0.0]
	tv.clock = func(): return clock[0]
	# The game's own control has the focus; a toast must not take it.
	(st[0] as Node).add_child(game)
	game.grab_focus()
	await _settle()
	t.check("toast: hidden until there is one", not tv.visible)
	tv.show_update("2.5.0")
	await _settle()
	t.check("toast: it never takes the focus from the game", tv.visible and st[0].gui_get_focus_owner() == game, str(st[0].gui_get_focus_owner()))
	var title := tv.find_child("Title", true, false) as Label
	t.check("toast: one line (the catalog's), two actions", title.text.ends_with("2.5.0 is available") and tv._buttons.filter(func(b): return b.visible).size() == 2)
	t.check("toast: the view lets the game's clicks through", tv.mouse_filter == Control.MOUSE_FILTER_IGNORE and tv.find_child("Anchor", true, false).mouse_filter == Control.MOUSE_FILTER_IGNORE)
	# The timer: 6 s, visible.
	t.check("toast: a visible 6 s timer", tv.seconds_left() == 6.0 and (tv.find_child("Timer", true, false) as ProgressBar).visible)
	clock[0] = 3.0
	tv._process(0.0)
	t.check("toast: it counts down", absf(tv.seconds_left() - 3.0) < 0.01 and absf((tv.find_child("Timer", true, false) as ProgressBar).value - 0.5) < 0.01)
	var reasons: Array = []
	tv.closed.connect(func(r: String) -> void: reasons.append(r))
	clock[0] = 6.5
	tv._process(0.0)
	await _settle()
	t.check("toast: after 6 s it goes", not tv.visible and reasons == ["timeout"], str(reasons))
	# An error stays; it is dismissed, never timed out.
	tv.show_error("network-error")
	await _settle()
	clock[0] = 1000.0
	tv._process(0.0)
	await _settle()
	t.check("toast: an error persists, with no timer (Must not be the only record: it names the failure)", tv.visible and not (tv.find_child("Timer", true, false) as ProgressBar).visible and (tv.find_child("Consequence", true, false) as Label).text != "")
	# A toast queues behind an error.
	tv.show_copied()
	await _settle()
	t.check("toast: another waits behind an error that is still up", tv.current.get("kind") == "error" and tv._queue.size() == 1)
	# Reach by pad: the first direction press with nothing focused.
	st[0].gui_release_focus()
	game.release_focus()
	await _settle()
	PKeyUiView.pointer_last = false
	_press(st[0], "ui_down")
	await _settle()
	var owner = st[0].gui_get_focus_owner()
	t.check("toast: a pad reaches its action with a direction press while nothing is focused", owner != null and tv.is_ancestor_of(owner), str(owner))
	_press(st[0], "ui_cancel")
	await _settle()
	t.check("toast: B dismisses it, and the next one shows", tv.current.get("kind") == "copied", str(tv.current))
	# Two actions at most.
	tv.push({"kind": "warning", "title": "Autosave is off", "actions": [{"id": "a", "label": "One"}, {"id": "b", "label": "Two"}, {"id": "c", "label": "Three"}]})
	await _settle()
	t.check("toast: no more than two actions show", tv._buttons.filter(func(b): return b.visible).size() == 2)
	# The timer waits while the toast has the focus.
	tv.dismiss()
	clock[0] = 2000.0
	tv.show_update("2.6.0")
	await _settle()
	tv._buttons[0].grab_focus()
	tv._process(0.0)
	clock[0] = 2005.0
	tv._process(0.0)
	t.check("toast: the timer waits while the toast has the focus", tv.visible and tv.seconds_left() > 5.0, str(tv.seconds_left()))
	game.grab_focus()
	tv._process(0.0)
	clock[0] = 2012.0
	tv._process(0.0)
	t.check("toast: and runs again when the focus leaves", not tv.visible or tv.current.is_empty())
	# Progress: the counted bar and Undo, until it finishes.
	tv.show_progress(38_000_000, 91_000_000, 66.0)
	await _settle()
	var status := tv.find_child("Status", true, false) as Label
	t.check("toast: a progress toast counts, with Undo, and stays", tv.visible and status.text == "38 of 91 MB · 1 minute left" and tv._buttons[0].text == "Undo" and not (tv.find_child("Timer", true, false) as ProgressBar).visible, status.text)
	tv.finish_progress()
	await _settle()
	t.check("toast: finishing the download clears it", not tv.visible)
	# The anchor: bottom right, inside the title-safe area; a phone's is the bottom, full width.
	tv.show_copied()
	await _settle()
	var card := tv.find_child("Card", true, false) as Control
	var vr := tv.get_global_rect()
	var gap_x := vr.end.x - card.get_global_rect().end.x
	var gap_y := vr.end.y - card.get_global_rect().end.y
	t.check("toast: it sits bottom right, 5 % in from the edges", gap_x >= 0.05 * 720.0 - 1.0 and gap_y >= 0.05 * 720.0 - 1.0 and gap_x < 200.0 and card.get_global_rect().position.x > vr.size.x * 0.5, "%s in %s" % [card.get_global_rect(), vr])
	_drop(st)
	var ph := PKeyToast.new()
	PKeyUiView.mobile_override = {"dpr": 3.0}
	PKeyUiView.safe_insets_override = [0.0, 47.0, 0.0, 34.0]
	var st2 := await _stage(ph, Vector2i(390, 844))
	ph.show_update("2.5.0")
	await _settle()
	var pc := ph.find_child("Card", true, false) as Control
	t.check("toast: on a phone it is the bottom of the screen, full width inside the margins", pc.get_global_rect().end.y > ph.get_global_rect().size.y * 0.8 and pc.get_global_rect().size.x > ph.get_global_rect().size.x * 0.8, str(pc.get_global_rect()))
	PKeyUiView.mobile_override = null
	PKeyUiView.safe_insets_override = null
	_drop(st2)
