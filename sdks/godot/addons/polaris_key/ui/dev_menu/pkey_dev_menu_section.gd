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

## The player picked another channel. The game persists it and applies it at the next configure
## (PKeyOptions.default_channel); nothing is switched mid-session here.
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
	var box := vbox(self, "Body", 8)
	_title = label(box, "Title", "PKeyTitle")
	var ch := hbox(box, "ChannelRow")
	_channel_label = label(ch, "ChannelLabel")
	_channel = OptionButton.new()
	_channel.name = "Channel"
	_channel.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_channel.set_meta(DATA_META, true)
	_channel.item_selected.connect(func(i: int): channel_selected.emit(_channels[i]))
	ch.add_child(_channel)
	_lock = label(box, "ChannelLock", "PKeyMuted")
	_facts = GridContainer.new()
	_facts.name = "Facts"
	_facts.columns = 2
	box.add_child(_facts)
	var actions := hbox(box, "Actions")
	_copy = button(actions, "CopyDiagnostics", copy_diagnostics)
	_check = button(actions, "ForceCheck", force_check)
	_status = label(box, "Status", "PKeyMuted")


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
	var lock := PKeyDevMenuController.channel_lock(f["outlet"], f["platform"])
	return [
		{"id": "channel", "label": t.text("dev_channel"), "value": f["channel"], "options": PKeyDevMenuController.channels(f["channel"], _entitled()), "locked": t.text("dev_channel_locked", lock) if lock != "" else "", "action": func(ch: String): channel_selected.emit(ch)},
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
		l.autowrap_mode = TextServer.AUTOWRAP_OFF
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
