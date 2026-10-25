class_name PKeyReleaseNotes
extends PKeyUiView
## "What's new in <product>" (UI-KITS.md §4.1 ReleaseNotes; ui-core's `release_notes_view`): the
## changelog as a list, newest first, each entry its version, its date (already worded) and its notes.
## The notes are text, never markup. States (the model's): loading, list, empty ("No release notes
## yet."), error ("Release notes couldn't be loaded." with **Try again**).

## **Try again** after a failed load.
signal retry_requested()
## Escape or a pad's back button.
signal back_requested()

## `[{version, date, notes}]`, newest first (PolarisKey.release.changelog() entries read as these).
var entries: Array = []
@export var loading := false
## A failed load.
@export var failed := false
@export var modal := false

var model: Dictionary = {}

var _card: BoxContainer
var _product: PKeyProductHeader
var _title: Label
var _body: Label
var _list: VBoxContainer
var _actions: BoxContainer
var _retry: Button


func _build() -> void:
	name = "PKeyReleaseNotes"
	_card = columns(card_panel(), "Body")
	var text := vbox(_card, "Text", "PKeyStack")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_product = product_header(text, "Product")
	_product.card = true
	_title = label(text, "Title", "PKeyTitle")
	_body = label(text, "Message", "PKeyMuted")
	_list = vbox(text, "Entries", "PKeySections")
	loading_bar(text)
	_actions = actions_row(_card, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_retry = button(_actions, "Retry", func() -> void: retry_requested.emit(), "PKeyPrimary")


func _bleeds() -> bool:
	return true


func _scrim_wanted() -> bool:
	return modal


func _guard_for_modal() -> bool:
	return modal and visible


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 0


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), modal]


func _render() -> void:
	var inp := {}
	if loading:
		inp["loading"] = true
	elif failed:
		inp["error"] = {"code": "network"}
	else:
		inp["releaseNotes"] = entries
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("ReleaseNotes", inp)
	var st := String(model.get("state", "hidden"))
	visible = st != "hidden"
	if not visible:
		return
	var args := {"product": PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))}
	_product.refresh()
	cat_text(_title, "releaseNotes.title" if st in ["list", "loading", "empty"] else "", args)
	cat_text(_body, "releaseNotes.empty" if st == "empty" else ("releaseNotes.error" if st == "error" else ""), args)
	cat_text(_retry, "common.tryAgain" if st == "error" else "", args)
	for ch in _list.get_children():
		_list.remove_child(ch)
		ch.queue_free()
	if st == "list":
		var i := 0
		for e in entries:
			i += 1
			var box := vbox(_list, "Entry%d" % i, "PKeyTight")
			var head := label(box, "Version", "PKeySection", true)
			head.set_meta(CATALOG_META, true)
			head.text = String(catalog().format("releaseNotes.version", {"version": String(e.get("version", ""))}))
			var date := label(box, "Released", "PKeyMuted", true)
			date.set_meta(CATALOG_META, true)
			date.text = String(catalog().format("releaseNotes.released", {"date": String(e.get("date", ""))})) if String(e.get("date", "")) != "" else ""
			date.visible = date.text != ""
			var notes := label(box, "Notes", "", true)
			notes.text = String(e.get("notes", ""))
	set_loading(st == "loading")


func _arrange(m: Dictionary) -> void:
	set_columns(_card, false)
	super(m)


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width"), content_room().x))


func _initial_focus() -> Control:
	return _retry if is_focusable(_retry) else null


func _focus_chain() -> Array:
	return [_retry]


func _cancel() -> bool:
	if visible:
		close_then(func() -> void:
			back_requested.emit()
			restore_opener())
		return true
	return false
