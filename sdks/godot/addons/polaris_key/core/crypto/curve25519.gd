class_name PKeyCurve25519
extends RefCounted
## X25519 (RFC 7748) and Ed25519 signing (RFC 8032) on the field and point code of PKeyEd25519
## (ref10, 10 limbs of radix 2^25.5), for the device key store (CC-26.6). The engine has neither.
##
## Shape, from the CC-13 spike: every secret-dependent choice is a mask, never a branch or an
## index. The X25519 ladder is the ref10 Montgomery ladder (255 steps, mask-based conditional
## swap); signing's fixed-base multiplication is double-and-always-add with a mask select, so the
## sequence of field operations does not depend on the scalar. The only branches are on public
## loop counters. This is "constant time by construction" for the operations written here. It is
## NOT a guarantee about the GDScript VM, the allocator or the CPU: the engine does not promise
## that an integer operation takes the same time for every value, and nothing here was measured on
## hardware other than the CC-13 spike's (research-CC-13-godot-crypto.md). Treat the keys as
## protected from casual observation, not from a local timing attacker.
##
## Cost (CC-13, release template, desktop): X25519 about 5.3 ms, Ed25519 sign about 9.5 ms.
## Debug builds are about 1.6 times slower. Run it off the main thread for bulk work.
##
## Secrets: the byte arrays passed in belong to the caller, who clears them. Working copies made
## here are overwritten before returning.

## The five low-order u-coordinates of Curve25519 (0, 1, the two of order 8, p - 1) and the two
## non-canonical spellings below 2^255 that reduce to 0 and 1 (p and p + 1), little-endian hex.
const _LOW_ORDER_U := [
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
	"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]

static var _base: Array = []


## True when the 32-byte X25519 public key is a low-order point (RFC 7748 section 5: bit 255 is
## masked and the value reduced mod p, so every spelling of the five points is caught).
static func is_low_order(u: PackedByteArray) -> bool:
	if u.size() != 32:
		return false
	var m := u.duplicate()
	m[31] = m[31] & 0x7f
	return _LOW_ORDER_U.has(m.hex_encode())


static func _cswap(a: PackedInt64Array, b: PackedInt64Array, bit: int) -> void:
	var m: int = -bit
	for i in 10:
		var t: int = m & (a[i] ^ b[i])
		a[i] ^= t
		b[i] ^= t


## X25519(k, u): the 32-byte scalar `k` (clamped here) times the point with u-coordinate `u`.
## Returns 32 bytes. The caller refuses a low-order `u` and an all-zero result.
static func x25519(k: PackedByteArray, u: PackedByteArray) -> PackedByteArray:
	var e := k.duplicate()
	e[0] &= 248
	e[31] &= 127
	e[31] |= 64
	var x1 := PKeyEd25519.fe_new()
	var x2 := PKeyEd25519.fe_new()
	var z2 := PKeyEd25519.fe_new()
	var x3 := PKeyEd25519.fe_new()
	var z3 := PKeyEd25519.fe_new()
	var t0 := PKeyEd25519.fe_new()
	var t1 := PKeyEd25519.fe_new()
	var c121666 := PKeyEd25519.fe_new()
	c121666[0] = 121666
	PKeyEd25519.fe_frombytes(x1, u)
	PKeyEd25519.fe_1(x2)
	PKeyEd25519.fe_0(z2)
	PKeyEd25519.fe_copy(x3, x1)
	PKeyEd25519.fe_1(z3)
	var swap: int = 0
	var pos: int = 254
	while pos >= 0:
		var b: int = (e[pos >> 3] >> (pos & 7)) & 1
		swap ^= b
		_cswap(x2, x3, swap)
		_cswap(z2, z3, swap)
		swap = b
		PKeyEd25519.fe_sub(t0, x3, z3)
		PKeyEd25519.fe_sub(t1, x2, z2)
		PKeyEd25519.fe_add(x2, x2, z2)
		PKeyEd25519.fe_add(z2, x3, z3)
		PKeyEd25519.fe_mul(z3, t0, x2)
		PKeyEd25519.fe_mul(z2, z2, t1)
		PKeyEd25519.fe_sq(t0, t1)
		PKeyEd25519.fe_sq(t1, x2)
		PKeyEd25519.fe_add(x3, z3, z2)
		PKeyEd25519.fe_sub(z2, z3, z2)
		PKeyEd25519.fe_mul(x2, t1, t0)
		PKeyEd25519.fe_sub(t1, t1, t0)
		PKeyEd25519.fe_sq(z2, z2)
		PKeyEd25519.fe_mul(z3, t1, c121666)
		PKeyEd25519.fe_sq(x3, x3)
		PKeyEd25519.fe_add(t0, t0, z3)
		PKeyEd25519.fe_mul(z3, x1, z2)
		PKeyEd25519.fe_mul(z2, t1, t0)
		pos -= 1
	_cswap(x2, x3, swap)
	_cswap(z2, z3, swap)
	PKeyEd25519.fe_invert(z2, z2)
	PKeyEd25519.fe_mul(x2, x2, z2)
	var out := PackedByteArray()
	out.resize(32)
	PKeyEd25519.fe_tobytes(out, x2)
	e.fill(0)
	# `fill` must run on a typed variable: on a cast copy (`(f as Packed…).fill`) it is a no-op.
	x2.fill(0)
	z2.fill(0)
	x3.fill(0)
	z3.fill(0)
	t0.fill(0)
	t1.fill(0)
	return out


## The X25519 public key for a private key: X25519(k, 9).
static func x25519_public(k: PackedByteArray) -> PackedByteArray:
	var nine := PackedByteArray()
	nine.resize(32)
	nine[0] = 9
	return x25519(k, nine)


static func _pt(n: int) -> Array:
	var a := []
	for i in n:
		a.append(PKeyEd25519.fe_new())
	return a


static func _base_point() -> Array:
	if _base.is_empty():
		var bb := PackedByteArray()
		bb.resize(32)
		bb.fill(0x66)
		bb[0] = 0x58
		var p := _pt(4)
		PKeyEd25519.ge_frombytes_negate_vartime(p, bb)
		PKeyEd25519.fe_neg(p[0], p[0])
		PKeyEd25519.fe_neg(p[3], p[3])
		_base = p
	return _base


static func _select(r: Array, a: Array, b: Array, bit: int) -> void:
	var m: int = -bit
	for j in 4:
		var rj: PackedInt64Array = r[j]
		var aj: PackedInt64Array = a[j]
		var bj: PackedInt64Array = b[j]
		for i in 10:
			rj[i] = aj[i] ^ (m & (aj[i] ^ bj[i]))


## s * B for a 32-byte little-endian scalar (already clamped or reduced); the encoded point.
static func _scalarmult_base(s: PackedByteArray) -> PackedByteArray:
	PKeyEd25519.warmup()
	var bc := _pt(4)
	PKeyEd25519.ge_p3_to_cached(bc, _base_point())
	var t0 := PKeyEd25519.fe_new()
	var acc := _pt(4)
	var t := _pt(4)
	var d := _pt(4)
	var sum := _pt(4)
	PKeyEd25519.fe_0(acc[0])
	PKeyEd25519.fe_1(acc[1])
	PKeyEd25519.fe_1(acc[2])
	PKeyEd25519.fe_0(acc[3])
	var i: int = 255
	while i >= 0:
		PKeyEd25519.ge_p2_dbl(t, acc, t0)
		PKeyEd25519.ge_p1p1_to_p3(d, t)
		PKeyEd25519.ge_add(t, d, bc, t0)
		PKeyEd25519.ge_p1p1_to_p3(sum, t)
		_select(acc, d, sum, (s[i >> 3] >> (i & 7)) & 1)
		i -= 1
	var out := PackedByteArray()
	out.resize(32)
	PKeyEd25519.ge_tobytes(out, acc)
	for group: Array in [acc, t, d, sum]:
		for f: PackedInt64Array in group:
			f.fill(0)
	return out


## The expanded secret scalar `a` (clamped) and the 32-byte prefix of SHA-512(seed).
static func _expand(seed: PackedByteArray) -> Array:
	var h := PKeySha512.hash(seed)
	var a := h.slice(0, 32)
	a[0] &= 248
	a[31] &= 127
	a[31] |= 64
	var prefix := h.slice(32, 64)
	h.fill(0)
	return [a, prefix]


## The Ed25519 public key for a 32-byte seed.
static func ed25519_public(seed: PackedByteArray) -> PackedByteArray:
	var ex := _expand(seed)
	var a: PackedByteArray = ex[0]
	var pub := _scalarmult_base(a)
	a.fill(0)
	var prefix: PackedByteArray = ex[1]
	prefix.fill(0)
	return pub


## The 64-byte Ed25519 signature over `msg` by the 32-byte `seed`, whose public key is `pub`
## (pass the stored one: it is hashed into the challenge, so a wrong `pub` gives a signature
## that does not verify, which the proof signer catches by re-verifying).
static func ed25519_sign(seed: PackedByteArray, pub: PackedByteArray, msg: PackedByteArray) -> PackedByteArray:
	var ex := _expand(seed)
	var a: PackedByteArray = ex[0]
	var pre: PackedByteArray = ex[1]
	pre.append_array(msg)
	var h := PKeySha512.hash(pre)
	var r := PKeyEd25519.sc_reduce(h)
	pre.fill(0)
	h.fill(0)
	var rb := _scalarmult_base(r)
	var kin := rb.duplicate()
	kin.append_array(pub)
	kin.append_array(msg)
	var k := PKeyEd25519.sc_reduce(PKeySha512.hash(kin))
	var x := PackedInt64Array()
	x.resize(64)
	for i in 32:
		x[i] = r[i]
	for i in 32:
		for j in 32:
			x[i + j] += k[i] * a[j]
	var s := PackedByteArray()
	s.resize(32)
	PKeyEd25519Ref.modL(s, x)
	var sig := rb.duplicate()
	sig.append_array(s)
	a.fill(0)
	r.fill(0)
	x.fill(0)
	return sig
