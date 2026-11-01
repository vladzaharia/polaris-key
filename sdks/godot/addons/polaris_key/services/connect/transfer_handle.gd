@tool
class_name PKeyTransferHandle
extends RefCounted
## An outgoing Direct Transfer (WIRE-CONTRACT-V5 section 15.11): what `PolarisKey.cloud_connect.transfer.send()`
## answers. The content moves when the peer accepts. `await handle.wait()` (or the `finished` signal)
## settles on the end, which is also what the `result` signal of the transfer API reports:
##
##   {id, direction = "out", outcome, reason?, delivered}
##
## `outcome` is `delivered`, `cancelled` (`reason` says why: `declined`, `cancelled`, `hash`, `size`,
## `category`, `busy`, `quota` or `timeout`) or `closed` (the session ended first). `wait()` answers ok with
## the result when delivered, else a `transfer-cancelled` failure whose detail is the result.

signal finished(r: Dictionary)

var id := ""
## The result once the transfer ended; null while it runs.
var result: Variant = null

var _cancel: Callable


func _init(p_id: String, p_cancel: Callable) -> void:
	id = p_id
	_cancel = p_cancel


func _to_string() -> String:
	return "PKeyTransferHandle(%s%s)" % [id, " done" if result != null else ""]


func is_done() -> bool:
	return result != null


## Cancel (a no-op once the content is out and the peer has the last record).
func cancel() -> void:
	if _cancel.is_valid():
		_cancel.call(id)


## Waits for the end. A coroutine.
func wait() -> PKeyResult:
	while result == null:
		await finished
	var r: Dictionary = result
	if r["outcome"] == "delivered":
		return PKeyResult.success(r)
	return PKeyResult.failure(PKeyConstants.ErrorCode.TRANSFER_CANCELLED, "The transfer did not finish.", r)


## The transfer layer's call: the end, once.
func _finish(r: Dictionary) -> void:
	if result != null:
		return
	result = r
	_cancel = Callable()
	finished.emit(r)
