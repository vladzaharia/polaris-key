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
var _compiled_entries := {}
var _compiled_defaults := {}
var _compiled_version = null
var _fetched = null
var _fetched_entries := {}
var _snapshot := {}
var _bindings: Array = []
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
	_snapshot = _take_snapshot()


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


## The rows a settings screen shows: every key the document carries MINUS the hidden ones, in
## document order, enforced rows flagged (show them read-only). Hidden keys are still applied by
## `get_value`; they are only withheld here.
func list_user_config() -> Array[PKeyConfigEntry]:
	var out: Array[PKeyConfigEntry] = []
	var ctx := _context()
	for row in PKeyConfigResolve.list_user_entries(ctx.remote):
		var r := PKeyConfigResolve.resolve(ctx, row["key"])
		out.append(PKeyConfigEntry.new(row["key"], _copy(r["value"] if r["found"] else row["value"]), row["enforced"], r["source"], catalog_entry(row["key"])))
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
	if _store != null and _store.changed.is_connected(_on_store_changed):
		_store.changed.disconnect(_on_store_changed)
	_store = store
	if _store != null:
		_store.changed.connect(_on_store_changed)
	refresh()


func get_override_store() -> PKeyOverrideStore:
	return _store


func _on_store_changed(_keys: PackedStringArray) -> void:
	refresh()


func _local(key: String) -> Array:
	if _store == null:
		return []
	var accessor := _accessor(key)
	return [_store.get_override(key, accessor)] if _store.has_override(key, accessor) else []


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
		return PKeyMintResult.refused(PKeyMintResult.KIND_REFUSED, PKeyErrors.SERVICE_UNAVAILABLE, "The config service is not enabled for %s." % core.product)
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
	if _store != null:
		for k in _store.values:
			keys[String(k)] = true
	var ctx := _context()
	var out := {}
	for k in keys:
		out[k] = PKeyConfigResolve.resolve_value(ctx, k)
	return out


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
