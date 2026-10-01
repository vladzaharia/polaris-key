@tool
class_name PKeyJson
extends RefCounted
## Strict JSON for everything Polaris Key parses: RFC 8259 exactly as `JSON.parse` reads it, plus
## duplicate-key rejection at any depth (shared-jws `hasDuplicateKeys`).
##
## Godot's own parser is lenient (notes/A5 §2): it accepts trailing commas, leading zeros, `1.`,
## raw control characters in strings and keeps the LAST duplicate key. So no byte reaches
## `JSON` until this validator has passed the text:
##
##   1. one native RegEx pass tokenizes the text; a token that does not start where the last
##      one ended is a byte no JSON token covers (a bad escape, a raw control character, `1.`,
##      `+1`, an unterminated string, a stray letter) and fails the text;
##   2. a GDScript state machine walks the tokens (a handful for a bundle, hundreds for a
##      document) and enforces the grammar and the duplicate-key rule;
##   3. only then `JSON.new().parse()` builds the value, and its `Error` is checked —
##      `JSON.parse_string` is never used because its `null` is ambiguous with JSON `null`.
##
## WIRE-CONTRACT-V3 §10 (the U+0000 representation limit, P1-01's decision): a GDScript `String`
## cannot hold U+0000, so every real `\u0000` escape becomes `�` before steps 1–3. An
## escaped backslash before `u0000` (`\\u0000`) is text and stays.
##
## WIRE-CONTRACT-V4 §1.2 (P3-02): the walk also refuses a member name whose escape is a real
## `\u0000` (checked on the raw text, before `nul_as_fffd`), every number token outside
## binary64's range judged from its digits (rule 8: `1e400`, `1e-400`, `5e-324`, `1e4294967297`,
## which Godot reads as 10), and nesting past `MAX_JSON_DEPTH` (64) levels; `parse_bytes`
## refuses ill-formed UTF-8 and a leading BOM (no longer stripped). Every lone surrogate escape
## is refused, as Godot's parser always did. The walk records `non_wire_integers`: the RFC 6901
## pointer of every number token that cannot be a wire integer (a fraction or exponent part, or
## digits above 2^53 − 1), from which `PKeyClaims.is_wire_integer` decides every integer claim.
## Numbers are float64, and Godot's parser is not correctly rounded in their last bits (a V4 §10
## representation limit); a claim is always exact, because its token is checked.

const _TOKEN := "[ \\t\\n\\r]++" \
		+ "|\"(?:[^\"\\\\\\x00-\\x1f]++|\\\\(?:[\"\\\\/bfnrt]|u[0-9A-Fa-f]{4}))*+\"" \
		+ "|-?(?:0|[1-9][0-9]*+)(?:\\.[0-9]++)?(?:[eE][+-]?[0-9]++)?" \
		+ "|true|false|null" \
		+ "|[{}\\[\\]:,]"

# Parser states: what the next significant token may be.
enum { _VALUE, _VALUE_OR_CLOSE, _KEY, _KEY_OR_CLOSE, _COLON, _COMMA_OR_CLOSE, _END }

## WIRE-CONTRACT-V4 §1.2 rule 9: the top-level value is level 1.
const MAX_JSON_DEPTH := 64
const _MAX_WIRE_DIGITS := "9007199254740991"

static var _token_re: RegEx
static var _nul_re: RegEx
static var _plain_int_re: RegEx


static func _static_init() -> void:
	_token_re = RegEx.create_from_string(_TOKEN)
	_nul_re = RegEx.create_from_string("(?<!\\\\)((?:\\\\\\\\)*)\\\\u0000")
	_plain_int_re = RegEx.create_from_string("\\A-?(?:0|[1-9][0-9]*)\\z")


## Parse `text` strictly. Returns `{"ok": true, "value": v, "non_wire_integers": PointerSet}`
## or `{"ok": false, "error": why}`.
static func parse(text: String) -> Dictionary:
	var scan := walk(text)
	if scan["error"] != "":
		return {"ok": false, "error": scan["error"]}
	var t := nul_as_fffd(text)
	var j := JSON.new()
	if j.parse(t) != OK:
		return {"ok": false, "error": "engine parse failed at line %d: %s" % [j.get_error_line(), j.get_error_message()]}
	return {"ok": true, "value": j.data, "non_wire_integers": scan["non_wire_integers"]}


## Parse UTF-8 bytes strictly. A raw NUL byte is refused before decoding (Godot's decoder would
## turn it into U+FFFD, which a string accepts, where `JSON.parse` rejects the control
## character). WIRE-CONTRACT-V4 §1.2 rules 1–2: the bytes must be well-formed UTF-8 (Godot's
## decoder replaces an ill-formed sequence, so the re-encoded text must equal the bytes), and a
## leading BOM is refused rather than stripped.
static func parse_bytes(bytes: PackedByteArray) -> Dictionary:
	if bytes.find(0) != -1:
		return {"ok": false, "error": "raw NUL byte"}
	if bytes.size() >= 3 and bytes[0] == 0xEF and bytes[1] == 0xBB and bytes[2] == 0xBF:
		return {"ok": false, "error": "byte order mark"}
	var text := bytes.get_string_from_utf8()
	if text.to_utf8_buffer() != bytes:
		return {"ok": false, "error": "ill-formed UTF-8"}
	return parse(text)


## Compact JSON text for a value this SDK built (requests, the cache record).
static func stringify(value: Variant) -> String:
	return JSON.stringify(value, "", false)


## WIRE-CONTRACT-V3 §10: every real `\u0000` escape as `�`. No offset moves.
static func nul_as_fffd(text: String) -> String:
	if not text.contains("\\u0000"):
		return text
	return _nul_re.sub(text, "$1\\ufffd", true)


## The validator alone: "" when `text` is strict JSON without duplicate keys, else the reason.
static func validate(text: String) -> String:
	return walk(text)["error"]


## The token walk: `{"error": "" or why, "non_wire_integers": PointerSet}`. It runs on the
## RAW text, before `nul_as_fffd`, so a member name spelling a real `\u0000` is refused (V4 §1.2
## rule 7) rather than read as U+FFFD; value strings keep §10's replacement.
static func walk(text: String) -> Dictionary:
	var n := text.length()
	var pos := 0
	var state := _VALUE
	# One entry per open container: a Dictionary of the keys seen (object) or null (array), with
	# the current member name or array index in `segs` and the array counter in `idx`.
	var stack: Array = []
	var segs: PackedStringArray = []
	var idx: PackedInt64Array = []
	# `ids[k]`: the node in `non_wire` of the path `segs[0..k]`, once a number below it has been
	# recorded (-1 until then). Never a pointer string per number: with long member names over
	# many fractional numbers that grows with the square of the payload.
	var ids: PackedInt64Array = []
	var non_wire := PointerSet.new()
	for m: RegExMatch in _token_re.search_all(text):
		var start := m.get_start()
		if start != pos:
			return _refused("unexpected character at %d" % pos)
		pos = m.get_end()
		var tok := m.get_string()
		var c := tok.unicode_at(0)
		if c == 32 or c == 9 or c == 10 or c == 13:
			continue
		match state:
			_END:
				return _refused("trailing data at %d" % start)
			_COLON:
				if c != 58:  # :
					return _refused("expected ':' at %d" % start)
				state = _VALUE
				continue
			_KEY, _KEY_OR_CLOSE:
				if c == 125 and state == _KEY_OR_CLOSE:  # } of an empty object
					stack.pop_back()
					segs.resize(segs.size() - 1)
					idx.resize(idx.size() - 1)
					ids.resize(ids.size() - 1)
					state = _after_value(stack)
					continue
				if c != 34:  # "
					return _refused("expected a key at %d" % start)
				if _nul_re.search(tok) != null:
					return _refused("U+0000 in a member name at %d" % start)
				var key = _decode_string(tok)
				if key == null:
					return _refused("undecodable key at %d" % start)
				var seen: Dictionary = stack.back()
				if seen.has(key):
					return _refused("duplicate key %s at %d" % [JSON.stringify(key), start])
				seen[key] = true
				segs[segs.size() - 1] = key
				ids[ids.size() - 1] = -1
				state = _COLON
				continue
			_COMMA_OR_CLOSE:
				var top = stack.back()
				if c == 44:  # ,
					state = _KEY if top is Dictionary else _VALUE
				elif (c == 125 and top is Dictionary) or (c == 93 and top == null):  # } or ]
					stack.pop_back()
					segs.resize(segs.size() - 1)
					idx.resize(idx.size() - 1)
					ids.resize(ids.size() - 1)
					state = _after_value(stack)
				else:
					return _refused("expected ',' or a closing bracket at %d" % start)
				continue
		# _VALUE or _VALUE_OR_CLOSE
		if c == 93 and state == _VALUE_OR_CLOSE:  # ] of an empty array
			stack.pop_back()
			segs.resize(segs.size() - 1)
			idx.resize(idx.size() - 1)
			ids.resize(ids.size() - 1)
			state = _after_value(stack)
			continue
		if c == 125 or c == 93 or c == 58 or c == 44:
			return _refused("expected a value at %d" % start)
		if not stack.is_empty() and stack.back() == null:  # an array element: its index
			idx[idx.size() - 1] += 1
			segs[segs.size() - 1] = str(idx[idx.size() - 1])
			ids[ids.size() - 1] = -1
		if c == 123 or c == 91:  # { [
			if stack.size() + 1 > MAX_JSON_DEPTH:
				return _refused("nesting past %d levels at %d" % [MAX_JSON_DEPTH, start])
			stack.append({} if c == 123 else null)
			segs.append("")
			idx.append(-1)
			ids.append(-1)
			state = _KEY_OR_CLOSE if c == 123 else _VALUE_OR_CLOSE
			continue
		if c == 45 or (c >= 48 and c <= 57):  # a number
			if not number_in_range(tok):
				return _refused("number out of range at %d" % start)
			if _is_non_wire(tok):
				# Resolve the open path from its deepest recorded level, then record the number.
				var k := ids.size() - 1
				while k >= 0 and ids[k] < 0:
					k -= 1
				var node := 0 if k < 0 else ids[k]
				for j in range(k + 1, segs.size()):
					node = non_wire.child(node, segs[j])
					ids[j] = node
				non_wire.add(node)
		state = _after_value(stack)  # a string, number or literal
	if pos != n:
		return _refused("unexpected character at %d" % pos)
	if state != _END:
		return _refused("unexpected end of text")
	return {"error": "", "non_wire_integers": non_wire}


static func _refused(why: String) -> Dictionary:
	return {"error": why, "non_wire_integers": PointerSet.new()}


## WIRE-CONTRACT-V4 §3: the RFC 6901 pointers of the number tokens that cannot be wire integers,
## held as a tree of raw (unescaped) reference tokens: one node per container on the way to a
## recorded number, plus the number itself, each naming its parent. A member name is stored once
## however many numbers sit under it, so the set is linear in the payload's size (V4 §1.2: the
## verifier's work and memory are linear in the capped payload). `has` walks the tree; `keys`
## builds the escaped pointers, for callers that list them (the conformance runner).
class PointerSet extends RefCounted:
	# Node 0 is the top-level value.
	var _parent := PackedInt64Array([-1])
	var _name := PackedStringArray([""])
	var _children: Array = [null]  # per node: null, or {raw name: node}
	var _leaf := PackedByteArray([0])
	var _leaves := PackedInt64Array()

	## A set from escaped pointers (an invalid pointer is skipped).
	static func from_pointers(pointers: Array) -> PointerSet:
		var out := PointerSet.new()
		for p in pointers:
			var tokens = PointerSet.tokens(p)
			if tokens == null:
				continue
			var node := 0
			for tk in tokens:
				node = out.child(node, tk)
			out.add(node)
		return out

	## RFC 6901: the raw reference tokens of an escaped pointer, or null when it is not one (no
	## leading `/`, or a `~` not followed by `0` or `1`).
	static func tokens(pointer: String) -> Variant:
		if pointer == "":
			return []
		if not pointer.begins_with("/"):
			return null
		var out: Array = []
		for part in pointer.substr(1).split("/", true):
			var at := part.find("~")
			while at != -1:
				var next := part.substr(at + 1, 1)
				if next != "0" and next != "1":
					return null
				at = part.find("~", at + 2)
			out.append(part.replace("~1", "/").replace("~0", "~"))
		return out

	## The node for `name` under `node`, created when absent.
	func child(node: int, name: String) -> int:
		var m = _children[node]
		if m == null:
			m = {}
			_children[node] = m
		var id: int = m.get(name, -1)
		if id == -1:
			id = _parent.size()
			_parent.append(node)
			_name.append(name)
			_children.append(null)
			_leaf.append(0)
			m[name] = id
		return id

	## Record the number at `node`.
	func add(node: int) -> void:
		if _leaf[node] == 1:
			return
		_leaf[node] = 1
		_leaves.append(node)

	func has(pointer: String) -> bool:
		var path = PointerSet.tokens(pointer)
		if path == null:
			return false
		var node := 0
		for tk in path:
			var m = _children[node]
			if m == null:
				return false
			node = m.get(tk, -1)
			if node == -1:
				return false
		return _leaf[node] == 1

	func size() -> int:
		return _leaves.size()

	func is_empty() -> bool:
		return _leaves.is_empty()

	## Every pointer, escaped (`~` as `~0`, then `/` as `~1`), in document order.
	func keys() -> Array:
		var out: Array = []
		for n in _leaves:
			var parts := PackedStringArray()
			var k := n
			while k > 0:
				parts.append(_name[k].replace("~", "~0").replace("/", "~1"))
				k = _parent[k]
			parts.reverse()
			var pointer := ""
			for part in parts:
				pointer += "/" + part
			out.append(pointer)
		return out


## V4 §3: a number token that cannot be a wire integer.
static func _is_non_wire(tok: String) -> bool:
	if _plain_int_re.search(tok) == null:
		return true
	var digits := tok.trim_prefix("-")
	return digits.length() > _MAX_WIRE_DIGITS.length() or (digits.length() == _MAX_WIRE_DIGITS.length() and digits > _MAX_WIRE_DIGITS)


## V4 §1.2 rule 8, judged exactly from the token's digits: zero, or a magnitude of at least
## 10^-307 and below 10^308; an exponent of more than six significant digits is out outright.
static func number_in_range(tok: String) -> bool:
	var i := 0
	var n := tok.length()
	if i < n and tok.unicode_at(i) == 45:
		i += 1
	var int_digits := 0
	var leading_zeros := 0
	var saw_non_zero := false
	while i < n and tok.unicode_at(i) >= 48 and tok.unicode_at(i) <= 57:
		if not saw_non_zero:
			if tok.unicode_at(i) == 48:
				leading_zeros += 1
			else:
				saw_non_zero = true
		int_digits += 1
		i += 1
	if i < n and tok.unicode_at(i) == 46:  # .
		i += 1
		while i < n and tok.unicode_at(i) >= 48 and tok.unicode_at(i) <= 57:
			if not saw_non_zero:
				if tok.unicode_at(i) == 48:
					leading_zeros += 1
				else:
					saw_non_zero = true
			i += 1
	var exponent := 0
	if i < n and (tok.unicode_at(i) == 101 or tok.unicode_at(i) == 69):  # e E
		i += 1
		var negative := false
		if i < n and (tok.unicode_at(i) == 43 or tok.unicode_at(i) == 45):
			negative = tok.unicode_at(i) == 45
			i += 1
		var significant := 0
		while i < n and tok.unicode_at(i) >= 48 and tok.unicode_at(i) <= 57:
			var d := tok.unicode_at(i) - 48
			if significant > 0 or d != 0:
				significant += 1
				if significant > 6:
					return false
				exponent = exponent * 10 + d
			i += 1
		if negative:
			exponent = -exponent
	if not saw_non_zero:
		return true
	var power := int_digits - 1 - leading_zeros + exponent
	return power >= -307 and power <= 307


static func _after_value(stack: Array) -> int:
	return _END if stack.is_empty() else _COMMA_OR_CLOSE


## A string token's value: the bare text when it has no escape, else the engine's decoding of
## the (already validated) token. null when the engine refuses it (a lone surrogate).
static func _decode_string(tok: String) -> Variant:
	if not tok.contains("\\"):
		return tok.substr(1, tok.length() - 2)
	var j := JSON.new()
	if j.parse(tok) != OK or not (j.data is String):
		return null
	return j.data
