class_name PKeyBoot
extends PKeyUiView
## The drop-in boot scene (report §5.8): it walks the P1-09 stage machine (PKeyStages) — shell,
## guard, sync, gate, decide, fetch, mount, ready — showing a logo, a status line and a progress
## bar, the gate (activation, sign-in) when the licence needs the player, and a card with Retry
## when the boot stops offline, blocked or on an error. It never cuts to another scene: the shell
## stays on screen and READY hands over by signal; the game changes scene when it wants to.
##
##   func _ready() -> void:
##       var boot := await $PKeyBoot.run({"allow_offline": true})
##       if boot.outcome == PKeyBoot.READY:
##           get_tree().change_scene_to_file("res://game/title.tscn")
##
## One machine, many views: PKeyBoot never decides a transition. It does a stage's work each time
## the machine enters that stage (shell and guard again after a retry that resumes there), sends
## the result as the stage's event (PKeyBootHost: plans/P1-09.md §2.2), and renders what the
## machine says. A game that wants its own visuals connects to the signals and hides the default
## view (`show_default_view = false`).
##
## Options for `run()`: allow_offline (default true), allow_grace (true), required_packs and
## essential_packs (default: the content stamp's `required` expects and its `essential` ones,
## PolarisKey.update.packs.boot_options(); stage matrix v3: an OFFLINE stop with every required
## pack present offers "Play offline"), consent (`metered` (default): ask before downloading only
## on a metered network; `always`; `never`), metered (bool: the host knows it is on cellular),
## theme (a res:// Theme a mounted pack provides, applied to this view after MOUNT), background
## (true: after READY install the stamp's prefetch packs with a corner pill), sync_timeout_seconds
## (20, or 45 on a build
## without threads, where a bundle verify runs in frame slices: never under 10 s natively or 30 s
## sliced, S-04), offer_enrollment (false), release_url (""), keep_update_prompt (true: see the
## property), options (a PKeyOptions used when PolarisKey is not configured yet), host (replaces
## PKeyBootHost: tests, a custom pipeline).
##
## The update prompt sits on a plain full-rect overlay that takes no input, so its answer is a
## strip at the top: a mandatory or blocked answer never covers the boot view or the game.
##
## The signals are the machine's emits (stage-matrix.json `vocabulary.emits`); `boot_ready` is not
## `ready` because a Control cannot redeclare `ready` (plan decision 10).

signal stage_changed(stage: String, previous: String)
signal waiting(status: String)
signal update_available()
signal blocked(reason: String)
signal offline(can_play_offline: bool)
signal error(code: String)
signal boot_rolled_back()
signal boot_ready()
## Stage matrix v3: the download needs the player's consent (the size disclosure and the cellular
## choice). PKeyBoot shows the consent card (Download / Not now); `answer_consent(bool)` answers it
## from a game's own UI. Declining stops at BLOCKED {content-declined}, never ERROR.
signal consent_needed(bytes: int, metered: bool)
## Stage matrix v3: download progress, 0 <= done <= total.
signal fetch_progress(done: int, total: int)
## The boot stopped (READY, BLOCKED, OFFLINE or ERROR): the first stop resolves run(); a stop
## reached after a Retry arrives only here.
signal boot_finished(result: PKeyBootResult)
## The player answered the consent card (internal).
signal _consent_answered(yes: bool)

const READY := "ready"
const BLOCKED := "blocked"
const OFFLINE := "offline"
const ERROR := "error"
const RUNNING := "running"
const WAITING := "waiting"

## A stage shows the progress bar once it has run this long (S-04).
const PROGRESS_AFTER_MSEC := 250

## The logo shown above the status line (built-in TextureRect; null shows none).
@export var logo: Texture2D = null:
	set(value):
		logo = value
		refresh_view()
## Draw the default view. Off: only the signals (a game drawing its own boot screen).
@export var show_default_view := true
## Free this node once READY has been announced (PolarisKey.boot() sets it on the view it makes).
var free_on_ready := false
## When this node is freed at READY with an update answer on screen, hand the prompt to the
## parent (PolarisKey.boot()'s CanvasLayer) so it stays over the game: a mandatory or blocked
## answer stays until the build changes, a dismissable one until the player dismisses it. The
## `keep_update_prompt` option of run() overrides it (false: the game shows its own prompt, which
## replays the answer from PolarisKey.update.last_available).
var keep_update_prompt := true

## The machine's state (PKeyStages), the last stop's result, and the host doing the work.
var state: Dictionary = PKeyStages.initial_boot_state()
var result: PKeyBootResult = null
var host = null
var stages: Array = []
var update_result: PKeyResult = null
## The prompt handed over at READY (see keep_update_prompt), or null.
var kept_prompt: PKeyUpdatePrompt = null
var rolled_back := false
var verify_progress := -1.0

var _opts: Dictionary = {}
var _own_host: PKeyBootHost = null
var _gen := 0
var _running := false
var _stage_started := 0
var _sync_deadline := 0
var _sync_gen := -1
var _block_reason := ""
var _error_code := ""
var _retried := false
var _wait_status := ""
var _consent_bytes := 0
var _consent_metered := false
var _consent_open := false
var _background_done := 0
var _background_total := 0
var _background_running := false

var _center: CenterContainer
var _logo: TextureRect
var _shell: VBoxContainer
var _status: Label
var _progress: ProgressBar
var _card: PanelContainer
var _title: Label
var _body: Label
var _notice: Label
var _update_action: Button
var _retry: Button
var _play_offline: Button
var _consent_yes: Button
var _consent_no: Button
var _pill: Label
var gate: PKeyGateView
var prompt: PKeyUpdatePrompt
var _overlay: Control


## The boot shell's width on a viewport wide enough for it (narrower ones keep a gutter).
const SHELL_WIDTH := 480.0


func _apply_width(_width: float) -> void:
	_shell.custom_minimum_size.x = card_width(SHELL_WIDTH)


func _build() -> void:
	name = "PKeyBoot"
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_center = CenterContainer.new()
	_center.name = "Center"
	add_child(_center)
	var box := vbox(_center, "Shell", 16)
	box.custom_minimum_size = Vector2(SHELL_WIDTH, 0)
	_shell = box
	_logo = TextureRect.new()
	_logo.name = "Logo"
	_logo.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_logo.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_logo.custom_minimum_size = Vector2(0, 120)
	box.add_child(_logo)
	_status = label(box, "Status", "PKeyMuted")
	_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_progress = ProgressBar.new()
	_progress.name = "Progress"
	_progress.show_percentage = false
	_progress.custom_minimum_size = Vector2(0, 8)
	box.add_child(_progress)
	_notice = label(box, "Notice", "PKeyMuted")
	_card = PanelContainer.new()
	_card.name = "Card"
	_card.theme_type_variation = "PKeyCard"
	box.add_child(_card)
	var cb := vbox(_card, "Body", 12)
	_title = label(cb, "Title", "PKeyTitle")
	_body = label(cb, "Message", "PKeyMuted")
	var actions := hbox(cb, "Actions")
	actions.alignment = BoxContainer.ALIGNMENT_CENTER
	_update_action = button(actions, "UpdateAction", _on_update_action, "PKeyPrimary")
	_retry = button(actions, "Retry", retry, "PKeyPrimary")
	_play_offline = button(actions, "PlayOffline", play_offline)
	_consent_yes = button(actions, "Download", func() -> void: answer_consent(true), "PKeyPrimary")
	_consent_no = button(actions, "NotNow", func() -> void: answer_consent(false))
	gate = PKeyGateView.new()
	gate.auto_sdk = false
	gate.embedded = true
	gate.managed_retry = true
	gate.retry_requested.connect(retry)
	add_child(gate)
	# PKeyBoot is a Container, which ignores a child's anchors: the prompt lives on a plain
	# full-rect Control that takes no input, so its top-wide anchors hold and a locked answer is
	# a strip at the top, never a sheet over the boot view or the game behind it.
	_overlay = Control.new()
	_overlay.name = "Overlay"
	_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_overlay)
	prompt = PKeyUpdatePrompt.new()
	prompt.auto_sdk = false
	prompt.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	_overlay.add_child(prompt)
	# BACKGROUND's corner pill: optional packs installing after READY, never covering the game.
	_pill = Label.new()
	_pill.name = "Pill"
	_pill.theme_type_variation = "PKeyMuted"
	_pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_pill.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT)
	_pill.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	_pill.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_overlay.add_child(_pill)
	set_process(false)


func _ready() -> void:
	super()
	gate.sdk = sdk
	gate.activation.sdk = sdk
	prompt.sdk = sdk


## Run the boot; resolves at the first stop. A coroutine (see the class doc for `opts`).
func run(opts: Dictionary = {}) -> PKeyBootResult:
	_opts = opts
	result = null
	stages = []
	update_result = null
	rolled_back = false
	_retried = false
	if sdk == null and auto_sdk:
		sdk = default_sdk()
	var next_host = opts.get("host", null)
	if next_host == null:
		# Reuse this view's own host across runs, so its SDK connections are made once.
		if not (_own_host is PKeyBootHost) or _own_host.sdk != sdk:
			_own_host = PKeyBootHost.new(sdk)
		next_host = _own_host
	if host != null and host != next_host and host.has_signal("changed") and host.changed.is_connected(_on_host_changed):
		host.changed.disconnect(_on_host_changed)
	host = next_host
	if host.has_signal("changed") and not host.changed.is_connected(_on_host_changed):
		host.changed.connect(_on_host_changed)
	if sdk != null and sdk.has_signal("verify_progress") and not sdk.verify_progress.is_connected(set_verify_progress):
		sdk.verify_progress.connect(set_verify_progress)
	var packs = opts.get("required_packs")
	var essential = opts.get("essential_packs")
	if (packs == null or essential == null) and host.has_method("boot_options"):
		var bo: Dictionary = host.boot_options()
		if packs == null:
			packs = bo.get("requiredPacks", [])
		if essential == null:
			essential = bo.get("essentialPacks", [])
	state = PKeyStages.initial_boot_state(opts.get("allow_offline", true) == true, opts.get("allow_grace", true) == true, packs if packs is Array else [], essential if essential is Array else [])
	gate.allow_grace = opts.get("allow_grace", true) == true
	gate.offer_enrollment = opts.get("offer_enrollment", false) == true
	gate.release_url = String(opts.get("release_url", ""))
	prompt.release_url = gate.release_url
	gate.sdk = sdk
	gate.activation.sdk = sdk
	prompt.sdk = sdk
	# Follow later answers too: a staged code pack turns the offer into code-ready mid-boot.
	prompt.follow_updates()
	_running = true
	set_process(true)
	refresh_view()
	send({"type": "start"})
	if result != null:
		return result
	return await boot_finished


## Feed one event to the machine; returns true when it was accepted. Stage work, Retry, the gate's
## re-check and a game's own events (background.start, background.done) all come through here.
func send(event: Dictionary) -> bool:
	var tr := PKeyStages.boot_transition(state, event)
	if tr["emits"].is_empty():
		return false
	var before: String = state["stage"]
	var before_outcome: String = state["outcome"]
	state = tr["state"]
	if state["outcome"] != before_outcome:
		_note_outcome(state["outcome"])
	var entered := false
	for e in tr["emits"]:
		_emit(e)
		if e["type"] == "stage_changed":
			entered = true
	if entered:
		_stage_started = Time.get_ticks_msec()
		verify_progress = -1.0
	refresh_view()
	if entered:
		_enter(state["stage"], before)
	if entered and state["stage"] in [READY, BLOCKED, OFFLINE, ERROR] and before != "background":
		_stopped()
	return true


## Retry after a stop (the card's button) or from the waiting gate. Resumes where the machine
## says: the shell or the guard again when they had not finished, otherwise the sync.
func retry() -> void:
	_retried = true
	send({"type": "retry"})


## The boot-confirmation rule (plans/P3-01.md §2.10): every outcome the machine reaches goes to
## PolarisKey.update, which confirms the launch at once (waiting, blocked, offline) or after
## BOOT_OK_SECONDS at ready.
func _note_outcome(outcome: String) -> void:
	if sdk != null and sdk.get("update") != null and sdk.update.has_method("note_boot_outcome"):
		sdk.update.note_boot_outcome(outcome)


## Accepted only at an OFFLINE stop that can play what is present (`state.canPlayOffline`, stage
## matrix v3): every required pack installed and an essential one missing.
func play_offline() -> void:
	send({"type": "play-offline"})


## Answer the consent card (true: download; false: not now). A game with its own consent UI calls
## this after `consent_needed`.
func answer_consent(yes: bool) -> void:
	if not _consent_open:
		return
	_consent_open = false
	refresh_view()
	_consent_answered.emit(yes)


## The host's consent question: show the card and wait for the player. A coroutine.
func _consent_answer(bytes: int, metered: bool) -> bool:
	_consent_bytes = bytes
	_consent_metered = metered
	_consent_open = true
	refresh_view()
	var yes: bool = await _consent_answered
	return yes


## The `theme` option: a Theme a mounted pack provides, applied to this view after MOUNT.
func _swap_theme() -> void:
	var path = _opts.get("theme")
	if path is String and path != "" and ResourceLoader.exists(path):
		var t = load(path)
		if t is Theme:
			theme = t


## A byte count for the consent card ("12.3 MB").
static func human_size(bytes: int) -> String:
	if bytes >= 1000 * 1000 * 1000:
		return "%.1f GB" % (bytes / 1.0e9)
	if bytes >= 1000 * 1000:
		return "%.1f MB" % (bytes / 1.0e6)
	if bytes >= 1000:
		return "%d KB" % int(round(bytes / 1.0e3))
	return "%d B" % bytes


func _emit(e: Dictionary) -> void:
	match e["type"]:
		"stage_changed":
			stages.append(e["stage"])
			stage_changed.emit(e["stage"], e["previous"])
		"waiting":
			_wait_status = e["status"]
			waiting.emit(e["status"])
		"update_available":
			update_available.emit()
		"blocked":
			_block_reason = e["reason"]
			blocked.emit(e["reason"])
		"offline":
			offline.emit(e["canPlayOffline"])
		"error":
			_error_code = e["code"]
			error.emit(e["code"])
		"boot_rolled_back":
			rolled_back = true
			boot_rolled_back.emit()
		"boot_ready":
			boot_ready.emit()
		"consent_needed":
			consent_needed.emit(int(e["bytes"]), e["metered"] == true)
		"fetch_progress":
			fetch_progress.emit(int(e["done"]), int(e["total"]))


## Do the work of the stage just entered and send its event, unless the machine has moved on
## meanwhile (a sync timeout, a Retry): every entry has its own generation.
func _enter(stage: String, _previous: String) -> void:
	_gen += 1
	var gen := _gen
	var e: Variant = null
	match stage:
		"shell":
			e = await host.shell(_opts)
		"guard":
			e = await host.guard()
		"sync":
			_sync_gen = gen
			_sync_deadline = Time.get_ticks_msec() + int(_sync_timeout() * 1000.0)
			var force := _retried
			_retried = false
			e = await host.sync(force)
		"gate":
			e = await host.gate_status()
		"decide":
			e = await host.decide()
			if gen == _gen:
				var u = host.get("update_result")
				update_result = u if u is PKeyResult else null
				if update_result != null:
					# The revoked-content hard stop is BLOCKED's own card, not a banner over it.
					if not _revoked_content():
						prompt.show_result(update_result)
					gate.update_result = update_result
		"fetch":
			if host.has_method("fetch_with"):
				var fopts := {
					"consent": String(_opts.get("consent", "metered")),
					"metered": _opts.get("metered", false) == true,
					"answer": _consent_answer,
				}
				e = await host.fetch_with(state["options"]["requiredPacks"], send, fopts)
			else:
				e = await host.fetch(state["options"]["requiredPacks"])
			_consent_open = false
		"mount":
			e = await host.mount(state["options"]["requiredPacks"])
			if gen == _gen and e is Dictionary and e.get("type") == "mount.done":
				_swap_theme()
		_:
			return
	if gen != _gen or not (e is Dictionary):
		return
	send(e)


func _on_host_changed() -> void:
	# The licence may have moved while the gate waits for the player: read it again.
	if state["stage"] != "gate" or state["outcome"] != WAITING:
		return
	var gen := _gen
	var e = await host.gate_status()
	if gen == _gen and e is Dictionary:
		send(e)


func _process(_delta: float) -> void:
	if not _running:
		return
	if state["stage"] == "sync" and _sync_gen == _gen and Time.get_ticks_msec() >= _sync_deadline:
		_sync_gen = -1
		send({"type": "sync.timeout"})
	if not _progress.visible and _show_progress():
		refresh_view()


func _sync_timeout() -> float:
	var t = _opts.get("sync_timeout_seconds")
	if PKeyClaims.is_number(t) and float(t) > 0.0:
		return float(t)
	return 20.0 if OS.has_feature("threads") else 45.0


func _show_progress() -> bool:
	var s: String = state["stage"]
	return s in ["shell", "guard", "sync", "gate", "decide", "fetch", "mount"] and not (s == "gate" and state["outcome"] == WAITING) and Time.get_ticks_msec() - _stage_started >= PROGRESS_AFTER_MSEC


func _stopped() -> void:
	var outcome: String = state["outcome"]
	var reason := ""
	if outcome == BLOCKED:
		reason = _block_reason
	elif outcome == ERROR:
		reason = _error_code
	var r := PKeyBootResult.of(outcome, reason, stages)
	r.update = update_result
	r.rolled_back = rolled_back
	r.can_play_offline = state.get("canPlayOffline") == true
	result = r
	boot_finished.emit(r)
	if outcome == READY:
		await _background()
	if outcome == READY and free_on_ready:
		_running = false
		var owner_layer := get_parent()
		if _keep_prompt(owner_layer):
			queue_free()
		elif owner_layer is CanvasLayer:
			owner_layer.queue_free()
		else:
			queue_free()


## Hand the visible update prompt to `to` (the layer or parent this node is freed from) so it
## outlives the boot view; false when there is nothing to keep.
func _keep_prompt(to: Node) -> bool:
	if to == null or not bool(_opts.get("keep_update_prompt", keep_update_prompt)) or not prompt.visible:
		return false
	var kept := prompt
	_overlay.remove_child(kept)
	to.add_child(kept)
	kept.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE, Control.PRESET_MODE_MINSIZE)
	kept.follow_updates()
	if not kept.model.get("locked", false):
		kept.dismissed.connect(kept.queue_free)
	prompt = PKeyUpdatePrompt.new()
	prompt.auto_sdk = false
	prompt.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	_overlay.add_child(prompt)
	kept_prompt = kept
	return true


## BACKGROUND (stage matrix): after READY, install the stamp's prefetch packs that are not
## current, with the corner pill; the game runs meanwhile. A coroutine.
func _background() -> void:
	if _background_running or _opts.get("background", true) != true or not host.has_method("background_packs"):
		return
	var ids: Array = host.background_packs()
	if ids.is_empty() or not send({"type": "background.start"}):
		return
	_background_running = true
	_background_done = 0
	_background_total = 0
	var p = host.packs() if host.has_method("packs") else null
	var on_progress := func(_id: String, done: int, total: int) -> void:
		_background_done = done
		_background_total = total
		refresh_view()
	if p != null:
		p.pack_progress.connect(on_progress)
	refresh_view()
	await host.background(ids)
	if p != null and p.pack_progress.is_connected(on_progress):
		p.pack_progress.disconnect(on_progress)
	_background_running = false
	send({"type": "background.done"})
	refresh_view()


## The verified-bundle progress (PolarisKey.verify_progress) for the bar while a sliced verify
## runs.
func set_verify_progress(fraction: float) -> void:
	verify_progress = clampf(fraction, 0.0, 1.0)
	refresh_view()


func _status_key(stage: String) -> String:
	match stage:
		"idle", "shell", "guard":
			return "boot_starting"
		"sync":
			return "boot_syncing"
		"gate":
			return "boot_gate"
		"decide":
			return "boot_deciding"
		"fetch":
			return "boot_fetching"
		"mount":
			return "boot_mounting"
		"ready", "background":
			return "boot_ready"
	return ""


func _render() -> void:
	var t := c()
	var stage: String = state["stage"]
	var outcome: String = state["outcome"]
	var waiting_gate := stage == "gate" and outcome == WAITING
	var stopped := outcome in [BLOCKED, OFFLINE, ERROR]
	# While BACKGROUND runs the view is only its corner pill: transparent, taking no input.
	self_modulate.a = 1.0 if show_default_view and not _background_running else 0.0
	mouse_filter = Control.MOUSE_FILTER_IGNORE if _background_running else Control.MOUSE_FILTER_STOP
	_center.visible = show_default_view and not waiting_gate and not _background_running
	var shown: Texture2D = logo
	if shown == null and PKeyUiTheme.branded():
		shown = PKeyUiTheme.mark_texture(PKeyUiTheme.is_dark(self), 96)
	_logo.texture = shown
	_logo.visible = shown != null
	show_text(_status, t.text(_status_key(stage)) if not stopped and _status_key(stage) != "" else "")
	_progress.visible = not stopped and (_show_progress() or verify_progress >= 0.0)
	if verify_progress >= 0.0:
		_progress.set("indeterminate", false)
		_progress.value = verify_progress * 100.0
	else:
		_progress.set("indeterminate", true)
	show_text(_notice, t.text("boot_rolled_back") if rolled_back and not stopped else "")
	_card.visible = stopped
	var title := ""
	var body := ""
	var url := ""
	match outcome:
		OFFLINE:
			title = t.text("boot_offline_title")
			body = t.text("boot_offline_body")
		ERROR:
			title = t.text("boot_error_title")
			body = t.text("boot_error_body", _error_code)
		BLOCKED:
			if _block_reason == "content-declined":
				title = t.text("boot_declined_title")
				body = t.text("boot_declined_body")
			elif _block_reason == "update-required" and _revoked_content():
				# plans/P4-13.md §2.6 "Host copy": revoked REQUIRED content, with the offer's button
				# when the answer is an offer and none for `blocked`.
				title = t.text("update_revoked_title")
				body = t.text("update_revoked_body")
				if (update_result as PKeyUpdateCheck).decision.get("action") != "blocked":
					url = PKeyUpdatePromptController.update_url(update_result, gate._outlet(), String(_opts.get("release_url", "")))
			elif _block_reason == "update-required":
				title = t.text("boot_blocked_update_title")
				body = t.text("boot_blocked_update_body")
				url = PKeyUpdatePromptController.update_url(update_result, gate._outlet(), String(_opts.get("release_url", "")))
			else:
				title = t.text("boot_blocked_unavailable_title")
				body = t.text("boot_blocked_unavailable_body")
	show_text(_title, title)
	show_text(_body, body)
	show_text(_update_action, t.text("update_action") if stopped and url != "" else "")
	show_text(_retry, t.text("retry") if stopped else "")
	show_text(_play_offline, t.text("play_offline") if outcome == OFFLINE and state.get("canPlayOffline") == true else "")
	# The consent card (stage matrix v3 `fetch:waiting`): the size disclosure and the cellular
	# choice, on the same card, before a byte is downloaded.
	var consent := _consent_open and stage == "fetch"
	if consent:
		_card.visible = true
		show_text(_title, t.text("boot_consent_title"))
		show_text(_body, t.text("boot_consent_body_metered" if _consent_metered else "boot_consent_body", human_size(_consent_bytes)))
	show_text(_consent_yes, t.text("boot_consent_download") if consent else "")
	show_text(_consent_no, t.text("boot_consent_later") if consent else "")
	var pct := int(round(100.0 * _background_done / _background_total)) if _background_total > 0 else 0
	show_text(_pill, t.text("boot_background", clampi(pct, 0, 100)) if _background_running and show_default_view else "")
	gate.visible = show_default_view and waiting_gate
	if waiting_gate:
		var st: Dictionary = sdk.status() if sdk != null and sdk.has_method("status") and sdk.get("core") != null else {}
		if st.get("status") != _wait_status:
			st = {"status": _wait_status}
		gate.show_state(st)
	prompt.visible = show_default_view and prompt.model.get("visible", false) and not prompt.is_dismissed


## Whether DECIDE's answer is the revoked-content hard stop (boot `required`, plans/P4-13.md
## decision 4).
func _revoked_content() -> bool:
	return update_result is PKeyUpdateCheck and (update_result as PKeyUpdateCheck).ok \
			and PKeyDecision.boot_decision((update_result as PKeyUpdateCheck).decision) == PKeyDecision.BOOT_REQUIRED


func _focus_chain() -> Array:
	var out: Array = [_consent_yes, _consent_no, _update_action, _retry, _play_offline]
	if gate.visible:
		out.append_array(gate._focus_chain())
	if prompt.visible:
		out.append_array(prompt._focus_chain())
	return out


func _on_update_action() -> void:
	var url := PKeyUpdatePromptController.update_url(update_result, gate._outlet(), String(_opts.get("release_url", "")))
	if url != "":
		OS.shell_open(url)
