class_name PKeyToast
extends PKeyUiView
## A brief message over the game (UI-KITS.md §4.1 Toast; EXPERIENCE §7; React's `strip(…, "toast")`
## and ui-core's `toast_view` are the reference): one line plus its consequence, a status glyph
## (info, success, warning; status is never colour alone), at most two actions, and a visible timer
## that runs out in 6 seconds. An error does not: it stays until dismissed, and is never the only
## record of what went wrong (Must not).
##
##   $PKeyToast.show_update("2.5.0")             # "Tidewater 2.5.0 is available"  [Update now] [Dismiss]
##   $PKeyToast.show_copied()                    # "Copied"
##   $PKeyToast.show_success("Signed in as Mara", "Pro license")
##   $PKeyToast.show_warning("Autosave is off")  # a message the game words itself
##   $PKeyToast.show_error("sync-failed")        # the error's own title and message; stays
##   $PKeyToast.show_progress(38_000_000, 91_000_000, 60.0)   # the counted bar and Undo
##
## It sits over the game and never steals its focus: a toast takes no focus when it appears, and a
## pad reaches it with the first direction press while nothing else is focused, or with the
## `reach_action` input action when the game has bound one. The timer stops while the toast has the
## focus or the pointer is over it, and starts again when they leave. Toasts queue: an error shows at
## once, any other waits behind an error that is still up.
##
## `toast_anchor` places it (the host's setting, UI-KITS.md §4.3): bottom right by default, bottom
## centre or top right; on a phone it is the bottom of the screen, full width. It keeps inside the
## title-safe area (5 % of the screen) and the device's safe area.

## An action was chosen: `id` is the action's (`install`, `undo`, `dismiss`, or the host's own).
signal action_pressed(id: String)
## The toast went away: `reason` is `timeout`, `dismissed` or `replaced`.
signal closed(reason: String)
## The same two events with the toast they belong to (its `source`, the pusher's own tag, says whose
## it was): the shared toast host (PolarisKey.toasts()) serves several screens at once.
signal toast_action(toast: Dictionary, id: String)
signal toast_closed(toast: Dictionary, reason: String)

## Add a toast layer over the game in one line (a full-rect view that lets the game's clicks through):
##
##   var toasts := PKeyToast.open(self)
##   toasts.show_copied()
static func open(parent: Node = null) -> PKeyToast:
	var toast := PKeyToast.new()
	toast.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var host := parent
	if host == null:
		var tree := Engine.get_main_loop() as SceneTree
		host = tree.current_scene if tree != null and tree.current_scene != null else (tree.root if tree != null else null)
	if host != null:
		host.add_child(toast)
	return toast


## How long a toast that is not an error stays (the UI-KITS.md §4.1 timer).
const DURATION := 6.0
const ANCHORS := ["bottom_right", "bottom_center", "top_right"]

## Where the toast sits (see the class comment).
@export_enum("bottom_right", "bottom_center", "top_right") var toast_anchor := "bottom_right":
	set(value):
		toast_anchor = value
		if _built:
			queue_layout()
## An input action that moves the focus to the toast when pressed (the game binds one, say Select);
## ignored while the project has no such action.
@export var reach_action: StringName = &"pkey_toast_focus"
## Show the SDK's update events as toasts: an available update, a download's counted bar, and its end
## (PolarisKey.update.update_available, download_progress and update_staged). Off by default: a game
## chooses where its updates speak.
@export var follow_sdk := false
## `func() -> float` seconds (tests); empty: the system's.
var clock: Callable = Callable()

## The toast on screen: `{kind, title, consequence, actions, ...}` or {}.
var current: Dictionary = {}
var model: Dictionary = {}
var _queue: Array = []
var _shown_at := 0.0
var _paused_at := -1.0
var _paused_total := 0.0
var _hover := false
var _progress := {"received": 0, "total": 0, "seconds_left": -1.0}

var _margin: MarginContainer
var _glyph: TextureRect
var _texts: VBoxContainer
var _title: Label
var _consequence: Label
var _block: PKeyProgressBlock
var _actions: BoxContainer
var _buttons: Array = []
var _timer: ProgressBar


var _eta := PKeyProgressController.new()
var _bound := false


func _ready() -> void:
	super()
	if follow_sdk and sdk != null and sdk.get("update") != null and not _bound:
		_bound = true
		sdk.update.update_available.connect(_on_update_available)
		sdk.update.download_progress.connect(_on_download)
		sdk.update.update_staged.connect(func(_v: String) -> void: finish_progress())


func _on_update_available(r: PKeyResult) -> void:
	if not (r is PKeyUpdateCheck) or not r.ok:
		return
	var decision: Dictionary = (r as PKeyUpdateCheck).decision
	if decision.get("action") in ["binary", "store", "platform", "code-ready"] and decision.get("release") is Dictionary and decision["release"].get("version") is String:
		show_update(decision["release"]["version"])


func _on_download(received: int, total: int) -> void:
	_eta.note(received, _now())
	show_progress(received, total, _eta.seconds_left(received, total))


func _build() -> void:
	name = "PKeyToast"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_margin = MarginContainer.new()
	_margin.name = "Anchor"
	_margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_margin)
	var card := PanelContainer.new()
	card.name = "Card"
	card.mouse_filter = Control.MOUSE_FILTER_STOP
	card.mouse_entered.connect(func() -> void: _hover = true)
	card.mouse_exited.connect(func() -> void: _hover = false)
	_margin.add_child(card)
	_card_box = card
	var body := vbox(card, "Body", "PKeyTight")
	var row := hbox(body, "Row")
	_glyph = glyph_node(row, "Glyph", "info")
	_glyph.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_texts = vbox(row, "Texts", "PKeyTight")
	_texts.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_title = label(_texts, "Title", "PKeyStrong")
	# A status is announced as it appears: assertive for an error, polite for the rest.
	_consequence = label(_texts, "Consequence", "PKeyMuted")
	_block = PKeyProgressBlock.new()
	_block.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_texts.add_child(_block)
	_actions = actions_row(body, "Actions", BoxContainer.ALIGNMENT_END)
	for i in 2:
		var b := button(_actions, "Action%d" % i, _on_action.bind(i), "")
		_buttons.append(b)
	_timer = ProgressBar.new()
	_timer.name = "Timer"
	_timer.show_percentage = false
	_timer.min_value = 0.0
	_timer.max_value = 1.0
	_timer.step = 0.001
	_timer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_timer.set_meta(FREE_HEIGHT_META, true)
	body.add_child(_timer)
	visible = false


func _card_variation() -> String:
	return "PKeyBanner"


func _card_shown() -> bool:
	return true


## The view pads itself by the title-safe area and the device's safe area (`_title_safe`).
func _floats() -> bool:
	return true


func _bleeds() -> bool:
	return false


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), current.get("serial", 0)]


# ── Showing ──────────────────────────────────────────────────────────────────────────────────

## Show a toast. `toast`: `kind` (update, copied, warning, error, progress), plus by kind `version`
## (update), `title` and `consequence` (warning: the game's own words, shown as given), `code` (error:
## an error code, else `message`), and `actions`: up to two `{id, key}` (`key` a PKeyUiCopy key, or
## `label` a word of the game's own). Without `actions` the kind's own apply.
func push(toast: Dictionary) -> void:
	var t := toast.duplicate(true)
	t["serial"] = int(_serial()) + 1
	_last_serial = t["serial"]
	if current.is_empty() or current.get("kind") != "error" or t.get("kind") == "error":
		var replaced := not current.is_empty()
		var before := current
		current = t
		_start()
		if replaced:
			closed.emit("replaced")
			toast_closed.emit(before, "replaced")
	else:
		_queue.append(t)
	refresh_view()


var _last_serial := 0


func _serial() -> int:
	return _last_serial


func show_update(version: String, actions: Array = []) -> void:
	push({"kind": "update", "version": version, "actions": actions})


func show_copied() -> void:
	push({"kind": "copied"})


## A good-news note in the game's (or the kit's) own words: the success glyph, the 6 s timer.
func show_success(title: String, consequence := "", actions: Array = []) -> void:
	push({"kind": "success", "title": title, "consequence": consequence, "actions": actions})


func show_warning(title: String, consequence := "", actions: Array = []) -> void:
	push({"kind": "warning", "title": title, "consequence": consequence, "actions": actions})


## An error: `error` is an error code, a PKeyResult, or the game's own sentence. It stays until dismissed.
func show_error(error: Variant, consequence := "", actions: Array = []) -> void:
	PKeyUiFeedback.emit(&"error")
	var toast := {"kind": "error", "consequence": consequence, "actions": actions}
	if error is PKeyResult:
		toast["code"] = (error as PKeyResult).code
		toast["result"] = error
	else:
		toast["code"] = str(error)
	push(toast)


## A download's counted bar with Undo; it stays until `finish_progress()` or another toast.
func show_progress(received: int, total: int, seconds_left := -1.0, actions: Array = []) -> void:
	_progress = {"received": received, "total": total, "seconds_left": seconds_left}
	if current.get("kind") == "progress":
		refresh_view()
		return
	push({"kind": "progress", "actions": actions})


## The download is over: the progress toast goes (no record needed; the result has its own).
func finish_progress() -> void:
	if current.get("kind") == "progress":
		_close("dismissed")


func dismiss() -> void:
	if not current.is_empty():
		_close("dismissed")


func _start() -> void:
	_shown_at = _now()
	_paused_at = -1.0
	_paused_total = 0.0
	_hover = false


func _close(reason: String) -> void:
	var had_focus := _has_focus_inside()
	var gone := current
	current = {}
	if not _queue.is_empty():
		current = _queue.pop_front()
		_start()
	refresh_view()
	closed.emit(reason)
	toast_closed.emit(gone, reason)
	if had_focus:
		restore_opener()


func _now() -> float:
	return float(clock.call()) if clock.is_valid() else Time.get_ticks_msec() / 1000.0


## Seconds left on the timer (INF for a toast that does not time out).
func seconds_left() -> float:
	if current.is_empty() or _persists():
		return INF
	var spent := _now() - _shown_at - _paused_total - (_now() - _paused_at if _paused_at >= 0.0 else 0.0)
	return maxf(0.0, DURATION - spent)


## An error stays until dismissed; a download's progress until it ends.
func _persists() -> bool:
	return current.get("kind") in ["error", "progress"]


func _process(_delta: float) -> void:
	if current.is_empty():
		return
	var holding := _hover or _has_focus_inside()
	if holding and _paused_at < 0.0:
		_paused_at = _now()
	elif not holding and _paused_at >= 0.0:
		_paused_total += _now() - _paused_at
		_paused_at = -1.0
	if _persists():
		return
	var left := seconds_left()
	_timer.value = left / DURATION
	if left <= 0.0:
		_close("timeout")


# ── Rendering ────────────────────────────────────────────────────────────────────────────────

func _input_for_model() -> Dictionary:
	var kind := String(current.get("kind", ""))
	var inp: Dictionary = {}
	if kind == "":
		return inp
	inp["toast"] = {"kind": PKeyToastController.model_kind(kind)}
	match kind:
		"update":
			inp["update"] = {"action": "binary", "version": current.get("version", "")}
		"error":
			inp["error"] = {"code": current.get("code", "")}
		"progress":
			var fraction: Variant = PKeyProgressController.fraction_of(int(_progress["received"]), int(_progress["total"]))
			inp["update"] = {"action": "packs", "progress": {"phase": "download", "fraction": fraction if fraction != null else 0.0}}
	return inp


func _render() -> void:
	var t := c()
	model = PKeyToastController.view(_input_for_model())
	var state := String(model.get("state", "hidden"))
	visible = state != "hidden" and not current.is_empty()
	if not visible:
		return
	var kind := String(current.get("kind"))
	var words := PKeyToastController.words(current, t, _progress)
	show_text(_title, words["title"])
	show_text(_consequence, words["consequence"])
	# A game's own warning and the core's heading are data, not the kit's copy.
	for l in [_title, _consequence]:
		if bool(words["data"]) and kind in ["warning", "success"] or (kind == "error" and l == _title):
			l.set_meta(DATA_META, true)
		elif l.has_meta(DATA_META):
			l.remove_meta(DATA_META)
	_block.visible = kind == "progress"
	if kind == "progress":
		var rec := int(_progress["received"])
		var all := int(_progress["total"])
		var frac: Variant = PKeyProgressController.fraction_of(rec, all)
		_block.show_progress(t, "downloading", frac, rec, all, float(_progress["seconds_left"]), "packs")
		# The block's line is the title of a progress toast; its own title row stays out.
		_title.visible = false
	_glyph.set_meta(&"pkey_glyph", PKeyToastController.glyph_for(state))
	var actions := PKeyToastController.actions_for(current)
	for i in _buttons.size():
		var b: Button = _buttons[i]
		if i < actions.size():
			var a: Dictionary = actions[i]
			b.text = String(a["label"]) if a.has("label") else t.text(String(a["key"]))
			b.visible = true
			b.set_meta(&"pkey_action", a["id"])
			b.theme_type_variation = &"PKeyPrimary" if i == 0 and actions.size() > 1 and kind == "update" else &""
			if a["id"] == "dismiss" and kind != "update":
				b.theme_type_variation = &"PKeyLink"
		else:
			b.visible = false
	_actions.visible = not actions.is_empty()
	_timer.visible = not _persists()
	if not _timer.visible:
		_timer.value = 1.0
	var live := 2 if state == "error" else 1
	if "accessibility_live" in _title:
		_title.set("accessibility_live", live)
		_consequence.set("accessibility_live", live)
	if not _persists():
		name_for_reader(_timer, t.text("a11y_toast_timer", PKeyUiTheme.isolate(_time_text(t))))


func _time_text(t: PKeyUiCopy) -> String:
	var n := int(ceil(minf(seconds_left(), DURATION)))
	return t.text("duration_second") if n == 1 else t.text("duration_seconds", maxi(n, 0))


# ── Arrange ──────────────────────────────────────────────────────────────────────────────────

## Title-safe: 5 % of the screen from every edge, the page margin at least, past the device's safe area,
## as the view's own padding (so the base measures the room the card has).
func _title_safe(m: Dictionary) -> void:
	var screen: Vector2 = m["screen"]
	var ts := roundf(maxf(role("page_margin"), 0.05 * minf(screen.x, screen.y)))
	var want := [ts + _safe_applied[0], ts + _safe_applied[1], ts + _safe_applied[2], ts + _safe_applied[3]]
	var box := get_theme_stylebox("panel") as StyleBoxEmpty
	var have := [box.content_margin_left, box.content_margin_top, box.content_margin_right, box.content_margin_bottom] if box != null else []
	if have != want:
		var e := StyleBoxEmpty.new()
		e.content_margin_left = want[0]
		e.content_margin_top = want[1]
		e.content_margin_right = want[2]
		e.content_margin_bottom = want[3]
		add_theme_stylebox_override("panel", e)


func _arrange(m: Dictionary) -> void:
	_title_safe(m)
	super(m)
	var phone := bool(m.get("phone", false)) and not pad_only()
	var card := _card_box
	var room := content_room().x
	var want := minf(role("card_width"), room)
	var anchor := toast_anchor
	if phone:
		anchor = "bottom_full"
	match anchor:
		"bottom_full":
			card.size_flags_horizontal = Control.SIZE_FILL
			card.size_flags_vertical = Control.SIZE_SHRINK_END
			card.custom_minimum_size.x = 0.0
		"bottom_center":
			card.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
			card.size_flags_vertical = Control.SIZE_SHRINK_END
			card.custom_minimum_size.x = want
		"top_right":
			card.size_flags_horizontal = Control.SIZE_SHRINK_END
			card.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
			card.custom_minimum_size.x = want
		_:
			card.size_flags_horizontal = Control.SIZE_SHRINK_END
			card.size_flags_vertical = Control.SIZE_SHRINK_END
			card.custom_minimum_size.x = want
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_END)
	_timer.custom_minimum_size.y = maxf(3.0, roundf(4.0 * float(m["scale"])))
	_block.set_thickness(roundf(8.0 * float(m["scale"])))
	var tint := get_theme_color("font_color", "PKeyMuted")
	match String(model.get("state", "")):
		"error":
			tint = get_theme_color("font_color", "PKeyError")
		"warning":
			tint = get_theme_color("font_color", "PKeyWarning")
	size_glyph(_glyph, 20.0, tint)


## A strip that takes only its card's room: the rest of the view lets the game's clicks through.
func _apply_width(_width: float) -> void:
	pass


func _content() -> Control:
	return _margin


# ── Focus ────────────────────────────────────────────────────────────────────────────────────

func _focus_chain() -> Array:
	return _buttons


## A toast never takes the focus from the game on its own.
func ensure_focus(force := false) -> bool:
	return super(true) if force else false


func _takes_focus_from_game() -> bool:
	return false


func _unhandled_input(event: InputEvent) -> void:
	if visible and not current.is_empty() and InputMap.has_action(reach_action) and event.is_action_pressed(reach_action):
		if not _has_focus_inside():
			remember_opener()
			if ensure_focus(true):
				get_viewport().set_input_as_handled()
				return
	super(event)


## B, Back or Escape dismisses a toast the player has the focus on (an error included: the player
## has read it); the game's own cancel is untouched while the focus is elsewhere.
func _cancel() -> bool:
	if not current.is_empty() and _has_focus_inside():
		_close("dismissed")
		return true
	return false


func _on_action(i: int) -> void:
	var b: Button = _buttons[i]
	var id := String(b.get_meta(&"pkey_action", ""))
	action_pressed.emit(id)
	toast_action.emit(current, id)
	if id == "dismiss" or id == "install":
		_close("dismissed")
	elif id == "undo":
		_close("dismissed")
