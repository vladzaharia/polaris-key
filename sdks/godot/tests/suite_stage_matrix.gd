extends RefCounted
# @pkey-feature ui.stages packs.state
# The boot stage machine (PKeyStages) against the shared stage-matrix.json, the same file the
# Node (conformance/runners/node/stageMatrix.test.ts), Python (test_stage_matrix.py) and Swift
# (StageMatrixTests.swift) runners replay. For every row: each step's emits (as values), the
# stage sequence built from the actual `stage_changed` emits, the final stage and the outcome.
# At the row's initial state and after every step it sends every probe and checks that the state
# comes back unchanged with no emits exactly when the probe's type is not in `accepts` for that
# state (the probe result is discarded; the row continues from its own steps). Then every guard
# case, every confirmation case (version 2), and the port's own unit checks: malformed events
# are ignored, an ignored event returns the input Dictionary itself, the input is never mutated,
# the defaults, and the gate's pass set equals PKeyGate.is_usable. Godot reads every JSON number
# as a float, so `failedBoots` is compared numerically. Version 3 (plans/P4-01.md §2.10) adds the
# `fetch:waiting` and `offline:playable` accepts keys, and after every step `canPlayOffline` must
# equal the step's `offline` emit when it has one, and be false after any other accepted event.

const MATRIX := "res://tests/corpus/v2/stage-matrix.json"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("stage-matrix.json loads", m is Dictionary, MATRIX):
		return true
	t.info("stage-matrix runner on Godot %s" % Engine.get_version_info().string)
	t.check("stageMatrixVersion is 3", m.get("stageMatrixVersion") == 3.0, str(m.get("stageMatrixVersion")))
	t.check("maxFailedBoots equals MAX_FAILED_BOOTS", float(m.get("maxFailedBoots", -1)) == PKeyStages.MAX_FAILED_BOOTS)
	t.check("bootOkSeconds equals BOOT_OK_SECONDS", float(m.get("bootOkSeconds", -1)) == PKeyStages.BOOT_OK_SECONDS)
	var voc: Dictionary = m.get("vocabulary", {})
	t.check("vocabulary.stages equals BOOT_STAGES in order", voc.get("stages") == PKeyStages.BOOT_STAGES)
	t.check("vocabulary.outcomes equals BOOT_OUTCOMES in order", voc.get("outcomes") == PKeyStages.BOOT_OUTCOMES)
	t.check("vocabulary.events equals BOOT_EVENT_TYPES in order", voc.get("events") == PKeyStages.BOOT_EVENT_TYPES)
	t.check("vocabulary.emits equals BOOT_EMIT_TYPES in order", voc.get("emits") == PKeyStages.BOOT_EMIT_TYPES)
	t.check("vocabulary.guardActions equals BOOT_GUARD_ACTIONS in order", voc.get("guardActions") == PKeyStages.BOOT_GUARD_ACTIONS)
	t.check("vocabulary.confirmations equals BOOT_CONFIRMATIONS in order", voc.get("confirmations") == PKeyStages.BOOT_CONFIRMATIONS)
	t.check("vocabulary has exactly the six lists", voc.size() == 6, str(voc.keys()))
	var probes: Array = m.get("probes", [])
	var probe_types: Array = probes.map(func(p): return p.get("type"))
	t.check("one probe per event type, in order", probe_types == PKeyStages.BOOT_EVENT_TYPES)

	var rows: Array = m.get("rows", [])
	var accepts: Dictionary = m.get("accepts", {})
	var rows_ok := 0
	var probe_total := 0
	for row in rows:
		var r := _row(t, row, accepts, probes)
		if r >= 0:
			rows_ok += 1
			probe_total += r
	t.info("%d rows, %d probe transitions" % [rows.size(), probe_total])

	var guards: Array = m.get("guardCases", [])
	var guards_ok := 0
	for c in guards:
		var inp: Dictionary = c["input"]
		var got := PKeyStages.boot_guard_action(inp["staged"] == true, float(inp["failedBoots"]))
		if t.check("guard: %s" % c["name"], got == c["expect"]["action"], got):
			guards_ok += 1

	var confirms: Array = m.get("confirmCases", [])
	var outcomes: Array = confirms.map(func(c): return c["outcome"])
	outcomes.sort()
	var want := PKeyStages.BOOT_OUTCOMES.duplicate()
	want.sort()
	t.check("one confirm case per outcome", outcomes == want)
	var confirms_ok := 0
	for c in confirms:
		var got := PKeyStages.boot_confirmation(c["outcome"])
		if t.check("confirm: %s -> %s" % [c["outcome"], c["expect"]], got == c["expect"], got):
			confirms_ok += 1

	_unit(t)

	t.check("coverage: rows", rows_ok == rows.size() and rows.size() >= 69, "%d/%d" % [rows_ok, rows.size()])
	t.check("coverage: probes", probe_total >= 9728, str(probe_total))
	t.check("coverage: guard cases", guards_ok == guards.size() and guards.size() >= 7, "%d/%d" % [guards_ok, guards.size()])
	t.check("coverage: confirm cases", confirms_ok == confirms.size() and confirms.size() == 6, "%d/%d" % [confirms_ok, confirms.size()])
	return true


## One row; returns the number of probe transitions, or -1 when the row failed.
func _row(t: PKeyTestContext, row: Dictionary, accepts: Dictionary, probes: Array) -> int:
	var name: String = row["name"]
	var state := PKeyStages.initial_from(row["init"])
	var stages: Array = []
	var ok := true
	var n := _probe(state, accepts, probes)
	if n < 0:
		ok = t.check("%s: probes at the initial state" % name, false)
	var steps: Array = row["steps"]
	for i in steps.size():
		var step: Dictionary = steps[i]
		var tr := PKeyStages.boot_transition(state, step["event"])
		if tr["emits"] != step["emits"]:
			ok = t.check("%s: step %d (%s) emits" % [name, i + 1, step["event"]["type"]], false, "got %s, want %s" % [JSON.stringify(tr["emits"]), JSON.stringify(step["emits"])])
		for e in tr["emits"]:
			if e["type"] == "stage_changed":
				stages.append(e["stage"])
		state = tr["state"]
		var off: Array = tr["emits"].filter(func(x): return x["type"] == "offline")
		var want_playable: bool = off[0]["canPlayOffline"] == true if not off.is_empty() else false
		if not tr["emits"].is_empty() and (state.get("canPlayOffline") == true) != want_playable:
			ok = t.check("%s: step %d canPlayOffline" % [name, i + 1], false, str(state.get("canPlayOffline")))
		var p := _probe(state, accepts, probes)
		if p < 0:
			ok = t.check("%s: probes after step %d" % [name, i + 1], false, PKeyStages.accepts_key(state))
		else:
			n += p
	var expect: Dictionary = row["expect"]
	ok = t.check("%s: stage sequence" % name, stages == expect["stages"], "%s vs %s" % [stages, expect["stages"]]) and ok
	t.check("%s: final stage and outcome" % name, state["stage"] == expect["stages"].back() and state["outcome"] == expect["outcome"], "%s/%s" % [state["stage"], state["outcome"]])
	ok = ok and state["stage"] == expect["stages"].back() and state["outcome"] == expect["outcome"]
	ok = ok and n == (steps.size() + 1) * PKeyStages.BOOT_EVENT_TYPES.size()
	return n if ok else -1


## Every probe from `state`: ignored (same state by value, no emits) exactly when its type is not
## accepted at that key. Returns the count, or -1 on the first mismatch.
func _probe(state: Dictionary, accepts: Dictionary, probes: Array) -> int:
	var key := PKeyStages.accepts_key(state)
	if not accepts.has(key):
		return -1
	var accepted: Array = accepts[key]
	for p in probes:
		var tr := PKeyStages.boot_transition(state, p)
		var ignored: bool = tr["state"] == state and tr["emits"].is_empty()
		if ignored == accepted.has(p["type"]):
			return -1
	return probes.size()


func _unit(t: PKeyTestContext) -> void:
	var d := PKeyStages.initial_boot_state()
	t.check("unit: defaults", d == {"stage": "idle", "outcome": "running", "options": {"allowOffline": true, "allowGrace": true, "requiredPacks": [], "essentialPacks": []}, "sync": "pending", "resume": "shell", "canPlayOffline": false}, str(d))
	t.check("unit: initial_from({}) takes the defaults", PKeyStages.initial_from({}) == d)
	var packs := ["core"]
	var s := PKeyStages.initial_boot_state(true, true, packs)
	packs.append("later")
	t.check("unit: required packs are copied", s["options"]["requiredPacks"] == ["core"])
	var essential := ["hd"]
	var se := PKeyStages.initial_boot_state(true, true, [], essential)
	essential.append("later")
	t.check("unit: essential packs are copied", se["options"]["essentialPacks"] == ["hd"])

	# An ignored event returns the input Dictionary itself.
	var idle := PKeyStages.initial_boot_state()
	t.check("unit: an ignored event returns the same Dictionary", is_same(PKeyStages.boot_transition(idle, {"type": "mount.done"})["state"], idle))

	# The input is never mutated.
	var before := idle.duplicate(true)
	var started := PKeyStages.boot_transition(idle, {"type": "start"})
	t.check("unit: the input state is not mutated", idle == before and started["state"]["stage"] == "shell" and not is_same(started["state"], idle))

	# Malformed events are ignored; an extra key does not make an event malformed.
	var sync := _walk(["start", "shell.done", {"type": "guard.done", "result": "ok"}])
	var gate := _walk(["start", "shell.done", {"type": "guard.done", "result": "ok"}, {"type": "sync.done", "result": "ok"}])
	var decide := _walk(["start", "shell.done", {"type": "guard.done", "result": "ok"}, {"type": "sync.done", "result": "ok"}, {"type": "gate.status", "status": "ok"}])
	var fetch := _walk(["start", "shell.done", {"type": "guard.done", "result": "ok"}, {"type": "sync.done", "result": "ok"}, {"type": "gate.status", "status": "ok"}, {"type": "decide.done", "decision": "none"}])
	var malformed := [
		["null event", idle, null],
		["a string event", idle, "start"],
		["no type", idle, {}],
		["an unknown type", idle, {"type": "begin"}],
		["a non-string type", idle, {"type": 1}],
		["sync.done without a result", sync, {"type": "sync.done"}],
		["sync.done with an unknown result", sync, {"type": "sync.done", "result": "maybe"}],
		["guard.done with a wrong-typed result", _walk(["start", "shell.done"]), {"type": "guard.done", "result": true}],
		["gate.status with an unknown status", gate, {"type": "gate.status", "status": "fine"}],
		["decide.done with an unknown decision", decide, {"type": "decide.done", "decision": "maybe"}],
		["fetch.done without installed", fetch, {"type": "fetch.done", "result": "ok"}],
		["fetch.done with installed not a list", fetch, {"type": "fetch.done", "result": "ok", "installed": "core"}],
		["fetch.done with a non-string pack id", fetch, {"type": "fetch.done", "result": "ok", "installed": [1]}],
		["fail with a non-string code", sync, {"type": "fail", "code": 3}],
		["fail without a code", sync, {"type": "fail"}],
		["play-offline anywhere", sync, {"type": "play-offline"}],
		["fetch.consent with negative bytes", fetch, {"type": "fetch.consent", "bytes": -1, "metered": false}],
		["fetch.consent with fractional bytes", fetch, {"type": "fetch.consent", "bytes": 1.5, "metered": false}],
		["fetch.consent with bytes at 2^53", fetch, {"type": "fetch.consent", "bytes": 9007199254740992.0, "metered": false}],
		["fetch.consent with a non-bool metered", fetch, {"type": "fetch.consent", "bytes": 10, "metered": "no"}],
		["fetch.consent with string bytes", fetch, {"type": "fetch.consent", "bytes": "10", "metered": true}],
		["fetch.progress with done above total", fetch, {"type": "fetch.progress", "done": 2, "total": 1}],
		["fetch.progress with negative done", fetch, {"type": "fetch.progress", "done": -1, "total": 1}],
		["fetch.progress with fractional done", fetch, {"type": "fetch.progress", "done": 0.5, "total": 1}],
		["fetch.progress with a string total", fetch, {"type": "fetch.progress", "done": 0, "total": "1"}],
	]
	for c in malformed:
		var tr := PKeyStages.boot_transition(c[1], c[2])
		t.check("unit: malformed is ignored: %s" % c[0], is_same(tr["state"], c[1]) and tr["emits"].is_empty())
	# canPlayOffline resets when the playable offline stop is left.
	var playable := PKeyStages.initial_boot_state(true, true, ["core"], ["hd"])
	for e in ["start", "shell.done", {"type": "guard.done", "result": "ok"}, {"type": "sync.done", "result": "ok"}, {"type": "gate.status", "status": "ok"}, {"type": "decide.done", "decision": "none"}, {"type": "fetch.done", "result": "offline", "installed": ["core"]}]:
		playable = PKeyStages.boot_transition(playable, e if e is Dictionary else {"type": e})["state"]
	t.check("unit: a playable offline stop sets canPlayOffline", playable["stage"] == "offline" and playable["canPlayOffline"] == true)
	var mounted: Dictionary = PKeyStages.boot_transition(playable, {"type": "play-offline"})["state"]
	t.check("unit: play-offline mounts and resets canPlayOffline", mounted["stage"] == "mount" and mounted["canPlayOffline"] == false)
	var extra := PKeyStages.boot_transition(sync, {"type": "sync.done", "result": "ok", "note": "extra"})
	t.check("unit: an extra key is accepted", extra["state"]["stage"] == "gate" and not extra["emits"].is_empty())

	# The gate's pass set (allowGrace true) equals PKeyGate.is_usable.
	var agree := true
	for status in PKeyStages.LICENSE_STATUSES:
		var to := PKeyStages.boot_transition(gate, {"type": "gate.status", "status": status})
		if (to["state"]["stage"] == "decide") != PKeyGate.is_usable(status):
			agree = false
	t.check("unit: the gate's pass set equals PKeyGate.is_usable", agree)
	t.check("unit: boot_guard_action reads failedBoots as a number", PKeyStages.boot_guard_action(false, 2.0) == "roll-back" and PKeyStages.boot_guard_action(true, 1.0) == "apply-staged")


static func _walk(events: Array) -> Dictionary:
	var s := PKeyStages.initial_boot_state()
	for e in events:
		s = PKeyStages.boot_transition(s, e if e is Dictionary else {"type": e})["state"]
	return s
