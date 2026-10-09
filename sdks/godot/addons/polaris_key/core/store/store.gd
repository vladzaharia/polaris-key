class_name PKeyStore
extends RefCounted
## Where the device credential and the verified cache live (client-core `store.ts`). A store is
## DUMB on purpose: it round-trips bytes and knows nothing about versions, verification or
## migration; discarding a `v != 3` record is PKeyCache's decision, because that is a security
## rule.
##
## Failures are never swallowed: every failing operation sets `last_error` and emits `failed`,
## which Core forwards as `PolarisKey.store_error`. `status()` reports P1b-09's StoreStatus
## shape: {backend, degraded?: {reason, detail?}}.
##
## The file store (PKeyFileStore) is the default on the web; the Keychain and Keystore stores
## (P5-05, P5-06) and the desktop keyring store (PKeyKeyringStore, SP-27) subclass this.

## {op, path, error: int (Godot Error), message}.
signal failed(err: Dictionary)

## The last failure, or {} when none happened yet.
var last_error: Dictionary = {}


## The `pkeyt_` token, or "" when none is held.
func get_token() -> String:
	return ""


func set_token(_token: String) -> bool:
	return false


func clear_token() -> bool:
	return true


## The device id, minted once and then stable.
func get_device_id() -> String:
	return ""


## Whether a device id is already held, so `get_device_id()` will not derive one. Core prepares
## the raw source off the main thread first when this is false. A store that cannot tell answers
## false (preparing is then merely wasted work).
func has_device_id() -> bool:
	return false


## Whether this store keeps the device id in a desktop file that can be copied to another machine,
## so Core re-derives the id from the platform anchor at every start (PKeyDeviceBinding). The
## Keychain, Keystore, in-memory and host stores say false and keep their stored id.
func bindable() -> bool:
	return false


## Replace the stored device id (PKeyDeviceBinding only). False when it could not be written.
func set_device_id(_id: String) -> bool:
	return false


## The cache record as parsed JSON (a Dictionary), or null when absent or unreadable.
func read_cache() -> Variant:
	return null


func write_cache(_record: Dictionary) -> bool:
	return false


func clear_cache() -> bool:
	return true


func status() -> Dictionary:
	return {"backend": "custom"}


func _fail(op: String, path: String, error: int, message: String) -> void:
	last_error = {"op": op, "path": path, "error": error, "message": message}
	failed.emit(last_error)
