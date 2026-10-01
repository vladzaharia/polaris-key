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
func set_token(token: String, p_source := "") -> bool:
	_token = token
	_source = p_source
	return store.set_token(token)


func clear() -> bool:
	_token = ""
	_source = ""
	return store.clear_token()


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
	var next = await _reacquire.call(core_ref.get_ref() if core_ref != null else null, _token)
	var ok: bool = next is String and next != ""
	if ok:
		set_token(next)
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
	var next = await _reacquire.call(core_ref.get_ref() if core_ref != null else null, current_token)
	var next_token := ""
	var next_source := SOURCE_REACQUIRE
	if next is String:
		next_token = next
	elif next is Dictionary and next.get("token") is String:
		next_token = next["token"]
		if next.get("source") is String and next["source"] != "":
			next_source = next["source"]
	var ok := next_token != ""
	if ok:
		set_token(next_token, next_source)
	_last_ok = ok
	_in_flight = false
	reacquired.emit(ok)
	return ok
