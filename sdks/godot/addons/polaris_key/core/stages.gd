class_name PKeyStages
extends RefCounted
## The boot stage machine: a GDScript port of client-core `stages.ts` (plans/P1-09.md §2.2–§2.3,
## stage matrix version 2 from plans/P3-01.md §2.10, version 3 from plans/P4-01.md §2.10). One pure reducer every renderer drives:
## the host does each stage's work and reports the result as an event; the machine decides the
## next stage and what to emit. It does no I/O, reads no clock and never mutates its input, so
## `res://tests/corpus/v2/stage-matrix.json` pins it row by row, exactly as it pins the Node,
## Python and Swift ports. It lives in core/, not ui/, so a headless export can drive it.
##
##   var s := PKeyStages.initial_boot_state(true, true, [])
##   var t := PKeyStages.boot_transition(s, {"type": "start"})   # {state, emits}
##   s = t["state"]                                              # emits: Array of Dictionaries
##
## Events and emits are Dictionaries in the corpus's shape (dotted event types, snake_case emit
## types, camelCase payload keys, kebab-case payload values). The state is a Dictionary:
## {stage, outcome, options: {allowOffline, allowGrace, requiredPacks, essentialPacks}, sync,
## resume, canPlayOffline}. `canPlayOffline` (v3) is true only at an `offline` stop reached with
## every required pack present and an essential one missing, where `play-offline` is accepted.
##
## The normal path is idle → shell → guard → sync → gate → decide → fetch → mount → ready, and
## every stage is entered even when it has nothing to do. An event the current stage does not
## accept, or a malformed event, is IGNORED: the input state comes back unchanged (the same
## Dictionary instance) with no emits. Every accepted event emits something, so an empty list
## always means the event was ignored.
##
## Thread note: every list below is a const Array, which 4.4.1 must not index off the main thread
## (README "Writing GDScript here"). The reducer converts each one to a packed array before
## reading it, so it is safe to call from a worker thread too.

## Every stage, in boot order, then the three stops.
const BOOT_STAGES := ["idle", "shell", "guard", "sync", "gate", "decide", "fetch", "mount", "ready", "background", "offline", "blocked", "error"]
## The outcome a renderer reports: `running` until the boot stops or the gate waits.
const BOOT_OUTCOMES := ["running", "waiting", "ready", "blocked", "offline", "error"]
## The events a host sends, dotted.
const BOOT_EVENT_TYPES := ["start", "shell.done", "guard.done", "sync.done", "sync.timeout", "gate.status", "decide.done", "fetch.done", "mount.done", "background.start", "background.done", "retry", "play-offline", "fail", "fetch.consent", "fetch.progress"]
## The emits the machine produces, snake_case: the signal names PKeyBoot exposes.
const BOOT_EMIT_TYPES := ["stage_changed", "waiting", "update_available", "blocked", "offline", "error", "boot_rolled_back", "boot_ready", "consent_needed", "fetch_progress"]
## What `boot_guard_action` decides at launch.
const BOOT_GUARD_ACTIONS := ["none", "apply-staged", "roll-back"]
## What `decide.done` carries. `required` is P1-09's; the one v4 answer that maps to it is revoked
## REQUIRED content (plans/P4-13.md decision 4): floors never do.
const BOOT_DECISIONS := ["none", "optional", "required"]
## When a launch is confirmed, by outcome (`boot_confirmation`).
const BOOT_CONFIRMATIONS := ["now", "after-ok-seconds", "never"]
## Unconfirmed launches of the active slot that trigger a rollback on the next launch.
const MAX_FAILED_BOOTS := 2
## How long the outcome must stay `ready`, with the process alive, before the launch counts as
## confirmed (`stage-matrix.json#/bootOkSeconds`).
const BOOT_OK_SECONDS := 10

## The nine licence statuses, restated (the reducer keeps no dependency on PKeyGate).
const LICENSE_STATUSES := ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]


## Stage idle, outcome running, sync `pending`, resume `shell`, canPlayOffline false.
## `required_packs` and `essential_packs` (v3: packs the boot wants before READY but can play
## without) are copied and must hold strings (anything else is dropped).
static func initial_boot_state(allow_offline := true, allow_grace := true, required_packs: Array = [], essential_packs: Array = []) -> Dictionary:
	return {
		"stage": "idle",
		"outcome": "running",
		"options": {
			"allowOffline": allow_offline,
			"allowGrace": allow_grace,
			"requiredPacks": _strings(required_packs),
			"essentialPacks": _strings(essential_packs),
		},
		"sync": "pending",
		"resume": "shell",
		"canPlayOffline": false,
	}


## The same state built from the corpus's camelCase options (a row's `init`): an omitted key
## takes its default.
static func initial_from(init: Dictionary) -> Dictionary:
	var packs = init.get("requiredPacks", [])
	var essential = init.get("essentialPacks", [])
	return initial_boot_state(
		init.get("allowOffline", true) == true,
		init.get("allowGrace", true) == true,
		packs if packs is Array else [],
		essential if essential is Array else [],
	)


## The launch decision of the boot guard: roll back, apply a staged update, or neither.
## `failed_boots` is compared numerically (Godot reads every JSON number as a float).
static func boot_guard_action(staged: bool, failed_boots: float) -> String:
	if failed_boots >= MAX_FAILED_BOOTS:
		return "roll-back"
	if staged:
		return "apply-staged"
	return "none"


## Stage matrix v2: when the launch that reached `outcome` counts as confirmed. `waiting`,
## `blocked` and `offline` confirm at once; `ready` after BOOT_OK_SECONDS; `running` and `error`
## never.
static func boot_confirmation(outcome: String) -> String:
	match outcome:
		"waiting", "blocked", "offline":
			return "now"
		"ready":
			return "after-ok-seconds"
	return "never"


## The key of the corpus's `accepts` table: `gate:waiting` while the gate waits for the player,
## `fetch:waiting` while the fetch waits for download consent and `offline:playable` at a
## playable offline stop (v3), otherwise the stage.
static func accepts_key(state: Dictionary) -> String:
	if state.get("stage") == "gate" and state.get("outcome") == "waiting":
		return "gate:waiting"
	if state.get("stage") == "fetch" and state.get("outcome") == "waiting":
		return "fetch:waiting"
	if state.get("stage") == "offline" and state.get("canPlayOffline") == true:
		return "offline:playable"
	return String(state.get("stage", ""))


## The reducer: {state, emits}, `stage_changed` first. An event the current stage does not
## accept, or a malformed one, returns the input state itself and no emits.
static func boot_transition(state: Dictionary, event: Variant) -> Dictionary:
	if not (event is Dictionary):
		return _ignore(state)
	var e: Dictionary = event
	var stage: String = state["stage"]
	var waiting: bool = stage == "gate" and state["outcome"] == "waiting"
	var fetching: bool = stage == "fetch"
	var consent_waiting: bool = fetching and state["outcome"] == "waiting"
	var type = e.get("type")
	if not (type is String):
		return _ignore(state)

	match type:
		"start":
			return _go(state, "shell", "running", null) if stage == "idle" else _ignore(state)

		"shell.done":
			return _go(state, "guard", "running", null, {"resume": "guard"}) if stage == "shell" else _ignore(state)

		"guard.done":
			if stage != "guard" or not _one_of(e.get("result"), PackedStringArray(["ok", "applied", "rolled-back"])):
				return _ignore(state)
			var extra = {"type": "boot_rolled_back"} if e["result"] == "rolled-back" else null
			return _go(state, "sync", "running", extra, {"resume": "sync"})

		"sync.done":
			if stage != "sync" or not _one_of(e.get("result"), PackedStringArray(["ok", "offline", "error"])):
				return _ignore(state)
			return _on_sync(state, e["result"])

		"sync.timeout":
			return _on_sync(state, "offline") if stage == "sync" else _ignore(state)

		"gate.status":
			if stage != "gate" or not _one_of(e.get("status"), PackedStringArray(LICENSE_STATUSES)):
				return _ignore(state)
			return _on_gate_status(state, e["status"])

		"decide.done":
			if stage != "decide":
				return _ignore(state)
			match e.get("decision"):
				"none":
					return _go(state, "fetch", "running", null)
				"optional":
					return _go(state, "fetch", "running", {"type": "update_available"})
				"required":
					return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "update-required"})
			return _ignore(state)

		"fetch.done":
			if not fetching or not _one_of(e.get("result"), PackedStringArray(["ok", "offline", "failed", "declined"])):
				return _ignore(state)
			var installed = e.get("installed")
			if not (installed is Array):
				return _ignore(state)
			for id in installed:
				if not (id is String):
					return _ignore(state)
			if _missing(state["options"]["requiredPacks"], installed):
				if e["result"] == "offline":
					return _go(state, "offline", "offline", {"type": "offline", "canPlayOffline": false})
				if e["result"] == "declined":
					return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "content-declined"})
				return _go(state, "error", "error", {"type": "error", "code": "fetch-failed"})
			if e["result"] == "offline" and _missing(state["options"]["essentialPacks"], installed):
				return _go(state, "offline", "offline", {"type": "offline", "canPlayOffline": true}, {"canPlayOffline": true})
			return _go(state, "mount", "running", null)

		"fetch.consent":
			if not fetching or consent_waiting:
				return _ignore(state)
			if not _count(e.get("bytes")) or not (e.get("metered") is bool):
				return _ignore(state)
			return _go(state, "fetch", "waiting", {"type": "consent_needed", "bytes": e["bytes"], "metered": e["metered"]})

		"fetch.progress":
			if not fetching or not _count(e.get("done")) or not _count(e.get("total")) or float(e["done"]) > float(e["total"]):
				return _ignore(state)
			return _go(state, "fetch", "running", {"type": "fetch_progress", "done": e["done"], "total": e["total"]})

		"play-offline":
			if stage == "offline" and state.get("canPlayOffline") == true:
				return _go(state, "mount", "running", null)
			return _ignore(state)

		"mount.done":
			return _go(state, "ready", "ready", {"type": "boot_ready"}) if stage == "mount" else _ignore(state)

		"background.start":
			return _go(state, "background", "ready", null) if stage == "ready" else _ignore(state)

		"background.done":
			return _go(state, "ready", "ready", null) if stage == "background" else _ignore(state)

		"retry":
			if not waiting and stage != "offline" and stage != "blocked" and stage != "error":
				return _ignore(state)
			return _go(state, state["resume"], "running", null, {"sync": "pending"})

		"fail":
			var failing: bool = PackedStringArray(["shell", "guard", "sync", "decide", "mount"]).has(stage) or (stage == "gate" and not waiting) or (fetching and not consent_waiting)
			if not failing or not (e.get("code") is String):
				return _ignore(state)
			return _go(state, "error", "error", {"type": "error", "code": e["code"]})

	return _ignore(state)


# ── Internals ────────────────────────────────────────────────────────────────────────────

## Move to `stage` (emitting `stage_changed` first when it changes), then at most one emit. A
## new state: the input is never mutated. `canPlayOffline` resets unless the patch sets it.
static func _go(state: Dictionary, stage: String, outcome: String, extra: Variant, patch: Dictionary = {}) -> Dictionary:
	var emits: Array = []
	if stage != state["stage"]:
		emits.append({"type": "stage_changed", "stage": stage, "previous": state["stage"]})
	if extra != null:
		emits.append(extra)
	var next := {
		"stage": stage,
		"outcome": outcome,
		"options": state["options"],
		"sync": patch.get("sync", state["sync"]),
		"resume": patch.get("resume", state["resume"]),
		"canPlayOffline": patch.get("canPlayOffline", false),
	}
	return {"state": next, "emits": emits}


static func _ignore(state: Dictionary) -> Dictionary:
	return {"state": state, "emits": []}


static func _one_of(v: Variant, allowed: PackedStringArray) -> bool:
	return v is String and allowed.has(v)


## The stop a failed sync leads to: offline after no answer, error after an unusable one.
static func _sync_stop(state: Dictionary, sync: String, patch: Dictionary = {}) -> Dictionary:
	if sync == "offline":
		return _go(state, "offline", "offline", {"type": "offline", "canPlayOffline": false}, patch)
	return _go(state, "error", "error", {"type": "error", "code": "sync-failed"}, patch)


static func _on_sync(state: Dictionary, result: String) -> Dictionary:
	if result == "ok" or state["options"]["allowOffline"] == true:
		return _go(state, "gate", "running", null, {"sync": result})
	return _sync_stop(state, result, {"sync": result})


static func _on_gate_status(state: Dictionary, status: String) -> Dictionary:
	match status:
		"ok", "not-applicable":
			return _go(state, "decide", "running", null)
		"grace":
			if state["options"]["allowGrace"] == true:
				return _go(state, "decide", "running", null)
			return _gate_holds(state, status)
		"expired":
			return _gate_holds(state, status)
		"needs-activation", "revoked":
			return _go(state, "gate", "waiting", {"type": "waiting", "status": status})
		"version-too-old":
			return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "update-required"})
	# version-too-new, channel-not-entitled
	return _go(state, "blocked", "blocked", {"type": "blocked", "reason": "not-available"})


## `expired`, or `grace` the options refuse: the player can renew after a sync that was
## answered, otherwise the boot stops for the reason the sync failed.
static func _gate_holds(state: Dictionary, status: String) -> Dictionary:
	if state["sync"] == "offline" or state["sync"] == "error":
		return _sync_stop(state, state["sync"])
	return _go(state, "gate", "waiting", {"type": "waiting", "status": status})


static func _missing(ids: Array, installed: Array) -> bool:
	var have := PackedStringArray(installed)
	for id in PackedStringArray(ids):
		if not have.has(id):
			return true
	return false


## The strings of `list`, copied (anything else is dropped).
static func _strings(list: Array) -> Array:
	var out: Array = []
	for p in list:
		if p is String:
			out.append(p)
	return out


## A non-negative integer below 2^53 (v3's consent and progress payloads). Godot reads every JSON
## number as a float, so an integral float counts; a bool does not.
static func _count(v: Variant) -> bool:
	if v is int:
		return v >= 0 and v < 9007199254740992
	if v is float:
		return v >= 0.0 and v < 9007199254740992.0 and v == floorf(v)
	return false
