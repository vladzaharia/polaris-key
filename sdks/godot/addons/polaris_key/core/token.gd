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

## Emitted when an in-flight re-acquire settles.
signal reacquired(ok: bool)

var store: PKeyStore
## The PKeyCore handed to the re-acquire callable (weak: Core owns this manager).
var core_ref: WeakRef = null
## How many re-acquire attempts actually ran (tests assert one per pass).
var attempts := 0

var _token := ""
var _reacquire: Callable
var _in_flight := false
var _attempted := false
var _last_ok := false


func _init(p_store: PKeyStore) -> void:
	store = p_store


func load_token() -> void:
	_token = store.get_token()


func current() -> String:
	return _token


func has_token() -> bool:
	return _token != ""


func set_token(token: String) -> bool:
	_token = token
	return store.set_token(token)


func clear() -> bool:
	_token = ""
	return store.clear_token()


## `callable(core: PKeyCore, current_token: String) -> String`: the new token, or "" on failure
## (sdk-node's `ReacquireFn(ctx, current)`). It may be a coroutine; it is awaited. Core is passed
## in rather than captured, so the callable does not keep Core alive.
func set_reacquire(callable: Callable) -> void:
	_reacquire = callable


## Re-arm the single-attempt budget; called once at the top of each sync.
func begin_pass() -> void:
	_in_flight = false
	_attempted = false
	_last_ok = false


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
	var ok: bool = next is String and next != ""
	if ok:
		set_token(next)
	_last_ok = ok
	_in_flight = false
	reacquired.emit(ok)
	return ok
