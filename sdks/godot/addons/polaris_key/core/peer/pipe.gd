@tool
class_name PKeyPeerPipe
extends RefCounted
## The byte pipe under a `PKeyPeerLink` (CC-14.10a): a socket, an in-memory pair or a native pipe
## (CC-14b) behind one non-blocking port. The base class is a closed pipe; an implementation
## overrides the methods. Nothing here blocks, and nothing in a pipe's `str()` shows an address or
## a byte.
##
##   poll()           drive the transport; the link calls it once a frame
##   read()           the bytes that arrived since the last read; empty for none
##   write(bytes)     queue bytes to send; false when the pipe is closed or its queue is full
##   is_open()        false once the other side has closed and everything it sent has been read
##   close()          stop sending after what is queued has been flushed
##   abort()          drop the connection now
##   is_finished()    closed and nothing left to flush: the pump may let go of the link
##   remote_address() the peer's address as text, "" when it has none


func poll() -> void:
	pass


func read() -> PackedByteArray:
	return PackedByteArray()


func write(_bytes: PackedByteArray) -> bool:
	return false


func is_open() -> bool:
	return false


func close() -> void:
	pass


func abort() -> void:
	pass


func is_finished() -> bool:
	return true


func remote_address() -> String:
	return ""
