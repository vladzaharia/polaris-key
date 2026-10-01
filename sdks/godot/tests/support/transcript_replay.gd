class_name PKeyTranscriptReplay
extends RefCounted
## The transcript replay engine (P1b-03, PARITY §4.2): a port of
## conformance/runners/node/transcriptReplay.ts (and sdks/python/tests/transcript_replay.py), so
## every SDK is held to one recording in one way. The format is documented once, in
## packages/worker/test/transcripts/format.ts; the files are the generator-owned Godot mirror of
## conformance/transcripts/ at res://tests/transcripts/.
##
## `handle` is a PKeyFakeServer handler. It never fails the transport: an SDK may swallow a
## transport error (a best-effort report does), so a mismatch could vanish. Every problem is
## RECORDED and answered with a 599, and `end_step` returns the full list.
##
## The server origin is the fake server's loopback address, not the recorded `baseUrl`: every
## request that reaches it was sent to the one origin the SDK was configured with.

var transcript: Dictionary
var bindings := {}
var failures: Array = []

var _step = null
var _index := -1
var _served: Array = []
var _placeholder := RegEx.create_from_string("\\{([A-Za-z][A-Za-z0-9]*)\\}")


func _init(t: Dictionary) -> void:
	transcript = t
	bindings["deviceId"] = t["initial"]["deviceId"]
	bindings["version"] = t["initial"]["version"]
	if t["initial"].get("token") is String:
		bindings["token"] = t["initial"]["token"]


## Every feature the transcript proves is `implemented` in `manifest`, and nothing it presupposes
## is `na`. `pnpm parity:check` applies the same rule.
static func applies(t: Dictionary, manifest: Dictionary) -> bool:
	var features: Dictionary = manifest.get("features", {})
	for f in t["features"]:
		if features.get(f, {}).get("status") != "implemented":
			return false
	for f in t["requires"]:
		if features.get(f, {}).get("status") == "na":
			return false
	return true


func begin_step(index: int) -> Dictionary:
	_step = transcript["steps"][index]
	_index = index
	_served = []
	for i in _step["exchanges"]["items"].size():
		_served.append(false)
	for k in _step["args"]:
		if _step["args"][k] is String:
			bindings[k] = _step["args"][k]
	return _step


## Ends the step: [] when every recorded request was sent and nothing else was.
func end_step() -> Array:
	if _step != null:
		var items: Array = _step["exchanges"]["items"]
		for i in items.size():
			if not _served[i]:
				failures.append("expected request not sent: %s %s" % [items[i]["request"]["method"], items[i]["request"]["path"]])
	var out := failures.duplicate()
	if not out.is_empty():
		out.push_front("%s step %d (%s):" % [transcript["id"], _index, _step["action"] if _step != null else "?"])
	failures.clear()
	_step = null
	return out


## The PKeyFakeServer handler.
func handle(req: Dictionary) -> Dictionary:
	var label := "%s %s" % [req["method"], req["path"]]
	if _step == null:
		failures.append("unexpected request outside a step: %s" % label)
		return _no_match()
	var items: Array = _step["exchanges"]["items"]
	var candidates: Array = []
	for i in items.size():
		var r: Dictionary = items[i]["request"]
		if not _served[i] and r["method"] == req["method"] and r["path"] == req["path"]:
			candidates.append(i)
	if _step["exchanges"]["ordered"]:
		var nxt := _served.find(false)
		candidates = candidates.filter(func(i): return i == nxt)
	if candidates.is_empty():
		failures.append("unexpected request: %s" % label)
		return _no_match()
	for i in candidates:
		if problems(items[i], req).is_empty():
			_served[i] = true
			_capture(items[i])
			return _respond(items[i]["response"])
	failures.append("request %s does not match the recording:\n    %s" % [label, "\n    ".join(problems(items[candidates[0]], req))])
	return _no_match()


func problems(item: Dictionary, req: Dictionary) -> Array:
	var out: Array = []
	var expected: Dictionary = item["request"]
	var headers: Dictionary = req["headers"]
	for name in expected["headers"]:
		var sub := _substitute(expected["headers"][name])
		var actual = headers.get(String(name).to_lower())
		if sub.has("unbound"):
			out.append("header %s: sent before {%s} was bound (an earlier response it depends on)" % [name, sub["unbound"]])
		elif actual == null:
			out.append("header %s: missing" % name)
		elif actual != sub["value"]:
			out.append("header %s: expected %s, got %s" % [name, JSON.stringify(sub["value"]), JSON.stringify(actual)])
	for name in expected["requiredHeaders"]:
		if not headers.has(String(name).to_lower()):
			out.append("required header %s: missing" % name)
	var body: PackedByteArray = req["body"]
	var want = expected["body"]
	if want == null:
		if not body.is_empty():
			out.append("body: expected none, got %s" % body.get_string_from_utf8().left(120))
	elif body.is_empty():
		out.append("body: expected a JSON body, got none")
	else:
		var j := JSON.new()
		if j.parse(body.get_string_from_utf8()) != OK:
			out.append("body: not JSON")
			return out
		for p in body_problems(want["json"], j.data, want["match"], "$"):
			out.append("body %s" % p)
		if want.get("allowedKeys") is Array and j.data is Dictionary:
			for k in j.data:
				if not want["allowedKeys"].has(k):
					out.append("body: key \"%s\" is not allowed" % k)
	return out


static func _type_of(v: Variant) -> String:
	if v == null:
		return "null"
	if v is bool:
		return "boolean"
	if v is int or v is float:
		return "number"
	if v is String:
		return "string"
	if v is Array:
		return "array"
	return "object"


static func _equal(a: Variant, b: Variant) -> bool:
	return _type_of(a) == _type_of(b) and a == b


static func body_problems(expected: Variant, actual: Variant, mode: String, path: String) -> Array:
	if mode == "exact":
		return [] if _equal(expected, actual) else ["%s: expected %s, got %s" % [path, JSON.stringify(expected), JSON.stringify(actual)]]
	if expected is Dictionary:
		if not (actual is Dictionary):
			return ["%s: expected an object, got %s" % [path, _type_of(actual)]]
		var out: Array = []
		for k in expected:
			if not actual.has(k):
				out.append("%s.%s: missing" % [path, k])
			else:
				out.append_array(body_problems(expected[k], actual[k], mode, "%s.%s" % [path, k]))
		return out
	if mode == "shape":
		return [] if _type_of(expected) == _type_of(actual) else ["%s: expected a %s, got %s" % [path, _type_of(expected), _type_of(actual)]]
	return [] if _equal(expected, actual) else ["%s: expected %s, got %s" % [path, JSON.stringify(expected), JSON.stringify(actual)]]


func _substitute(template: String) -> Dictionary:
	var out := ""
	var at := 0
	for m in _placeholder.search_all(template):
		var name := m.get_string(1)
		if not bindings.has(name):
			return {"unbound": name}
		out += template.substr(at, m.get_start() - at) + str(bindings[name])
		at = m.get_end()
	return {"value": out + template.substr(at)}


func _capture(item: Dictionary) -> void:
	var cap = item.get("capture")
	if not (cap is Dictionary):
		return
	for name in cap:
		var cur = item["response"]["body"]
		for part in String(cap[name]).substr(2).split("."):
			cur = cur.get(part) if cur is Dictionary else null
		if cur is String:
			bindings[name] = cur
		else:
			failures.append("capture %s (%s) found no string" % [name, cap[name]])


static func _respond(response: Dictionary) -> Dictionary:
	var b = response["body"]
	return {
		"status": int(response["status"]),
		"headers": response["headers"],
		"body": b if b is String else JSON.stringify(b, "", false),
	}


static func _no_match() -> Dictionary:
	return {"status": 599, "body": "replay: no matching exchange"}
