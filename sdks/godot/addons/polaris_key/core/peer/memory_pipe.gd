@tool
class_name PKeyPeerMemoryPipe
extends PKeyPeerPipe
## Two ends of an in-memory byte pipe (CC-14.10a): what one end writes the other reads, in order.
## For tests and for a session wired to another in one process. Closing an end ends both
## directions for writing; the other end still reads what was sent before the close.

var _shared: Shared
var _side: int


## Both ends: [PKeyPeerMemoryPipe, PKeyPeerMemoryPipe].
static func pair() -> Array:
	var shared := Shared.new()
	return [PKeyPeerMemoryPipe.new(shared, 0), PKeyPeerMemoryPipe.new(shared, 1)]


func _init(shared: Shared = null, side := 0) -> void:
	_shared = shared if shared != null else Shared.new()
	_side = side


func _to_string() -> String:
	return "PKeyPeerMemoryPipe()"


func read() -> PackedByteArray:
	var out: PackedByteArray = _shared.buffers[_side]
	_shared.buffers[_side] = PackedByteArray()
	return out


func write(bytes: PackedByteArray) -> bool:
	if _shared.closed[_side] or _shared.closed[1 - _side]:
		return false
	# A PackedByteArray in an Array is a value: take it out, extend it, put it back.
	var queue: PackedByteArray = _shared.buffers[1 - _side]
	queue.append_array(bytes)
	_shared.buffers[1 - _side] = queue
	return true


func is_open() -> bool:
	return not (_shared.closed[0] or _shared.closed[1]) or not (_shared.buffers[_side] as PackedByteArray).is_empty()


func close() -> void:
	_shared.closed[_side] = true


func abort() -> void:
	_shared.closed[_side] = true
	_shared.buffers[1 - _side] = PackedByteArray()


func is_finished() -> bool:
	return _shared.closed[_side]


func remote_address() -> String:
	return "memory"


## What the two ends share: a buffer toward each and a closed flag for each.
class Shared extends RefCounted:
	var buffers: Array = [PackedByteArray(), PackedByteArray()]
	var closed: Array = [false, false]
