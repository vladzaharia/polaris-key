class_name PKeyConfigResolve
extends RefCounted
## Layered config resolution: a line-for-line port of client-core `config.ts` (`envVarName`,
## `readEnvValue`, `looksLikeJson`, `resolveSource`, `resolveValue`, `listUserEntries`). The rule
## is contract, shared by every SDK:
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

const DEFAULT_ENV_PREFIX := "PKEY_CONFIG_"

const ENFORCED := &"enforced"
const HIDDEN := &"hidden"
const LOCAL := &"local"
const ENV := &"env"
const REMOTE_DEFAULT := &"remote-default"
const FALLBACK := &"fallback"

static var _number_re: RegEx


static func _static_init() -> void:
	_number_re = RegEx.create_from_string("\\A-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\z")


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


## client-core `looksLikeJson`: true/false/null, a JSON number, or text opening with `{`, `[`
## or `"`. Anything else is used as the raw string.
static func looks_like_json(s: String) -> bool:
	var t := s.strip_edges()
	if t == "":
		return false
	if t == "true" or t == "false" or t == "null":
		return true
	if _number_re.search(t) != null:
		return true
	var first := t.left(1)
	return first == "{" or first == "[" or first == "\""


## A key's environment value: `[value]` (JSON-parsed with PKeyJson when it looks like JSON, the
## raw string when that parse fails or it does not), or `[]` when the variable is unset.
static func read_env_value(ctx: Context, key: String) -> Array:
	var raw = ctx.env.call(env_var_name(ctx.env_prefix, key))
	if not (raw is String):
		return []
	if looks_like_json(raw):
		var parsed := PKeyJson.parse(raw)
		return [parsed["value"]] if parsed["ok"] else [raw]
	return [raw]


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


## client-core `listUserEntries`: every remote entry MINUS the hidden ones, in document order,
## each {key, value, enforced}.
static func list_user_entries(remote: Variant) -> Array:
	var out: Array = []
	if not (remote is Dictionary):
		return out
	for key in remote:
		var entry = remote[key]
		if not (entry is Dictionary):
			continue
		var state := _state(entry)
		if state == "hidden":
			continue
		out.append({"key": String(key), "value": entry.get("value"), "enforced": state == "enforced"})
	return out
