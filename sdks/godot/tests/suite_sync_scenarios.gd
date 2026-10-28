extends RefCounted
# @pkey-feature sync.scenarios
# @pkey-feature sync.settings config.sync
# `sync-scenarios.json`: the Cloud Sync client state machine and the setting routes.
#
# Mirrors sdks/python/tests/test_sync_scenarios.py. The corpus is read from the generator-owned
# mirror through the strict parser (ints stay ints). `settingCases` runs in full and every
# scenario replays: there is no skip list (U-21.5 deleted PENDING), and the run asserts the replay
# count equals the corpus count. The X-1 conflict-copy unit test and the principal, blocked and
# 410 paths are in tests/core/test_cloud_sync_machine.gd.
#
# The machine contract the driver calls (snake_case; `set`/`get` are Object methods, so the value
# calls are `set_value`/`get_value`/`clear_value`): the constructor takes the opts Dictionary
# built in `_opts`; `import_local(v)`, `set_value(k, v)`, `clear_value(k)`, `put(c, id, v)`,
# `add(c, id, v)`, `remove(c, id, v)`, `flush()`, `refresh()` (each returns a Dictionary),
# `advance(ms)`, `set_network(state)`, `receive(res, opened)`, `set_root(has)`, `sign_in(subject)`,
# `sign_out(discard)`, `take_requests()`, `take_events()`, `get_value(k)`, `setting_state(k)`,
# `record(collection, id)`, `journal()`, `status()`, `encryption_since()`.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Routes := preload("res://addons/polaris_key/core/sync/sync_routes.gd")

const CORPUS := "res://tests/corpus/v2/sync-scenarios.json"
const STEP_KINDS := ["local", "advance", "network", "respond", "signIn", "signOut", "relaunch", "root", "assert"]
const CALLS := ["set", "clear", "put", "add", "remove", "flush", "refresh"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var loaded := Types.load_json_file(CORPUS)
	if not t.check("corpus loads through the strict parser", loaded["ok"], str(loaded.get("error", ""))):
		return true
	var corpus: Dictionary = loaded["value"]
	_helpers(t)
	_constants(t, corpus)
	_shape(t, corpus)
	_setting_cases(t, corpus["settingCases"])
	_scenarios(t, corpus)
	_misuse(t, corpus)
	return true


func _constants(t: PKeyTestContext, corpus: Dictionary) -> void:
	t.check("syncScenariosVersion is the generated constant", Types.json_equal(corpus["syncScenariosVersion"], PKeyConstants.SYNC_SCENARIOS_VERSION))
	t.check("corpus constants are the generated ones", Types.json_equal(corpus["constants"], {
		"debounceMs": PKeyConstants.SYNC_DEBOUNCE_MS,
		"signOutFlushMs": PKeyConstants.SYNC_SIGNOUT_FLUSH_MS,
		"pendingDays": PKeyConstants.SYNC_PENDING_DAYS,
		"maxMutationsPerPush": PKeyConstants.SYNC_MAX_MUTATIONS,
		"maxClockSkewMs": PKeyConstants.SYNC_MAX_CLOCK_SKEW_MS,
		"maxValueBytes": PKeyConstants.SYNC_MAX_VALUE_BYTES,
	}))


## A corpus change the driver does not know fails here, before any scenario replays.
func _shape(t: PKeyTestContext, corpus: Dictionary) -> void:
	t.check("the step kinds are the driver's", Types.json_equal(corpus["steps"], STEP_KINDS))
	t.check("the calls are the driver's", Types.json_equal(corpus["calls"], CALLS))
	var names := {}
	var unknown := 0
	for sc: Dictionary in corpus["scenarios"]:
		names[sc["name"]] = true
		for step: Dictionary in sc["steps"]:
			var kind: String = step.keys()[0]
			if not STEP_KINDS.has(kind) or step.size() != 1:
				unknown += 1
			elif kind == "local" and not CALLS.has(step[kind]["call"]):
				unknown += 1
	t.check("scenario names are unique", names.size() == corpus["scenarios"].size())
	t.check("every step and call is known", unknown == 0, str(unknown))
	t.check("the corpus has scenarios, rules and setting cases", corpus["scenarios"].size() > 0 and corpus["rules"].size() > 0 and corpus["settingCases"].size() > 0)


func _setting_cases(t: PKeyTestContext, cases: Array) -> void:
	for c: Dictionary in cases:
		var issues: Array = []
		for e: Dictionary in c["entries"]:
			for i: Dictionary in Routes.user_setting_issues(e):
				issues.append({"key": e["key"], "code": i["code"], "severity": i["severity"]})
		var name: String = c["name"]
		t.check("%s: issues" % name, Types.json_equal(issues, c["issues"]))
		if c["routes"] == null:
			var blocked := false
			for i: Dictionary in issues:
				blocked = blocked or i["severity"] == "error"
			t.check("%s: an error blocks" % name, blocked)
			continue
		var routes := Routes.synced_settings({"entries": c["entries"]})
		t.check("%s: routes" % name, Types.json_equal(routes, c["routes"]))
		var open_clean := true
		for key in c["open"]:
			for r: Dictionary in routes:
				open_clean = open_clean and r["key"] != key
		t.check("%s: open keys have no route" % name, open_clean)
	t.check("setting cases evaluated", cases.size() > 0)


func _scenarios(t: PKeyTestContext, corpus: Dictionary) -> void:
	var ran := 0
	for sc: Dictionary in corpus["scenarios"]:
		_replay(t, corpus, sc)
		ran += 1
	t.check("every corpus scenario replays (no skip list)", ran == corpus["scenarios"].size(), "%d" % ran)


func _opts(corpus: Dictionary, init: Dictionary, ids: Array) -> Dictionary:
	return {
		"product": corpus["product"],
		"catalog": init["catalog"],
		"document": init["document"],
		"now": init["clock"]["now"],
		"offsetMs": init["clock"]["offsetMs"],
		"contacted": init["clock"]["contacted"],
		"subject": init["subject"],
		"network": init["network"],
		"onSignOut": init["options"]["onSignOut"],
		"encryption": init["encryption"],
		"hasRoot": init["hasRoot"],
		"newClientId": func() -> String: return ids.pop_front(),
	}


func _call(m: Variant, name: String, args: Array) -> Dictionary:
	match name:
		"set":
			return m.set_value(args[0], args[1])
		"clear":
			return m.clear_value(args[0])
		"put":
			return m.put(args[0], args[1], args[2])
		"add":
			return m.add(args[0], args[1], args[2])
		"remove":
			return m.remove(args[0], args[1], args[2])
		"flush":
			return m.flush()
	return m.refresh()


## One scenario against the machine (Python `test_scenario`).
func _replay(t: PKeyTestContext, corpus: Dictionary, sc: Dictionary) -> void:
	var init: Dictionary = sc["init"]
	var ids: Array = init["clientIds"].duplicate()
	var opts := _opts(corpus, init, ids)
	var machine_script: GDScript = load("res://addons/polaris_key/core/sync/cloud_sync_machine.gd")
	var m: Variant = machine_script.new(opts)
	var licence: Variant = Types.clone(init["licence"])
	var name: String = sc["name"]
	if init["legacyLocal"] != null:
		t.check("%s: import" % name, Types.json_equal(m.import_local(init["legacyLocal"]), {"ok": true}))
	var i := 0
	for step: Dictionary in sc["steps"]:
		i += 1
		var kind: String = step.keys()[0]
		var raw: Dictionary = step[kind]
		var where := "%s, step %d (%s)" % [name, i, kind]
		match kind:
			"local":
				var result := _call(m, raw["call"], raw.get("args", []))
				if raw.has("expect"):
					t.check(where, Types.json_equal(result, raw["expect"]))
			"advance":
				m.advance(raw["ms"])
			"network":
				t.check(where, m.set_network(raw["state"])["ok"])
			"respond":
				var res: Dictionary = {"status": raw["status"], "body": raw["body"]} if raw.has("opened") else raw
				t.check(where, m.receive(res, raw.get("opened"))["ok"])
			"root":
				m.set_root(raw.get("has") == true)
			"signIn":
				m.sign_in(raw["subject"])
			"signOut":
				m.sign_out(raw.get("discardUnsynced") == true)
			"relaunch":
				m = machine_script.relaunch(m, opts, "lost" if raw.get("journal") == "lost" else "kept")
			"assert":
				_assert(t, m, raw, where, licence)


func _assert(t: PKeyTestContext, m: Variant, raw: Dictionary, where: String, licence: Variant) -> void:
	var requests: Variant = m.take_requests()
	var events: Variant = m.take_events()
	if raw.has("requests"):
		t.check("%s: requests" % where, Types.json_equal(requests, raw["requests"]))
	if raw.has("events"):
		t.check("%s: events" % where, Types.json_equal(events, raw["events"]))
	var values: Dictionary = raw.get("values", {})
	for key in values:
		t.check("%s: values.%s" % [where, key], Types.json_equal(m.get_value(key), values[key]))
	var states: Dictionary = raw.get("states", {})
	for key in states:
		t.check("%s: states.%s" % [where, key], Types.json_equal(m.setting_state(key), states[key]))
	var records: Dictionary = raw.get("records", {})
	for key: String in records:
		var parts := key.split("/", true, 1)
		t.check("%s: records.%s" % [where, key], Types.json_equal(m.record(parts[0], parts[1]), records[key]))
	if raw.has("journal"):
		t.check("%s: journal" % where, Types.json_equal(m.journal(), raw["journal"]))
	if raw.has("status"):
		t.check("%s: status" % where, Types.json_equal(m.status(), raw["status"]))
	if raw.has("encryptionSince"):
		t.check("%s: encryptionSince" % where, Types.json_equal(m.encryption_since(), raw["encryptionSince"]))
	if raw.has("licence"):
		t.check("%s: licence" % where, Types.json_equal(licence, raw["licence"]))


## The value helpers (the Python ones are pinned by the scenarios; these cover the Godot seams).
func _helpers(t: PKeyTestContext) -> void:
	t.check("json_equal: 1 equals 1.0", Types.json_equal(1, 1.0) and Types.json_equal({"a": [1]}, {"a": [1.0]}))
	t.check("json_equal: a bool is not a number", not Types.json_equal(true, 1) and not Types.json_equal(0, false) and Types.json_equal(true, true))
	t.check("json_equal: null is a value, absent is not null", Types.json_equal(null, null) and not Types.json_equal(null, Types.ABSENT) and Types.json_equal(Types.ABSENT, Types.ABSENT) and not Types.json_equal(Types.ABSENT, 0))
	t.check("json_equal: null is not 0, '' or false", not Types.json_equal(null, 0) and not Types.json_equal(null, "") and not Types.json_equal(false, null))
	t.check("json_equal: member order is ignored, a missing member is not", Types.json_equal({"a": 1, "b": 2}, {"b": 2, "a": 1}) and not Types.json_equal({"a": 1}, {"a": 1, "b": null}))
	t.check("json_equal: arrays are ordered and typed", not Types.json_equal([1, 2], [2, 1]) and not Types.json_equal([], {}) and not Types.json_equal("1", 1))
	t.check("json_equal: NaN equals nothing", not Types.json_equal(NAN, NAN) and not Types.json_equal(INF, INF))
	t.check("is_number: finite only, never a bool", Types.is_number(1) and Types.is_number(1.5) and not Types.is_number(INF) and not Types.is_number(NAN) and not Types.is_number(true) and not Types.is_number("1"))
	t.check("is_integer: whole numbers", Types.is_integer(3) and Types.is_integer(3.0) and not Types.is_integer(3.5) and not Types.is_integer(INF) and not Types.is_integer(false))
	var high := String.chr(0xFFFF)
	var astral := String.chr(0x1F600)
	t.check("utf16_less: code units, not code points", Types.utf16_less(astral, high) and not Types.utf16_less(high, astral) and Types.utf16_cmp("a", "a") == 0 and Types.utf16_less("a", "ab"))
	t.check("sorted_keys: UTF-16 order", Types.sorted_keys({high: 1, astral: 2, "z": 3}) == ["z", astral, high])
	var j := Types.load_json_text('{"i": 1, "f": 1.0, "e": 1e2, "big": 9007199254740993, "n": null, "a": [2, 2.5]}')
	var v: Dictionary = j["value"]
	t.check("loader: ints stay ints, 1.0 and 1e2 stay floats", j["ok"] and typeof(v["i"]) == TYPE_INT and typeof(v["f"]) == TYPE_FLOAT and typeof(v["e"]) == TYPE_FLOAT and typeof(v["a"][0]) == TYPE_INT and typeof(v["a"][1]) == TYPE_FLOAT)
	t.check("loader: a number past 2^53 is not made an int, null is kept", typeof(v["big"]) == TYPE_FLOAT and v.has("n") and v["n"] == null)
	t.check("loader: a \\u0000 escape in a name fails closed: setting, member, key, renamedTo, k, record, aliases", not Types.load_json_text('{"setting":"a\\u0000b"}')["ok"] and not Types.load_json_text('{"member":"m\\u0000"}')["ok"] \
			and not Types.load_json_text('{"key":"\\u0000k"}')["ok"] and not Types.load_json_text('{"renamedTo":"x\\u0000"}')["ok"] and not Types.load_json_bytes('{"k":"x\\u0000"}'.to_utf8_buffer())["ok"] \
			and not Types.load_json_text('{"record":["c","i\\u0000"]}')["ok"] and not Types.load_json_text('{"aliases":{"a":"b\\u0000"}}')["ok"] and not Types.load_json_text('{"a\\u0000":1}')["ok"])
	t.check("loader: a \\u0000 escape in a value keeps the U+FFFD replacement, and an escaped backslash is text", Types.load_json_text('{"value":"p\\u0000q"}')["value"]["value"] == "p\ufffdq" and Types.load_json_text('["a\\u0000"]')["ok"] and Types.load_json_text('{"setting":"a\\\\u0000b"}')["ok"])
	t.check("loader: strict (trailing comma, duplicate key, leading zero)", not Types.load_json_text('{"a":1,}')["ok"] and not Types.load_json_text('{"a":1,"a":2}')["ok"] and not Types.load_json_text("[01]")["ok"])


## Host misuse never relies on `assert` (a release template strips it): an error result, always.
func _misuse(t: PKeyTestContext, corpus: Dictionary) -> void:
	var sc: Dictionary = corpus["scenarios"][0]
	var init: Dictionary = sc["init"]
	var ids: Array = init["clientIds"].duplicate()
	var machine_script: GDScript = load("res://addons/polaris_key/core/sync/cloud_sync_machine.gd")
	var m: Variant = machine_script.new(_opts(corpus, init, ids))
	var empty: Variant = m.take_requests()
	var in_flight: bool = m.status()["state"] == "syncing"
	if not in_flight:
		m.refresh()
		m.set_network("offline")
		m.set_network("online")
		in_flight = m.status()["state"] == "syncing"
	t.check("misuse: a signed-in machine has a request in flight", in_flight and empty.size() >= 1)
	var off: Dictionary = m.set_network("offline")
	t.check("misuse: set_network(offline) in flight is refused, not asserted", not off["ok"] and off["error"] == "request-in-flight" and m.network_state() == "online")
	m.receive({"error": "transport"})
	var again: Dictionary = m.receive({"error": "transport"})
	t.check("misuse: receive with nothing in flight is an error result", not again["ok"] and again["error"] == "no-request-in-flight")
