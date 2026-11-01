class_name PKeyLoopbackTicker
extends Node
## Drives a PKeyLoopbackListener every frame while it lives (a child of the SDK's host node). It
## frees itself once the listener has closed. It runs while the game is paused.

var listener: Object = null


func _init() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	name = "PKeyLoopbackTicker"


func _process(_delta: float) -> void:
	if listener == null or listener.is_closed():
		queue_free()
		return
	listener.poll()
