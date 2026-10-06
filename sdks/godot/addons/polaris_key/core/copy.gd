class_name PKeyCopy
extends RefCounted
## The core copy API (core.copy, SDK-PARITY-PASS §3.2): what an SDK SAYS for a code, read from
## the generated English tables in copy_generated.gd (PKeyCoreCopy) with a host override layer.
## The rule is React's (packages/sdk-react/src/core/copy.ts):
##
##   message(code, params, detail)       the sentence for a code: the host override, then the
##                                       error-code table, then the gate table (licenseStatus),
##                                       then the activation table (activationResult), then
##                                       COPY_FALLBACK naming the code. Never the raw body.
##   title(code)                         the short heading, by the same lookup
##   activation_message(kind, code, ..)  the sentence for a typed activation result: the
##                                       activation table only, never the error-code table
##   activation_title(kind)              its heading
##   has(code)                           whether a code has its own sentence (override or table)
##
## The tables are separate on purpose: the error code `unauthorized` reads "Not signed in", the
## activation result `unauthorized` reads "Key not accepted".
##
## Placeholders are written `{name}` (PKeyCoreCopy.COPY_PLACEHOLDERS). `{code}` defaults to the
## code; the others come from `params` (camelCase as copy.en.json, or snake_case). A placeholder
## with no value is dropped with the space before it, so a raw `{name}` never shows.
##
## English is generated: edit conformance/parity/copy.en.json and run `pnpm gen:constants`. A host
## overrides any sentence or heading without forking the table:
##
##   PolarisKey.core.copy.set_overrides({"device_limit": "Diceroll is on all your devices."})
##
## An activation result is overridden under `activation:<activationResult>`
## (`activation:unauthorized`), so it never collides with the error code of the same name.
##
## Every PKeyCore shares PKeyCopy.shared(), so the UI kit (PKeyUiCopy) reads the same overrides.

## code -> host message, code -> host title (the override layer; wins per key).
var message_overrides: Dictionary = {}
var title_overrides: Dictionary = {}
## Replaces COPY_FALLBACK's message when non-empty (`{code}` is filled in).
var fallback_message := ""

static var _shared: PKeyCopy = null
static var _placeholder: RegEx = null


## The copy every PKeyCore and the UI kit read until given their own.
static func shared() -> PKeyCopy:
	if _shared == null:
		_shared = PKeyCopy.new()
	return _shared


## Merge host overrides: `messages` and `titles` are code -> text; an empty `fallback` keeps the
## generated fallback sentence.
func set_overrides(messages: Dictionary, titles: Dictionary = {}, fallback := "") -> void:
	message_overrides.merge(messages, true)
	title_overrides.merge(titles, true)
	if fallback != "":
		fallback_message = fallback


## Drop every host override (back to the generated English).
func clear_overrides() -> void:
	message_overrides = {}
	title_overrides = {}
	fallback_message = ""


## A §3.1 activation kind in any spelling (`deviceLimit`, `device_limit`) as its
## activationResult (`device-limit`).
static func activation_result(kind: String) -> String:
	var out := ""
	for i in kind.length():
		var ch := kind[i]
		if ch == "_":
			out += "-"
		elif ch != ch.to_lower():
			out += "-" + ch.to_lower()
		else:
			out += ch
	return out


## The generated entry for a code: error code, then gate status, then activation result.
static func entry(code: String) -> Dictionary:
	if PKeyCoreCopy.COPY_CODES.has(code):
		return PKeyCoreCopy.COPY_CODES[code]
	if PKeyCoreCopy.COPY_GATE.has(code):
		return PKeyCoreCopy.COPY_GATE[code]
	return PKeyCoreCopy.COPY_ACTIVATION.get(activation_result(code), {})


## Whether `code` has its own sentence: a host override or a generated entry.
func has(code: Variant) -> bool:
	var c := _str(code)
	return message_overrides.get(c) is String or not entry(c).is_empty()


## Whether the host overrides `code`'s sentence.
func has_override(code: Variant) -> bool:
	return message_overrides.get(_str(code)) is String


## The unfilled sentence for `code` (override, tables, fallback), before placeholders.
func message_template(code: Variant) -> String:
	var c := _str(code)
	if message_overrides.get(c) is String:
		return message_overrides[c]
	var e := entry(c)
	if not e.is_empty():
		return e["message"]
	return fallback_message if fallback_message != "" else String(PKeyCoreCopy.COPY_FALLBACK["message"])


## The sentence for `code` with its placeholders filled; `detail` (a refusal's reason, say) is
## appended in parentheses when given. An unknown code reads COPY_FALLBACK naming it.
func message(code: Variant, params: Dictionary = {}, detail := "") -> String:
	var c := _str(code)
	var out := fill(message_template(c), c, params)
	return "%s (%s)" % [out, detail] if detail != "" else out


## The short heading for `code`, or COPY_FALLBACK's title.
func title(code: Variant) -> String:
	var c := _str(code)
	if title_overrides.get(c) is String:
		return title_overrides[c]
	var e := entry(c)
	return String(e["title"]) if not e.is_empty() else String(PKeyCoreCopy.COPY_FALLBACK["title"])


## The sentence for a typed activation result (PKeyActivationResult.kind, any spelling). It reads
## the activation table only; `code` fills `{code}` (a refusal names the server's code). A kind
## with no activation entry reads message(kind).
func activation_message(kind: Variant, code := "", params: Dictionary = {}) -> String:
	var k := _str(kind)
	var e: Dictionary = PKeyCoreCopy.COPY_ACTIVATION.get(activation_result(k), {})
	var key := "activation:" + activation_result(k)
	var text: String = message_overrides[key] if message_overrides.get(key) is String else String(e.get("message", ""))
	if text == "":
		return message(k, params)
	return fill(text, code if code != "" else k, params)


## The heading for a typed activation result.
func activation_title(kind: Variant) -> String:
	var k := activation_result(_str(kind))
	var key := "activation:" + k
	if title_overrides.get(key) is String:
		return title_overrides[key]
	var e: Dictionary = PKeyCoreCopy.COPY_ACTIVATION.get(k, {})
	return String(e["title"]) if not e.is_empty() else title(kind)


## Fill `{name}` placeholders: `params[name]` (or its snake_case spelling), `{code}` defaulting to
## `code`; an unfilled placeholder is dropped with the space before it.
static func fill(text: String, code: String, params: Dictionary = {}) -> String:
	if not text.contains("{"):
		return text
	if _placeholder == null:
		_placeholder = RegEx.create_from_string("( ?)\\{(\\w+)\\}")
	var out := ""
	var at := 0
	for m in _placeholder.search_all(text):
		out += text.substr(at, m.get_start() - at)
		var name := m.get_string(2)
		var v = params.get(name, params.get(name.to_snake_case()))
		if v != null:
			out += m.get_string(1) + _value(v)
		elif name == "code":
			out += m.get_string(1) + code
		at = m.get_end()
	return out + text.substr(at)


static func _value(v: Variant) -> String:
	# Every JSON number is a float in Godot; a whole number reads without ".0".
	if v is float and is_finite(v) and v == floorf(v) and absf(v) < 1e15:
		return str(int(v))
	return str(v)


static func _str(v: Variant) -> String:
	return str(v) if v != null else ""
