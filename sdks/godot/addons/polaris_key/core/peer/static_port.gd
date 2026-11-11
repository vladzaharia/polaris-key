@tool
class_name PKeyPeerStaticPort
extends RefCounted
## A key port whose public half was read at `create`, on the calling thread: the Noise task may run
## on another, and the port's `dh` is the only call it makes (the device key store locks inside it).

var _inner: Object
var _pub: PackedByteArray


func _init(inner: Object, pub: PackedByteArray) -> void:
	_inner = inner
	_pub = pub.duplicate()


func _to_string() -> String:
	return "PKeyPeerStaticPort()"


func public_key() -> PackedByteArray:
	return _pub.duplicate()


func dh(remote: PackedByteArray) -> Variant:
	return _inner.call("dh", remote)
