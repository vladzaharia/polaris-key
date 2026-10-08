class_name PKeyStatusBanner
extends PKeyUiView
## A thin, non-blocking strip: offline grace ("Offline — 3 days left"), when the licence was last
## checked, and that an update is available. It never takes focus (it has no control) and hides
## itself when there is nothing to say.
##
## With `sdk`, it follows PolarisKey.state_changed and update.update_available; `show_state()`
## drives it without one. Headless logic: PKeyBannerController.

## Also show "Checked … ago" outside grace.
@export var show_last_verified := false

## `func() -> float` epoch seconds (tests); empty: the SDK's effective clock, else the system's.
var now_source: Callable = Callable()

var state: Dictionary = {}
var update_available := false

var _lines: VBoxContainer
var _bound := false


func _build() -> void:
	name = "PKeyStatusBanner"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	# A transparent strip floating its card in from the top and the sides (`_arrange`).
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_lines = vbox(card_panel("Card", false), "Lines", "PKeyTight")
	_card_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# A strip: its lines centred, at most a wide card's width, the page margin from the sides.
	max_content_width = float(PKeyUiTheme.MEASURES["card_width_wide"])


func _card_shown() -> bool:
	return true


func _floats() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyBanner"


func _arrange(m: Dictionary) -> void:
	_float_strip()
	super(m)


## A toast that hugs its lines: as wide as the longest one (plus the card's padding), never wider
## than the room, centred.
func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	var widest := 0.0
	for l in _lines.get_children():
		var label_ := l as Label
		if label_ != null and label_.visible:
			widest = maxf(widest, text_width(label_, label_.text))
	super(minf(ceilf(widest) + 2.0 + card_padding_x(), width))


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
	var lines := PKeyBannerController.lines(state, _now(), update_available, show_last_verified, c())
	var labels := _lines.get_children()
	while labels.size() < lines.size():
		# The first line says what is happening; the rest qualify it.
		var l := label(_lines, "Line%d" % labels.size(), "" if labels.is_empty() else "PKeyMuted")
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		labels.append(l)
	for i in labels.size():
		var l: Label = labels[i]
		if i < lines.size():
			l.text = c().text(lines[i][0], lines[i][1])
			l.visible = true
		else:
			l.visible = false
	visible = not lines.is_empty()
