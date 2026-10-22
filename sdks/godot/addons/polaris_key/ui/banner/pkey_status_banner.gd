class_name PKeyStatusBanner
extends PKeyUiView
## A thin, non-blocking strip: offline grace ("Offline · 3 days left", "last day" on the last one),
## when the licence was last checked, and that an update is available. Grace and an overdue check
## carry Reconnect (it asks the SDK to sync) and every line can be dismissed for the session
## (UI-KITS.md GraceBanner). The strip never takes the focus from the game on its own: a pad
## reaches Reconnect and Dismiss with its first direction press while nothing else is focused. It
## hides itself when there is nothing to say.
##
## With `sdk`, it follows PolarisKey.state_changed and update.update_available; `show_state()`
## drives it without one. Headless logic: PKeyBannerController.

## The player asked to reconnect (always emitted; with an SDK the banner also runs `sdk.sync(true)`).
signal reconnect_requested()
## The player dismissed what the banner said (until the game restarts, or the message changes).
signal dismissed()

## Also show "Checked … ago" outside grace.
@export var show_last_verified := false

## `func() -> float` epoch seconds (tests); empty: the SDK's effective clock, else the system's.
var now_source: Callable = Callable()

var state: Dictionary = {}
var update_available := false

var _card: BoxContainer
var _row: HBoxContainer
var _glyph: TextureRect
var _lines: VBoxContainer
var _actions: BoxContainer
var _reconnect: Button
var _dismiss: Button
var _bound := false
var _reconnecting := false
## The copy keys the player dismissed this session: a line comes back only as a different message
## (the last day after the days left).
static var _dismissed := {}


func _build() -> void:
	name = "PKeyStatusBanner"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	# A transparent strip floating its card in from the top and the sides (`_arrange`).
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_card = columns(card_panel("Card", false), "Body")
	_card_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_row = hbox(_card, "Row")
	_row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Status is a glyph and a word: the offline mark before "Offline" (UI-KITS.md §1.5 rule 9).
	_glyph = glyph_node(_row, "Glyph", "cloud_off")
	_lines = vbox(_row, "Lines", "PKeyTight")
	_lines.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_actions = actions_row(_card, "Actions", BoxContainer.ALIGNMENT_END)
	_actions.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_reconnect = button(_actions, "Reconnect", _on_reconnect, "PKeyPrimary")
	_dismiss = button(_actions, "Dismiss", _on_dismiss)
	# A strip: its lines centred, at most a wide card's width, the page margin from the sides.
	max_content_width = float(PKeyUiTheme.MEASURES["card_width_wide"])


func _card_shown() -> bool:
	return true


func _floats() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyBanner"


## The words and their actions side by side on a landscape screen when both fit, stacked otherwise
## (a narrow window, a game's large type).
func _row_layout() -> bool:
	if not is_landscape() or phone_screen():
		return false
	return _hug_width(true) <= content_room().x


func _arrange(m: Dictionary) -> void:
	_float_strip()
	var row := _row_layout()
	set_columns(_card, row)
	_actions.size_flags_horizontal = Control.SIZE_SHRINK_END if row else Control.SIZE_FILL
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_END if row else BoxContainer.ALIGNMENT_BEGIN)
	_actions.custom_minimum_size.x = _actions_line() if row else 0.0
	super(m)
	var warn: bool = (_grace_left() < 86400.0 and state.get("status") == "grace") or state.get("status") == "expired"
	size_glyph(_glyph, 16.0, get_theme_color("font_color", "PKeyWarning") if warn else get_theme_color("font_color", "PKeyMuted"))


## Seconds of offline grace left (INF outside grace).
func _grace_left() -> float:
	if state.get("status") == "grace" and PKeyClaims.is_number(state.get("grace_until")):
		return float(state["grace_until"]) - _now()
	return INF


## A toast that hugs its lines: as wide as the longest one (plus the card's padding), never wider
## than the room, centred.
func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(_hug_width(_row_layout()), width))


## The card's width hugging its lines (and, side by side, the buttons): as wide as the longest
## line plus the card's padding.
func _hug_width(with_actions: bool) -> float:
	var widest := 0.0
	for l in _lines.get_children():
		var label_ := l as Label
		if label_ != null and label_.visible:
			widest = maxf(widest, text_width(label_, label_.text))
	var glyph_w := (_glyph.custom_minimum_size.x + float(_row.get_theme_constant("separation"))) if _glyph.visible else 0.0
	var actions_w := (_actions_line() + float(_card.get_theme_constant("separation"))) if with_actions and _actions.visible else 0.0
	return ceilf(widest) + 2.0 + glyph_w + actions_w + card_padding_x()


## The width the buttons need on one line.
func _actions_line() -> float:
	var line := 0.0
	for b in _actions.get_children():
		if (b as Control).visible:
			line += (b as Control).get_combined_minimum_size().x + (role("inline_gap") if line > 0.0 else 0.0)
	return line


func _ready() -> void:
	super()
	if sdk != null and not _bound and sdk.has_signal("state_changed"):
		_bound = true
		sdk.state_changed.connect(func(s): show_state(s, update_available))
		if sdk.get("update") != null:
			sdk.update.update_available.connect(func(_r): show_state(state, true))
		show_state(sdk.status(), update_available)


func show_state(s: Dictionary, update := false) -> void:
	state = s
	update_available = update
	refresh_view()


func _now() -> float:
	if now_source.is_valid():
		return float(now_source.call())
	if sdk != null and sdk.get("core") != null and sdk.core.clock != null:
		return sdk.core.clock.now()
	return Time.get_unix_time_from_system()


func _render() -> void:
	var lines := PKeyBannerController.lines(state, _now(), update_available, show_last_verified, c()).filter(func(l: Array) -> bool: return not _dismissed.has(l[0]))
	var labels := _lines.get_children()
	while labels.size() < lines.size():
		# The first line says what is happening; the rest qualify it.
		var l := label(_lines, "Line%d" % labels.size(), "" if labels.is_empty() else "PKeyMuted")
		labels.append(l)
	var grace_first: bool = not lines.is_empty() and lines[0][0] in ["banner_grace", "banner_last_day", "banner_expired"]
	for i in labels.size():
		var l: Label = labels[i]
		if i < lines.size():
			l.text = c().text(lines[i][0], lines[i][1])
			l.visible = true
			# Less than a day of grace left is a warning; more is a fact.
			if i == 0:
				var overdue: bool = lines[0][0] == "banner_expired"
				l.theme_type_variation = &"PKeyWarning" if grace_first and (overdue or _grace_left() < 86400.0) else &""
		else:
			l.visible = false
	_glyph.visible = grace_first
	visible = not lines.is_empty()
	# Reconnect where the licence is what is waiting (grace, an overdue check); every line dismisses.
	show_text(_reconnect, c().text("banner_reconnect") if grace_first else "")
	_reconnect.disabled = _reconnecting
	show_text(_dismiss, c().text("banner_dismiss") if not lines.is_empty() else "")


func _focus_chain() -> Array:
	return [_reconnect, _dismiss]


## The strip is the game's to look past: it takes the focus only when the player asks (a direction
## press with nothing focused), never on its own.
func ensure_focus(force := false) -> bool:
	return super(true) if force else false


func _on_reconnect() -> void:
	reconnect_requested.emit()
	if sdk == null or _reconnecting or not sdk.has_method("sync"):
		return
	_reconnecting = true
	refresh_view()
	await sdk.sync(true)
	_reconnecting = false
	if is_inside_tree():
		refresh_view()


func _on_dismiss() -> void:
	for l in PKeyBannerController.lines(state, _now(), update_available, show_last_verified, c()):
		_dismissed[l[0]] = true
	dismissed.emit()
	refresh_view()
	restore_opener()


## Forget what was dismissed (a new session, tests).
static func reset_dismissed() -> void:
	_dismissed.clear()
