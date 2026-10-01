class_name PKeyConfigResolve
extends RefCounted
## Layered config resolution (WIRE-CONTRACT-V3 §2.2.1, pinned by `config-matrix.json`): a port of
## client-core `config.ts` (`envVarName`, `readEnvValue`, `resolveSource`, `resolveValue`,
## `listUserEntries`). The rule is contract, shared by every SDK:
##
##   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
##
## `enforced` and `hidden` keys are LOCKED to the remote value: a local override or an
## environment value for one is ignored (never deleted), so the player's saved choice returns if
## the operator relaxes the state. A `default` key, or a key the document does not carry, takes
## the layers in order.
##
## The host supplies the layers through a `Context` (the GDScript twin of `ResolveContext`):
##   remote      the verified config document's `config` map (key -> ManagedEntry), or null
##   local       `Callable(key: String) -> Array`: `[value]` when the player has an override,
##               `[]` when not (an Array, so a JSON `null` override is still an override)
##   env         `Callable(var_name: String) -> Variant`: the raw String, or null when unset
##   env_prefix  a key's variable is `env_prefix + key.replace(".", "__")`
##
## "Nothing matched" is `{found: false}`; the caller substitutes its fallback.
##
## An environment value (rule 2) is parsed only when the raw text is one strict JSON text, and is
## otherwise the raw string: three scans over the raw text (depth, numbers, member names), then
## PKeyJson. Two WIRE-CONTRACT-V3 §10 limits apply to the parsed value only, never the verdict:
## Godot's number parser is not correctly rounded, and `\u0000` in a string value reads as U+FFFD.

const DEFAULT_ENV_PREFIX := "PKEY_CONFIG_"

const ENFORCED := &"enforced"
const HIDDEN := &"hidden"
const LOCAL := &"local"
const ENV := &"env"
const REMOTE_DEFAULT := &"remote-default"
const FALLBACK := &"fallback"

## Rule 2: at most this many arrays and objects open at any point.
const MAX_ENV_DEPTH := 64
## Rule 2: a non-zero number's first non-zero digit has a power of ten within ±307.
const MAX_DECIMAL_EXPONENT := 307
## Rule 2: an exponent part has at most this many significant digits.
const MAX_EXPONENT_DIGITS := 6


## The resolution inputs (client-core `ResolveContext`).
class Context:
	extends RefCounted
	var remote = null
	var local: Callable = func(_key: String) -> Array: return []
	var env: Callable = func(_name: String) -> Variant: return null
	var env_prefix := DEFAULT_ENV_PREFIX

	## A context over plain tables, for tests and static overrides.
	static func from_tables(p_remote: Variant, p_local: Dictionary = {}, p_env: Dictionary = {}, p_prefix := DEFAULT_ENV_PREFIX) -> Context:
		var c := Context.new()
		c.remote = p_remote
		c.local = func(key: String) -> Array: return [p_local[key]] if p_local.has(key) else []
		c.env = func(name: String) -> Variant: return p_env.get(name)
		c.env_prefix = p_prefix
		return c


## `run.concurrency` -> `PKEY_CONFIG_run__concurrency` (every `.` becomes `__`).
static func env_var_name(prefix: String, key: String) -> String:
	return prefix + key.replace(".", "__")


## A key's environment value: `[value]`, or `[]` when the variable is unset. Values from
## `--pkey-config key=value` take this path too.
static func read_env_value(ctx: Context, key: String) -> Array:
	var raw = ctx.env.call(env_var_name(ctx.env_prefix, key))
	if not (raw is String):
		return []
	return [parse_env_value(raw)]


## Rule 2: the parsed value when `raw` is one strict JSON text, else `raw` unchanged. Never fails.
## The scans run first, so Godot's parser never meets a deeper text, an out-of-range number (its
## exponent wraps at 2^32) or a member name holding U+0000 (which `PKeyJson.parse` would turn
## into U+FFFD before reading names). Nothing checks the parsed numbers afterwards: Godot reads
## some in-range spellings as 0 or NaN (§10), and such a check would keep the raw string where
## every other SDK parses.
static func parse_env_value(raw: String) -> Variant:
	if nesting_exceeds(raw, MAX_ENV_DEPTH):
		return raw
	if not numbers_in_range(raw):
		return raw
	if _name_holds_nul(raw):
		return raw
	var parsed := PKeyJson.parse(raw)
	return parsed["value"] if parsed["ok"] else raw


## True when more than `limit` arrays and objects are open at some point. String contents are
## skipped (a backslash skips the next character). Exact for every text PKeyJson accepts.
static func nesting_exceeds(raw: String, limit: int) -> bool:
	var depth := 0
	var in_string := false
	var i := 0
	var n := raw.length()
	while i < n:
		var c := raw.unicode_at(i)
		if in_string:
			if c == 92:  # backslash
				i += 1
			elif c == 34:
				in_string = false
		elif c == 34:
			in_string = true
		elif c == 91 or c == 123:  # [ {
			depth += 1
			if depth > limit:
				return true
		elif c == 93 or c == 125:  # ] }
			depth -= 1
		i += 1
	return false


static func _is_digit(c: int) -> bool:
	return c >= 48 and c <= 57


static func _is_number_run(c: int) -> bool:
	return _is_digit(c) or c == 46 or c == 101 or c == 69 or c == 43 or c == 45  # . e E + -


## True when every number token outside a string is in rule 2's range. A token is the run of
## digits, `.`, `e`, `E`, `+` and `-` at each `-` or digit.
static func numbers_in_range(raw: String) -> bool:
	var in_string := false
	var i := 0
	var n := raw.length()
	while i < n:
		var c := raw.unicode_at(i)
		if in_string:
			if c == 92:
				i += 2
			else:
				if c == 34:
					in_string = false
				i += 1
			continue
		if c == 34:
			in_string = true
			i += 1
			continue
		if c == 45 or _is_digit(c):
			var start := i
			while i < n and _is_number_run(raw.unicode_at(i)):
				i += 1
			if not number_token_in_range(raw.substr(start, i - start)):
				return false
			continue
		i += 1
	return true


## Judge one number token from its decimal digits, with no floating point: in range when its
## exponent part has at most six significant digits and the number is zero or its first
## non-zero digit's power of ten is from -307 to 307. Never fails on a malformed run.
static func number_token_in_range(token: String) -> bool:
	var i := 0
	var n := token.length()
	if i < n and token.unicode_at(i) == 45:
		i += 1
	var int_digits := 0
	var leading_zeros := 0
	var saw_non_zero := false
	while i < n and _is_digit(token.unicode_at(i)):
		if not saw_non_zero:
			if token.unicode_at(i) == 48:
				leading_zeros += 1
			else:
				saw_non_zero = true
		int_digits += 1
		i += 1
	if i < n and token.unicode_at(i) == 46:
		i += 1
		while i < n and _is_digit(token.unicode_at(i)):
			if not saw_non_zero:
				if token.unicode_at(i) == 48:
					leading_zeros += 1
				else:
					saw_non_zero = true
			i += 1
	var exponent := 0
	if i < n and (token.unicode_at(i) == 101 or token.unicode_at(i) == 69):
		i += 1
		var negative := false
		if i < n and (token.unicode_at(i) == 43 or token.unicode_at(i) == 45):
			negative = token.unicode_at(i) == 45
			i += 1
		var significant := 0
		while i < n and _is_digit(token.unicode_at(i)):
			var d := token.unicode_at(i) - 48
			if significant > 0 or d != 0:
				significant += 1
				if significant > MAX_EXPONENT_DIGITS:
					return false
				exponent = exponent * 10 + d
			i += 1
		if negative:
			exponent = -exponent
	if not saw_non_zero:
		return true  # every digit is zero
	var power := int_digits - 1 - leading_zeros + exponent
	return power >= -MAX_DECIMAL_EXPONENT and power <= MAX_DECIMAL_EXPONENT


## True when a member name spells a real `\u0000` escape. Strings are walked as the depth scan
## walks them, so a backslash escapes the next character and `"a\\u0000"` holds no U+0000; a
## string followed by JSON whitespace and `:` is a member name. Exact for every text PKeyJson
## accepts. It must run before `PKeyJson.parse`, whose first step is `nul_as_fffd`.
static func _name_holds_nul(raw: String) -> bool:
	var i := 0
	var n := raw.length()
	while i < n:
		if raw.unicode_at(i) != 34:
			i += 1
			continue
		i += 1
		var holds := false
		while i < n:
			var c := raw.unicode_at(i)
			if c == 92:
				if raw.substr(i + 1, 5) == "u0000":
					holds = true
				i += 2
				continue
			if c == 34:
				break
			i += 1
		i += 1  # past the closing quote
		var j := i
		while j < n and raw.unicode_at(j) in [32, 9, 10, 13]:
			j += 1
		if holds and j < n and raw.unicode_at(j) == 58:  # :
			return true
	return false


static func _entry(ctx: Context, key: String) -> Variant:
	if ctx.remote is Dictionary:
		var e = ctx.remote.get(key)
		if e is Dictionary:
			return e
	return null


static func _state(entry: Variant) -> String:
	if entry is Dictionary and entry.get("state") is String:
		return entry["state"]
	return ""


## Both at once (one environment read): {found: bool, value?, source: StringName}.
static func resolve(ctx: Context, key: String) -> Dictionary:
	var entry = _entry(ctx, key)
	var state := _state(entry)
	# enforced | hidden -> the remote value is locked; local and env are ignored.
	if state == "enforced" or state == "hidden":
		return {"found": true, "value": entry.get("value"), "source": ENFORCED if state == "enforced" else HIDDEN}
	# default | absent -> local > env > remote-default > (the caller's fallback).
	var local: Array = ctx.local.call(key)
	if not local.is_empty():
		return {"found": true, "value": local[0], "source": LOCAL}
	var env := read_env_value(ctx, key)
	if not env.is_empty():
		return {"found": true, "value": env[0], "source": ENV}
	if entry != null:
		return {"found": true, "value": entry.get("value"), "source": REMOTE_DEFAULT}
	return {"found": false, "source": FALLBACK}


## client-core `resolveSource`.
static func resolve_source(ctx: Context, key: String) -> StringName:
	return resolve(ctx, key)["source"]


## client-core `resolveValue`: `[value]`, or `[]` when nothing matched.
static func resolve_value(ctx: Context, key: String) -> Array:
	var r := resolve(ctx, key)
	return [r["value"]] if r["found"] else []


## client-core `listUserEntries` (rule 4): every document entry MINUS the hidden ones, in
## document order, each {key, value, enforced} with its resolved value. A key only a local
## override or the environment supplies is not listed.
static func list_user_entries(ctx: Context) -> Array:
	var out: Array = []
	if not (ctx.remote is Dictionary):
		return out
	for key in ctx.remote:
		var entry = ctx.remote[key]
		if not (entry is Dictionary):
			continue
		var state := _state(entry)
		if state == "hidden":
			continue
		var r := resolve(ctx, String(key))
		out.append({"key": String(key), "value": r["value"] if r["found"] else entry.get("value"), "enforced": state == "enforced"})
	return out
