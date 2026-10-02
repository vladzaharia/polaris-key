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
	theme_type_variation = "PKeyBanner"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_lines = vbox(self, "Lines", 2)


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
		var l := label(_lines, "Line%d" % labels.size(), "PKeyMuted")
		labels.append(l)
	for i in labels.size():
		var l: Label = labels[i]
		if i < lines.size():
			l.text = c().text(lines[i][0], lines[i][1])
			l.visible = true
		else:
			l.visible = false
	visible = not lines.is_empty()
