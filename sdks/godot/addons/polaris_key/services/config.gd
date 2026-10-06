class_name PKeyConfig
extends RefCounted
## `PolarisKey.config`: managed config over the signed config document (sdk-node
## `config/client.ts`; report §5.4, notes/A2 §1.10 and §11).
##
##   var speed: float = PolarisKey.config.get_value("dice.animSpeed", 1.0)
##   PolarisKey.config.get_source("dice.animSpeed")      # &"enforced", &"local", &"env", …
##   PolarisKey.config.set_override_store(PKeyConfigFileStore.new("user://settings.cfg"))
##   PolarisKey.config.config_changed.connect(_apply_settings)
##   PolarisKey.config.bind_property($Dice, "roll_speed", "dice.animSpeed", 1.0)
##   PolarisKey.config.set_value("dice.animSpeed", 2.0)    # PKeyResult; persisted, type-checked
##   PolarisKey.config.setting("dice.animSpeed").changed.connect(_on_speed)
##   var m := await PolarisKey.config.mint_token("leaderboard")   # m.token, m.expires_at
##
## Precedence is contract (PKeyConfigResolve, client-core `config.ts`):
##
##   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
##
## The fallback is the caller's argument, else (when the caller passed none, i.e. null) the
## compiled mirror's DEFAULTS (`tools/gen-mirrors.ts --lang gdscript`, `set_compiled_catalog`);
## both report source `fallback`.
##
## SECRETS ARE NOT SECRET IN A GAME. A `clientScoped` secret rides the signed config document,
## which sits in `user://pkey/<product>/managed.json` (IndexedDB on web, readable by any
## same-origin script); anything in a `.pck` is extractable too. Use edge-mint (`mint_token`)
## for third-party API keys: the signing key never leaves the Worker and the minted token lives
## in memory only.
##
## Everything here works before `configure()` and offline: with no document every key falls
## through to its fallback.

## The effective value of these keys changed: after a sync, a bundle import, `start()`, an
## override written through the store, or a catalog that moved a key's accessor. Sorted; one
## emission per event; never for a key whose value did not change.
signal config_changed(keys: PackedStringArray)

## The Worker's recipe-id alphabet (`MINT_ID` in services/config/routes.ts): an id outside it
## could never reach the recipe lookup, so it is refused here instead of sent.
const MINT_ID_PATTERN := "\\A[a-z0-9-]+\\z"
## A minted token is reused until this many seconds before its `expires_at`.
const MINT_REUSE_MARGIN_SECONDS := 30

## The Core this client reads (set by `PolarisKey.configure`), or null.
var core: PKeyCore = null
## The environment layer (PKeyConfigEnv), rebuilt from the options at `configure`.
var env: PKeyConfigEnv

var _store: PKeyOverrideStore = null
## True while `_store` is the default persisted store attach() installed (not the game's own).
var _default_store := false
var _compiled_entries := {}
var _compiled_defaults := {}
var _compiled_version = null
var _fetched = null
var _fetched_entries := {}
var _snapshot := {}
var _bindings: Array = []
## key -> PKeyConfigSetting (`setting(key)`): one live handle per key.
var _settings := {}
## True while clear_all() clears key by key: the store's per-key `changed` is folded into one
## refresh at the end.
var _quiet := false
## recipe id -> {device_token, result}: memory only, never persisted.
var _minted := {}
## recipe id -> MintPending: a mint in flight, shared by concurrent asks under the same token.
var _minting := {}
var _ctx := PKeyConfigResolve.Context.new()

static var _mint_id_re: RegEx


static func _static_init() -> void:
	_mint_id_re = RegEx.create_from_string(MINT_ID_PATTERN)


## One mint in flight; concurrent callers await `done`.
class MintPending:
	extends RefCounted
	signal done(result: PKeyMintResult)
	var device_token := ""
	var result: PKeyMintResult = null

	func _init(p_token: String) -> void:
		device_token = p_token

	func wait() -> PKeyMintResult:
		if result != null:
			return result
		return await done

	func finish(r: PKeyMintResult) -> void:
		result = r
		done.emit(r)


func _init() -> void:
	env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_AUTO, PKeyConfigResolve.DEFAULT_ENV_PREFIX)
	_ctx.local = _local


## Called by `PolarisKey.configure`: read from this Core from now on.
func attach(p_core: PKeyCore) -> void:
	core = p_core
	env = PKeyConfigEnv.for_process(core.options.config_env_layer, core.options.config_env_prefix)
	if core.options.config_catalog != null:
		set_compiled_catalog(core.options.config_catalog)
	_minted.clear()
	_minting.clear()
	_install_default_store()
	_snapshot = _take_snapshot()


## SDK parity §3.11: the settings layer persists by default (PKeyOptions.persist_settings), in a
## PKeyConfigFileStore at PKeyOptions.settings_path. A store the game installed itself is never
## replaced; the default one follows the options at every configure().
func _install_default_store() -> void:
	if _store != null and not _default_store:
		return
	var path := core.options.settings_path
	if core.options.persist_settings and path != "":
		if _store is PKeyConfigFileStore and (_store as PKeyConfigFileStore).path == path:
			return
		_set_store(PKeyConfigFileStore.new(path))
		_default_store = true
	elif _default_store:
		_set_store(null)
		_default_store = false


# ── Resolution ─────────────────────────────────────────────────────────────────────────────

## The effective value of `key`. `fallback` when nothing resolves; with no fallback (null), the
## compiled mirror's default, else null. Containers are copies.
func get_value(key: String, fallback: Variant = null) -> Variant:
	var r := PKeyConfigResolve.resolve(_context(), key)
	if r["found"]:
		return _copy(r["value"])
	if fallback != null:
		return fallback
	return _copy(_compiled_defaults.get(key))


## Where `get_value(key)` takes its value from: &"enforced", &"hidden", &"local", &"env",
## &"remote-default" or &"fallback".
func get_source(key: String) -> StringName:
	return PKeyConfigResolve.resolve_source(_context(), key)


## The rows a settings screen shows (WIRE-CONTRACT-V3 §2.2.1 rule 4): every key the document
## carries MINUS the hidden ones, in document order, each with its resolved value, enforced rows
## flagged (show them read-only). Hidden keys are still applied by `get_value`; they are only
## withheld here, as are keys only an override or the environment supplies.
func list_user_config() -> Array[PKeyConfigEntry]:
	var out: Array[PKeyConfigEntry] = []
	var ctx := _context()
	for row in PKeyConfigResolve.list_user_entries(ctx):
		var source := PKeyConfigResolve.resolve_source(ctx, row["key"])
		out.append(PKeyConfigEntry.new(row["key"], _copy(row["value"]), row["enforced"], source, catalog_entry(row["key"])))
	return out


## A managed secret's value (a String), or null. Secrets are never enumerated and have no local
## or environment layer. Treat it as readable by the player (see the class notes).
func get_secret(key: String) -> Variant:
	var doc = _doc()
	if doc == null or not (doc.get("secrets") is Dictionary):
		return null
	var e = doc["secrets"].get(key)
	return e["value"] if e is Dictionary and e.get("value") is String else null


## The catalog version the last verified document stated (an int), or null.
func schema_version() -> Variant:
	var doc = _doc()
	return int(doc["schemaVersion"]) if doc != null and PKeyClaims.is_number(doc.get("schemaVersion")) else null


## Whether the product runs Config (the config-side twin of the licence's `not-applicable`).
func enabled() -> bool:
	return core != null and core.enabled("config")


# ── Local overrides ────────────────────────────────────────────────────────────────────────

## The player's settings layer (PKeyOverrideStore; PKeyConfigFileStore for a settings.cfg), or
## null for none. Read at every `get_value`.
func set_override_store(store: PKeyOverrideStore) -> void:
	_default_store = false
	_set_store(store)
	refresh()


## Whether the current settings layer is the default persisted one (PKeyOptions.persist_settings).
func is_default_override_store() -> bool:
	return _default_store


func _set_store(store: PKeyOverrideStore) -> void:
	if _store != null and _store.changed.is_connected(_on_store_changed):
		_store.changed.disconnect(_on_store_changed)
	_store = store
	if _store != null:
		_store.changed.connect(_on_store_changed)


func get_override_store() -> PKeyOverrideStore:
	return _store


func _on_store_changed(_keys: PackedStringArray) -> void:
	if not _quiet:
		refresh()


func _local(key: String) -> Array:
	if _store == null:
		return []
	var accessor := _accessor(key)
	return [_store.get_override(key, accessor)] if _store.has_override(key, accessor) else []


# ── config.local: set_value / clear / clear_all / setting (SDK parity §3.11, S-17 §5.11) ──────
#
# Device-local writes go through the current override store (the persisted PKeyConfigFileStore
# by default, or the game's own), so they survive a restart and every write emits
# `config_changed` exactly once (none when the effective value did not move). `set` itself is
# Object's, so the write is `set_value`, the twin of `get_value` (S-17 §5.11's Godot name).

## Persist a device-local override for `key` and return a PKeyResult (its detail is the stored
## value). Refused, with nothing written:
##   - `managed_by_admin` when the operator locked the key (`enforced` or `hidden` in the verified
##     document; with no document entry, the catalog's `managementDefault`);
##   - `invalid-options` when `value` does not fit the catalog entry's schema (`type`, `enum`,
##     `minimum`/`maximum`, `minLength`/`maxLength`), or, with no catalog entry, the JSON type of
##     the document's value; when the key is a secret; or when the value is not JSON;
##   - `store-failed` when the store could not save (the value may still apply this session).
## Godot's numbers are typed by the catalog, not by the Variant: 3.0 is a valid `integer` (stored
## as 3) and 3 a valid `number`. A null value clears the override (a ConfigFile cannot hold null).
func set_value(key: String, value: Variant) -> PKeyResult:
	if typeof(value) == TYPE_NIL:
		return clear(key)
	var refused := _write_refusal(key)
	if refused != null:
		return refused
	var checked := _check_value(key, value)
	if not checked["ok"]:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, checked["message"], {"key": key})
	var store := _writable_store()
	if not store.set_override(key, checked["value"], _accessor(key)):
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The setting %s could not be saved." % key, {"key": key})
	return PKeyResult.success(_copy(checked["value"]))


## Remove the device-local override for `key`: the environment, the remote default or the
## fallback answers again. Clearing a key with no override succeeds and emits nothing.
func clear(key: String) -> PKeyResult:
	if key == "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "A config key is required.")
	if _store == null:
		return PKeyResult.success()
	if not _store.clear_override(key, _accessor(key)):
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The setting %s could not be cleared." % key, {"key": key})
	return PKeyResult.success()


## Remove every device-local override for a key this client knows (the document's, the
## catalog's, the bound and watched keys, the store's table), emitting `config_changed` once.
## Anything else in the game's own settings file is left alone. The detail is the cleared keys.
func clear_all() -> PKeyResult:
	if _store == null:
		return PKeyResult.success(PackedStringArray())
	var cleared := PackedStringArray()
	var failed := false
	_quiet = true
	for k in _known_keys():
		var accessor := _accessor(k)
		if _store.has_override(k, accessor):
			if _store.clear_override(k, accessor):
				cleared.append(k)
			else:
				failed = true
	_quiet = false
	refresh()
	cleared.sort()
	if failed:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "Some settings could not be cleared.", cleared)
	return PKeyResult.success(cleared)


## The live handle on `key` (PKeyConfigSetting): its value, source and lock now, then `changed`
## on every change. The same handle for the same key.
func setting(key: String) -> PKeyConfigSetting:
	var h: PKeyConfigSetting = _settings.get(key)
	if h == null:
		h = PKeyConfigSetting.new(key, self)
		_settings[key] = h
		if not _snapshot.has(key):
			_snapshot[key] = PKeyConfigResolve.resolve_value(_context(), key)
	_update_setting(h, false)
	return h


## Whether the operator locked `key` against device-local writes (`set_value` refuses it with
## `managed_by_admin`).
func is_locked(key: String) -> bool:
	var r := _write_refusal(key)
	return r != null and r.code == PKeyErrors.MANAGED_BY_ADMIN


func _write_refusal(key: String) -> PKeyResult:
	if key == "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "A config key is required.")
	var state := ""
	var remote = _remote()
	if remote is Dictionary and remote.get(key) is Dictionary:
		state = str(remote[key].get("state", ""))
	else:
		state = str(catalog_entry(key).get("managementDefault", ""))
	if state == "enforced" or state == "hidden":
		return PKeyResult.failure(PKeyErrors.MANAGED_BY_ADMIN, "%s is managed by the product's administrator and cannot be changed here." % key, {"key": key, "state": state})
	return null


## The store a write goes to: the current one, else a memory table (PKeyOptions.persist_settings
## off and no store of the game's own: the override lasts this session).
func _writable_store() -> PKeyOverrideStore:
	if _store == null:
		_set_store(PKeyOverrideStore.new())
		_default_store = true
	return _store


## {ok, value (normalised), message}. Typed by the catalog entry's schema, else by the JSON type
## of the document's current value, else any JSON value.
func _check_value(key: String, value: Variant) -> Dictionary:
	if not _is_json(value, 0):
		return _bad("%s takes a JSON value (a bool, number, string, array or dictionary)." % key)
	var entry := catalog_entry(key)
	if entry.get("kind") == "secret":
		return _bad("%s is a secret: secrets have no device-local value." % key)
	var schema = entry.get("schema")
	if schema is Dictionary and schema.has("type"):
		return _check_schema(key, value, schema)
	var remote = _remote()
	if remote is Dictionary and remote.get(key) is Dictionary and remote[key].has("value"):
		var current = remote[key]["value"]
		if current != null and _json_type(current) != _json_type(value):
			return _bad("%s takes %s, like its current value." % [key, _type_phrase(_json_type(current))])
	return {"ok": true, "value": _normalise(value)}


static func _check_schema(key: String, value: Variant, schema: Dictionary) -> Dictionary:
	var types = schema["type"]
	var allowed: Array = types if types is Array else [types]
	var hit = null
	for t in allowed:
		hit = _as_type(value, str(t))
		if hit != null:
			break
	if hit == null:
		var phrases := PackedStringArray()
		for t in allowed:
			phrases.append(_type_phrase(str(t)))
		return _bad("%s takes %s." % [key, " or ".join(phrases)])
	var out = hit[0]
	if schema.get("enum") is Array:
		var found := false
		var shown := PackedStringArray()
		for e in schema["enum"]:
			shown.append(JSON.stringify(e))
			if _same(e, out):
				found = true
		if not found:
			return _bad("%s takes one of %s." % [key, ", ".join(shown)])
	if PKeyClaims.is_number(out):
		if PKeyClaims.is_number(schema.get("minimum")) and float(out) < float(schema["minimum"]):
			return _bad("%s is at least %s." % [key, _num_text(schema["minimum"])])
		if PKeyClaims.is_number(schema.get("maximum")) and float(out) > float(schema["maximum"]):
			return _bad("%s is at most %s." % [key, _num_text(schema["maximum"])])
	if out is String:
		var n: int = out.length()
		if PKeyClaims.is_number(schema.get("minLength")) and n < int(schema["minLength"]):
			return _bad("%s is at least %d characters." % [key, int(schema["minLength"])])
		if PKeyClaims.is_number(schema.get("maxLength")) and n > int(schema["maxLength"]):
			return _bad("%s is at most %d characters." % [key, int(schema["maxLength"])])
	return {"ok": true, "value": out}


## [value as `type`] when `value` is one, else null. Numbers by value, not by Variant type.
static func _as_type(value: Variant, type: String) -> Variant:
	match type:
		"boolean":
			return [value] if value is bool else null
		"string":
			return [String(value)] if value is String or value is StringName else null
		"integer":
			if value is int:
				return [value]
			if value is float and is_finite(value) and value == floorf(value) and absf(value) <= 9007199254740991.0:
				return [int(value)]
			return null
		"number":
			return [value] if value is int or (value is float and is_finite(value)) else null
		"array":
			return [_normalise(value)] if value is Array else null
		"object":
			return [_normalise(value)] if value is Dictionary else null
	return null


static func _type_phrase(type: String) -> String:
	match type:
		"boolean":
			return "true or false"
		"string":
			return "a string"
		"integer":
			return "a whole number"
		"number":
			return "a number"
		"array":
			return "a list"
		"object":
			return "a dictionary"
	return type


static func _json_type(v: Variant) -> String:
	if v is bool:
		return "boolean"
	if PKeyClaims.is_number(v):
		return "number"
	if v is String or v is StringName:
		return "string"
	if v is Array:
		return "array"
	if v is Dictionary:
		return "object"
	return "null"


## Whether `v` is a JSON value: bool, finite number, string, and arrays and string-keyed
## dictionaries of those (nesting bounded).
static func _is_json(v: Variant, depth: int) -> bool:
	if depth > 64:
		return false
	if v == null or v is bool or v is int or v is String or v is StringName:
		return true
	if v is float:
		return is_finite(v)
	if v is Array:
		for x in v:
			if not _is_json(x, depth + 1):
				return false
		return true
	if v is Dictionary:
		for k in v:
			if not (k is String or k is StringName) or not _is_json(v[k], depth + 1):
				return false
		return true
	return false


## A deep copy with StringNames as Strings.
static func _normalise(v: Variant) -> Variant:
	if v is StringName:
		return String(v)
	if v is Array:
		var a: Array = []
		for x in v:
			a.append(_normalise(x))
		return a
	if v is Dictionary:
		var d := {}
		for k in v:
			d[String(k)] = _normalise(v[k])
		return d
	return v


static func _num_text(n: Variant) -> String:
	var f := float(n)
	return str(int(f)) if f == floorf(f) and absf(f) < 1e15 else str(f)


static func _bad(message: String) -> Dictionary:
	return {"ok": false, "message": message}


func _update_setting(h: PKeyConfigSetting, emit: bool) -> void:
	var ctx := _context()
	var r := PKeyConfigResolve.resolve(ctx, h.key)
	var v = _copy(r["value"]) if r["found"] else _copy(_compiled_defaults.get(h.key))
	h._update(v, PKeyConfigResolve.resolve_source(ctx, h.key), is_locked(h.key), emit)


# ── Catalog ────────────────────────────────────────────────────────────────────────────────

## Use a compiled mirror (`tools/gen-mirrors.ts --lang gdscript` -> catalog_generated.gd, or
## PKeyOptions.config_catalog): its DEFAULTS become the no-fallback default and its entries the
## catalog until `fetch_schema()` brings the live one. Any object with ENTRIES / DEFAULTS /
## CATALOG_VERSION constants works; null removes it.
func set_compiled_catalog(mirror: Variant) -> void:
	_compiled_entries = {}
	_compiled_defaults = {}
	_compiled_version = null
	var consts := {}
	if mirror is Script:
		consts = (mirror as Script).get_script_constant_map()
	elif mirror is Dictionary:
		consts = mirror
	for e in consts.get("ENTRIES", []):
		if e is Dictionary and e.get("key") is String:
			_compiled_entries[e["key"]] = e
	if consts.get("DEFAULTS") is Dictionary:
		_compiled_defaults = consts["DEFAULTS"]
	_compiled_version = consts.get("CATALOG_VERSION")
	refresh()


## The catalog a settings UI renders from: the last one `fetch_schema()` brought, else the
## compiled mirror's ({schemaVersion, entries}), else {}.
func catalog() -> Dictionary:
	if _fetched is Dictionary:
		return _fetched.duplicate(true)
	if _compiled_version != null:
		var entries: Array = []
		for k in _compiled_entries:
			entries.append(_compiled_entries[k].duplicate(true))
		return {"schemaVersion": _compiled_version, "entries": entries}
	return {}


## One key's catalog entry (fetched, else compiled), or {}.
func catalog_entry(key: String) -> Dictionary:
	if _fetched_entries.has(key):
		return _fetched_entries[key].duplicate(true)
	if _compiled_entries.has(key):
		return _compiled_entries[key].duplicate(true)
	return {}


func _accessor(key: String) -> String:
	var e = _fetched_entries.get(key, _compiled_entries.get(key))
	return e["accessor"] if e is Dictionary and e.get("accessor") is String else ""


## `GET /<p>/config/schema`: the product's active catalog, parsed (a Dictionary with
## `schemaVersion` and `entries`). Unsigned, unauthenticated and DIAGNOSTIC: UI hints only —
## what a client acts on arrives in the signed document. Every failure (a refusal, a network
## error, a body that is not a catalog, local-only, Config off) is null, never an error. The
## last good one is kept in memory (`catalog()`). A coroutine.
func fetch_schema() -> Variant:
	if not enabled():
		return null
	var r := await core.transport.request("GET", core.url("config/schema"), core.headers({"Accept": "application/json"}))
	if not r.ok:
		return null
	var status: int = r.detail["status"]
	if status < 200 or status >= 300:
		return null
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"] or not _is_catalog(parsed["value"]):
		return null
	_fetched = parsed["value"]
	_fetched_entries = {}
	for e in _fetched["entries"]:
		if e is Dictionary and e.get("key") is String:
			_fetched_entries[e["key"]] = e
	refresh()
	return _fetched.duplicate(true)


## The catalog's outer shape; the entries are the product's own data and are not validated.
static func _is_catalog(v: Variant) -> bool:
	return v is Dictionary and PKeyClaims.is_number(v.get("schemaVersion")) and v.get("entries") is Array


# ── Edge-mint ──────────────────────────────────────────────────────────────────────────────

## False only when this session's discovery document says the product has no approved edge-mint
## recipe (`services.config.mint.available` is false). Without discovery the mint is attempted.
func mint_available() -> bool:
	if core == null or not (core.discovery_manifest is Dictionary):
		return true
	var cfg = core.discovery_manifest.get("services", {}).get("config")
	if cfg is Dictionary and cfg.get("mint") is Dictionary:
		return not PKeyClaims.is_false(cfg["mint"].get("available"))
	return true


## Mint a third-party token through the product's edge-mint recipe `recipe_id`
## (`GET /<p>/config/mint/<recipe_id>/token` with the device bearer). A coroutine.
##
## Minted tokens live IN MEMORY ONLY, per recipe, bound to the device token they were minted
## with, and are reused until `expires_at` minus 30 s; two concurrent asks share one request. A
## 401 gets the one re-acquire every authenticated call gets (the same route a document 401
## takes), then one retry; nothing else is retried. Nothing is sent when Config is off, when
## discovery says no recipe is approved, or when the id fails `^[a-z0-9-]+$`.
func mint_token(recipe_id: String) -> PKeyMintResult:
	if core == null:
		return PKeyMintResult.refused(PKeyMintResult.KIND_REFUSED, PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if not core.enabled("config"):
		var off := PKeyMintResult.refused(PKeyMintResult.KIND_REFUSED, PKeyErrors.SERVICE_UNAVAILABLE, "The config service is not enabled for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.CONFIG_MINT, "config")
		return off
	if not mint_available():
		return PKeyMintResult.refused(PKeyMintResult.KIND_REFUSED, PKeyErrors.MINT_UNAVAILABLE, "Discovery says %s has no approved edge-mint recipe." % core.product)
	if _mint_id_re.search(recipe_id) == null:
		return PKeyMintResult.refused(PKeyMintResult.KIND_REFUSED, PKeyErrors.BAD_REQUEST, "\"%s\" is not an edge-mint recipe id (lower-case letters, digits and \"-\")." % recipe_id.left(64))
	var current := core.tokens.current()
	var held = _minted.get(recipe_id)
	if held != null:
		var minted: PKeyMintResult = held["result"]
		if current != "" and held["device_token"] == current and core.clock.now() < float(minted.expires_at - MINT_REUSE_MARGIN_SECONDS):
			return minted.from_cache()
		_minted.erase(recipe_id)
	var pending = _minting.get(recipe_id)
	if pending != null and current != "" and pending.device_token == current:
		return await pending.wait()
	var p := MintPending.new(current)
	_minting[recipe_id] = p
	var out := await _mint_once(recipe_id)
	var r: PKeyMintResult = out["result"]
	if r.ok:
		_minted[recipe_id] = {"device_token": out["device_token"], "result": r}
	if _minting.get(recipe_id) == p:
		_minting.erase(recipe_id)
	p.finish(r)
	return r


## Forget every minted token (they are also forgotten at `configure`).
func clear_minted() -> void:
	_minted.clear()


func _mint_once(recipe_id: String) -> Dictionary:
	if not core.tokens.has_token():
		return {"result": PKeyMintResult.refused(PKeyMintResult.KIND_UNAUTHORIZED, PKeyErrors.NO_TOKEN, "Edge-mint needs a device token: activate, enrol, sign in or register first.")}
	var path := "config/mint/%s/token" % recipe_id
	var presented := core.tokens.current()
	var r := await core.request("GET", path, null, true)
	if _status(r) == 401 and await core.tokens.reacquire():
		presented = core.tokens.current()
		r = await core.request("GET", path, null, true)
	return {"result": _mint_result(r, recipe_id), "device_token": presented}


static func _status(r: PKeyResult) -> int:
	return int(r.detail.get("status", 0)) if r.detail is Dictionary else 0


static func _mint_result(r: PKeyResult, recipe_id: String) -> PKeyMintResult:
	var status := _status(r)
	if r.ok:
		var parsed := PKeyJson.parse_bytes(r.detail["body"])
		var b = parsed["value"] if parsed["ok"] else null
		if b is Dictionary and b.get("token") is String and b["token"] != "" and PKeyClaims.is_number(b.get("expiresAt")):
			return PKeyMintResult.minted(b["token"], int(b["expiresAt"]))
		return PKeyMintResult.refused(PKeyMintResult.KIND_INVALID_RESPONSE, PKeyErrors.INVALID_RESPONSE, "Edge-mint answered without a token and its expiry.", status)
	var kind := PKeyMintResult.KIND_ERROR
	if r.code == PKeyErrors.NO_TOKEN:
		kind = PKeyMintResult.KIND_UNAUTHORIZED
	elif status == 0:
		kind = PKeyMintResult.KIND_NETWORK
	elif status == 401:
		kind = PKeyMintResult.KIND_UNAUTHORIZED
	elif status == 404:
		kind = PKeyMintResult.KIND_NOT_FOUND
	elif status == 429:
		kind = PKeyMintResult.KIND_RATE_LIMITED
	elif status >= 500:
		kind = PKeyMintResult.KIND_SERVER_ERROR
	var message := r.message if r.message != "" else "Edge-mint of \"%s\" failed with status %d." % [recipe_id, status]
	return PKeyMintResult.refused(kind, r.code, message, status)


# ── Change notification and bindings ───────────────────────────────────────────────────────

## Bind `object.property` to `key` (PKeyConfigBinding): set now and on every change.
func bind_property(object: Object, property: StringName, key: String, fallback: Variant = null) -> PKeyConfigBinding:
	return PKeyConfigBinding.bind_property(object, property, key, fallback, self)


## Re-resolve every key this client knows, apply the bindings whose key changed, and emit
## `config_changed` once with exactly the keys whose effective value changed. PolarisKey calls it
## after start, sync and bundle import; a store's `changed` signal calls it. Returns the keys.
func refresh() -> PackedStringArray:
	var next := _take_snapshot()
	var changed := PackedStringArray()
	for k in next:
		if not _snapshot.has(k) or not _same(_snapshot[k], next[k]):
			changed.append(k)
	_snapshot = next
	_bindings = _bindings.filter(func(b: PKeyConfigBinding) -> bool: return b.target() != null)
	for h in _settings.values():
		_update_setting(h, true)
	if changed.is_empty():
		return changed
	changed.sort()
	for b in _bindings.duplicate():
		if changed.has(b.key):
			b.apply()
	config_changed.emit(changed)
	return changed


## key -> [value] (resolved) or [] (falls back), over every key this client knows: the
## document's, the catalog's config keys, the bound keys, the store's table and every key seen
## before (so a key that disappears from the document is reported too).
func _take_snapshot() -> Dictionary:
	var ctx := _context()
	var out := {}
	for k in _known_keys():
		out[k] = PKeyConfigResolve.resolve_value(ctx, k)
	return out


## Every key this client knows: seen before, the document's, the catalog's config keys, the
## bound and watched (`setting`) keys and the store's table.
func _known_keys() -> Array:
	var keys := {}
	for k in _snapshot:
		keys[k] = true
	var remote = _remote()
	if remote is Dictionary:
		for k in remote:
			keys[String(k)] = true
	for entries in [_compiled_entries, _fetched_entries]:
		for k in entries:
			if entries[k].get("kind") == "config":
				keys[k] = true
	for b in _bindings:
		keys[b.key] = true
	for k in _settings:
		keys[k] = true
	if _store != null:
		for k in _store.values:
			keys[String(k)] = true
	return keys.keys()


func _add_binding(b: PKeyConfigBinding) -> void:
	_bindings.append(b)
	if not _snapshot.has(b.key):
		_snapshot[b.key] = PKeyConfigResolve.resolve_value(_context(), b.key)


func _remove_binding(b: PKeyConfigBinding) -> void:
	_bindings.erase(b)


# ── Internals ──────────────────────────────────────────────────────────────────────────────

func _doc() -> Variant:
	if core == null or core.cache == null or core.cache.config == null:
		return null
	return core.cache.config["doc"]


func _remote() -> Variant:
	var doc = _doc()
	return doc.get("config") if doc is Dictionary and doc.get("config") is Dictionary else null


func _context() -> PKeyConfigResolve.Context:
	_ctx.remote = _remote()
	_ctx.env = env.lookup
	_ctx.env_prefix = env.prefix
	return _ctx


static func _copy(v: Variant) -> Variant:
	if v is Dictionary or v is Array:
		return v.duplicate(true)
	return v


## JSON equality: numbers by value whatever their int/float type, containers deeply.
static func _same(a: Variant, b: Variant) -> bool:
	if PKeyClaims.is_number(a) and PKeyClaims.is_number(b):
		return float(a) == float(b)
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not _same(a[i], b[i]):
				return false
		return true
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _same(a[k], b[k]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b
