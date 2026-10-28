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

var model: Dictionary = {}

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
	_action = button(_card, "Action", _on_action, "PKeyPrimary")


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
		"locked":
			unlock_requested.emit()
		_:
			sign_in_requested.emit()
