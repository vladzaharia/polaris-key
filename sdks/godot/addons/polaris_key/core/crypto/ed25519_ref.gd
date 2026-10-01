# Ed25519 signature VERIFY in pure GDScript — straight port of TweetNaCl's crypto_sign_open
# (public domain, Bernstein et al.), field elements as 16 x 16-bit limbs in PackedInt64Array.
#
# This is the "baseline" variant: faithful to the C, loops not unrolled, every field element a
# fresh PackedInt64Array. See ed25519_fast.gd for the optimized variant.
#
# Deviations from TweetNaCl, all toward STRICTER (matching WebCrypto/OpenSSL, CryptoKit,
# pyca/cryptography as used by the other Polaris Key SDKs):
#   * S must be canonical (S < L) — TweetNaCl omits this check (signature malleability).
#   * The public key's y-coordinate must be canonical (y < p).
#   * Carries use multiplication instead of `c << 16` so no shift ever has a negative LEFT
#     operand written as a constant expression (GDScript's analyzer rejects that at parse time
#     in debug builds; the runtime VM uses validated operators and does an arithmetic shift).
class_name PKeyEd25519Ref
extends RefCounted

const D := [0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203]
const D2 := [0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406]
const GX := [0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169]
const GY := [0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666]
const SQRTM1 := [0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83]
const L := [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]


static func gf(init: Array = []) -> PackedInt64Array:
	# A local copy: on 4.4 two threads reading one const Array race (it hands elements out
	# through a single shared slot), so thread-reachable code never indexes or iterates one.
	var src := PackedInt64Array(init)
	var r := PackedInt64Array()
	r.resize(16)
	for i in init.size():
		r[i] = src[i]
	return r


static func set25519(r: PackedInt64Array, a: PackedInt64Array) -> void:
	for i in 16:
		r[i] = a[i]


static func car25519(o: PackedInt64Array) -> void:
	var c: int
	for i in 16:
		o[i] += 65536
		c = o[i] >> 16
		if i < 15:
			o[i + 1] += c - 1
		else:
			o[0] += c - 1 + 37 * (c - 1)
		o[i] -= c * 65536


static func sel25519(p: PackedInt64Array, q: PackedInt64Array, b: int) -> void:
	var c: int = ~(b - 1)
	var t: int
	for i in 16:
		t = c & (p[i] ^ q[i])
		p[i] ^= t
		q[i] ^= t


static func pack25519(o: PackedByteArray, n: PackedInt64Array) -> void:
	var m := gf()
	var t := gf()
	set25519(t, n)
	car25519(t)
	car25519(t)
	car25519(t)
	for j in 2:
		m[0] = t[0] - 0xffed
		for i in range(1, 15):
			m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1)
			m[i - 1] &= 0xffff
		m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1)
		var b: int = (m[15] >> 16) & 1
		m[14] &= 0xffff
		sel25519(t, m, 1 - b)
	for i in 16:
		o[2 * i] = t[i] & 0xff
		o[2 * i + 1] = (t[i] >> 8) & 0xff


static func verify32(x: PackedByteArray, xo: int, y: PackedByteArray) -> bool:
	var d: int = 0
	for i in 32:
		d |= x[xo + i] ^ y[i]
	return d == 0


static func neq25519(a: PackedInt64Array, b: PackedInt64Array) -> bool:
	var c := PackedByteArray()
	c.resize(32)
	var d := PackedByteArray()
	d.resize(32)
	pack25519(c, a)
	pack25519(d, b)
	return not verify32(c, 0, d)


static func par25519(a: PackedInt64Array) -> int:
	var d := PackedByteArray()
	d.resize(32)
	pack25519(d, a)
	return d[0] & 1


static func unpack25519(o: PackedInt64Array, n: PackedByteArray) -> void:
	for i in 16:
		o[i] = n[2 * i] + (n[2 * i + 1] << 8)
	o[15] &= 0x7fff


static func A(o: PackedInt64Array, a: PackedInt64Array, b: PackedInt64Array) -> void:
	for i in 16:
		o[i] = a[i] + b[i]


static func Z(o: PackedInt64Array, a: PackedInt64Array, b: PackedInt64Array) -> void:
	for i in 16:
		o[i] = a[i] - b[i]


static func M(o: PackedInt64Array, a: PackedInt64Array, b: PackedInt64Array) -> void:
	var t := PackedInt64Array()
	t.resize(31)
	for i in 16:
		var ai: int = a[i]
		for j in 16:
			t[i + j] += ai * b[j]
	for i in 15:
		t[i] += 38 * t[i + 16]
	for i in 16:
		o[i] = t[i]
	car25519(o)
	car25519(o)


static func S(o: PackedInt64Array, a: PackedInt64Array) -> void:
	M(o, a, a)


static func inv25519(o: PackedInt64Array, i: PackedInt64Array) -> void:
	var c := gf()
	set25519(c, i)
	for a in range(253, -1, -1):
		S(c, c)
		if a != 2 and a != 4:
			M(c, c, i)
	set25519(o, c)


static func pow2523(o: PackedInt64Array, i: PackedInt64Array) -> void:
	var c := gf()
	set25519(c, i)
	for a in range(250, -1, -1):
		S(c, c)
		if a != 1:
			M(c, c, i)
	set25519(o, c)


static func add(p: Array, q: Array) -> void:
	var a := gf(); var b := gf(); var c := gf(); var d := gf(); var t := gf()
	var e := gf(); var f := gf(); var g := gf(); var h := gf()
	var d2 := gf(D2)
	Z(a, p[1], p[0])
	Z(t, q[1], q[0])
	M(a, a, t)
	A(b, p[0], p[1])
	A(t, q[0], q[1])
	M(b, b, t)
	M(c, p[3], q[3])
	M(c, c, d2)
	M(d, p[2], q[2])
	A(d, d, d)
	Z(e, b, a)
	Z(f, d, c)
	A(g, d, c)
	A(h, b, a)
	M(p[0], e, f)
	M(p[1], h, g)
	M(p[2], g, f)
	M(p[3], e, h)


static func cswap(p: Array, q: Array, b: int) -> void:
	for i in 4:
		sel25519(p[i], q[i], b)


static func pack(r: PackedByteArray, p: Array) -> void:
	var tx := gf(); var ty := gf(); var zi := gf()
	inv25519(zi, p[2])
	M(tx, p[0], zi)
	M(ty, p[1], zi)
	pack25519(r, ty)
	r[31] ^= par25519(tx) << 7


static func scalarmult(p: Array, q: Array, s: PackedByteArray) -> void:
	set25519(p[0], gf())
	set25519(p[1], gf([1]))
	set25519(p[2], gf([1]))
	set25519(p[3], gf())
	for i in range(255, -1, -1):
		var b: int = (s[i >> 3] >> (i & 7)) & 1
		cswap(p, q, b)
		add(q, p)
		add(p, p)
		cswap(p, q, b)


static func scalarbase(p: Array, s: PackedByteArray) -> void:
	var q := [gf(GX), gf(GY), gf([1]), gf()]
	M(q[3], gf(GX), gf(GY))
	scalarmult(p, q, s)


static func modL(r: PackedByteArray, x: PackedInt64Array) -> void:
	var l := PackedInt64Array(L)  # see gf
	var carry: int
	var j: int
	for i in range(63, 31, -1):
		carry = 0
		j = i - 32
		while j < i - 12:
			x[j] += carry - 16 * x[i] * l[j - (i - 32)]
			carry = (x[j] + 128) >> 8
			x[j] -= carry * 256
			j += 1
		x[j] += carry
		x[i] = 0
	carry = 0
	for k in 32:
		x[k] += carry - (x[31] >> 4) * l[k]
		carry = x[k] >> 8
		x[k] &= 255
	for k in 32:
		x[k] -= carry * l[k]
	for k in 32:
		x[k + 1] += x[k] >> 8
		r[k] = x[k] & 255


static func reduce(h: PackedByteArray) -> PackedByteArray:
	var x := PackedInt64Array()
	x.resize(64)
	for i in 64:
		x[i] = h[i]
	var r := PackedByteArray()
	r.resize(32)
	modL(r, x)
	return r


## True iff the 32-byte little-endian scalar at sig[32..64) is < L (canonical S).
static func s_is_canonical(sig: PackedByteArray) -> bool:
	var l := PackedInt64Array(L)  # see gf
	for i in range(31, -1, -1):
		var si: int = sig[32 + i]
		if si < l[i]:
			return true
		if si > l[i]:
			return false
	return false  # S == L


## True iff the 255-bit y encoded in pk is < p = 2^255 - 19.
static func y_is_canonical(pk: PackedByteArray) -> bool:
	if (pk[31] & 0x7f) != 0x7f:
		return true
	for i in range(30, 0, -1):
		if pk[i] != 0xff:
			return true
	return pk[0] < 0xed


static func unpackneg(r: Array, p: PackedByteArray) -> bool:
	var t := gf(); var chk := gf(); var num := gf(); var den := gf()
	var den2 := gf(); var den4 := gf(); var den6 := gf()
	set25519(r[2], gf([1]))
	unpack25519(r[1], p)
	S(num, r[1])
	M(den, num, gf(D))
	Z(num, num, r[2])
	A(den, r[2], den)
	S(den2, den)
	S(den4, den2)
	M(den6, den4, den2)
	M(t, den6, num)
	M(t, t, den)
	pow2523(t, t)
	M(t, t, num)
	M(t, t, den)
	M(t, t, den)
	M(r[0], t, den)
	S(chk, r[0])
	M(chk, chk, den)
	if neq25519(chk, num):
		M(r[0], r[0], gf(SQRTM1))
	S(chk, r[0])
	M(chk, chk, den)
	if neq25519(chk, num):
		return false
	if par25519(r[0]) == (p[31] >> 7):
		Z(r[0], gf(), r[0])
	M(r[3], r[0], r[1])
	return true


## Verify a detached Ed25519 signature. sig: 64 bytes, msg: any, pk: 32 bytes raw.
static func verify(sig: PackedByteArray, msg: PackedByteArray, pk: PackedByteArray) -> bool:
	if sig.size() != 64 or pk.size() != 32:
		return false
	if not s_is_canonical(sig):
		return false
	if not y_is_canonical(pk):
		return false
	var q := [gf(), gf(), gf(), gf()]
	if not unpackneg(q, pk):
		return false
	var hin := sig.slice(0, 32)
	hin.append_array(pk)
	hin.append_array(msg)
	var h := reduce(PKeySha512.hash(hin))
	var p := [gf(), gf(), gf(), gf()]
	scalarmult(p, q, h)
	scalarbase(q, sig.slice(32, 64))
	add(p, q)
	var t := PackedByteArray()
	t.resize(32)
	pack(t, p)
	return verify32(sig, 0, t)
