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
## Known divergences, recorded rather than tolerated (they only ever REJECT): Godot's parser
## rejects a lone surrogate escape (`"\ud800"`) that `JSON.parse` accepts, and nesting deeper
## than Godot's recursion limit. Both fail closed. Numbers are float64, as in JS: `1e400` is
## `inf` and 2^53 − 1 is exact.

const _TOKEN := "[ \\t\\n\\r]++" \
		+ "|\"(?:[^\"\\\\\\x00-\\x1f]++|\\\\(?:[\"\\\\/bfnrt]|u[0-9A-Fa-f]{4}))*+\"" \
		+ "|-?(?:0|[1-9][0-9]*+)(?:\\.[0-9]++)?(?:[eE][+-]?[0-9]++)?" \
		+ "|true|false|null" \
		+ "|[{}\\[\\]:,]"

# Parser states: what the next significant token may be.
enum { _VALUE, _VALUE_OR_CLOSE, _KEY, _KEY_OR_CLOSE, _COLON, _COMMA_OR_CLOSE, _END }

static var _token_re: RegEx
static var _nul_re: RegEx


static func _static_init() -> void:
	_token_re = RegEx.create_from_string(_TOKEN)
	_nul_re = RegEx.create_from_string("(?<!\\\\)((?:\\\\\\\\)*)\\\\u0000")


## Parse `text` strictly. Returns `{"ok": true, "value": v}` or `{"ok": false, "error": why}`.
static func parse(text: String) -> Dictionary:
	var t := nul_as_fffd(text)
	var why := validate(t)
	if why != "":
		return {"ok": false, "error": why}
	var j := JSON.new()
	if j.parse(t) != OK:
		return {"ok": false, "error": "engine parse failed at line %d: %s" % [j.get_error_line(), j.get_error_message()]}
	return {"ok": true, "value": j.data}


## Parse UTF-8 bytes strictly. A raw NUL byte is refused before decoding (Godot's decoder would
## turn it into U+FFFD, which a string accepts, where `JSON.parse` rejects the control
## character), and one leading BOM is dropped, as `TextDecoder` does.
static func parse_bytes(bytes: PackedByteArray) -> Dictionary:
	if bytes.find(0) != -1:
		return {"ok": false, "error": "raw NUL byte"}
	var text := bytes.get_string_from_utf8()
	if not text.is_empty() and text.unicode_at(0) == 0xFEFF:
		text = text.substr(1)
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
## Run it on text that has already been through `nul_as_fffd`.
static func validate(text: String) -> String:
	var n := text.length()
	var pos := 0
	var state := _VALUE
	# One entry per open container: a Dictionary of the keys seen (object) or null (array).
	var stack: Array = []
	for m: RegExMatch in _token_re.search_all(text):
		var start := m.get_start()
		if start != pos:
			return "unexpected character at %d" % pos
		pos = m.get_end()
		var tok := m.get_string()
		var c := tok.unicode_at(0)
		if c == 32 or c == 9 or c == 10 or c == 13:
			continue
		match state:
			_END:
				return "trailing data at %d" % start
			_COLON:
				if c != 58:  # :
					return "expected ':' at %d" % start
				state = _VALUE
				continue
			_KEY, _KEY_OR_CLOSE:
				if c == 125 and state == _KEY_OR_CLOSE:  # } of an empty object
					stack.pop_back()
					state = _after_value(stack)
					continue
				if c != 34:  # "
					return "expected a key at %d" % start
				var key = _decode_string(tok)
				if key == null:
					return "undecodable key at %d" % start
				var seen: Dictionary = stack.back()
				if seen.has(key):
					return "duplicate key %s at %d" % [JSON.stringify(key), start]
				seen[key] = true
				state = _COLON
				continue
			_COMMA_OR_CLOSE:
				var top = stack.back()
				if c == 44:  # ,
					state = _KEY if top is Dictionary else _VALUE
				elif c == 125 and top is Dictionary:  # }
					stack.pop_back()
					state = _after_value(stack)
				elif c == 93 and top == null:  # ]
					stack.pop_back()
					state = _after_value(stack)
				else:
					return "expected ',' or a closing bracket at %d" % start
				continue
		# _VALUE or _VALUE_OR_CLOSE
		if c == 93 and state == _VALUE_OR_CLOSE:  # ] of an empty array
			stack.pop_back()
			state = _after_value(stack)
		elif c == 123:  # {
			stack.append({})
			state = _KEY_OR_CLOSE
		elif c == 91:  # [
			stack.append(null)
			state = _VALUE_OR_CLOSE
		elif c == 125 or c == 93 or c == 58 or c == 44:
			return "expected a value at %d" % start
		else:
			state = _after_value(stack)  # a string, number or literal
	if pos != n:
		return "unexpected character at %d" % pos
	if state != _END:
		return "unexpected end of text"
	return ""


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
