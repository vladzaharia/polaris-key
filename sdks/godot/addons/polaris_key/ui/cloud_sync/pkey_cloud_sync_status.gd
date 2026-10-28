class_name PKeyCloudSyncStatus
extends PKeyUiView
## A small Cloud Sync status (UI-KITS.md §4.1 CloudSyncStatus; ui-core's `cloud_sync_status_view`):
## "Synced 2 minutes ago", "Syncing…", "Offline · changes sync when you reconnect", "Some changes
## conflict." (with **Review** where the game handles it) or "Couldn't sync. Try again later."; a
## sync that failed because nobody is signed in says "You're signed out." and offers **Sign in to
## sync**, in a neutral tone. A device with no key for the synced data says "Sync is locked." and
## offers **Unlock sync** (`locked`); a changed key says "Your sync key changed." and always offers
## **Review** (`ring-changed`), which opens `PKeyRingChange` (the game connects `review_requested`).
## It never implies universal backup, and it hides itself while the
## Sync service is off or there is no state to show. A strip: it takes no focus from the game; a pad
## reaches its action with the first direction press.

## **Review** was chosen on a conflict.
signal review_requested()
## **Sign in to sync** was chosen.
signal sign_in_requested()
## **Unlock sync** was chosen on a `locked` status: show `PKeyUnlockSync`.
signal unlock_requested()

## "synced", "syncing", "offline", "conflict", "error", "locked" or "ring-changed"; "" shows nothing.
@export var state := ""
## When it last synced, already worded ("2 minutes ago"); used by `synced`.
@export var sync_time := ""
## The game can review a conflict: offer **Review**.
@export var can_review := false
## False with an `error`: the sync failed because nobody is signed in.
@export var signed_in := true
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

var _layer: CanvasLayer = null
var _screen: PKeyUiView = null
var _card: BoxContainer
var _glyph: TextureRect
var _text: Label
var _action: Button


static func input(st: String, signed: bool, review: bool, on: bool) -> Dictionary:
	var out := {}
	if st != "":
		out["cloudSync"] = {"state": st, "signedIn": signed, "canReview": review}
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
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_glyph = glyph_node(row, "Glyph", "info")
	_text = label(row, "Status", "PKeyMuted")
	_text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# A quiet action: the state is what the strip says, the button only a way on.
	_action = button(_card, "Action", _on_action, "PKeyLink")


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
	await host.start()
	_from_host()


func _from_host() -> void:
	state = host.status_row
	signed_in = not host.signed_out
	sync_time = host.sync_time
	service_on = true
	refresh_view()
	# A screen is already in front (another strip opened it): draw it here too.
	if host.screen != "" and _screen == null:
		_present(host.screen)


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


func _card_shown() -> bool:
	return true


func _floats() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyBanner"


func _screen_key() -> String:
	return String(model.get("state", ""))


func _render() -> void:
	model = view(input(state, signed_in, can_review, service_on))
	var st := String(model.get("state", "hidden"))
	visible = st != "hidden"
	if not visible:
		return
	var copy: Array = model.get("copy", [])
	var args := {"time": sync_time}
	var key := "cloudSync.signedOut" if copy.has("cloudSync.signedOut") else String(copy[0]) if not copy.is_empty() else ""
	cat_text(_text, key, args)
	var primary = model.get("decisions", {}).get("primary")
	cat_text(_action, "" if primary == null else String(primary), args)
	_glyph.set_meta(&"pkey_glyph", {"synced": "success", "syncing": "info", "offline": "cloud_off", "conflict": "warning", "error": "warning", "locked": "lock", "ring-changed": "warning"}.get(st, "info"))


func _arrange(m: Dictionary) -> void:
	_float_strip()
	# The words keep the whole width; a Review or Sign in action goes under them.
	set_columns(_card, false)
	_action.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	super(m)
	size_glyph(_glyph, 20.0, get_theme_color("font_color", "PKeyWarning") if state in ["conflict", "error", "ring-changed"] else get_theme_color("font_color", "PKeyMuted"))


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
		"locked":
			unlock_requested.emit()
			if host != null:
				host.open_unlock()
		_:
			sign_in_requested.emit()
