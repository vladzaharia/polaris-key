class_name PKeySha512Stream
extends RefCounted
## Resumable SHA-512 (FIPS 180-4): the same compression as `PKeySha512.hash`, run a few blocks at
## a time, so a bundle-sized hash can be spread across frames (no-threads web) or run on a
## worker thread. The whole message is known up front (a JWS signing input), so padding and the
## big-endian word load happen once, natively, exactly as `PKeySha512.hash` does them.

var _words: PackedInt64Array
var _nw := 0
var _blk := 0
var _h := PackedInt64Array(PKeySha512.IV)
var _w := PackedInt64Array()
var _kk := PackedInt64Array(PKeySha512.K)


func _init(msg: PackedByteArray) -> void:
	var ml: int = msg.size()
	var total: int = ((ml + 16 + 1 + 127) >> 7) << 7
	var buf: PackedByteArray = msg.duplicate()
	buf.resize(total)
	buf[ml] = 0x80
	var bits: int = ml * 8
	for i in 8:
		buf[total - 1 - i] = (bits >> (8 * i)) & 0xff
	buf.reverse()
	_words = buf.to_int64_array()
	_nw = _words.size()
	_w.resize(80)


func is_done() -> bool:
	return _blk >= _nw


## Compresses up to `max_blocks` 128-byte blocks. Returns true once every block is done.
func step(max_blocks: int) -> bool:
	var words := _words
	var w := _w
	var kk := _kk
	var h0: int = _h[0]
	var h1: int = _h[1]
	var h2: int = _h[2]
	var h3: int = _h[3]
	var h4: int = _h[4]
	var h5: int = _h[5]
	var h6: int = _h[6]
	var h7: int = _h[7]
	var blk: int = _blk
	var stop: int = mini(_nw, blk + 16 * max_blocks)
	while blk < stop:
		var base: int = _nw - 1 - blk
		for t in 16:
			w[t] = words[base - t]
		for t in range(16, 80):
			var x: int = w[t - 15]
			var y: int = w[t - 2]
			var s0: int = (((x >> 1) & 0x7fffffffffffffff) | (x << 63)) ^ (((x >> 8) & 0x00ffffffffffffff) | (x << 56)) ^ ((x >> 7) & 0x01ffffffffffffff)
			var s1: int = (((y >> 19) & 0x00001fffffffffff) | (y << 45)) ^ (((y >> 61) & 0x7) | (y << 3)) ^ ((y >> 6) & 0x03ffffffffffffff)
			w[t] = w[t - 16] + s0 + w[t - 7] + s1
		var a: int = h0
		var b: int = h1
		var c: int = h2
		var d: int = h3
		var e: int = h4
		var f: int = h5
		var g: int = h6
		var h: int = h7
		for t in 80:
			var S1: int = (((e >> 14) & 0x0003ffffffffffff) | (e << 50)) ^ (((e >> 18) & 0x00003fffffffffff) | (e << 46)) ^ (((e >> 41) & 0x7fffff) | (e << 23))
			var t1: int = h + S1 + ((e & f) ^ (~e & g)) + kk[t] + w[t]
			var S0: int = (((a >> 28) & 0xfffffffff) | (a << 36)) ^ (((a >> 34) & 0x3fffffff) | (a << 30)) ^ (((a >> 39) & 0x1ffffff) | (a << 25))
			var t2: int = S0 + ((a & b) ^ (a & c) ^ (b & c))
			h = g
			g = f
			f = e
			e = d + t1
			d = c
			c = b
			b = a
			a = t1 + t2
		h0 += a
		h1 += b
		h2 += c
		h3 += d
		h4 += e
		h5 += f
		h6 += g
		h7 += h
		blk += 16
	_blk = blk
	_h[0] = h0
	_h[1] = h1
	_h[2] = h2
	_h[3] = h3
	_h[4] = h4
	_h[5] = h5
	_h[6] = h6
	_h[7] = h7
	return _blk >= _nw


## The 64-byte digest. Finishes any blocks still pending.
func digest() -> PackedByteArray:
	while not step(64):
		pass
	var out: PackedByteArray = PackedInt64Array([_h[7], _h[6], _h[5], _h[4], _h[3], _h[2], _h[1], _h[0]]).to_byte_array()
	out.reverse()
	return out
