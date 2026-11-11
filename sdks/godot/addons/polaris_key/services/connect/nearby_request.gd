@tool
class_name PKeyNearbyRequest
extends RefCounted
## D's nearby request (`PolarisKey.cloud_connect.nearby.request`): the approvers found nearby and the one the
## person chose. A thin face over `PKeyPeerNearbyRequester`, which keeps the rules (see its header). Signals
## observe: `approvers_changed(list)`, `result(status)` (display only; the host's poll is the authority),
## `record(record_type, body)` (Sync records, once the person confirmed the account) and `closed(code)`.
## Methods decide: `choose(id)`, `confirm_account()`, `decline_account()`, `close()`.

signal approvers_changed(list: Array)
signal result(status: String)
signal record(record_type: int, body: PackedByteArray)
signal closed(code: StringName)

var _core: PKeyPeerNearbyRequester


func _init(core: PKeyPeerNearbyRequester) -> void:
	_core = core
	# Methods, not lambdas: a lambda holds `self`, and `core` holds the connection, a cycle that outlives the request.
	core.approvers_changed.connect(_on_approvers_changed)
	core.result.connect(_on_result)
	core.record.connect(_on_record)
	core.closed.connect(_on_closed)


func _on_approvers_changed(list: Array) -> void:
	approvers_changed.emit(list)


func _on_result(status: String) -> void:
	result.emit(status)


func _on_record(record_type: int, body: PackedByteArray) -> void:
	record.emit(record_type, body)


func _on_closed(code: StringName) -> void:
	closed.emit(code)


func _to_string() -> String:
	return "PKeyNearbyRequest()"


## The approvers that said HELLO, at most 8: [{id, label (String or null), platform}]. Empty once the person
## chose.
func approvers() -> Array:
	return _core.approvers()


## What `VOUCH_RESULT` said ("" before it came). For display only.
func get_result() -> String:
	return _core.get_result()


func is_closed() -> bool:
	return _core.is_closed()


## The person tapped this approver. Starts the code on that session only and closes the others `peer_bye`.
## ok with {code}: D's code to show ("123 456"); the request goes out once it is shown. A coroutine.
func choose(approver_id: String) -> PKeyResult:
	return await _core.choose(approver_id)


## The person confirmed that the signed-in account is theirs: held records go to `record`. It counts for the
## session that was chosen; it is not a standing consent.
func confirm_account() -> PKeyResult:
	return _core.confirm_account()


## The person declined, or the screen timed out: every held record is dropped and the session closes.
func decline_account() -> void:
	_core.decline_account()


## End the request: the browse stops and every session closes `peer_bye`.
func close() -> void:
	_core.close()


## Drop every socket now, with no goodbye (the sign-out bound's force path).
func destroy() -> void:
	_core.destroy()
