class_name PKeyAccountTab
extends PKeyUiView
## The Account and license pane (UI-KITS.md §4.1 AccountAndLicense, §4.3 "Account and Settings";
## React's `accountRows` and ui-core's `account_view` are the reference), in inset grouped rows: the
## label on the left and its control or value on the right, 52 px tall (64 px with a second line):
##
##   (list)     {tier} license, with the license's status          Signed in as {name}  [Manage ↗]
##              or "Activated with a license key"                  Devices  ▮▮▯  2 of 3 in use
##   Updates    Update automatically (a switch) · Release channel · Check for updates · Version {version}
##   (list)     Managed settings
##   (list)     Sign out, in danger text, in a group of its own
##   (line)     Powered by Polaris Locker, where the game turned it on
##
## A floating license shows no holder: it is never attached to an account behind the person's back
## (Must not). On a TV or console the email is masked (`m•••@fennick.studio`) and revealed while its
## Manage button has the focus. Offline, it shows the last saved details under "Offline · showing the
## last saved details". Status is a word, never colour alone.
##
## It embeds into a game's own settings (`PKeySettingsPanel` adds it as its first section; a game's
## tabbed menu adds it like any Control) or opens as a whole page. `refresh_from_sdk()` reads the SDK;
## the properties drive it without one.

## The player chose Manage (the portal page for the account): `manage_url` opens when it is https.
signal manage_requested()
## The player chose Devices: the game opens a PKeyDeviceList.
signal devices_requested()
## The player chose Managed settings: the game opens its settings, on the managed group.
signal managed_settings_requested()
## The player chose Check for updates.
signal check_updates_requested()
## The player switched Update automatically.
signal auto_update_changed(on: bool)
## The player chose another release channel.
signal channel_changed(channel: String)
## The player chose Sign out (with an SDK it signs out first; `result` is its answer, null without).
signal signed_out(result: PKeyResult)

## The portal page Manage opens ("" opens nothing; the signal is still emitted).
@export var manage_url := ""
## Read the SDK when the pane enters the tree and when the licence state changes.
@export var auto_load := true
## Show the pane's own title and product (a whole page); a pane in a settings section lets the section name it.
@export var show_title := true

## What the pane shows (the SDK fills these; a game sets them to drive it without one).
var tier := ""
var holder := ""
var signed_in := false
var status := ""
var devices_used := -1
var devices_limit := -1
var auto_update := false
var channel := ""
var channel_options: Array = PKeyAccountController.CHANNELS
var channel_locked_by := ""
var version := ""
var cloud_sync := ""
var cloud_sync_time := ""
var services: Array = []
var loading := false
var checked_note := ""
## Mask the email (`m•••@fennick.studio`) and reveal it while Manage has the focus: on by itself on a
## TV or console (a pad-only screen), a game turns it on for any shared screen.
var mask_email := false
var model: Dictionary = {}

var _frame: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _notice: Label
var _list: VBoxContainer
var _powered_by: PKeyPoweredBy
var _groups := {}
var _controls := {}
var _checking := false
var _signing_out := false
var _signature := ""
var _bound := false


func _build() -> void:
	name = "PKeyAccountTab"
	_frame = vbox(card_panel(), "Frame", "PKeySections")
	var head := vbox(_frame, "Head", "PKeyStack")
	_product = product_header(head, "Product")
	_product.card = true
	_title = label(head, "Title", "PKeyTitle")
	_notice = label(_frame, "Notice", "PKeyMuted")
	loading_bar(_frame)
	_list = vbox(_frame, "Groups", "PKeySections")
	_powered_by = brand_node(_frame, "PoweredBy", BRAND_POWERED_BY)
	# The web layout's cap (UI-KITS.md §4.3).
	max_content_width = 640.0


func _ready() -> void:
	super()
	if sdk != null and auto_load and not _bound:
		_bound = true
		if sdk.has_signal("state_changed"):
			sdk.state_changed.connect(func(_s: Dictionary) -> void: refresh_from_sdk())
		_follow_cloud_sync()
		refresh_from_sdk()


## The Cloud Sync row follows `PolarisKey.cloud_sync` (shared with the status strip): "Sync is locked."
## and "Your sync key changed." beside the usual states.
func _follow_cloud_sync() -> void:
	var h := PKeyCloudSyncKitHost.of(sdk)
	if h == null:
		return
	h.changed.connect(func() -> void:
		cloud_sync = h.account_state()
		cloud_sync_time = h.sync_time
		refresh_view())
	h.start()


func _process(_delta: float) -> void:
	_tick_loading()
	if loading and _loading_since > 0 and not _frame.visible and Time.get_ticks_msec() - _loading_since >= 250:
		refresh_view()


## On a phone the page is the card, edge to edge (DL1: full-bleed, top-aligned).
func _bleeds() -> bool:
	return true


func _screen_key() -> String:
	return String(model.get("state", ""))


# ── Data ─────────────────────────────────────────────────────────────────────────────────────

## Read the SDK: the tier, who is signed in, the seats, the channel and version, the services. The
## seat count comes from the roster when it was loaded (`show_devices()`), else the license's limit.
func refresh_from_sdk() -> void:
	if sdk == null:
		return
	var f := PKeyAccountController.facts(sdk)
	tier = f["tier"]
	holder = f["holder"]
	signed_in = f["signed_in"]
	status = f["status"]
	if f["devices_limit"] != null:
		devices_limit = f["devices_limit"]
	channel = f["channel"]
	channel_locked_by = f["channel_locked"]
	version = f["version"]
	services = PKeyAccountController.services(sdk)
	loading = false
	refresh_view()


## The seats in use, from a roster the game has loaded (`used` of `limit`; -1 for either: not known).
func show_devices(used: int, limit := -1) -> void:
	devices_used = used
	if limit >= 0:
		devices_limit = limit
	refresh_view()


func show_loading() -> void:
	loading = true
	refresh_view()


func _model_input() -> Dictionary:
	var state := {
		"signed_in": signed_in,
		"status": status,
		"loading": loading,
		"services": services,
		"powered_by": PKeyUiTheme.powered_by,
	}
	if loading and _loading_since > 0:
		state["elapsed_ms"] = Time.get_ticks_msec() - _loading_since
	return PKeyAccountController.input(state)


func _on(slug: String) -> bool:
	return services.is_empty() or services.has(slug)


# ── Rendering ────────────────────────────────────────────────────────────────────────────────

func _render() -> void:
	var t := c()
	set_loading(loading)
	model = PKeyAccountController.view(_model_input())
	var state := String(model.get("state", "signed-in"))
	var copy: Array = model.get("copy", [])
	visible = state != "hidden"
	var waiting := state == "loading" and not (_loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 250)
	_frame.visible = visible and not waiting
	var nested := outer_view() != self
	if show_title and not nested:
		_product.refresh()
	else:
		_product.visible = false
	show_text(_title, t.text("account_title") if show_title and not nested else "")
	show_text(_notice, t.text("account_offline") if state == "offline" else "")
	_list.visible = state != "loading"
	fx_error("sync_error" if cloud_sync == "error" else "")
	var sig := JSON.stringify([
		state, tier, holder, signed_in, status, devices_used, devices_limit, auto_update, channel, channel_options,
		channel_locked_by, version, cloud_sync, cloud_sync_time, services, manage_url, _checking, checked_note,
		PKeyUiTheme.powered_by, mask_email, pad_only(),
	])
	if sig != _signature and state != "loading":
		_signature = sig
		_rebuild(t, state)
	_powered_by.visible = "part.poweredBy" in copy
	_refresh_values(t)


func _group(name_: String, heading: String = "") -> VBoxContainer:
	var holder_box := vbox(_list, name_, "PKeyTight")
	if heading != "":
		var h := label(holder_box, "Heading", "PKeyMuted")
		h.text = heading
	var panel := PanelContainer.new()
	panel.name = "List"
	panel.theme_type_variation = "PKeyRail"
	holder_box.add_child(panel)
	var rows := vbox(panel, "Rows", "PKeySections")
	return rows


## A row: the label column (a title and a second line) and the control column.
func _row(parent: Node, key: String, title: String, sub := "") -> Dictionary:
	var row := BoxContainer.new()
	row.name = "Row_" + key
	row.theme_type_variation = "PKeyActionRow"
	row.set_meta(&"pkey_two_line", sub != "")
	parent.add_child(row)
	var text := vbox(row, "Text", "PKeyTight")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	text.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var ttl := label(text, "Label", "PKeyStrong")
	ttl.text = title
	var sub_label := label(text, "Sub", "PKeyMuted")
	sub_label.text = sub
	sub_label.visible = sub != ""
	var control := hbox(row, "Control")
	control.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var out := {"row": row, "title": ttl, "sub": sub_label, "control": control}
	_controls[key] = out
	return out


## A row whose label is its action: a link-styled button at the start of the label column.
func _link_row(parent: Node, key: String, text: String, callback: Callable, sub := "") -> Dictionary:
	var r := _row(parent, key, text, sub)
	(r["title"] as Control).visible = false
	var b := Button.new()
	b.name = "Action"
	b.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	b.theme_type_variation = &"PKeyLink"
	b.text = text
	b.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	b.pressed.connect(callback)
	var column := (r["row"] as Control).get_child(0)
	column.add_child(b)
	column.move_child(b, 0)
	r["button"] = b
	return r


func _rebuild(t: PKeyUiCopy, state: String) -> void:
	var held := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	var held_key := ""
	for k in _controls:
		for part in ["manage", "devices", "switch", "channel", "check", "version", "managed", "sign_out"]:
			if _controls[k].has(part) and _controls[k][part] == held and held != null:
				held_key = "%s|%s" % [k, part]
	for ch in _list.get_children():
		_list.remove_child(ch)
		ch.queue_free()
	_controls.clear()
	_groups.clear()
	var license := _on("license")
	var first := _group("Group_License")
	var any := false
	if license and (tier != "" or status != "" or state == "offline"):
		var r := _row(first, "tier", t.text("account_tier", PKeyUiTheme.isolate(tier)) if tier != "" else t.text("account_title"))
		var key := PKeyAccountController.status_key("grace" if state == "offline" else status)
		r["sub"].text = t.text(key) if key != "" else ""
		r["sub"].visible = key != ""
		r["row"].set_meta(&"pkey_two_line", key != "")
		any = true
	if license:
		var who := holder
		var masked := false
		if signed_in and who.contains("@") and (mask_email or pad_only()):
			masked = true
		var r2 := _row(first, "holder", t.text("account_holder", PKeyUiTheme.isolate(who)) if signed_in and who != "" else t.text("account_key_only"))
		r2["masked"] = masked
		r2["full"] = who
		if signed_in:
			var mg := button(r2["control"], "Manage", _on_manage, "PKeyLink")
			mg.text = t.text("manage")
			r2["manage"] = mg
		any = true
	elif signed_in:
		var r3 := _row(first, "holder", t.text("account_holder", PKeyUiTheme.isolate(holder)))
		var mg2 := button(r3["control"], "Manage", _on_manage, "PKeyLink")
		mg2.text = t.text("manage")
		r3["manage"] = mg2
		any = true
	if license and (devices_limit > 0 or devices_used >= 0):
		var r4 := _link_row(first, "devices", t.text("account_devices"), func() -> void: devices_requested.emit())
		var dv: Button = r4["button"]
		var meter := PKeySeatMeter.new()
		meter.name = "Meter"
		r4["control"].add_child(meter)
		var caption := label(r4["control"], "Caption", "PKeyMuted")
		caption.autowrap_mode = TextServer.AUTOWRAP_OFF
		if devices_limit > 0:
			caption.text = t.text("seat_caption", [maxi(devices_used, 0), devices_limit]) if devices_used >= 0 else ""
			meter.set_meta(&"pkey_used", maxi(devices_used, 0))
			meter.set_meta(&"pkey_limit", devices_limit)
			name_for_reader(meter, t.text("seat_label_one" if devices_limit == 1 else "seat_label", [maxi(devices_used, 0), devices_limit]))
		else:
			caption.text = str(devices_used)
			caption.set_meta(DATA_META, true)
		r4["devices"] = dv
		r4["meter"] = meter
		any = true
	if _on("sync") and cloud_sync != "":
		var r5 := _row(first, "sync", t.text("account_cloud_sync"))
		var sk := {
			"synced": "sync_synced", "syncing": "sync_syncing", "offline": "sync_offline", "conflict": "sync_conflict",
			"error": "sync_error", "signedOut": "sync_signed_out", "locked": "sync_locked",
			"ring-changed": "sync_ring_changed",
		}.get(cloud_sync, "")
		if sk != "":
			var v := label(r5["control"], "Value", "PKeyMuted")
			v.text = t.text(sk, cloud_sync_time) if t.template(sk).contains("%s") else t.text(sk)
		any = true
	(first.get_parent().get_parent() as Control).visible = any
	_groups["license"] = first
	# Updates.
	if _on("update"):
		var upd := _group("Group_Updates", t.text("account_updates"))
		var auto := _row(upd, "auto", t.text("account_auto_update"))
		var sw := CheckButton.new()
		sw.name = "Switch"
		sw.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		sw.set_pressed_no_signal(auto_update)
		sw.toggled.connect(func(on: bool) -> void:
			auto_update = on
			auto_update_changed.emit(on))
		name_for_reader(sw, t.text("account_auto_update"))
		auto["control"].add_child(sw)
		auto["switch"] = sw
		var chan := _row(upd, "channel", t.text("account_channel"))
		if channel_locked_by != "":
			var lock := glyph_node(chan["control"], "Lock", "lock")
			chan["lock"] = lock
			var lv := label(chan["control"], "Value", "PKeyMuted")
			lv.text = channel.capitalize()
			lv.set_meta(DATA_META, true)
			lv.autowrap_mode = TextServer.AUTOWRAP_OFF
		else:
			var ob := OptionButton.new()
			ob.name = "Channel"
			ob.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			ob.set_meta(DATA_META, true)
			var opts: Array = channel_options.duplicate()
			if channel != "" and not opts.has(channel):
				opts.append(channel)
			for i in opts.size():
				ob.add_item(String(opts[i]).capitalize(), i)
				if opts[i] == channel:
					ob.select(i)
			ob.item_selected.connect(func(i: int) -> void:
				channel = String(opts[i])
				channel_changed.emit(channel)
				if sdk != null and sdk.get("update") != null:
					sdk.update.set_channel(channel))
			name_for_reader(ob, t.text("account_channel"))
			chan["control"].add_child(ob)
			chan["channel"] = ob
		var chk := _link_row(upd, "check", t.text("update_checking") if _checking else t.text("update_check_now"), _on_check, checked_note)
		(chk["button"] as Button).disabled = _checking
		chk["check"] = chk["button"]
		if version != "":
			var ver := _row(upd, "version", t.text("account_version", version))
			ver["title"].visible = true
	# Managed settings.
	if _on("config"):
		var mg3 := _group("Group_Managed")
		var mr := _link_row(mg3, "managed", t.text("account_managed"), func() -> void: managed_settings_requested.emit())
		mr["managed"] = mr["button"]
	# Sign out: a group of its own, in danger text.
	if _on("license") or _on("identity"):
		var so := _group("Group_SignOut")
		var sr := _link_row(so, "sign_out", t.text("account_sign_out"), _on_sign_out)
		(sr["button"] as Button).disabled = _signing_out
		sr["sign_out"] = sr["button"]
	if held_key != "":
		var parts := held_key.split("|")
		if _controls.has(parts[0]) and _controls[parts[0]].has(parts[1]):
			(_controls[parts[0]][parts[1]] as Control).grab_focus.call_deferred()


func _refresh_values(_t: PKeyUiCopy) -> void:
	# The email is masked on a shared screen and shown while its Manage button has the focus.
	for k in _controls:
		var r: Dictionary = _controls[k]
		if r.get("masked", false):
			var shown := PKeyAccountController.mask_email(String(r["full"]))
			if r.has("manage") and (r["manage"] as Control).has_focus():
				shown = String(r["full"])
			(r["title"] as Label).text = c().text("account_holder", PKeyUiTheme.isolate(shown))


# ── Arrange ──────────────────────────────────────────────────────────────────────────────────

func _arrange(m: Dictionary) -> void:
	super(m)
	# A button inside a padded group fits the room that padding leaves.
	var first_list := _list.find_child("List", true, false) as Control
	if first_list != null:
		PKeyListScroll.fit_buttons(self, _list, first_list)
	var narrow := bool(m.get("phone", false)) or content_room().x < role("card_width") * 0.9
	var one := roundf(52.0 * float(m["scale"]))
	var two := roundf(64.0 * float(m["scale"]))
	for k in _controls:
		var r: Dictionary = _controls[k]
		var row := r["row"] as BoxContainer
		row.vertical = narrow and (r.has("switch") == false)
		row.custom_minimum_size.y = two if bool(row.get_meta(&"pkey_two_line", false)) else one
		(r["control"] as Control).size_flags_horizontal = Control.SIZE_FILL if row.vertical else Control.SIZE_SHRINK_END
		if r.has("meter"):
			var meter := r["meter"] as PKeySeatMeter
			meter.show_seats(int(meter.get_meta(&"pkey_used", 0)), int(meter.get_meta(&"pkey_limit", 0)), float(m["scale"]))
		if r.has("manage"):
			(r["manage"] as Button).icon = PKeyUiTheme.glyph("external", get_theme_color("font_color", "PKeyLink"), 16.0, float(m["scale"]) * float(m["physical"]) * 2.0)
		if r.has("lock"):
			size_glyph(r["lock"], 16.0, get_theme_color("font_color", "PKeyMuted"))
		if r.has("sign_out"):
			var danger := get_theme_color("font_color", "PKeyError")
			for item in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
				(r["sign_out"] as Button).add_theme_color_override(item, danger)


# ── Focus ────────────────────────────────────────────────────────────────────────────────────

func _focus_chain() -> Array:
	var out: Array = []
	for k in _controls:
		for part in ["manage", "devices", "switch", "channel", "check", "managed", "sign_out"]:
			if _controls[k].has(part):
				out.append(_controls[k][part])
	return out


# ── Actions ──────────────────────────────────────────────────────────────────────────────────

func _on_manage() -> void:
	manage_requested.emit()
	if manage_url != "" and manage_url.begins_with("https://"):
		OS.shell_open(manage_url)


func _on_check() -> void:
	check_updates_requested.emit()
	if sdk == null or sdk.get("update") == null or _checking:
		return
	_checking = true
	checked_note = ""
	refresh_view()
	var again: PKeyUpdateCheck = await sdk.update.decide()
	_checking = false
	if not is_inside_tree():
		return
	# The note says what the check found: nothing newer reads "Up to date".
	if again.ok and (again.decision.get("action") in [null, "none"]):
		checked_note = c().text("progress_done")
	refresh_view()


func _on_sign_out() -> void:
	if sdk == null or sdk.get("identity") == null:
		signed_out.emit(null)
		return
	_signing_out = true
	refresh_view()
	var r: PKeyResult = await sdk.identity.sign_out()
	_signing_out = false
	if is_inside_tree():
		refresh_view()
	signed_out.emit(r)
