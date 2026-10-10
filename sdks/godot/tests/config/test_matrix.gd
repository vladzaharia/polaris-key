extends RefCounted
# @pkey-feature config.resolve config.list
# The Godot runner for `conformance/corpus/v2/config-matrix.json` (WIRE-CONTRACT-V3 §2.2.1), read
# from the generator-owned mirror res://tests/corpus/v2/config-matrix.json (written by
# `pnpm gen corpus`; never edit it). Every resolve, environment-value and list case runs through
# PKeyConfigResolve twice: with the environment layer on, against `expect`, and with a
# PKeyConfigEnv whose `enabled` is false (as CONFIG_ENV_NEVER and a release web or mobile build
# leave it), against `expectNoEnv` where present, else `expect`.
#
# Comparison is canonical JSON: keys unordered, arrays ordered, numbers by value. Under
# WIRE-CONTRACT-V3 §10 a number's value is Godot's own reading, which is not correctly rounded;
# the matrix compares only numbers every SDK reads alike, and pins the two range edges as
# `anyNumber`.

const MATRIX := "res://tests/corpus/v2/config-matrix.json"
const CONFIG_MATRIX_VERSION := 1
const FLOORS := {"resolveCases": 24, "envValueCases": 82, "listCases": 8}


func run(t: PKeyTestContext) -> void:
	if not t.check("matrix: config-matrix.json present", FileAccess.file_exists(MATRIX), MATRIX):
		return
	var j := JSON.new()
	if not t.check("matrix: config-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var m: Dictionary = j.data
	t.check("matrix: configMatrixVersion", m.get("configMatrixVersion") is float and int(m["configMatrixVersion"]) == CONFIG_MATRIX_VERSION, str(m.get("configMatrixVersion")))
	for section in FLOORS:
		t.check("matrix: %s floor" % section, m.get(section) is Array and m[section].size() >= FLOORS[section], "%d rows" % (m[section].size() if m.get(section) is Array else -1))
	_resolve_cases(t, m.get("resolveCases", []))
	_env_value_cases(t, m.get("envValueCases", []))
	_list_cases(t, m.get("listCases", []))
	_doctored(t, m)


## A context over the row's tables, with the environment layer on or off.
static func _ctx(row: Dictionary, env_on: bool) -> PKeyConfigResolve.Context:
	var local: Dictionary = row["localOverrides"]
	var table: Dictionary = row["env"]
	var layer := PKeyConfigEnv.new()
	layer.prefix = row["envPrefix"]
	layer.enabled = env_on
	layer.reader = func(name: String) -> Variant: return table.get(name)
	var c := PKeyConfigResolve.Context.new()
	c.remote = row["remote"]
	c.local = func(key: String) -> Array: return [local[key]] if local.has(key) else []
	# A bound method does not keep its RefCounted object alive; the lambda's capture does.
	c.env = func(name: String) -> Variant: return layer.lookup(name)
	c.env_prefix = row["envPrefix"]
	return c


static func _is_number(v: Variant) -> bool:
	return v is int or v is float


## Canonical JSON equality: keys unordered, arrays ordered, numbers by value (-0 equals 0).
static func _canon_eq(a: Variant, b: Variant) -> bool:
	if _is_number(a) and _is_number(b):
		return float(a) == float(b)
	if a == null or b == null:
		return a == null and b == null
	if a is bool or b is bool:
		return a is bool and b is bool and a == b
	if a is String and b is String:
		return a == b
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _canon_eq(a[i], b[i]):
				return false
		return true
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _canon_eq(a[k], b[k]):
				return false
		return true
	return false


static func _resolve(row: Dictionary, env_on: bool) -> Dictionary:
	var c := _ctx(row, env_on)
	var r := PKeyConfigResolve.resolve(c, row["key"])
	return {"value": r["value"] if r["found"] else row["fallback"], "source": String(r["source"])}


static func _passes(got: Dictionary, want: Dictionary) -> bool:
	return got["source"] == want["source"] and _canon_eq(got["value"], want["value"])


func _resolve_cases(t: PKeyTestContext, rows: Array) -> void:
	for row in rows:
		var want_off: Dictionary = row["expectNoEnv"] if row.get("expectNoEnv") is Dictionary else row["expect"]
		var on := _resolve(row, true)
		var off := _resolve(row, false)
		t.check("matrix: resolve %s" % row["id"], _passes(on, row["expect"]), "%s, want %s" % [on, row["expect"]])
		t.check("matrix: resolve %s without an environment" % row["id"], _passes(off, want_off), "%s, want %s" % [off, want_off])


## An envValueCase as the resolve case the file's description expands it to.
static func _expand(row: Dictionary) -> Dictionary:
	return {
		"remote": null,
		"localOverrides": {},
		"env": {"PKEY_CONFIG_value": row["raw"]},
		"envPrefix": "PKEY_CONFIG_",
		"key": "value",
		"fallback": "(fallback)",
	}


func _env_value_cases(t: PKeyTestContext, rows: Array) -> void:
	var started := Time.get_ticks_usec()
	for row in rows:
		var c := _expand(row)
		var on := _resolve(c, true)
		var ok: bool
		if row.get("anyNumber") == true:
			ok = on["source"] == "env" and _is_number(on["value"]) and is_finite(float(on["value"]))
		else:
			ok = _passes(on, {"value": row["value"], "source": "env"})
		var shown: String = JSON.stringify(on["value"]) if not (on["value"] is String) or on["value"].length() < 200 else "(%d characters)" % on["value"].length()
		t.check("matrix: env value %s" % row["id"], ok, "%s (%s)" % [shown, on["source"]])
		var off := _resolve(c, false)
		t.check("matrix: env value %s without an environment" % row["id"], _passes(off, {"value": "(fallback)", "source": "fallback"}), str(off))
	t.info("matrix: %d env values in %.1f ms" % [rows.size(), (Time.get_ticks_usec() - started) / 1000.0])


static func _list(row: Dictionary, env_on: bool) -> Array:
	var rows := PKeyConfigResolve.list_user_entries(_ctx(row, env_on))
	rows.sort_custom(func(a, b): return String(a["key"]) < String(b["key"]))
	return rows


static func _list_passes(got: Array, want: Array) -> bool:
	if got.size() != want.size():
		return false
	for i in got.size():
		if got[i]["key"] != want[i]["key"] or got[i]["enforced"] != want[i]["enforced"] or not _canon_eq(got[i]["value"], want[i]["value"]):
			return false
	return true


func _list_cases(t: PKeyTestContext, rows: Array) -> void:
	for row in rows:
		var want_off: Array = row["expectNoEnv"] if row.get("expectNoEnv") is Array else row["expect"]
		t.check("matrix: list %s" % row["id"], _list_passes(_list(row, true), row["expect"]), str(_list(row, true)))
		t.check("matrix: list %s without an environment" % row["id"], _list_passes(_list(row, false), want_off), str(_list(row, false)))


func _doctored(t: PKeyTestContext, m: Dictionary) -> void:
	var row: Dictionary = m["resolveCases"][0]
	var doctored: Dictionary = row["expect"].duplicate()
	doctored["value"] = "doctored"
	t.check("matrix: a doctored resolve row fails the same comparison", _passes(_resolve(row, true), row["expect"]) and not _passes(_resolve(row, true), doctored))
	var list_row: Dictionary = m["listCases"][0]
	t.check("matrix: a doctored list row fails the same comparison", _list_passes(_list(list_row, true), list_row["expect"]) and not _list_passes(_list(list_row, true), list_row["expect"].slice(1)))
