extends RefCounted
## Cloud Sync's shared value helpers (preloaded by the machine, the host and the routes; no public
## class). A port of the helpers at the top of Python `cloud_sync/machine.py`.
##
## The data model is plain JSON: Dictionary, Array, String, int, float, bool and null. Three Godot
## facts shape it:
##   * `null` is a value, distinct from "absent" (the TypeScript `undefined`): `ABSENT` is the
##     absent sentinel, and `json_equal(null, ABSENT)` is false (U-06.5, rule M-4);
##   * the engine's JSON parser makes every number a float. `load_json_text` restores the integers
##     (a token with no fraction or exponent, within 2^53) so `1` and `1.0` keep their type, and
##     `json_equal` compares numbers by value (`1 == 1.0`) and never treats a bool as a number;
##   * a String sorts by code point; JS order is UTF-16 code units, so `utf16_less` compares units.

const JsonStrict := preload("res://addons/polaris_key/core/json_strict.gd")

## The partition of a device nobody has signed in on.
const LOCAL_PARTITION := "local"
const DAY_MS := 86_400_000
## The most keys a partition's "ever sealed" latch holds (E2E); the oldest go first.
const SEALED_LATCH_MAX := 4096


class _Absent:
	extends RefCounted

	func _to_string() -> String:
		return "<absent>"


## "No value". A JSON null is a real value and is not this.
static var ABSENT: RefCounted = _Absent.new()


static func is_absent(v: Variant) -> bool:
	return v is _Absent


## `{"ok": true}`
static func ok() -> Dictionary:
	return {"ok": true}


## `{"ok": false, "error": error}`
static func fail(error: String) -> Dictionary:
	return {"ok": false, "error": error}


static func is_object(v: Variant) -> bool:
	return v is Dictionary


static func is_array(v: Variant) -> bool:
	return v is Array


static func is_string(v: Variant) -> bool:
	return v is String or v is StringName


## An int or a finite float; never a bool, never NaN or infinity (rule M-3).
static func is_number(v: Variant) -> bool:
	var t := typeof(v)
	if t == TYPE_INT:
		return true
	return t == TYPE_FLOAT and is_finite(v)


## A number with no fractional part (a float counts when it is whole).
static func is_integer(v: Variant) -> bool:
	var t := typeof(v)
	if t == TYPE_INT:
		return true
	return t == TYPE_FLOAT and is_finite(v) and v == floorf(v)


static func clone(v: Variant) -> Variant:
	if v is Dictionary or v is Array:
		return v.duplicate(true)
	return v


## A string as UTF-16 code units. A GDScript String holds code points; one above U+FFFF is two units.
static func utf16_units(s: String) -> PackedInt32Array:
	var out := PackedInt32Array()
	for i in s.length():
		var c := s.unicode_at(i)
		if c > 0xFFFF:
			c -= 0x10000
			out.append(0xD800 | (c >> 10))
			out.append(0xDC00 | (c & 0x3FF))
		else:
			out.append(c)
	return out


## -1, 0 or 1: JS `a < b` order (UTF-16 code units).
static func utf16_cmp(a: String, b: String) -> int:
	var ua := utf16_units(a)
	var ub := utf16_units(b)
	var n := mini(ua.size(), ub.size())
	for i in n:
		if ua[i] != ub[i]:
			return -1 if ua[i] < ub[i] else 1
	if ua.size() == ub.size():
		return 0
	return -1 if ua.size() < ub.size() else 1


static func utf16_less(a: String, b: String) -> bool:
	return utf16_cmp(a, b) < 0


## The keys of a Dictionary in UTF-16 order.
static func sorted_keys(d: Dictionary) -> Array:
	var keys: Array = d.keys()
	keys.sort_custom(func(a: Variant, b: Variant) -> bool: return utf16_less(String(a), String(b)))
	return keys


## Structural equality over JSON values: object member order is ignored, numbers compare by value
## (`1` equals `1.0`), a bool is never a number, `null` is a value and `ABSENT` equals only itself.
static func json_equal(a: Variant, b: Variant) -> bool:
	var ta := typeof(a)
	var tb := typeof(b)
	if ta == TYPE_BOOL or tb == TYPE_BOOL:
		return ta == TYPE_BOOL and tb == TYPE_BOOL and a == b
	if a is _Absent or b is _Absent:
		return a is _Absent and b is _Absent
	if ta == TYPE_ARRAY or tb == TYPE_ARRAY:
		if ta != TYPE_ARRAY or tb != TYPE_ARRAY or a.size() != b.size():
			return false
		for i in a.size():
			if not json_equal(a[i], b[i]):
				return false
		return true
	if ta == TYPE_DICTIONARY or tb == TYPE_DICTIONARY:
		if ta != TYPE_DICTIONARY or tb != TYPE_DICTIONARY or a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not json_equal(a[k], b[k]):
				return false
		return true
	if is_number(a) and is_number(b):
		return a == b
	if ta == TYPE_FLOAT or tb == TYPE_FLOAT or ta == TYPE_INT or tb == TYPE_INT:
		return false
	if ta == TYPE_NIL or tb == TYPE_NIL:
		return ta == tb
	if is_string(a) and is_string(b):
		return String(a) == String(b)
	return false


## Strict-parse JSON text (U-40.1's parser: never `JSON.parse_string`) and restore integer
## types. `{"ok": true, "value": v}` or `{"ok": false, "error": why}`.
static func load_json_text(text: String) -> Dictionary:
	if _nul_in_name(text):
		return {"ok": false, "error": "a \\u0000 escape in a name"}
	var parsed := JsonStrict.parse(text)
	if not parsed["ok"]:
		return {"ok": false, "error": parsed["error"]}
	var non_wire: Variant = parsed["non_wire_integers"]
	return {"ok": true, "value": _restore(parsed["value"], "", non_wire)}


## As `load_json_text`, for UTF-8 bytes (a served body): ill-formed UTF-8, a BOM and a raw NUL are refused.
static func load_json_bytes(bytes: PackedByteArray) -> Dictionary:
	if _nul_in_name(bytes.get_string_from_utf8()):
		return {"ok": false, "error": "a \\u0000 escape in a name"}
	var parsed := JsonStrict.parse_bytes(bytes)
	if not parsed["ok"]:
		return {"ok": false, "error": parsed["error"]}
	return {"ok": true, "value": _restore(parsed["value"], "", parsed["non_wire_integers"])}


## As `load_json_text`, for a file (a missing file is `ok: false`).
static func load_json_file(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {"ok": false, "error": "missing file %s" % path}
	return load_json_text(FileAccess.get_file_as_string(path))


static var _name_re: RegEx


## A real `\u0000` escape inside a NAME: the string of a `setting`, `member`, `key`, `renamedTo` or
## `k` member, or the strings of a `record` array or an `aliases` map. A GDScript String cannot hold
## NUL, so such a name would read as U+FFFD and collide with a different name (HC-4): refuse the
## text. A value keeps the U+FFFD replacement (the wire contract), so a value with NUL, which
## another SDK may legitimately write, still pulls. (A member NAME with the escape is refused by
## the strict parser itself.)
static func _nul_in_name(text: String) -> bool:
	if not text.contains("\\u0000"):
		return false
	if _name_re == null:
		_name_re = RegEx.create_from_string("\"(?:setting|member|key|renamedTo|k|record|aliases)\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|\\[[^\\]]*\\]|\\{[^}]*\\})")
	for m in _name_re.search_all(text):
		var g := m.get_string(1)
		if JsonStrict.nul_as_fffd(g) != g:
			return true
	return false


static func _restore(v: Variant, pointer: String, non_wire: Variant) -> Variant:
	var t := typeof(v)
	if t == TYPE_DICTIONARY:
		var out := {}
		for k in v:
			out[k] = _restore(v[k], pointer + "/" + String(k).replace("~", "~0").replace("/", "~1"), non_wire)
		return out
	if t == TYPE_ARRAY:
		var arr := []
		for i in v.size():
			arr.append(_restore(v[i], pointer + "/" + str(i), non_wire))
		return arr
	if t == TYPE_FLOAT and is_finite(v) and absf(v) < 9007199254740992.0 and v == floorf(v) and not non_wire.has(pointer):
		return int(v)
	return v
