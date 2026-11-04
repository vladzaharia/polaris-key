class_name PKeyTokenManager
extends RefCounted
## The device credential (WIRE-CONTRACT-V3 §6): sdk-node `core/token.ts`.
##
## §5: a 401 gets exactly ONE re-acquire, then one retry of the failed fetch. `sync()` fetches
## licence and config in parallel and both can 401 at once, so `reacquire_once` collapses them:
## the first caller starts the attempt, every other caller in the same pass awaits THAT
## attempt (the `reacquired` signal), and `begin_pass()` re-arms it once per sync.
##
## The re-acquire itself is injected (`set_reacquire`): P1-03 supplies `POST /license/token`
## and `POST /devices/register` (re-register on 401 for licence-less devices). Without one, a
## 401 is a hard 401.

## How the current token was obtained (P1b-06's TokenSource), held in memory only: after a restart
## the source is unknown (""), because persisting it would change the store contract.
const SOURCE_ACTIVATE := "activate"
const SOURCE_ENROLL := "enroll"
const SOURCE_REGISTER := "register"
const SOURCE_SIGNIN := "signin"
const SOURCE_REACQUIRE := "reacquire"
## What the device holds its token as (`tokenOrigin` in the cache record, kept across restarts).
## Automatic sign-in's rung 1 counts only ORIGIN_SIGN_IN: not a key activation, an enrolment or a
## registration, and not a device an account sign-out left activated.
const ORIGIN_SIGN_IN := "sign_in"
const ORIGIN_REGISTER := "register"
const ORIGIN_KEY := "key"
## The two routes the §5 single re-acquire can take (`choose_reacquire_route`).
const ROUTE_LICENSE_TOKEN := "license-token"
const ROUTE_DEVICES_REGISTER := "devices-register"

## Emitted when an in-flight re-acquire settles.
signal reacquired(ok: bool)

var store: PKeyStore
## The PKeyCore handed to the re-acquire callable (weak: Core owns this manager).
var core_ref: WeakRef = null
## How many re-acquire attempts actually ran (tests assert one per pass).
var attempts := 0

## Bumped by every sign-out. A ladder that read an earlier value must not store a token
## (set_token_unless_signed_out).
var sign_out_generation := 0

var _token := ""
var _source := ""
var _reacquire: Callable
var _in_flight := false
var _attempted := false
var _last_ok := false


func _init(p_store: PKeyStore) -> void:
	store = p_store


func load_token() -> void:
	_token = store.get_token()
	_source = ""


func current() -> String:
	return _token


func has_token() -> bool:
	return _token != ""


## How the current token was obtained in this process (SOURCE_*), or "" when it was loaded from
## the store or none is held.
func source() -> String:
	return _source


## Hold and persist `token`, obtained through `p_source` (SOURCE_*). False when the store could
## not write it (the token is still held for this session; the store reported the failure).
##
## `p_origin` (ORIGIN_*) is what the device holds the token as; "" derives it from the source
## (`reacquire` and "" keep what is held). `person` is true for a sign-in the person started
## (device code, redirect, `choice.complete`, an `exchange` called from the sign-in form): only that
## lowers the sign-out flag. The ladder's own store never does.
func set_token(token: String, p_source := "", person := false, p_origin := "") -> bool:
	var cache := _cache()
	var origin := p_origin if p_origin != "" else origin_of(p_source)
	# Crash-safe order: a changing origin is erased first and written last, so a crash between
	# leaves none, which rung 1 reads as "not a sign-in".
	if cache != null and origin != "" and cache.token_origin != "" and cache.token_origin != origin:
		cache.set_token_origin("")
	_token = token
	_source = p_source
	var stored := store.set_token(token)
	# A token that replaces an unconfirmed one is written first; only then does the mark go. A re-acquire
	# (no origin) keeps it.
	if cache != null and stored and origin != "" and cache.token_unconfirmed:
		cache.set_token_unconfirmed(false)
	if cache != null:
		if origin != "":
			cache.set_token_origin(origin)
		if person:
			cache.set_explicit_sign_out(false)
	return stored


func clear() -> bool:
	_token = ""
	_source = ""
	var cache := _cache()
	if cache != null:
		cache.set_token_origin("")
	var cleared := store.clear_token()
	# The mark goes after the token it describes: a crash leaves a mark over no token, never a bare token.
	if cleared and cache != null:
		cache.set_token_unconfirmed(false)
	return cleared


## True while the held token is a nearby sign-in's that no person confirmed (see PKeyCache.token_unconfirmed).
func unconfirmed() -> bool:
	var cache := _cache()
	return _token != "" and cache != null and cache.token_unconfirmed


## Hold a nearby sign-in's token under the unconfirmed mark. The mark is written BEFORE the token (a crash leaves
## the old token or the marked one, never a bare one); a mark that cannot be written stores nothing. It is no
## sign-in (no origin) until confirm_unconfirmed(). False when nothing was stored.
func set_unconfirmed_token(token: String) -> bool:
	var cache := _cache()
	if cache == null or token == "" or not cache.mark_unconfirmed():
		return false
	if not store.set_token(token):
		cache.set_token_unconfirmed(false)
		return false
	_token = token
	_source = SOURCE_SIGNIN
	return true


## The person confirmed the account: `&"ok"` once the token is a sign-in (the mark is gone, the origin is
## `sign_in`, the signed-out flag is lowered). The held token is compared to `expected` and the mark checked
## in this one step, with no await: `&"mismatch"` (another token is held, so nothing is confirmed), `&"none"`
## (nothing is unconfirmed) or `&"failed"` (the record could not be written; the token stays unconfirmed).
func confirm_unconfirmed(expected: String) -> StringName:
	if expected == "" or _token != expected:
		return &"mismatch"
	if not unconfirmed():
		return &"none"
	var cache := _cache()
	if not cache.confirm_unconfirmed():
		return &"failed"
	cache.set_explicit_sign_out(false)
	return &"ok"


## The ladder's store: only while no sign-out happened since `generation` was read and the flag is
## clear. The check and the write have no await between them, so a sign-out cannot interleave
## (I-45.9's fix). Null stores nothing; else the store's verdict, as set_token(). Never lowers the
## flag.
func set_token_unless_signed_out(token: String, generation: int) -> Variant:
	var cache := _cache()
	if cache == null or cache.explicit_sign_out or generation != sign_out_generation:
		return null
	return set_token(token, SOURCE_SIGNIN)


func bump_sign_out_generation() -> void:
	sign_out_generation += 1


## What the held token is (ORIGIN_*), or "" when none or unknown.
func origin() -> String:
	var cache := _cache()
	return cache.token_origin if cache != null and _token != "" else ""


## True after a sign-out until the next sign-in the person starts. Fails closed: without a cache
## it reads as signed out.
func explicit_sign_out() -> bool:
	var cache := _cache()
	return cache == null or cache.explicit_sign_out


static func origin_of(p_source: String) -> String:
	match p_source:
		SOURCE_SIGNIN:
			return ORIGIN_SIGN_IN
		SOURCE_REGISTER, SOURCE_ENROLL:
			return ORIGIN_REGISTER
		SOURCE_ACTIVATE:
			return ORIGIN_KEY
	return ""


func _cache() -> PKeyCache:
	var core = core_ref.get_ref() if core_ref != null else null
	return core.cache if core != null else null


## P1b-06's route rule for the §5 single re-acquire, the same in every SDK: License disabled for
## the product, or a token this process minted by registering, re-registers
## (ROUTE_DEVICES_REGISTER); anything else asks `POST /license/token` (ROUTE_LICENSE_TOKEN).
## There is deliberately no restart heuristic: after a restart the source is "".
static func choose_reacquire_route(license_enabled: bool, p_source: String) -> String:
	if not license_enabled or p_source == SOURCE_REGISTER:
		return ROUTE_DEVICES_REGISTER
	return ROUTE_LICENSE_TOKEN


## `callable(core: PKeyCore, current_token: String) -> Variant`: the new token String, or
## {token, source} to name how it was obtained (a bare String counts as SOURCE_REACQUIRE), or
## "" / null on failure (sdk-node's `ReacquireFn(ctx, current, source)`; the current source is
## `core.tokens.source()`). It may be a coroutine; it is awaited. Core is passed in rather than
## captured, so the callable does not keep Core alive.
func set_reacquire(callable: Callable) -> void:
	_reacquire = callable


## Re-arm the single-attempt budget; called once at the top of each sync.
func begin_pass() -> void:
	_in_flight = false
	_attempted = false
	_last_ok = false


## The single re-acquire for an authenticated call made OUTSIDE a sync pass (an edge-mint): one
## attempt per call, never a loop, through the same injected route a document 401 takes. The
## caller retries its request once when this returns true and fails on a second 401. It does not
## touch the sync pass's budget; an attempt already in flight is joined. A coroutine.
func reacquire() -> bool:
	if _in_flight:
		return await reacquired
	if _token == "" or not _reacquire.is_valid():
		return false
	_in_flight = true
	attempts += 1
	var next: Array = _normalise_reacquired(
		await _reacquire.call(core_ref.get_ref() if core_ref != null else null, _token)
	)
	var ok: bool = next[0] != ""
	if ok:
		set_token(next[0], next[1])
	_in_flight = false
	reacquired.emit(ok)
	return ok


## At most one re-acquire per pass, shared by every concurrent 401. True when a NEW token is in
## hand and the caller should retry once. A coroutine.
func reacquire_once() -> bool:
	if _in_flight:
		return await reacquired
	if _attempted:
		return _last_ok
	if _token == "" or not _reacquire.is_valid():
		return false
	_attempted = true
	_in_flight = true
	attempts += 1
	var current_token := _token
	var next: Array = _normalise_reacquired(
		await _reacquire.call(core_ref.get_ref() if core_ref != null else null, current_token)
	)
	var ok: bool = next[0] != ""
	if ok:
		set_token(next[0], next[1])
	_last_ok = ok
	_in_flight = false
	reacquired.emit(ok)
	return ok


## A re-acquire callable's result as [token, source]: a bare String is SOURCE_REACQUIRE,
## {token, source?} names its source (empty or missing also means SOURCE_REACQUIRE), and
## anything else is ["", SOURCE_REACQUIRE] (failure). Shared by reacquire() and reacquire_once().
static func _normalise_reacquired(next: Variant) -> Array:
	var next_token := ""
	var next_source := SOURCE_REACQUIRE
	if next is String:
		next_token = next
	elif next is Dictionary and next.get("token") is String:
		next_token = next["token"]
		if next.get("source") is String and next["source"] != "":
			next_source = next["source"]
	return [next_token, next_source]
