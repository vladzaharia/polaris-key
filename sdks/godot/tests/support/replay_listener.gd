class_name PKeyReplayListener
extends RefCounted
## The loopback listener of a recorded conversation (the transcript replayer's): the recorded port and
## no socket. The recorded redirect is handed to the session's own callback handler, as the real
## listener would; it answers `[location, final]`.

var port := 0
var _accept: Callable = Callable()
var _closed := false


func _init(p_port: int) -> void:
	port = p_port


func start(accept: Callable) -> void:
	_accept = accept


func close() -> void:
	_closed = true


func poll() -> void:
	pass


func is_closed() -> bool:
	return _closed


## The listener's answer to the browser's redirect: `[location, final]`.
func deliver(url: String) -> Array:
	if not _accept.is_valid():
		return ["", false]
	return _accept.call(url)
