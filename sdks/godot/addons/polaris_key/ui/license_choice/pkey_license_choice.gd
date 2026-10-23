class_name PKeyLicenseChoice
extends PKeyUiView
## Choose a license for this device (UI-KITS.md §4.1 LicenseChoice; step 3 of the sign-in form,
## SIGN-IN.md §3.6; React's `licenseRows` and ui-core's `license_choice_view` are the reference):
## when a signed-in account holds several licenses, each is a row carrying its tier, its origin and
## term in plain words ("Added with a key · Lifetime"), a seat meter with its count ("1 of 3 devices"),
## and a tag when it is the one this device uses ("On this device") or has no free seat ("All devices
## in use"). One row is selected (a check on its end); **Use this license** is the one
## primary. A full license cannot be chosen: its action is **Replace a device**. Keep, create and a
## first license are rows of their own and never one outcome (Must not).
##
## States (the model's, ui-matrix.json `signIn` / LicenseChoice): loading, many, one, current, keep,
## new, create, all-full, mixed, replace-open, raced, grant-expired, none-keys and none-no-keys.
##
## `show_choices()` drives it with the session's LicenseChoiceView (see PKeyLicenseChoiceController);
## the host listens to `chosen`, `replace_requested`, `key_requested` and the other signals, and calls
## `show_raced()` when the seat it chose was taken meanwhile.

## The player chose: `{kind: license | keep | create | new, id}`.
signal chosen(selection: Dictionary)
## The selected row changed (a license id, `keep`, `create` or `new`).
signal selection_changed(id: String)
## The player chose Replace a device on a full license.
signal replace_requested(license_id: String)
## The player confirmed replacing `device` (a row of the replace view) so this license seats here.
signal replace_confirmed(license_id: String, device: Dictionary)
## The player chose "Use a license key instead".
signal key_requested()
## The player chose "Use another account" (the account holds no license for this product).
signal other_account_requested()
## The player chose "Sign in again" (the sign-in grant expired).
signal restart_requested()
## The player chose "Get {product}" (the purchase link opens when it is https).
signal purchase_requested()

## The device the license will be used on, for the lede ("Tidewater will use it on Work laptop.").
@export var device_name := ""
## The developer's name, for "From {developer}" and a first license's lede; "" says neither.
@export var developer := ""
## Lead with the product's header (off inside the gate, whose pane already shows it).
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			if _built:
				refresh_view()

## The session's LicenseChoiceView, or {} before it arrives.
var choices: Dictionary = {}
## The selected id; "" takes the view's preselected one, else the first that can be chosen.
var selected := ""
var loading := false
## The session's flags (`raced`, `grantExpired`, `event`, `replace`), see PKeyLicenseChoiceController.
var flags: Dictionary = {}
## The replace view while Replace a device is open in place: `{devices: [{label, leastRecent}]}`.
var replace_view: Dictionary = {}
## `{os, formFactor}` of the device, or {} (a browser tab says "in this browser").
var platform: Dictionary = {}
## What the build offers (`keyEntry`); a member left out is on.
var capabilities: Dictionary = {}
var model: Dictionary = {}

var _frame: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _notice: Label
var _group: Label
var _list_scroll: ScrollContainer
var _list_panel: PanelContainer
var _rows: VBoxContainer
var _actions: BoxContainer
var _primary: Button
var _secondary: Button
var _entries: Array = []
var _nodes: Array = []
var _selected_id := ""
var _signature := ""
var _check_on: Texture2D = null
var _check_off: Texture2D = null
var _check_side := 20
var _lede_shown := false
var _model_hid := false
var _group_shown := false
var _checks_key := ""
var _replace_target := ""
var _picked_replace := 0


func _build() -> void:
	name = "PKeyLicenseChoice"
	_frame = vbox(card_panel(), "Frame", "PKeySections")
	var head := vbox(_frame, "Head", "PKeyStack")
	_product = product_header(head, "Product")
	_product.card = true
	var titles := vbox(head, "Titles", "PKeyTight")
	_title = label(titles, "Title", "PKeyTitle")
	_lede = label(titles, "Lede", "PKeyMuted")
	loading_bar(_frame)
	_notice = label(_frame, "Notice", "PKeyMuted")
	_group = label(_frame, "Group", "PKeyMuted")
	_list_scroll = PKeyListScroll.make(_frame, "ListScroll")
	_list_panel = PanelContainer.new()
	_list_panel.name = "List"
	_list_panel.theme_type_variation = "PKeyRail"
	_list_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list_scroll.add_child(_list_panel)
	_rows = vbox(_list_panel, "Rows", "PKeySections")
	_actions = actions_row(_frame, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Continue", _on_primary, "PKeyPrimary")
	_secondary = button(_actions, "Secondary", _on_secondary, "PKeyLink")


func _process(_delta: float) -> void:
	_tick_loading()
	if loading and _loading_due() and not _frame.visible:
		refresh_view()


func _loading_due() -> bool:
	return _loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 250


## On a phone the page is the card, edge to edge (DL1: full-bleed, top-aligned).
func _bleeds() -> bool:
	return true


func _screen_key() -> String:
	return String(model.get("state", ""))


# ── Data ─────────────────────────────────────────────────────────────────────────────────────

## Show the session's LicenseChoiceView; `pick` selects a row (a license id, `keep`, `create`, `new`).
func show_choices(view: Dictionary, pick := "") -> void:
	choices = view
	loading = false
	flags = {}
	replace_view = {}
	if pick != "":
		selected = pick
	refresh_view()


func show_loading() -> void:
	loading = true
	refresh_view()


## Apply a ui-matrix.json `signIn` family input whole: its `choices`, `selected`, the session's
## flags, the `replaceView` and `loading` (the headless layer and the scenes read the same rows).
func show_input(inp: Dictionary) -> void:
	choices = inp["choices"] if inp.get("choices") is Dictionary else {}
	selected = String(inp["selected"]) if inp.get("selected") != null else ""
	flags = (inp["signIn"] as Dictionary).duplicate() if inp.get("signIn") is Dictionary else {}
	replace_view = inp["replaceView"] if inp.get("replaceView") is Dictionary else {}
	loading = bool(inp.get("loading", false))
	# A row that says how long the wait has been (DL7) starts its clock that far back.
	if loading and inp.get("elapsedMs") != null:
		_loading_since = Time.get_ticks_msec() - int(inp["elapsedMs"])
	refresh_view()


## The seat the player chose was taken meanwhile (`after_replace`: after freeing a device); choose again.
func show_raced(after_replace := false) -> void:
	flags = {"raced": true, "event": "confirm-replace" if after_replace else null}
	if not after_replace:
		flags.erase("event")
	replace_view = {}
	refresh_view()


## The sign-in grant expired while the player chose.
func show_grant_expired() -> void:
	flags = {"grantExpired": true}
	refresh_view()


## Open Replace a device in place for `license_id`, with the license's devices.
func open_replace(license_id: String, view: Dictionary) -> void:
	_replace_target = license_id
	replace_view = view
	flags = {"event": "open-replace", "replace": "inline"}
	refresh_view()


func _model_input() -> Dictionary:
	var extra := {}
	if loading:
		extra["loading"] = true
		if _loading_since > 0:
			extra["elapsedMs"] = Time.get_ticks_msec() - _loading_since
	if not replace_view.is_empty():
		extra["replaceView"] = replace_view
	if not platform.is_empty():
		extra["platform"] = platform
	if not capabilities.is_empty():
		extra["capabilities"] = capabilities
	return PKeyLicenseChoiceController.input(choices if not choices.is_empty() else null, selected, flags, extra)


## The selection a continue answers with.
func selection() -> Dictionary:
	for e in _entries:
		if e["id"] == _selected_id:
			return {"kind": e["kind"], "id": e["id"]}
	return {}


# ── Rendering ────────────────────────────────────────────────────────────────────────────────

func _product_name() -> String:
	return String(PKeyUiTheme.product_identity()["name"])


func _developer() -> String:
	if developer != "":
		return developer
	return PKeySettingsController.product_name(sdk) if sdk != null else ""


func _render() -> void:
	var t := c()
	set_loading(loading)
	model = PKeyLicenseChoiceController.view(_model_input())
	var state := String(model.get("state", "hidden"))
	var copy: Array = model.get("copy", [])
	# Hidden when its service is off; shown again when it is back. Whether a host (the gate) shows it
	# is the host's: the view never overrides a host that hid it.
	if state == "hidden":
		visible = false
		_model_hid = true
	elif _model_hid:
		visible = true
		_model_hid = false
	var waiting := state == "loading" and not _loading_due()
	_frame.visible = state != "hidden" and not waiting
	if show_product:
		_product.refresh()
	else:
		_product.visible = false
	_entries = PKeyLicenseChoiceController.entries(choices, state) if state in ["many", "one", "current", "keep", "new", "create", "all-full", "mixed", "raced"] else []
	_selected_id = PKeyLicenseChoiceController.selected_id(_entries, selected if selected != "" else choices.get("preselected"))
	var args: Dictionary = model.get("args", {})
	# The title.
	var title := t.text("choice_title")
	match state:
		"none-keys", "none-no-keys":
			title = t.text("choice_none_title")
		"replace-open":
			title = t.text("replace_title", PKeyUiTheme.isolate(String(args.get("device", ""))))
		"grant-expired":
			title = t.text("choice_too_long")
	show_text(_title, title if state != "hidden" else "")
	# The lede: where the license will be used; a first license says who gives it.
	var lede := ""
	var device := device_name if device_name != "" else ""
	match state:
		"many", "one", "current", "keep", "mixed", "create":
			if platform.get("os") == "web":
				lede = t.text("choice_lede_browser")
			elif device != "":
				lede = t.text("choice_lede", PKeyUiTheme.isolate(device))
		"new":
			var dev := _developer()
			if dev != "":
				lede = t.text("choice_lede_new", PKeyUiTheme.isolate(dev))
	show_text(_lede, lede)
	_lede_shown = _lede.visible
	# A message the state carries.
	var notice := ""
	if "signin.choice.allFullCreate" in copy:
		notice = t.text("choice_all_full_create")
	elif "signin.choice.allFull" in copy:
		notice = t.text("choice_all_full")
	elif "signin.choice.noneReplaceable" in copy:
		var dev2 := _developer()
		notice = t.text("choice_none_replaceable", [PKeyUiTheme.isolate(dev2), PKeyUiTheme.isolate(dev2)]) if dev2 != "" else ""
	elif "signin.choice.raced" in copy:
		notice = t.text("choice_raced")
	elif "signin.replace.raced" in copy:
		notice = t.text("choice_replace_raced")
	elif "signin.none.body" in copy:
		notice = t.text("choice_none_body")
	elif "signin.replace.consequence" in copy:
		notice = t.text("replace_consequence", [PKeyUiTheme.isolate(String(args.get("device", ""))), PKeyUiTheme.isolate(device if device != "" else "")]) if device != "" else ""
	show_text(_notice, notice)
	var group_on := "signin.choice.group" in copy
	show_text(_group, t.text("choice_group") if group_on else "")
	_group_shown = _group.visible
	var list_on := not _entries.is_empty() and state != "replace-open"
	_list_scroll.visible = list_on
	var sig := JSON.stringify([_entries, state, developer, device_name])
	if sig != _signature:
		_signature = sig
		_rebuild(t)
	_apply_selection()
	# The primary and the one link beside it.
	var primary_label := PKeyLicenseChoiceController.label_key(model["decisions"]["primary"]) if model.has("decisions") else ""
	var ready := true
	if state in ["many", "one", "current", "keep", "new", "create", "mixed", "raced"]:
		ready = _selected_id != ""
	show_text(_primary, t.text(primary_label) if primary_label != "" else "")
	if primary_label == "choice_none_get":
		_primary.text = t.text("choice_none_get")
	_primary.disabled = not ready
	var link_key := ""
	var get_license = choices.get("getLicense")
	var wants_key: bool = capabilities.get("keyEntry", true) != false and not (get_license is Dictionary and get_license.get("keyEntry") == false)
	if state in ["many", "one", "current", "keep", "new", "create", "mixed", "all-full"] and wants_key:
		link_key = "sign_in_use_key"
	elif state == "replace-open":
		link_key = "replace_back"
	elif state in ["none-keys"]:
		link_key = ""
	elif state == "none-no-keys" and model.get("decisions", {}).get("primary") == "signin.none.get":
		link_key = "choice_none_other"
	show_text(_secondary, t.text(link_key) if link_key != "" else "")
	_actions.visible = _primary.visible or _secondary.visible


func _rebuild(t: PKeyUiCopy) -> void:
	var held := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	var held_name := ""
	if held != null and _rows.is_ancestor_of(held):
		held_name = String(_rows.get_path_to(held))
	for ch in _rows.get_children():
		_rows.remove_child(ch)
		ch.queue_free()
	_nodes.clear()
	for i in _entries.size():
		_nodes.append(_make_entry(i, _entries[i], t))
	if held_name != "":
		var again := _rows.get_node_or_null(NodePath(held_name)) as Control
		if again != null:
			again.grab_focus.call_deferred()


func _make_entry(i: int, e: Dictionary, t: PKeyUiCopy) -> Dictionary:
	var holder := vbox(_rows, "Entry_%d" % i, "PKeyTight")
	var out := {"id": e["id"], "holder": holder}
	var pick := Button.new()
	pick.name = "Pick"
	pick.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	pick.theme_type_variation = &"PKeyLink"
	pick.alignment = 0 as HorizontalAlignment
	pick.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	pick.expand_icon = true
	# A radio of the list: pressed is the selected row (a screen reader says so).
	pick.toggle_mode = true
	holder.add_child(pick)
	pick.pressed.connect(_select.bind(String(e["id"])))
	out["pick"] = pick
	var detail := vbox(holder, "Detail", "PKeyTight")
	out["detail"] = detail
	var title := ""
	var meta := ""
	match e["kind"]:
		"keep":
			title = t.text("choice_keep")
			meta = t.text("choice_keep_meta")
		"create":
			title = t.text("choice_create")
			meta = t.text("choice_create_meta")
		"new":
			title = String(e.get("tier", ""))
			meta = t.text("choice_meta_new")
		_:
			var r: Dictionary = e["row"]
			title = String(r.get("tierName", ""))
			var seats = r.get("seats")
			if seats is Dictionary and seats.get("limit") != null:
				var used := int(seats.get("used", 0))
				var limit := int(seats["limit"])
				var seat_line := hbox(detail, "Seats")
				var meter := PKeySeatMeter.new()
				meter.name = "Meter"
				seat_line.add_child(meter)
				var caption := label(seat_line, "Caption", "PKeyMuted")
				caption.size_flags_horizontal = Control.SIZE_EXPAND_FILL
				caption.text = t.text("choice_devices_one" if limit == 1 else "choice_devices", [used, limit])
				name_for_reader(meter, t.text("seat_label_one" if limit == 1 else "seat_label", [used, limit]))
				out["meter"] = meter
				out["seat_line"] = seat_line
				out["used"] = used
				out["limit"] = limit
			var parts := PKeyLicenseChoiceController.meta_parts(r, _developer())
			var origin := t.text(parts[0], PKeyUiTheme.isolate(String(parts[1]))) if parts[0] != "" and parts[1] != null else (t.text(parts[0]) if parts[0] != "" else "")
			var term := t.text(parts[2], parts[3]) if parts[3] != null else t.text(parts[2])
			meta = t.text("choice_meta", [origin, term]) if origin != "" else term
	pick.text = title
	if e["kind"] in ["license", "new"]:
		# A tier's name is the developer's data.
		pick.set_meta(DATA_META, true)
	pick.disabled = not e["selectable"]
	name_for_reader(pick, title)
	if meta != "":
		var m := label(detail, "Meta", "PKeyMuted")
		m.text = meta
	var tags := HFlowContainer.new()
	tags.name = "Tags"
	tags.theme_type_variation = "PKeyRow"
	detail.add_child(tags)
	out["tags"] = tags
	if e["kind"] == "license":
		var r2: Dictionary = e["row"]
		if r2.get("current") == true:
			var tag := label(tags, "Current", "PKeyBadge")
			tag.text = t.text("choice_tag_current")
			tag.autowrap_mode = TextServer.AUTOWRAP_OFF
		if r2.get("state") != "free":
			var full := label(tags, "Full", "PKeyBadge")
			full.text = t.text("choice_tag_full")
			full.autowrap_mode = TextServer.AUTOWRAP_OFF
			var rep = r2.get("replace")
			if rep is Dictionary and rep.get("allowed") == true:
				var rb := button(detail, "Replace", _on_row_replace.bind(String(e["id"])), "PKeyLink")
				rb.text = t.text("replace_open")
				rb.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
				out["replace"] = rb
	elif e["kind"] == "new":
		var tag2 := label(tags, "New", "PKeyBadge")
		tag2.text = t.text("choice_tag_new")
		tag2.autowrap_mode = TextServer.AUTOWRAP_OFF
	tags.visible = tags.get_child_count() > 0
	return out


func _apply_selection() -> void:
	for n in _nodes:
		var on: bool = n["id"] == _selected_id and not (n["pick"] as Button).disabled
		# Only the selected row carries its check, at the start of its title (a blank of the same size
		# keeps the titles aligned).
		(n["pick"] as Button).icon = _check_on if on else _check_off
		(n["pick"] as Button).set_pressed_no_signal(on)


func _select(id: String) -> void:
	if id == _selected_id:
		# Pressing the selected row again keeps it selected.
		_apply_selection()
		return
	selected = id
	_selected_id = id
	selection_changed.emit(id)
	refresh_view()


# ── Arrange ──────────────────────────────────────────────────────────────────────────────────

func _arrange(m: Dictionary) -> void:
	super(m)
	_make_checks(m)
	for n in _nodes:
		(n["pick"] as Button).add_theme_constant_override("icon_max_width", _check_side)
		(n["pick"] as Button).icon = _check_on if n["id"] == _selected_id and not (n["pick"] as Button).disabled else _check_off
		if n.has("meter"):
			(n["meter"] as PKeySeatMeter).show_seats(int(n["used"]), int(n["limit"]), float(m["scale"]))
	PKeyListScroll.fit_buttons(self, _list_panel, _list_panel, _list_scroll)
	var changed := _fit_list()
	# The card's own scroll is decided on what the list now takes, and a view that grew meanwhile is
	# the screen's size again.
	fit_scrolls(available_height(), outer_view() == self and _stretches_vertically())
	_release_offsets()
	PKeyListScroll.resync(self)
	if changed:
		PKeyUiView._resort_all(self)


## The list takes the room the card leaves; on a screen too short for two of its rows the product's
## header collapses to one line (DL5: never removed), and the lede and the group's label go, before the
## list scrolls in what is left (DL3).
func _fit_list() -> bool:
	var least := role("control_height")
	_product.card = true
	_lede.visible = _lede_shown
	_group.visible = _group_shown
	_frame.theme_type_variation = &"PKeySections"
	var room := PKeyListScroll.wanted(self, _list_scroll, _list_panel, least)
	if room > 0.0 and room < 2.5 * least:
		_product.card = false
		_lede.visible = false
		_group.visible = false
		# Its parts a stack's gap apart rather than a card's sections.
		_frame.theme_type_variation = &"PKeyStack"
	return PKeyListScroll.apply(self, _list_scroll, _list_panel, least)


func _layout_stale() -> bool:
	return PKeyListScroll.stale(self, _list_scroll, _list_panel, role("control_height"))


## The check mark of the selected row and a blank of its size, for the screen's scale.
func _make_checks(m: Dictionary) -> void:
	_check_side = maxi(16, roundi(20.0 * float(m["scale"])))
	var k := float(m["scale"]) * float(m["physical"]) * 2.0
	var key := "%s|%s|%s" % [k, get_theme_color("font_color", "PKeyLink").to_html(), _check_off != null]
	if key == _checks_key:
		return
	_checks_key = key
	_check_on = PKeyUiTheme.glyph("check", get_theme_color("font_color", "PKeyLink"), 20.0, k)
	var blank := Image.create(maxi(2, int(_check_on.get_width()) if _check_on != null else 2), maxi(2, int(_check_on.get_height()) if _check_on != null else 2), false, Image.FORMAT_RGBA8)
	_check_off = ImageTexture.create_from_image(blank)


# ── Focus ────────────────────────────────────────────────────────────────────────────────────

func _focus_chain() -> Array:
	var out: Array = []
	for n in _nodes:
		out.append(n["pick"])
		if n.has("replace"):
			out.append(n["replace"])
	out.append_array([_primary, _secondary])
	return out


func _initial_focus() -> Control:
	if is_focusable(_primary):
		return _primary
	var chain := focus_order()
	return chain[0] if not chain.is_empty() else null


# ── Actions ──────────────────────────────────────────────────────────────────────────────────

func _on_row_replace(license_id: String) -> void:
	replace_requested.emit(license_id)


func _on_primary() -> void:
	var p = model.get("decisions", {}).get("primary")
	var key := "" if p == null else String(p)
	match key:
		"signin.choice.continue", "signin.choice.create":
			var s := selection()
			if key == "signin.choice.create":
				s = {"kind": "create", "id": "create"}
			if not s.is_empty():
				chosen.emit(s)
		"signin.again":
			restart_requested.emit()
		"signin.choice.keyInstead":
			key_requested.emit()
		"signin.none.get":
			var link = model.get("decisions", {}).get("link")
			purchase_requested.emit()
			if link is Dictionary and link.get("url") is String and String(link["url"]).begins_with("https://"):
				OS.shell_open(link["url"])
		"signin.none.otherAccount":
			other_account_requested.emit()
		"signin.replace.open":
			for e in _entries:
				if e["kind"] == "license" and e["row"].get("state") != "free" and e["row"].get("replace") is Dictionary and e["row"]["replace"].get("allowed") == true:
					replace_requested.emit(String(e["id"]))
					break
		"signin.replace.confirm":
			var devices = replace_view.get("devices")
			var device: Dictionary = {}
			if devices is Array and not devices.is_empty():
				var pick_i := clampi(_picked_replace, 0, devices.size() - 1)
				device = devices[pick_i]
			replace_confirmed.emit(_replace_target, device)


func _on_secondary() -> void:
	match String(model.get("state", "")):
		"replace-open":
			flags = {}
			replace_view = {}
			refresh_view()
		"none-no-keys":
			other_account_requested.emit()
		_:
			key_requested.emit()


func _cancel() -> bool:
	if String(model.get("state", "")) == "replace-open" and is_visible_in_tree():
		_on_secondary()
		return true
	return false
