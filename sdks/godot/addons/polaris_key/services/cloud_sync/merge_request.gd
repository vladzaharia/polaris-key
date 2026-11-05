class_name PKeyMergeRequest
extends RefCounted
## One conflict a person or an app is asked to settle (plans/U-08.md sections 2.2 to 2.4; WIRE-CONTRACT-V5
## section 11.5). `revision` is the only policy that asks: a plain `put` of a record, or a save write, whose
## compare-and-set lost to another copy. The device keeps its copy unsent until `keep`, so nothing is lost.
##
## A port of client-core's `MergeRequest` (sync/merge.ts). The request is a live object: its members read the
## current state, so a host that holds one sees it reopen after a failed keep.
##
##   request.id          "w:<collection>/<record>"; stable while the request is open
##   request.cause       "write" ("accountMerge" arrives with U-08b)
##   request.collection, request.record      the plain record id (never sent)
##   request.local       null, or {value, version, saved_at, device, file}: this device's copy; `version` is
##                       the base it was written on, `value` a record's value or a save's metadata,
##                       `saved_at` and `device` come from a save's metadata (null for a record),
##                       `file` is null or {size, format}
##   request.remote      the same for the cloud's copy (null: deleted elsewhere); `version` is the server's
##   request.choices     the answers `keep` accepts: "local", "remote", "value" (a record) or "local",
##                       "remote" and, while a slot of the 16 is free, "both" (a save)
##   request.newer       "local", "remote" or null; by `saved_at`, display only
##   request.state       "open" or "applying" (a keep is in flight)
##   request.error       the last keep's failure code, or null
##
##   var r := await request.keep("local")     "local", "remote", "both" or {"value": v}
##
## `keep` never throws. It answers a PKeyResult: on success the detail is `{kept, version, copy_id?}`; a
## failure carries `code` `sync-merge-closed` (the request is closed), `bad_request` (not one of `choices`,
## or a keep is already running) or `sync-failed`, with the failure in `detail.code` and
## `detail.reopened` (true: the request is open again with `error` set).

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

var id: String:
	get:
		return _view["id"]
var cause: String:
	get:
		return _view["cause"]
var collection: String:
	get:
		return _view["collection"]
var record: String:
	get:
		return _view["record"]
var local: Variant:
	get:
		return Types.clone(_view["local"])
var remote: Variant:
	get:
		return Types.clone(_view["remote"])
var choices: Array:
	get:
		return (_view["choices"] as Array).duplicate()
var state: String:
	get:
		return _view["state"]
var error: Variant:
	get:
		return _view["error"]
var newer: Variant:
	get:
		return newer_of(_view["local"], _view["remote"])

var _view: Dictionary
var _registry: WeakRef
## A saves request settles its keep itself: Callable(choice) -> Dictionary (a coroutine). Invalid: the machine's.
var _backend: Callable
var _closed := false


func _init(p_view: Dictionary, registry: Object, backend: Callable = Callable()) -> void:
	_view = p_view
	_registry = weakref(registry)
	_backend = backend


## Which copy is newer by `saved_at`; null unless both carry one and they differ.
static func newer_of(p_local: Variant, p_remote: Variant) -> Variant:
	if not (p_local is Dictionary) or not (p_remote is Dictionary):
		return null
	var a: Variant = p_local.get("saved_at")
	var b: Variant = p_remote.get("saved_at")
	if not Types.is_number(a) or not Types.is_number(b) or a == b:
		return null
	return "local" if a > b else "remote"


## Whether the request has ended (kept, superseded or dropped); `keep` on it answers `sync-merge-closed`.
func is_closed() -> bool:
	return _closed


## Answer the request. See the header.
func keep(choice: Variant) -> PKeyResult:
	var reg: Object = _registry.get_ref()
	if reg == null:
		return _failure({"ok": false, "code": PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED, "reopened": false})
	return _failure(await reg.keep_request(self, choice))


static func _failure(outcome: Dictionary) -> PKeyResult:
	if outcome["ok"]:
		var d := {"kept": outcome["kept"], "version": outcome["version"]}
		if outcome.has("copy_id"):
			d["copy_id"] = outcome["copy_id"]
		return PKeyResult.success(d)
	var code := String(outcome["code"])
	var detail := {"code": code, "reopened": outcome["reopened"]}
	if code == PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED:
		return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED, "The conflict is closed.", detail)
	if code == PKeyConstants.ErrorCode.BAD_REQUEST:
		return PKeyResult.failure(PKeyConstants.ErrorCode.BAD_REQUEST, "That answer is not one of the request's choices.", detail)
	return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_FAILED, "The answer could not be applied: " + code, detail)
