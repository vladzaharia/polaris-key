class_name PKeyCloudSyncKitHost
extends RefCounted
## What the Cloud Sync status strip and screens do with `PolarisKey.cloud_sync` (U-42.5T; the Godot
## form of the Swift `CloudSyncKitHostModel`): reads the machine's status, follows the `"cloudSync"`
## event, and says which row to draw and which screen is in front. No node here. `sdk` is the
## PolarisKey autoload or a test's stand-in: `cloud_sync.status()` / `.flush()` (coroutines over a
## PKeyResult), `keyring.unlock()` (asked only while the machine is locked, to tell a changed ring
## from a plain lock; it never accepts one) and the `event(kind, data)` signal.
##
##   status_row   "" (hidden: local, Sync off or unreadable), "synced", "syncing", "offline",
##                "error", "locked" or "ring-changed" (the strip's states)
##   signed_out   with `error`: nobody is signed in (neutral wording, Sign in to sync)
##   screen       "" or "unlock", "ring_change", "recovery_code"
##
## No recovery code is kept past `clear_code()`; no event carries a value. Redraw on `changed`.

signal changed()
signal screen_changed(screen: String)

const META := &"pkey_cloud_sync_host"

var sdk: Node = null
var status_row := ""
var signed_out := false
var sync_time := ""
var screen := ""
## The ring the row was drawn for (`by`: the device that set it up, `served`: its pin); empty unless ring-changed.
var by := ""
var served: Dictionary = {}
## The code to show once (RecoveryCode); "" otherwise.
var code := ""
## "New recovery code" could not make one (the previous code still works).
var new_code_failed := false

var _generation := 0
var _last_synced_ms := -1
var _started := false


## The one host an SDK node has, so a strip and the Account tab agree.
static func of(p_sdk: Node) -> PKeyCloudSyncKitHost:
	if p_sdk == null or not is_instance_valid(p_sdk) or p_sdk.get("cloud_sync") == null:
		return null
	if p_sdk.has_meta(META):
		return p_sdk.get_meta(META)
	var h := PKeyCloudSyncKitHost.new()
	h.sdk = p_sdk
	p_sdk.set_meta(META, h)
	return h


## Follow the event stream and read the status once. Idempotent.
func start() -> void:
	if not _started and sdk != null and sdk.has_signal("event"):
		_started = true
		sdk.event.connect(_on_event)
	await refresh()


func stop() -> void:
	if _started and sdk != null and is_instance_valid(sdk) and sdk.event.is_connected(_on_event):
		sdk.event.disconnect(_on_event)
	_started = false


## Reads the machine's status and redraws the row.
func refresh() -> void:
	_generation += 1
	var mine := _generation
	if sdk == null or not is_instance_valid(sdk) or sdk.get("cloud_sync") == null:
		_set_row("")
		return
	var r: PKeyResult = await sdk.cloud_sync.status()
	if mine != _generation:
		return
	if not r.ok or not (r.detail is Dictionary):
		_set_row("")  # the service is off (typed N/A) or unreadable: no row, never a dead one
		return
	var st: Dictionary = r.detail
	signed_out = false
	match String(st.get("state", "")):
		"locked":
			await _locked(mine)
		"idle", "pending":
			_set_row("synced")
		"syncing":
			_set_row("syncing")
		"offline", "paused":
			_set_row("offline")
		"blocked":
			var why := String(st.get("reason", ""))
			signed_out = why == "account_required" or why == "unauthorized"
			_set_row("error")
		_:
			_set_row("")  # local, unsupported


## Locked: the key ring says whether the ring changed under this device (never accepts it).
func _locked(mine: int) -> void:
	served = {}
	by = ""
	var ring = sdk.get("keyring")
	var r: PKeyResult = await ring.unlock() if ring != null else null
	if mine != _generation:
		return
	var d: Dictionary = r.detail if r != null and r.ok and r.detail is Dictionary else {}
	match String(d.get("kind", "")):
		"ring-changed":
			served = d.get("served", {}) if d.get("served") is Dictionary else {}
			by = String(d["by"]) if d.get("by") is String else ""
			_set_row("ring-changed")
		"unlocked":
			var next: PKeyResult = await sdk.cloud_sync.status()
			if mine != _generation:
				return
			if next.ok and next.detail is Dictionary and next.detail.get("state") != "locked":
				await refresh()
			else:
				_set_row("locked")
		_:
			_set_row("locked")


func _on_event(kind: String, data: Dictionary) -> void:
	if kind != PKeyConstants.EventKind.CLOUDSYNC:
		return
	match String(data.get("type", "")):
		"signedOut", "signInOffered":
			# Not a fault: the row says so and offers to sign in.
			_generation += 1
			signed_out = true
			_set_row("error")
		"change":
			_last_synced_ms = Time.get_ticks_msec()
			refresh()
		_:
			refresh()


func _set_row(row: String) -> void:
	status_row = row
	sync_time = _relative() if row == "synced" else ""
	changed.emit()


func _relative() -> String:
	if _last_synced_ms < 0:
		return ""
	var mins := int((Time.get_ticks_msec() - _last_synced_ms) / 60000.0)
	if mins < 1:
		return tr("just now")
	return tr("%d min ago") % mins


## The Account tab's Cloud Sync row: `error` with nobody signed in reads as "signedOut".
func account_state() -> String:
	if status_row == "error" and signed_out:
		return "signedOut"
	return status_row


# ── Screens ───────────────────────────────────────────────────────────────────────────────────


func _show(next: String) -> void:
	screen = next
	screen_changed.emit(next)
	changed.emit()


## Unlock: the strip's button, or "use recovery code" from RingChange.
func open_unlock() -> void:
	_show("unlock")


## Review a changed ring: the ring the row was drawn for, never a fresh read.
func open_review() -> void:
	if served.is_empty():
		open_unlock()  # nothing to accept: only the recovery code remains
		return
	_show("ring_change")


## The recovery code was accepted, or the ring accepted: this device holds the key; send what waited.
func on_unlocked() -> void:
	await _finish(true)


func on_accepted() -> void:
	await _finish(true)


## Start over made a new ring: its recovery code is shown once; with none, the screen ends.
func on_started_over(new_code: String) -> void:
	if new_code == "":
		await _finish(true)
		return
	code = new_code
	_show("recovery_code")


## Settings' "New recovery code": makes one through the key ring and shows it once. The previous code
## stops working only once the new one is held.
func request_new_recovery_code() -> void:
	new_code_failed = false
	var r: PKeyResult = await PKeyCloudSyncController.new_recovery_code(sdk)
	if not r.ok or not (r.detail is String) or r.detail == "":
		new_code_failed = true
		changed.emit()
		return
	code = r.detail
	_show("recovery_code")


func on_code_done() -> void:
	await _finish(true)


## Cancel or Escape: leave the screen. An unsaved code is never dropped.
func dismiss() -> void:
	if screen == "recovery_code":
		return
	await _finish(false)


func clear_code() -> void:
	code = ""


func _finish(refreshing: bool) -> void:
	clear_code()
	if screen != "":
		_show("")
	if not refreshing or sdk == null or sdk.get("cloud_sync") == null:
		return
	# The key is held: send what was waiting, then redraw from the machine.
	await sdk.cloud_sync.flush()
	await refresh()
