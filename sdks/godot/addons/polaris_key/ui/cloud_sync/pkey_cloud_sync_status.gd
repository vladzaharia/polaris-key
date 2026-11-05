class_name PKeyCloudSyncStatus
extends PKeyUiView
## A small Cloud Sync status (UI-KITS.md §4.1 CloudSyncStatus; ui-core's `cloud_sync_status_view`):
## "Synced 2 minutes ago", "Syncing…", "Offline · changes sync when you reconnect", "Some changes
## conflict." (with **Review** where the game handles it) or "Couldn't sync. Try again later."; a
## sync that failed because nobody is signed in says "You're signed out." and offers **Sign in to
## sync**, in a neutral tone. A device with no key for the synced data says "Sync is locked." and
## offers **Unlock sync** (`locked`); a changed key says "Your sync key changed." and always offers
## **Review** (`ring-changed`), which opens `PKeyRingChange` (the game connects `review_requested`).
## While saves move it says so and never says synced: `transferring` ("Syncing saves…" before its
## figures, with a bar that is filled by the counted fraction or runs indeterminate), `waiting` (for a
## connection, power, or the app opening) and `transfer-failed` ("Couldn't sync your saves." with a
## secondary **Try again**, `retry_requested`).
## It never implies universal backup, and it hides itself while the
## Sync service is off or there is no state to show. A strip: it takes no focus from the game; a pad
## reaches its action with the first direction press.

## **Review** was chosen on a conflict.
signal review_requested()
## **Sign in to sync** was chosen.
signal sign_in_requested()
## **Unlock sync** was chosen on a `locked` status: show `PKeyUnlockSync`.
signal unlock_requested()
## **Try again** was chosen on a `transfer-failed` status.
signal retry_requested()

## "synced", "syncing", "offline", "conflict", "error", "locked", "ring-changed", "transferring",
## "waiting" or "transfer-failed"; "" shows nothing.
@export var state := ""
## When it last synced, already worded ("2 minutes ago"); used by `synced`.
@export var sync_time := ""
## The game can review a conflict: offer **Review**.
@export var can_review := false
## False with an `error`: the sync failed because nobody is signed in.
@export var signed_in := true
## While `transferring`: display-ready sizes ("38 MB", "61 MB"), both or neither.
@export var transfer_size := ""
@export var transfer_total := ""
## While `transferring`: the counted fraction (0 to 1) that fills the bar; negative runs the bar
## indeterminate.
@export var transfer_fraction := -1.0
## While `waiting`: "network" (default), "battery" or "background".
@export_enum("network", "battery", "background") var reason := "network"
## False turns the Sync service off: nothing shows.
@export var service_on := true

## Follow `PolarisKey.cloud_sync` (its status and the "cloudSync" event) and open the screens from
## the strip; off, the strip is driven only by its properties. Read when the strip enters the tree.
@export var follow_sdk := true
## Show `PKeyUnlockSync`, `PKeyRingChange` and `PKeyRecoveryCode` over the game when the host says so;
## off, the game connects the signals and shows them itself.
@export var present_screens := true

var model: Dictionary = {}
## The binding, once following (see `follow()`).
var host: PKeyCloudSyncKitHost = null

## The saves binding, once following and the SDK has saves (K.5T).
var saves_host: PKeySaveScreensHost = null

var _layer: CanvasLayer = null
var _screen: PKeyUiView = null
var _save_screen := false
## `can_review` as the game set it; a save conflict adds Review while it is pending.
var _game_can_review := false
var _card: BoxContainer
var _glyph: TextureRect
var _text: Label
var _figures: Label
var _bar: ProgressBar
var _action: Button
var _action_pad: MarginContainer
var _row: HBoxContainer


static func input(st: String, signed: bool, review: bool, on: bool, extra := {}) -> Dictionary:
	var out := {}
	if st != "":
		var sync := {"state": st, "signedIn": signed, "canReview": review}
		sync.merge(extra, true)
		out["cloudSync"] = sync
	if not on:
		out["services"] = ["license", "config", "release", "distribution", "update", "identity"]
	return out


static func view(inp: Dictionary) -> Dictionary:
	return preload("res://addons/polaris_key/ui/model/models.gd").view_of("CloudSyncStatus", inp)


func _build() -> void:
	name = "PKeyCloudSyncStatus"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_card = columns(card_panel("Card", false), "Body")
	_card_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var row := hbox(_card, "Row")
	_row = row
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_glyph = glyph_node(row, "Glyph", "info")
	_text = label(row, "Status", "PKeyMuted")
	_text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# The label is the live line: a state change is announced once. The byte figures are their own
	# label, not live, so an update to them is not.
	if "accessibility_live" in _text:
		_text.set("accessibility_live", 1)
	# Under the words, not beside them: a figure beside a narrow strip would squeeze the status line.
	_figures = label(_card, "Figures", "PKeyMuted")
	_figures.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_figures.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# The counted fraction of a transfer: on its own row, the whole width of the strip.
	_bar = ProgressBar.new()
	_bar.name = "Progress"
	_bar.show_percentage = false
	_bar.min_value = 0.0
	_bar.max_value = 1.0
	_bar.visible = false
	_bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_bar.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_bar.custom_minimum_size = Vector2(0.0, 6.0)
	_bar.set_meta(FREE_HEIGHT_META, true)
	_card.add_child(_bar)
	# A quiet action: the state is what the strip says, the button only a way on.
	# In a margin of its own, so a failed transfer's Try again can line up with the words.
	_action_pad = MarginContainer.new()
	_action_pad.name = "ActionPad"
	_action_pad.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_card.add_child(_action_pad)
	_action = button(_action_pad, "Action", _on_action, "PKeyLink")


func _ready() -> void:
	super()
	if sdk != null and follow_sdk:
		follow(sdk)


func _exit_tree() -> void:
	_drop_screen()
	if host != null:
		host.changed.disconnect(_from_host)
		host.screen_changed.disconnect(_present)
		host = null
	if saves_host != null:
		saves_host.changed.disconnect(_from_host)
		saves_host = null


## Bind to `p_sdk`'s Cloud Sync: the strip then shows the machine's state (locked and ring-changed
## included), and Unlock sync / Review open the screens. A coroutine over the first read.
func follow(p_sdk: Node) -> void:
	var h := PKeyCloudSyncKitHost.of(p_sdk)
	if h == null or h == host:
		return
	if host != null:
		host.changed.disconnect(_from_host)
		host.screen_changed.disconnect(_present)
	host = h
	host.changed.connect(_from_host)
	host.screen_changed.connect(_present)
	# The saves, when the SDK has them: while one moves the strip says so (K.5T).
	if saves_host == null:
		saves_host = PKeySaveScreensHost.of(p_sdk)
		if saves_host != null:
			_game_can_review = can_review
			saves_host.changed.connect(_from_host)
			saves_host.start()
	await host.start()
	_from_host()


func _from_host() -> void:
	state = host.status_row
	signed_in = not host.signed_out
	sync_time = host.sync_time
	service_on = true
	_over_saves()
	refresh_view()
	# A save conflict that settled (or was dismissed) takes its screen with it.
	if _save_screen and saves_host != null and saves_host.conflict() == null:
		_drop_screen()
	# A screen is already in front (another strip opened it): draw it here too.
	if host.screen != "" and _screen == null:
		_present(host.screen)


## While a save moves, fails or conflicts, that is the state (a ring that is locked or changed is more
## urgent and stands). Otherwise the host's own state stands and the transfer figures are cleared.
func _over_saves() -> void:
	var o: Dictionary = saves_host.transfer_input() if saves_host != null else {}
	var t: Dictionary = o.get("transfer", {}) if o.get("transfer") is Dictionary else {}
	if not o.is_empty() and state != "locked" and state != "ring-changed":
		state = String(o["state"])
	var shown := state == String(o.get("state", "-"))
	transfer_size = String(t.get("size", "")) if shown else ""
	transfer_total = String(t.get("total", "")) if shown else ""
	transfer_fraction = float(t["fraction"]) if shown and t.has("fraction") else -1.0
	can_review = _game_can_review or (shown and bool(o.get("can_review", false)))


## The screen in front (`""` closes it). Keeps the host's models; a recovery code lives only on its view.
func _present(which: String) -> void:
	_drop_screen()
	if which == "" or not present_screens or not is_inside_tree():
		return
	var view: PKeyUiView
	match which:
		"unlock":
			var u := PKeyUnlockSync.new()
			u.unlocked.connect(host.on_unlocked)
			u.started_over.connect(host.on_started_over)
			u.cancelled.connect(host.dismiss)
			view = u
		"ring_change":
			var r := PKeyRingChange.new()
			r.by = host.by
			r.served = host.served
			r.accepted.connect(host.on_accepted)
			r.use_code_requested.connect(host.open_unlock)
			r.cancelled.connect(host.dismiss)
			view = r
		"recovery_code":
			var c := PKeyRecoveryCode.new()
			c.code = host.code
			c.done.connect(host.on_code_done)
			view = c
		_:
			return
	view.auto_sdk = false
	view.sdk = host.sdk
	_show(view)


## The save conflict screen, over the game, bound to the saves: the strip's Review on a save conflict.
func _present_save_conflict() -> void:
	if not present_screens or not is_inside_tree() or saves_host == null:
		return
	_drop_screen()
	var view := PKeySaveConflict.new()
	view.auto_sdk = false
	view.sdk = saves_host.sdk
	_save_screen = true
	_show(view)


func _show(view: PKeyUiView) -> void:
	_layer = CanvasLayer.new()
	_layer.name = "PKeyCloudSyncScreens"
	_layer.layer = 100
	get_tree().root.add_child(_layer)
	_layer.add_child(view)
	view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_screen = view
	view.ensure_focus()


func _drop_screen() -> void:
	if _layer != null and is_instance_valid(_layer):
		_layer.queue_free()
	_layer = null
	_screen = null
	_save_screen = false


func _card_shown() -> bool:
	return true


func _floats() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyBanner"


func _screen_key() -> String:
	return String(model.get("state", ""))


func _render() -> void:
	var extra := {}
	if state == "transferring":
		var t := {}
		if transfer_size != "":
			t["size"] = transfer_size
		if transfer_total != "":
			t["total"] = transfer_total
		if transfer_fraction >= 0.0:
			t["fraction"] = transfer_fraction
		extra["transfer"] = t
	elif state == "waiting":
		extra["reason"] = reason
	model = view(input(state, signed_in, can_review, service_on, extra))
	var st := String(model.get("state", "hidden"))
	visible = st != "hidden"
	if not visible:
		return
	var copy: Array = model.get("copy", [])
	var args := {"time": sync_time}
	var key := "cloudSync.signedOut" if copy.has("cloudSync.signedOut") else String(copy[0]) if not copy.is_empty() else ""
	var action_key = model.get("decisions", {}).get("primary")
	var bar := false
	match st:
		"transferring":
			# The label comes before its figures, and the figures are the model's own.
			key = "cloudSync.transferring"
			bar = true
		"waiting":
			for k in copy:
				if String(k).begins_with("cloudSync.waiting"):
					key = String(k)
		"transfer-failed":
			key = "cloudSync.transferFailed"
			# Secondary: the strip is small, and Try again never competes with the game's primary.
			action_key = "common.tryAgain"
	cat_text(_text, key, args)
	if st == "transferring" and copy.has("cloudSync.transferProgress"):
		cat_text(_figures, "cloudSync.transferProgress", model.get("args", {}))
	else:
		cat_text(_figures, "")
	cat_text(_action, "" if action_key == null else String(action_key), args)
	_bar.visible = bar
	_action_pad.visible = _action.visible
	if bar:
		var held := transfer_fraction >= 0.0
		if held:
			_bar.indeterminate = false
			_bar.value = clampf(transfer_fraction, 0.0, 1.0)
			_bar.self_modulate.a = 1.0
		else:
			_hold_still(_bar)
	_glyph.set_meta(&"pkey_glyph", {
		"synced": "success", "syncing": "info", "offline": "cloud_off", "conflict": "warning", "error": "warning",
		"locked": "lock", "ring-changed": "warning", "transferring": "info", "waiting": "info", "transfer-failed": "warning",
	}.get(st, "info"))
	# Waiting for a connection is the offline glyph; power and the app in the background are not offline.
	if st == "waiting" and copy.has("cloudSync.waitingNetwork"):
		_glyph.set_meta(&"pkey_glyph", "cloud_off")


func _arrange(m: Dictionary) -> void:
	_float_strip()
	# The words keep the whole width; a Review or Sign in action goes under them.
	set_columns(_card, false)
	_action.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	super(m)
	size_glyph(_glyph, 20.0, get_theme_color("font_color", "PKeyWarning") if state in ["conflict", "error", "ring-changed", "transfer-failed"] else get_theme_color("font_color", "PKeyMuted"))
	# Try again after a failed transfer lines up with the words, not under the glyph.
	var indent := 0
	if state == "transfer-failed":
		indent = roundi(_glyph.get_combined_minimum_size().x + float(_row.get_theme_constant("separation")))
	var rtl := _row.is_layout_rtl()
	_action_pad.add_theme_constant_override("margin_left", 0 if rtl else indent)
	_action_pad.add_theme_constant_override("margin_right", indent if rtl else 0)


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide"), width))


func _focus_chain() -> Array:
	return [_action]


## The strip is the game's to look past: it takes the focus only when the player asks.
func ensure_focus(force := false) -> bool:
	return super(true) if force else false


func _on_action() -> void:
	match state:
		"conflict", "ring-changed":
			review_requested.emit()
			if state == "ring-changed" and host != null:
				host.open_review()
			elif state == "conflict" and saves_host != null and saves_host.conflict() != null:
				_present_save_conflict()
		"locked":
			unlock_requested.emit()
			if host != null:
				host.open_unlock()
		"transfer-failed":
			retry_requested.emit()
		_:
			sign_in_requested.emit()
