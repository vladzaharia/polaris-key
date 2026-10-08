class_name PKeyDevMenuSection
extends PKeyUiView
## A section for the game's own developer menu: a channel picker (locked, with the reason, when
## the build's outlet owns the channel), build info, COPY DIAGNOSTICS, and Force check.
##
## Two ways in, so either menu shape works (report §5.8 says Diceroll registers sections with
## `DevMenu.register_section`, notes/A4 §4.1 says `DevMenu.register_row`; D-02 confirms which):
##
##   DevMenu.register_section("Polaris Key", PKeyDevMenuSection.new())   # a Control
##   for row in PKeyDevMenuSection.new().rows(): DevMenu.register_row(row) # data
##
## Each row is {id, label, value, action?, options?, locked?}: `action` is a Callable for a
## button row, `options` the choices for the channel row. The diagnostics never hold a token, a
## key or a secret (PKeyDevMenuController).

## The player picked another channel. The SDK persists it (PolarisKey.update.set_channel(): the
## next update check uses it, and staged code from the old channel is dropped at once, notes/A4
## P11); the licence gate keeps this build's channel.
signal channel_selected(channel: String)
## COPY DIAGNOSTICS put this text on the clipboard.
signal diagnostics_copied(text: String)
## Force check finished: the sync and the update check it ran.
signal checked(sync: PKeySyncResult, update: PKeyResult)

## Facts to show when there is no SDK (snapshots); null reads the SDK.
var facts_override: Variant = null
var entitled_override: Variant = null
var status_line := ""
var busy := false

var _title: Label
var _channel_label: Label
var _channel: OptionButton
var _lock: Label
var _facts: GridContainer
var _copy: Button
var _check: Button
var _status: Label
var _channels: Array = []


func _build() -> void:
	name = "PKeyDevMenuSection"
	max_content_width = 600.0
	var box := vbox(card_panel(), "Body", "PKeySections")
	_title = label(box, "Title", "PKeySection")
	var channel := vbox(box, "ChannelField", "PKeyTight")
	var ch := hbox(channel, "ChannelRow")
	_channel_label = label(ch, "ChannelLabel")
	_channel_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_channel_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_channel = OptionButton.new()
	_channel.name = "Channel"
	_channel.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_channel.set_meta(DATA_META, true)
	_channel.item_selected.connect(func(i: int): select_channel(_channels[i]))
	ch.add_child(_channel)
	_lock = label(channel, "ChannelLock", "PKeyMuted")
	_facts = GridContainer.new()
	_facts.name = "Facts"
	_facts.theme_type_variation = "PKeyGrid"
	_facts.columns = 2
	box.add_child(_facts)
	var actions := actions_row(box, "Actions", FlowContainer.ALIGNMENT_BEGIN)
	_copy = button(actions, "CopyDiagnostics", copy_diagnostics)
	_check = button(actions, "ForceCheck", force_check)
	_status = label(actions.get_parent(), "Status", "PKeyMuted")


func facts() -> Dictionary:
	if facts_override is Dictionary:
		return facts_override
	return PKeyDevMenuController.facts(sdk)


func _entitled() -> Array:
	if entitled_override is Array:
		return entitled_override
	if sdk != null and sdk.get("license") != null:
		return sdk.license.entitled_channels()
	return []


## The section as data rows (see the class doc).
func rows() -> Array:
	var t := c()
	var f := facts()
	var lock_kind: String = f.get("outlet_kind", f["outlet"])
	var lock := PKeyDevMenuController.channel_lock(lock_kind, f["platform"], f.get("outlet_subkind"), f.get("server_caps"))
	if lock != "" and f["outlet"] != "":
		lock = f["outlet"]
	return [
		{"id": "channel", "label": t.text("dev_channel"), "value": f["channel"], "options": PKeyDevMenuController.channels(f["channel"], _entitled()), "locked": t.text("dev_channel_locked", lock) if lock != "" else "", "action": select_channel},
		{"id": "build", "label": t.text("dev_build"), "value": "%s (%s)" % [f["version"], f["build"]]},
		{"id": "outlet", "label": t.text("dev_outlet"), "value": f["outlet"] if f["outlet"] != "" else "-"},
		{"id": "sdk", "label": t.text("dev_sdk"), "value": f["sdk"]},
		{"id": "engine", "label": t.text("dev_engine"), "value": f["engine"]},
		{"id": "device", "label": t.text("dev_device"), "value": f["device"]},
		{"id": "gate", "label": t.text("dev_gate"), "value": f["gate"]},
		{"id": "last_sync", "label": t.text("dev_last_sync"), "value": Time.get_datetime_string_from_unix_time(int(f["last_sync"]), true) if PKeyClaims.is_number(f["last_sync"]) else t.text("dev_never")},
		{"id": "copy_diagnostics", "label": t.text("dev_copy"), "action": copy_diagnostics},
		{"id": "force_check", "label": t.text("dev_force_check"), "action": force_check},
	]


func _render() -> void:
	var t := c()
	var r := rows()
	_title.text = t.text("dev_title")
	_channel_label.text = r[0]["label"]
	_channels = r[0]["options"]
	_channel.clear()
	for i in _channels.size():
		_channel.add_item(_channels[i], i)
	_channel.select(_channels.find(r[0]["value"]))
	_channel.disabled = r[0]["locked"] != "" or busy
	show_text(_lock, r[0]["locked"])
	var fact_rows := r.filter(func(x): return x.has("value") and x["id"] != "channel")
	var cells := _facts.get_children()
	while cells.size() < fact_rows.size() * 2:
		var idx := cells.size()
		var l := label(_facts, "Fact%d%s" % [idx / 2, "Name" if idx % 2 == 0 else "Value"], "PKeyMuted" if idx % 2 == 0 else "", idx % 2 == 1)
		if idx % 2 == 0:
			l.autowrap_mode = TextServer.AUTOWRAP_OFF
		else:
			# A value (a 32-character device id) wraps inside its column on a narrow screen.
			l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cells.append(l)
	for i in fact_rows.size():
		(cells[i * 2] as Label).text = fact_rows[i]["label"]
		(cells[i * 2 + 1] as Label).text = str(fact_rows[i]["value"])
	_copy.text = r[8]["label"]
	_check.text = t.text("dev_checking") if busy else r[9]["label"]
	_check.disabled = busy
	show_text(_status, status_line)


func _focus_chain() -> Array:
	return [_channel, _copy, _check]


## Switch to `channel` (the picker, or the `channel` row's action): staged code from another
## channel is dropped, then channel_selected tells the game to persist the choice. Refused while
## the channel is locked.
func select_channel(channel: String) -> void:
	var r := rows()
	if r[0]["locked"] != "" or channel == r[0]["value"]:
		return
	if sdk != null and sdk.get("update") != null and sdk.update.has_method("set_channel"):
		var res: PKeyResult = sdk.update.set_channel(channel)
		if not res.ok:
			status_line = c().for_result(res)
			refresh_view()
			return
	elif sdk != null and sdk.get("update") != null and sdk.update.has_method("drop_staged"):
		sdk.update.drop_staged()
	channel_selected.emit(channel)
	refresh_view()


## Put the diagnostics on the clipboard; returns the text.
func copy_diagnostics() -> String:
	var text := PKeyDevMenuController.diagnostics(facts())
	DisplayServer.clipboard_set(text)
	status_line = c().text("dev_copied")
	refresh_view()
	diagnostics_copied.emit(text)
	return text


## A forced sync, then the update decision (the v3 check when the signed decision is not
## available). A coroutine.
func force_check() -> void:
	if sdk == null or not sdk.has_method("sync") or busy:
		return
	busy = true
	status_line = ""
	refresh_view()
	var s: PKeySyncResult = await sdk.sync(true)
	var u: PKeyResult = await sdk.update.decide()
	if not u.ok and (u.code == PKeyErrors.SERVICE_UNAVAILABLE or u.code == PKeyErrors.NOT_CONFIGURED):
		u = await sdk.update.check()
	busy = false
	var what := "ok" if s.ok else String(s.code)
	if u is PKeyUpdateCheck and u.ok:
		what += ", " + (u as PKeyUpdateCheck).action()
	elif u is PKeyVersionCheck and u.ok:
		what += ", " + (u as PKeyVersionCheck).version
	status_line = c().text("dev_checked", what)
	refresh_view()
	checked.emit(s, u)
