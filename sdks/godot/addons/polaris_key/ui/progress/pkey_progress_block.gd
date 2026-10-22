class_name PKeyProgressBlock
extends VBoxContainer
## The words and the bar of a download or install (UI-KITS.md §4.1 UpdateProgress): a title for
## content packs, one status line in tabular figures ("38 of 91 MB · 1 minute left"), and a counted
## bar (a determinate bar with a text count beside it, status never colour alone). The inline row
## (PKeyUpdateProgress) and the progress toast (PKeyToast) both draw it, so the two say the same
## thing in the same words. Verification happens inside downloading; the line says "Installing…"
## only at apply and "Up to date" only when done (Must not: installed before apply).

var _title: Label
var _status: Label
var _bar: ProgressBar
var phase := ""
var _fx_state := ""


func _init() -> void:
	name = "Progress"
	theme_type_variation = &"PKeyTight"
	_title = Label.new()
	_title.name = "Title"
	_title.theme_type_variation = &"PKeyStrong"
	_title.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_title)
	_status = Label.new()
	_status.name = "Status"
	_status.theme_type_variation = &"PKeyMuted"
	_status.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# A screen reader announces the count as it changes, politely.
	if "accessibility_live" in _status:
		_status.set("accessibility_live", 1)
	add_child(_status)
	_bar = ProgressBar.new()
	_bar.name = "Bar"
	_bar.show_percentage = false
	_bar.min_value = 0.0
	_bar.max_value = 1.0
	_bar.step = 0.001
	_bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_bar.set_meta(PKeyUiView.FREE_HEIGHT_META, true)
	add_child(_bar)


## The bar's thickness at the screen's scale (the view calls this when it arranges).
func set_thickness(px: float) -> void:
	_bar.custom_minimum_size.y = maxf(4.0, px)


## Draw `state` (the model's `update_progress_view` state) with `copy`. `action` is `packs` for
## content (it gets its own title), `received` and `total` are bytes (0: not known), `seconds_left`
## is -1 when it cannot be said.
func show_progress(t: PKeyUiCopy, state: String, fraction: Variant, received: int, total: int, seconds_left: float, action: String) -> void:
	phase = state
	var title := t.text("progress_content_title") if action == "packs" else ""
	var status := ""
	var show_bar := true
	var indeterminate := false
	match state:
		"queued":
			status = t.text("progress_queued")
			fraction = 0.0
		"downloading":
			if total > 0:
				var pair := PKeyProgressController.sizes(received, total)
				if seconds_left >= 0.0:
					status = t.text("progress_downloading", [pair[0], pair[1], _left(t, seconds_left)])
				else:
					status = t.text("update_downloading_of", [pair[0], pair[1]])
			else:
				status = t.text("progress_content_title")
		"installing":
			status = t.text("progress_installing")
			indeterminate = true
		"paused":
			status = t.text("progress_paused")
		"failed":
			status = t.text("progress_failed")
			show_bar = false
		"done":
			status = t.text("progress_done")
			show_bar = false
	_title.text = title
	_title.visible = title != ""
	_status.text = status
	_status.visible = status != ""
	_status.theme_type_variation = &"PKeyError" if state == "failed" else &"PKeyMuted"
	if _fx_state != state:
		_fx_state = state
		if state == "failed":
			PKeyUiFeedback.emit(&"error")
	_bar.visible = show_bar
	if indeterminate:
		_bar.indeterminate = not PKeyUiTheme.reduce_motion()
		_bar.value = 1.0 if PKeyUiTheme.reduce_motion() else 0.0
		_bar.self_modulate.a = 0.55 if PKeyUiTheme.reduce_motion() else 1.0
	else:
		_bar.indeterminate = false
		_bar.self_modulate.a = 1.0
		_bar.value = clampf(float(fraction) if fraction != null else 0.0, 0.0, 1.0)
	var named := t.text("a11y_progress", PKeyProgressController.sizes(received, total)) if total > 0 and state == "downloading" else status
	PKeyUiView.name_for_reader(_bar, named)


## "20 seconds", "1 minute", "3 hours": a time left in whole units.
static func _left(t: PKeyUiCopy, seconds: float) -> String:
	var s := maxf(seconds, 0.0)
	if s < 60.0:
		var n := maxi(1, int(ceil(s)))
		return t.text("duration_second") if n == 1 else t.text("duration_seconds", n)
	return t.duration(s)


## The status line's text (for a test or a host drawing its own bar).
func status_text() -> String:
	return _status.text


func bar() -> ProgressBar:
	return _bar
