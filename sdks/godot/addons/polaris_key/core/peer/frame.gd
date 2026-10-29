@tool
class_name PKeyPeerFrame
extends RefCounted
## WIRE-CONTRACT-V5 section 15.6: TCP framing of `pkey-peer/1`, `u16be len || Noise message`, len 1 to
## 65,535 (CC-14.3), ported from `packages/client-core/src/peer/frame.ts`.
##
## Pure functions over bytes, no I/O. A zero length closes the session with `peer_bad_frame`,
## wherever it occurs. `encode` answers an empty array for a message it refuses (a frame is never
## empty). `decode` and `Reader.push` answer {ok = true, frames: Array[PackedByteArray], rest} /
## {ok = true, frames} or {ok = false, error = &"peer_bad_frame"}.

const MAX_FRAME := 65535
const ERROR_BAD_FRAME := &"peer_bad_frame"


## `u16be len || noise`, or an empty array when `noise` is empty or over MAX_FRAME bytes.
static func encode(noise: PackedByteArray) -> PackedByteArray:
	if noise.size() < 1 or noise.size() > MAX_FRAME:
		return PackedByteArray()
	var out := PackedByteArray()
	out.resize(2)
	out[0] = noise.size() >> 8
	out[1] = noise.size() & 0xff
	out.append_array(noise)
	return out


## Cut a byte stream into frames; a trailing partial frame is `rest`. A zero length closes.
static func decode(stream: PackedByteArray) -> Dictionary:
	var frames: Array[PackedByteArray] = []
	var i := 0
	var n := stream.size()
	while n - i >= 2:
		var length := (stream[i] << 8) | stream[i + 1]
		if length == 0:
			return {"ok": false, "error": ERROR_BAD_FRAME}
		if n - i - 2 < length:
			break
		frames.append(stream.slice(i + 2, i + 2 + length))
		i += 2 + length
	return {"ok": true, "frames": frames, "rest": stream.slice(i)}


## A stateful reader over a socket's chunks. One growing buffer and an offset: every byte is copied
## in once and out once (plus the occasional compaction, which moves at most as many bytes as
## were read since the last one), so a peer that trickles a frame one byte at a time costs linear
## work. `copied` counts the bytes moved, for the test. After a zero length the reader is dead and
## refuses every further chunk.
class Reader extends RefCounted:
	var copied := 0
	var _buf := PackedByteArray()
	var _start := 0
	var _dead := false


	func _to_string() -> String:
		return "PKeyPeerFrame.Reader()"


	## The bytes held and not yet cut into a frame.
	func pending() -> int:
		return _buf.size() - _start


	## {ok = true, frames} or {ok = false, error}.
	func push(chunk: PackedByteArray) -> Dictionary:
		var frames: Array[PackedByteArray] = []
		if _dead:
			return {"ok": false, "error": PKeyPeerFrame.ERROR_BAD_FRAME}
		_buf.append_array(chunk)
		copied += chunk.size()
		var n := _buf.size()
		while n - _start >= 2:
			var length := (_buf[_start] << 8) | _buf[_start + 1]
			if length == 0:
				_dead = true
				_buf = PackedByteArray()
				_start = 0
				return {"ok": false, "error": PKeyPeerFrame.ERROR_BAD_FRAME}
			if n - _start - 2 < length:
				break
			frames.append(_buf.slice(_start + 2, _start + 2 + length))
			copied += length
			_start += 2 + length
		if _start == n:
			_buf = PackedByteArray()
			_start = 0
		elif _start > 0 and _start >= n - _start:
			# The dead prefix is at least half the buffer: drop it. The live bytes moved are fewer
			# than the dead ones, which were each read in once, so the work stays linear.
			copied += n - _start
			_buf = _buf.slice(_start)
			_start = 0
		return {"ok": true, "frames": frames}
