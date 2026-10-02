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
## Options for `run()`: allow_offline (default true), allow_grace (true), required_packs ([],
## accepted; nothing installs packs until P4-08), sync_timeout_seconds (20, or 45 on a build
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
## The boot stopped (READY, BLOCKED, OFFLINE or ERROR): the first stop resolves run(); a stop
## reached after a Retry arrives only here.
signal boot_finished(result: PKeyBootResult)

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

var _center: CenterContainer
var _logo: TextureRect
var _status: Label
var _progress: ProgressBar
var _card: PanelContainer
var _title: Label
var _body: Label
var _notice: Label
var _update_action: Button
var _retry: Button
var _play_offline: Button
var gate: PKeyGateView
var prompt: PKeyUpdatePrompt
var _overlay: Control


func _build() -> void:
	name = "PKeyBoot"
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_center = CenterContainer.new()
	_center.name = "Center"
	add_child(_center)
	var box := vbox(_center, "Shell", 16)
	box.custom_minimum_size = Vector2(420, 0)
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
	_update_action = button(actions, "UpdateAction", _on_update_action, "PKeyPrimary")
	_retry = button(actions, "Retry", retry, "PKeyPrimary")
	_play_offline = button(actions, "PlayOffline", play_offline)
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
	var packs = opts.get("required_packs", [])
	state = PKeyStages.initial_boot_state(opts.get("allow_offline", true) == true, opts.get("allow_grace", true) == true, packs if packs is Array else [])
	gate.allow_grace = opts.get("allow_grace", true) == true
	gate.offer_enrollment = opts.get("offer_enrollment", false) == true
	gate.release_url = String(opts.get("release_url", ""))
	prompt.release_url = gate.release_url
	gate.sdk = sdk
	gate.activation.sdk = sdk
	prompt.sdk = sdk
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
	state = tr["state"]
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


## Not accepted in v1: `can_play_offline` is never true (plans/P1-09.md decision 12).
func play_offline() -> void:
	send({"type": "play-offline"})


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
					prompt.show_result(update_result)
					gate.update_result = update_result
		"fetch":
			e = await host.fetch(state["options"]["requiredPacks"])
		"mount":
			e = await host.mount()
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
	result = r
	boot_finished.emit(r)
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
	self_modulate.a = 1.0 if show_default_view else 0.0
	_center.visible = show_default_view and not waiting_gate
	_logo.texture = logo
	_logo.visible = logo != null
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
			if _block_reason == "update-required":
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
	# Never true in v1: no path offers play without the required set and a usable gate.
	show_text(_play_offline, "")
	gate.visible = show_default_view and waiting_gate
	if waiting_gate:
		var st: Dictionary = sdk.status() if sdk != null and sdk.has_method("status") and sdk.get("core") != null else {}
		if st.get("status") != _wait_status:
			st = {"status": _wait_status}
		gate.show_state(st)
	prompt.visible = show_default_view and prompt.model.get("visible", false) and not prompt.is_dismissed


func _focus_chain() -> Array:
	var out: Array = [_update_action, _retry, _play_offline]
	if gate.visible:
		out.append_array(gate._focus_chain())
	if prompt.visible:
		out.append_array(prompt._focus_chain())
	return out


func _on_update_action() -> void:
	var url := PKeyUpdatePromptController.update_url(update_result, gate._outlet(), String(_opts.get("release_url", "")))
	if url != "":
		OS.shell_open(url)
