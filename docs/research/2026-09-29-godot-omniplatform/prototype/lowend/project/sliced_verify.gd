# Frame-sliced Ed25519 verify for single-threaded builds (Godot web without threads).
#
# The same arithmetic as PKEd25519Fast.verify, but the two long loops yield to the next frame
# whenever the slice budget is spent:
#   * the SHA-512 compression loop over R || A || M (the bulk of a 350 KB bundle verify);
#   * the width-5 sliding-window double-scalar multiply (about 253 doublings).
# Everything else (A decompression, sc_reduce, the final inversion) runs unsliced; each is
# under a millisecond on desktop. Research code for S-04, not the SDK's verifier (-> P1-02).
class_name PKLowendSliced
extends RefCounted

var tree: SceneTree
var budget_us: int
var deadline := 0
var yields := 0


func _init(t: SceneTree, budget_ms: float) -> void:
	tree = t
	budget_us = int(budget_ms * 1000.0)


func _maybe_yield() -> void:
	if Time.get_ticks_usec() >= deadline:
		yields += 1
		await tree.process_frame
		deadline = Time.get_ticks_usec() + budget_us


func verify(sig: PackedByteArray, msg: PackedByteArray, pk: PackedByteArray) -> bool:
	yields = 0
	deadline = Time.get_ticks_usec() + budget_us
	if sig.size() != 64 or pk.size() != 32:
		return false
	if not PKEd25519Fast.s_is_canonical(sig) or not PKEd25519Fast.y_is_canonical(pk):
		return false
	PKEd25519Fast.warmup()
	var A: Array = PKEd25519Fast._pt(4)
	if not PKEd25519Fast.ge_frombytes_negate_vartime(A, pk):
		return false
	var hin := sig.slice(0, 32)
	hin.append_array(pk)
	hin.append_array(msg)
	var digest: PackedByteArray = await sha512(hin)
	var h: PackedByteArray = PKEd25519Fast.sc_reduce(digest)
	var R: Array = PKEd25519Fast._pt(3)
	await double_scalarmult(R, h, A, sig.slice(32, 64))
	var chk := PackedByteArray()
	chk.resize(32)
	PKEd25519Fast.ge_tobytes(chk, R)
	var d: int = 0
	for i in 32:
		d |= chk[i] ^ sig[i]
	return d == 0


## PKSha512.hash with a yield check after every 128-byte block.
func sha512(msg: PackedByteArray) -> PackedByteArray:
	var ml: int = msg.size()
	var total: int = ((ml + 16 + 1 + 127) >> 7) << 7
	var buf: PackedByteArray = msg.duplicate()
	buf.resize(total)
	buf[ml] = 0x80
	var bits: int = ml * 8
	for i in 8:
		buf[total - 1 - i] = (bits >> (8 * i)) & 0xff
	buf.reverse()
	var words: PackedInt64Array = buf.to_int64_array()
	var nw: int = words.size()
	var kk: PackedInt64Array = PackedInt64Array(PKSha512.K)
	var w: PackedInt64Array = PackedInt64Array()
	w.resize(80)
	var h0: int = PKSha512.IV[0]
	var h1: int = PKSha512.IV[1]
	var h2: int = PKSha512.IV[2]
	var h3: int = PKSha512.IV[3]
	var h4: int = PKSha512.IV[4]
	var h5: int = PKSha512.IV[5]
	var h6: int = PKSha512.IV[6]
	var h7: int = PKSha512.IV[7]
	var blk: int = 0
	while blk < nw:
		var base: int = nw - 1 - blk
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
		await _maybe_yield()
	var out: PackedByteArray = PackedInt64Array([h7, h6, h5, h4, h3, h2, h1, h0]).to_byte_array()
	out.reverse()
	return out


## PKEd25519Fast.ge_double_scalarmult_vartime with a yield check per bit position.
func double_scalarmult(r: Array, a: PackedByteArray, A: Array, b: PackedByteArray) -> void:
	var aslide: PackedInt32Array = PKEd25519Fast.slide(a)
	var bslide: PackedInt32Array = PKEd25519Fast.slide(b)
	var t0: PackedInt64Array = PKEd25519Fast.fe_new()
	var t: Array = PKEd25519Fast._pt(4)
	var u: Array = PKEd25519Fast._pt(4)
	var A2: Array = PKEd25519Fast._pt(4)
	var Ai := []
	for i in 8:
		Ai.append(PKEd25519Fast._pt(4))
	PKEd25519Fast.ge_p3_to_cached(Ai[0], A)
	PKEd25519Fast.ge_p2_dbl(t, A, t0)
	PKEd25519Fast.ge_p1p1_to_p3(A2, t)
	for i in 7:
		PKEd25519Fast.ge_add(t, A2, Ai[i], t0)
		PKEd25519Fast.ge_p1p1_to_p3(u, t)
		PKEd25519Fast.ge_p3_to_cached(Ai[i + 1], u)
	PKEd25519Fast.fe_0(r[0])
	PKEd25519Fast.fe_1(r[1])
	PKEd25519Fast.fe_1(r[2])
	var bi_tab: Array = PKEd25519Fast._bi
	var i := 255
	while i >= 0:
		if aslide[i] != 0 or bslide[i] != 0:
			break
		i -= 1
	while i >= 0:
		PKEd25519Fast.ge_p2_dbl(t, r, t0)
		var ai: int = aslide[i]
		if ai > 0:
			PKEd25519Fast.ge_p1p1_to_p3(u, t)
			PKEd25519Fast.ge_add(t, u, Ai[ai >> 1], t0)
		elif ai < 0:
			PKEd25519Fast.ge_p1p1_to_p3(u, t)
			PKEd25519Fast.ge_sub(t, u, Ai[(-ai) >> 1], t0)
		var bi: int = bslide[i]
		if bi > 0:
			PKEd25519Fast.ge_p1p1_to_p3(u, t)
			PKEd25519Fast.ge_madd(t, u, bi_tab[bi >> 1], t0)
		elif bi < 0:
			PKEd25519Fast.ge_p1p1_to_p3(u, t)
			PKEd25519Fast.ge_msub(t, u, bi_tab[(-bi) >> 1], t0)
		PKEd25519Fast.ge_p1p1_to_p2(r, t)
		i -= 1
		await _maybe_yield()
