class_name PKeyUpdateProgress
extends PKeyUiView
## Compact download and install progress for an app update or content packs (UI-KITS.md §4.1
## UpdateProgress; React's `progressFor` and ui-core's `update_progress_view` are the reference): a
## strip with a counted bar and one line in tabular figures, "Downloading · 38 of 91 MB · 1 minute
## left". It never takes the focus from the game; a pad reaches its action with the first direction
## press while nothing else is focused, as the status banner's.
##
## States (the model's): queued ("Waiting to download"), downloading, installing, paused ("Paused ·
## waiting for Wi-Fi", with **Download now**), failed ("Couldn't download", with **Try again**) and
## done ("Up to date"). Verification happens inside downloading; "Installing…" appears only at apply,
## and nothing says installed before it (Must not). The strip hides itself while there is no
## progress.
##
## `set_progress()` drives it; with an SDK it follows PolarisKey.update.download_progress (an app
## update) and PolarisKey.packs.pack_progress (content). A game that draws the bar itself reads
## PKeyProgressController. The same block draws inside PKeyToast.

## The player chose **Download now** on a paused download.
signal resume_requested()
## The player chose **Try again** on a failed one.
signal retry_requested()

## One line and a thinner bar, for a corner of a HUD (the "pill"); else a row with the bar under the words.
@export var compact := false

var action := "packs"
var version := ""
var received := 0
var total := 0
var fraction: Variant = null
var phase := ""
var seconds_left := -1.0
var model: Dictionary = {}
## `func() -> float` seconds (tests); empty: the system's.
var clock: Callable = Callable()

var _card: BoxContainer
var _row: BoxContainer
var _glyph: TextureRect
var _block: PKeyProgressBlock
var _actions: BoxContainer
var _action: Button
var _eta := PKeyProgressController.new()
var _bound := false


func _build() -> void:
	name = "PKeyUpdateProgress"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_card = columns(card_panel("Card", false), "Body")
	_card_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_row = hbox(_card, "Row")
	_row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_glyph = glyph_node(_row, "Glyph", "success")
	_block = PKeyProgressBlock.new()
	_block.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_block.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_row.add_child(_block)
	_actions = actions_row(_card, "Actions", BoxContainer.ALIGNMENT_END)
	_actions.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_action = button(_actions, "Action", _on_action, "PKeyPrimary")
	max_content_width = float(PKeyUiTheme.MEASURES["card_width_wide"])


func _card_shown() -> bool:
	return true


func _floats() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyBanner"


func _ready() -> void:
	super()
	if sdk != null and not _bound:
		_bound = true
		if sdk.get("update") != null:
			sdk.update.download_progress.connect(_on_download)
			sdk.update.update_staged.connect(func(_v: String) -> void: set_progress("done"))
		if sdk.get("packs") != null:
			sdk.packs.pack_progress.connect(func(_id: String, bytes: int, all: int) -> void: set_progress("download", bytes, all, "packs"))
			sdk.packs.pack_failed.connect(func(_id: String, _err: String) -> void: set_progress("failed", received, total, "packs"))


func _now() -> float:
	return float(clock.call()) if clock.is_valid() else Time.get_ticks_msec() / 1000.0


func _on_download(got: int, all: int) -> void:
	set_progress("download", got, all, "binary")


## Show a download or install: `phase_name` is one of the model's phases (queued, download, verify,
## paused, install, failed, done), `got` and `all` bytes (0: not known).
func set_progress(phase_name: String, got := 0, all := 0, p_action := "", p_version := "") -> void:
	phase = phase_name
	received = got
	total = all
	if p_action != "":
		action = p_action
	if p_version != "":
		version = p_version
	if phase == "download":
		_eta.note(received, _now())
		seconds_left = _eta.seconds_left(received, total)
	elif phase == "queued":
		_eta.reset()
		seconds_left = -1.0
	fraction = PKeyProgressController.fraction_of(received, total)
	if phase == "verify" or phase == "done":
		fraction = 1.0
	refresh_view()


## Stop showing progress.
func clear() -> void:
	phase = ""
	refresh_view()


func _render() -> void:
	var t := c()
	var inp: Dictionary = {} if phase == "" else PKeyProgressController.input(phase, fraction, action, version)
	model = PKeyProgressController.view(inp)
	var state := String(model.get("state", "hidden"))
	visible = state != "hidden"
	if state == "hidden":
		return
	_block.show_progress(t, state, fraction, received, total, seconds_left, action)
	_glyph.visible = state in ["done", "failed"]
	_glyph.set_meta(&"pkey_glyph", "success" if state == "done" else "warning")
	var primary := _primary_of(model)
	var label := ""
	if primary == "updateProgress.resume":
		label = t.text("progress_resume")
	elif primary == "common.tryAgain":
		label = t.text("retry")
	show_text(_action, label)


## The catalog key the view's primary is labelled by ("" for none).
static func _primary_of(view: Dictionary) -> String:
	var p = view.get("decisions", {}).get("primary")
	return "" if p == null else String(p)


func _screen_key() -> String:
	return String(model.get("state", ""))


func _arrange(m: Dictionary) -> void:
	_float_strip()
	var row := is_landscape() and not phone_screen() and _action.visible and _hug_actions() <= content_room().x * 0.5
	set_columns(_card, row)
	_actions.size_flags_horizontal = Control.SIZE_SHRINK_END if row else Control.SIZE_FILL
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_END if row else BoxContainer.ALIGNMENT_BEGIN)
	super(m)
	_block.set_thickness(roundf((4.0 if compact else 8.0) * float(m["scale"])))
	var warn := get_theme_color("font_color", "PKeyWarning") if phase == "failed" else get_theme_color("font_color", "PKeyMuted")
	size_glyph(_glyph, 20.0, warn)


func _hug_actions() -> float:
	return _action.get_combined_minimum_size().x if _action.visible else 0.0


## A strip that hugs its words, at most a wide card, centred.
func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide") if not compact else role("card_width"), width))


func _focus_chain() -> Array:
	return [_action]


## The strip is the game's to look past: it takes the focus only when the player asks.
func ensure_focus(force := false) -> bool:
	return super(true) if force else false


func _on_action() -> void:
	match phase:
		"paused":
			resume_requested.emit()
		"failed":
			retry_requested.emit()
