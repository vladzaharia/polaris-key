extends RefCounted
## Pure-GDScript Ed25519 signature VERIFICATION (RFC 8032, cofactorless check [S]B == R + [k]A,
## rejecting S >= L, as OpenSSL / libsodium / CryptoKit do). Verify-only: every input is public,
## so nothing here needs to be constant-time. Also carries a pure-GDScript SHA-512, because
## Godot 4.7's HashingContext only offers MD5 / SHA-1 / SHA-256.
##
##   const Ed25519 := preload("res://addons/polaris_key/crypto/ed25519.gd")
##   Ed25519.verify(pub32: PackedByteArray, msg: PackedByteArray, sig64: PackedByteArray) -> bool
##
## Field: GF(2^255-19) in ref10's 10-limb radix-2^25.5 layout on 64-bit GDScript ints
## (runtime int arithmetic wraps and >> is arithmetic, both checked on 4.7.2).
## Curve: twisted Edwards a=-1, extended coordinates, RFC 8032 §5.1.4 formulas.
## Scalar mult: Straus/Shamir joint double-and-add over (S, k) with B, -A, B-A precomputed.

const _K: Array[int] = [4794697086780616226, 8158064640168781261, -5349999486874862801, -1606136188198331460, 4131703408338449720, 6480981068601479193, -7908458776815382629, -6116909921290321640, -2880145864133508542, 1334009975649890238, 2608012711638119052, 6128411473006802146, 8268148722764581231, -9160688886553864527, -7215885187991268811, -4495734319001033068, -1973867731355612462, -1171420211273849373, 1135362057144423861, 2597628984639134821, 3308224258029322869, 5365058923640841347, 6679025012923562964, 8573033837759648693, -7476448914759557205, -6327057829258317296, -5763719355590565569, -4658551843659510044, -4116276920077217854, -3051310485924567259, 489312712824947311, 1452737877330783856, 2861767655752347644, 3322285676063803686, 5560940570517711597, 5996557281743188959, 7280758554555802590, 8532644243296465576, -9096487096722542874, -7894198246740708037, -6719396339535248540, -6333637450476146687, -4446306890439682159, -4076793802049405392, -3345356375505022440, -2983346525034927856, -860691631967231958, 1182934255886127544, 1847814050463011016, 2177327727835720531, 2830643537854262169, 3796741975233480872, 4115178125766777443, 5681478168544905931, 6601373596472566643, 7507060721942968483, 8399075790359081724, 8693463985226723168, -8878714635349349518, -8302665154208450068, -8016688836872298968, -6606660893046293015, -4685533653050689259, -4147400797238176981, -3880063495543823972, -3348786107499101689, -1523767162380948706, -757361751448694408, 500013540394364858, 748580250866718886, 1242879168328830382, 1977374033974150939, 2944078676154940804, 3659926193048069267, 4368137639120453308, 4836135668995329356, 5532061633213252278, 6448918945643986474, 6902733635092675308, 7801388544844847127]
const _H0: Array[int] = [7640891576956012808, -4942790177534073029, 4354685564936845355, -6534734903238641935, 5840696475078001361, -7276294671716946913, 2270897969802886507, 6620516959819538809]
const _D_HEX := "a3785913ca4deb75abd841414d0a700098e879777940c78c73fe6f2bee6c0352"
const _SQRTM1_HEX := "b0a00e4a271beec478e42fad0618432fa7d7fb3d99004d2b0bdfc14f8024832b"
const _B_HEX := "5866666666666666666666666666666666666666666666666666666666666666"
const _L_BYTES: Array[int] = [237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]


static func fe_mul(f: PackedInt64Array, g: PackedInt64Array) -> PackedInt64Array:
	var f0: int = f[0]
	var f1: int = f[1]
	var f2: int = f[2]
	var f3: int = f[3]
	var f4: int = f[4]
	var f5: int = f[5]
	var f6: int = f[6]
	var f7: int = f[7]
	var f8: int = f[8]
	var f9: int = f[9]
	var g0: int = g[0]
	var g1: int = g[1]
	var g2: int = g[2]
	var g3: int = g[3]
	var g4: int = g[4]
	var g5: int = g[5]
	var g6: int = g[6]
	var g7: int = g[7]
	var g8: int = g[8]
	var g9: int = g[9]
	var f1_2: int = f1 * 2
	var f3_2: int = f3 * 2
	var f5_2: int = f5 * 2
	var f7_2: int = f7 * 2
	var f9_2: int = f9 * 2
	var g1_19: int = g1 * 19
	var g2_19: int = g2 * 19
	var g3_19: int = g3 * 19
	var g4_19: int = g4 * 19
	var g5_19: int = g5 * 19
	var g6_19: int = g6 * 19
	var g7_19: int = g7 * 19
	var g8_19: int = g8 * 19
	var g9_19: int = g9 * 19
	var h0: int = f0*g0 + f1_2*g9_19 + f2*g8_19 + f3_2*g7_19 + f4*g6_19 + f5_2*g5_19 + f6*g4_19 + f7_2*g3_19 + f8*g2_19 + f9_2*g1_19
	var h1: int = f0*g1 + f1*g0 + f2*g9_19 + f3*g8_19 + f4*g7_19 + f5*g6_19 + f6*g5_19 + f7*g4_19 + f8*g3_19 + f9*g2_19
	var h2: int = f0*g2 + f1_2*g1 + f2*g0 + f3_2*g9_19 + f4*g8_19 + f5_2*g7_19 + f6*g6_19 + f7_2*g5_19 + f8*g4_19 + f9_2*g3_19
	var h3: int = f0*g3 + f1*g2 + f2*g1 + f3*g0 + f4*g9_19 + f5*g8_19 + f6*g7_19 + f7*g6_19 + f8*g5_19 + f9*g4_19
	var h4: int = f0*g4 + f1_2*g3 + f2*g2 + f3_2*g1 + f4*g0 + f5_2*g9_19 + f6*g8_19 + f7_2*g7_19 + f8*g6_19 + f9_2*g5_19
	var h5: int = f0*g5 + f1*g4 + f2*g3 + f3*g2 + f4*g1 + f5*g0 + f6*g9_19 + f7*g8_19 + f8*g7_19 + f9*g6_19
	var h6: int = f0*g6 + f1_2*g5 + f2*g4 + f3_2*g3 + f4*g2 + f5_2*g1 + f6*g0 + f7_2*g9_19 + f8*g8_19 + f9_2*g7_19
	var h7: int = f0*g7 + f1*g6 + f2*g5 + f3*g4 + f4*g3 + f5*g2 + f6*g1 + f7*g0 + f8*g9_19 + f9*g8_19
	var h8: int = f0*g8 + f1_2*g7 + f2*g6 + f3_2*g5 + f4*g4 + f5_2*g3 + f6*g2 + f7_2*g1 + f8*g0 + f9_2*g9_19
	var h9: int = f0*g9 + f1*g8 + f2*g7 + f3*g6 + f4*g5 + f5*g4 + f6*g3 + f7*g2 + f8*g1 + f9*g0
	return _carry(h0, h1, h2, h3, h4, h5, h6, h7, h8, h9)


static func fe_sq(f: PackedInt64Array) -> PackedInt64Array:
	var f0: int = f[0]
	var f1: int = f[1]
	var f2: int = f[2]
	var f3: int = f[3]
	var f4: int = f[4]
	var f5: int = f[5]
	var f6: int = f[6]
	var f7: int = f[7]
	var f8: int = f[8]
	var f9: int = f[9]
	var f0_2: int = f0 * 2
	var f1_2: int = f1 * 2
	var f1_4: int = f1 * 4
	var f2_2: int = f2 * 2
	var f3_2: int = f3 * 2
	var f3_4: int = f3 * 4
	var f4_2: int = f4 * 2
	var f5_2: int = f5 * 2
	var f5_4: int = f5 * 4
	var f6_2: int = f6 * 2
	var f7_2: int = f7 * 2
	var f7_4: int = f7 * 4
	var f8_2: int = f8 * 2
	var f9_2: int = f9 * 2
	var f5_19: int = f5 * 19
	var f6_19: int = f6 * 19
	var f7_19: int = f7 * 19
	var f8_19: int = f8 * 19
	var f9_19: int = f9 * 19
	var h0: int = f0*f0 + f1_4*f9_19 + f2_2*f8_19 + f3_4*f7_19 + f4_2*f6_19 + f5_2*f5_19
	var h1: int = f0_2*f1 + f2_2*f9_19 + f3_2*f8_19 + f4_2*f7_19 + f5_2*f6_19
	var h2: int = f0_2*f2 + f1_2*f1 + f3_4*f9_19 + f4_2*f8_19 + f5_4*f7_19 + f6*f6_19
	var h3: int = f0_2*f3 + f1_2*f2 + f4_2*f9_19 + f5_2*f8_19 + f6_2*f7_19
	var h4: int = f0_2*f4 + f1_4*f3 + f2*f2 + f5_4*f9_19 + f6_2*f8_19 + f7_2*f7_19
	var h5: int = f0_2*f5 + f1_2*f4 + f2_2*f3 + f6_2*f9_19 + f7_2*f8_19
	var h6: int = f0_2*f6 + f1_4*f5 + f2_2*f4 + f3_2*f3 + f7_4*f9_19 + f8*f8_19
	var h7: int = f0_2*f7 + f1_2*f6 + f2_2*f5 + f3_2*f4 + f8_2*f9_19
	var h8: int = f0_2*f8 + f1_4*f7 + f2_2*f6 + f3_4*f5 + f4*f4 + f9_2*f9_19
	var h9: int = f0_2*f9 + f1_2*f8 + f2_2*f7 + f3_2*f6 + f4_2*f5
	return _carry(h0, h1, h2, h3, h4, h5, h6, h7, h8, h9)

const _TWO26 := 67108864
const _TWO25 := 33554432
const _TWO24 := 16777216

static var _ready := false
static var _D: PackedInt64Array
static var _D2: PackedInt64Array
static var _SQRTM1: PackedInt64Array
static var _B_CACHED: Array
static var _B_EXT: Array
static var _MASK: PackedInt64Array  # _MASK[n] = 2^(64-n) - 1, for logical right shifts


static func _setup() -> void:
	if _ready:
		return
	_MASK = PackedInt64Array()
	_MASK.resize(65)
	var one := 1
	for n in range(1, 64):
		_MASK[n] = (one << (64 - n)) - 1
	_D = fe_frombytes(_D_HEX.hex_decode())
	_D2 = fe_add(_D, _D)
	_SQRTM1 = fe_frombytes(_SQRTM1_HEX.hex_decode())
	_ready = true  # decode() below needs _D/_SQRTM1
	_B_EXT = decode_point(_B_HEX.hex_decode())
	_B_CACHED = _to_cached(_B_EXT)


# ---------------------------------------------------------------- SHA-512

static func sha512(msg: PackedByteArray) -> PackedByteArray:
	_setup()
	var m := msg.duplicate()
	var bitlen := msg.size() * 8
	m.append(0x80)
	while (m.size() % 128) != 112:
		m.append(0)
	for i in 8:
		m.append(0)  # high 64 bits of the 128-bit length
	for i in range(7, -1, -1):
		m.append((bitlen >> (i * 8)) & 0xff)
	var H := PackedInt64Array(_H0)
	var w := PackedInt64Array()
	w.resize(80)
	var mk := _MASK
	for off in range(0, m.size(), 128):
		for t in 16:
			var o := off + t * 8
			w[t] = (m[o] << 56) | (m[o + 1] << 48) | (m[o + 2] << 40) | (m[o + 3] << 32) \
				| (m[o + 4] << 24) | (m[o + 5] << 16) | (m[o + 6] << 8) | m[o + 7]
		for t in range(16, 80):
			var x: int = w[t - 15]
			var y: int = w[t - 2]
			var s0: int = (((x >> 1) & mk[1]) | (x << 63)) ^ (((x >> 8) & mk[8]) | (x << 56)) ^ ((x >> 7) & mk[7])
			var s1: int = (((y >> 19) & mk[19]) | (y << 45)) ^ (((y >> 61) & mk[61]) | (y << 3)) ^ ((y >> 6) & mk[6])
			w[t] = w[t - 16] + s0 + w[t - 7] + s1
		var a: int = H[0]
		var b: int = H[1]
		var c: int = H[2]
		var d: int = H[3]
		var e: int = H[4]
		var f: int = H[5]
		var g: int = H[6]
		var h: int = H[7]
		for t in 80:
			var S1: int = (((e >> 14) & mk[14]) | (e << 50)) ^ (((e >> 18) & mk[18]) | (e << 46)) ^ (((e >> 41) & mk[41]) | (e << 23))
			var ch: int = (e & f) ^ (~e & g)
			var t1: int = h + S1 + ch + _K[t] + w[t]
			var S0: int = (((a >> 28) & mk[28]) | (a << 36)) ^ (((a >> 34) & mk[34]) | (a << 30)) ^ (((a >> 39) & mk[39]) | (a << 25))
			var mj: int = (a & b) ^ (a & c) ^ (b & c)
			var t2: int = S0 + mj
			h = g
			g = f
			f = e
			e = d + t1
			d = c
			c = b
			b = a
			a = t1 + t2
		H[0] += a
		H[1] += b
		H[2] += c
		H[3] += d
		H[4] += e
		H[5] += f
		H[6] += g
		H[7] += h
	var out := PackedByteArray()
	for v in H:
		for i in range(7, -1, -1):
			out.append((v >> (i * 8)) & 0xff)
	return out


# ---------------------------------------------------------------- field GF(2^255-19)

static func _carry(h0: int, h1: int, h2: int, h3: int, h4: int, h5: int, h6: int, h7: int, h8: int, h9: int) -> PackedInt64Array:
	var c: int
	c = (h0 + _TWO25) >> 26; h1 += c; h0 -= c * _TWO26
	c = (h4 + _TWO25) >> 26; h5 += c; h4 -= c * _TWO26
	c = (h1 + _TWO24) >> 25; h2 += c; h1 -= c * _TWO25
	c = (h5 + _TWO24) >> 25; h6 += c; h5 -= c * _TWO25
	c = (h2 + _TWO25) >> 26; h3 += c; h2 -= c * _TWO26
	c = (h6 + _TWO25) >> 26; h7 += c; h6 -= c * _TWO26
	c = (h3 + _TWO24) >> 25; h4 += c; h3 -= c * _TWO25
	c = (h7 + _TWO24) >> 25; h8 += c; h7 -= c * _TWO25
	c = (h4 + _TWO25) >> 26; h5 += c; h4 -= c * _TWO26
	c = (h8 + _TWO25) >> 26; h9 += c; h8 -= c * _TWO26
	c = (h9 + _TWO24) >> 25; h0 += c * 19; h9 -= c * _TWO25
	c = (h0 + _TWO25) >> 26; h1 += c; h0 -= c * _TWO26
	return PackedInt64Array([h0, h1, h2, h3, h4, h5, h6, h7, h8, h9])


static func fe_carry(f: PackedInt64Array) -> PackedInt64Array:
	return _carry(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9])


static func fe_add(f: PackedInt64Array, g: PackedInt64Array) -> PackedInt64Array:
	return PackedInt64Array([f[0] + g[0], f[1] + g[1], f[2] + g[2], f[3] + g[3], f[4] + g[4],
		f[5] + g[5], f[6] + g[6], f[7] + g[7], f[8] + g[8], f[9] + g[9]])


static func fe_sub(f: PackedInt64Array, g: PackedInt64Array) -> PackedInt64Array:
	return PackedInt64Array([f[0] - g[0], f[1] - g[1], f[2] - g[2], f[3] - g[3], f[4] - g[4],
		f[5] - g[5], f[6] - g[6], f[7] - g[7], f[8] - g[8], f[9] - g[9]])


static func fe_neg(f: PackedInt64Array) -> PackedInt64Array:
	return PackedInt64Array([-f[0], -f[1], -f[2], -f[3], -f[4], -f[5], -f[6], -f[7], -f[8], -f[9]])


static func fe_one() -> PackedInt64Array:
	return PackedInt64Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])


static func fe_zero() -> PackedInt64Array:
	return PackedInt64Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])


## Little-endian 32 bytes -> field element (top bit ignored, as RFC 8032 decoding does after
## it has read the sign bit).
static func fe_frombytes(s: PackedByteArray) -> PackedInt64Array:
	var h := PackedInt64Array()
	h.resize(10)
	var pos := 0
	for i in 10:
		var width := 26 if i % 2 == 0 else 25
		var v := 0
		for b in width:
			var p := pos + b
			if p < 255:
				v |= ((s[p >> 3] >> (p & 7)) & 1) << b
		h[i] = v
		pos += width
	return h


## Canonical little-endian encoding (fully reduced mod p), ref10's fe_tobytes.
static func fe_tobytes(fin: PackedInt64Array) -> PackedByteArray:
	var f := fe_carry(fin)
	var h0: int = f[0]; var h1: int = f[1]; var h2: int = f[2]; var h3: int = f[3]; var h4: int = f[4]
	var h5: int = f[5]; var h6: int = f[6]; var h7: int = f[7]; var h8: int = f[8]; var h9: int = f[9]
	var q: int = (19 * h9 + _TWO24) >> 25
	q = (h0 + q) >> 26; q = (h1 + q) >> 25; q = (h2 + q) >> 26; q = (h3 + q) >> 25
	q = (h4 + q) >> 26; q = (h5 + q) >> 25; q = (h6 + q) >> 26; q = (h7 + q) >> 25
	q = (h8 + q) >> 26; q = (h9 + q) >> 25
	h0 += 19 * q
	var c: int
	c = h0 >> 26; h1 += c; h0 -= c * _TWO26
	c = h1 >> 25; h2 += c; h1 -= c * _TWO25
	c = h2 >> 26; h3 += c; h2 -= c * _TWO26
	c = h3 >> 25; h4 += c; h3 -= c * _TWO25
	c = h4 >> 26; h5 += c; h4 -= c * _TWO26
	c = h5 >> 25; h6 += c; h5 -= c * _TWO25
	c = h6 >> 26; h7 += c; h6 -= c * _TWO26
	c = h7 >> 25; h8 += c; h7 -= c * _TWO25
	c = h8 >> 26; h9 += c; h8 -= c * _TWO26
	c = h9 >> 25; h9 -= c * _TWO25
	var limbs := [h0, h1, h2, h3, h4, h5, h6, h7, h8, h9]
	var out := PackedByteArray()
	var acc := 0
	var bits := 0
	for i in 10:
		acc |= int(limbs[i]) << bits
		bits += 26 if i % 2 == 0 else 25
		while bits >= 8:
			out.append(acc & 0xff)
			acc >>= 8
			bits -= 8
	out.append(acc & 0xff)
	return out


static func fe_isnegative(f: PackedInt64Array) -> int:
	return fe_tobytes(f)[0] & 1


static func fe_iszero(f: PackedInt64Array) -> bool:
	for b in fe_tobytes(f):
		if b != 0:
			return false
	return true


static func fe_sqn(f: PackedInt64Array, n: int) -> PackedInt64Array:
	var r := f
	for i in n:
		r = fe_sq(r)
	return r


## z^(p-2)
static func fe_invert(z: PackedInt64Array) -> PackedInt64Array:
	var t0 := fe_sq(z)
	var t1 := fe_sqn(t0, 2)
	t1 = fe_mul(z, t1)
	t0 = fe_mul(t0, t1)
	var t2 := fe_sq(t0)
	t1 = fe_mul(t1, t2)
	t2 = fe_sqn(t1, 5)
	t1 = fe_mul(t2, t1)
	t2 = fe_sqn(t1, 10)
	t2 = fe_mul(t2, t1)
	var t3 := fe_sqn(t2, 20)
	t2 = fe_mul(t3, t2)
	t2 = fe_sqn(t2, 10)
	t1 = fe_mul(t2, t1)
	t2 = fe_sqn(t1, 50)
	t2 = fe_mul(t2, t1)
	t3 = fe_sqn(t2, 100)
	t2 = fe_mul(t3, t2)
	t2 = fe_sqn(t2, 50)
	t1 = fe_mul(t2, t1)
	t1 = fe_sqn(t1, 5)
	return fe_mul(t1, t0)


## z^((p-5)/8)
static func fe_pow22523(z: PackedInt64Array) -> PackedInt64Array:
	var t0 := fe_sq(z)
	var t1 := fe_sqn(t0, 2)
	t1 = fe_mul(z, t1)
	t0 = fe_mul(t0, t1)
	t0 = fe_sq(t0)
	t0 = fe_mul(t1, t0)
	t1 = fe_sqn(t0, 5)
	t0 = fe_mul(t1, t0)
	t1 = fe_sqn(t0, 10)
	t1 = fe_mul(t1, t0)
	var t2 := fe_sqn(t1, 20)
	t1 = fe_mul(t2, t1)
	t1 = fe_sqn(t1, 10)
	t0 = fe_mul(t1, t0)
	t1 = fe_sqn(t0, 50)
	t1 = fe_mul(t1, t0)
	t2 = fe_sqn(t1, 100)
	t1 = fe_mul(t2, t1)
	t1 = fe_sqn(t1, 50)
	t0 = fe_mul(t1, t0)
	t0 = fe_sqn(t0, 2)
	return fe_mul(t0, z)


# ---------------------------------------------------------------- points

## RFC 8032 §5.1.3 decoding -> extended [X, Y, Z, T], or [] when invalid.
static func decode_point(s: PackedByteArray) -> Array:
	_setup()
	if s.size() != 32:
		return []
	# Reject a non-canonical y (y >= p): p = 2^255-19, so y >= p iff all of bytes 1..30 are 0xff,
	# byte 31 (sans sign bit) is 0x7f and byte 0 >= 0xed.
	var noncanon := (s[31] & 0x7f) == 0x7f and s[0] >= 0xed
	if noncanon:
		for i in range(1, 31):
			if s[i] != 0xff:
				noncanon = false
				break
	if noncanon:
		return []
	var sign := (s[31] >> 7) & 1
	var y := fe_frombytes(s)
	var one := fe_one()
	var u := fe_sq(y)
	var v := fe_mul(u, _D)
	u = fe_sub(u, one)              # y^2 - 1
	v = fe_carry(fe_add(v, one))    # d y^2 + 1
	var v3 := fe_mul(fe_sq(v), v)
	var x := fe_mul(fe_mul(fe_sq(v3), v), u)   # u v^7
	x = fe_pow22523(x)
	x = fe_mul(fe_mul(x, v3), u)               # u v^3 (u v^7)^((p-5)/8)
	var vxx := fe_mul(fe_sq(x), v)
	if not fe_iszero(fe_sub(vxx, u)):
		if not fe_iszero(fe_add(vxx, u)):
			return []
		x = fe_mul(x, _SQRTM1)
	if fe_iszero(x) and sign == 1:
		return []
	if fe_isnegative(x) != sign:
		x = fe_neg(x)
	return [x, y, one, fe_mul(x, y)]


static func encode_point(p: Array) -> PackedByteArray:
	var zi := fe_invert(p[2])
	var x := fe_mul(p[0], zi)
	var y := fe_mul(p[1], zi)
	var s := fe_tobytes(y)
	s[31] ^= fe_isnegative(x) << 7
	return s


static func _neg_point(p: Array) -> Array:
	return [fe_neg(p[0]), p[1], p[2], fe_neg(p[3])]


## Cached form for repeated additions: [Y+X, Y-X, 2dT, 2Z].
static func _to_cached(p: Array) -> Array:
	return [fe_carry(fe_add(p[1], p[0])), fe_carry(fe_sub(p[1], p[0])), fe_mul(p[3], _D2), fe_carry(fe_add(p[2], p[2]))]


## RFC 8032 §5.1.4 addition (a = -1) with q in cached form: 8M.
static func _add_cached(p: Array, q: Array) -> Array:
	var a := fe_mul(fe_sub(p[1], p[0]), q[1])
	var b := fe_mul(fe_add(p[1], p[0]), q[0])
	var c := fe_mul(p[3], q[2])
	var d := fe_mul(p[2], q[3])
	var e := fe_sub(b, a)
	var f := fe_sub(d, c)
	var g := fe_add(d, c)
	var h := fe_add(b, a)
	return [fe_mul(e, f), fe_mul(g, h), fe_mul(f, g), fe_mul(e, h)]


## RFC 8032 §5.1.4 doubling (a = -1): 4M + 4S. T is not an input.
static func _dbl(p: Array) -> Array:
	var a := fe_sq(p[0])
	var b := fe_sq(p[1])
	var c2 := fe_sq(p[2])
	var c := fe_add(c2, c2)
	var h := fe_add(a, b)
	var e := fe_carry(fe_sub(h, fe_sq(fe_add(p[0], p[1]))))
	var g := fe_sub(a, b)
	var f := fe_carry(fe_add(c, g))
	return [fe_mul(e, f), fe_mul(g, h), fe_mul(f, g), fe_mul(e, h)]


static func _add_ext(p: Array, q: Array) -> Array:
	return _add_cached(p, _to_cached(q))


# ---------------------------------------------------------------- scalars

## 64-byte little-endian -> 32-byte little-endian mod L (TweetNaCl modL).
static func _reduce64(r: PackedByteArray) -> PackedByteArray:
	var x := PackedInt64Array()
	x.resize(64)
	for i in 64:
		x[i] = r[i]
	var carry := 0
	var i := 63
	while i >= 32:
		carry = 0
		var j := i - 32
		var xi: int = x[i]
		while j < i - 12:
			x[j] += carry - 16 * xi * int(_L_BYTES[j - (i - 32)])
			carry = (x[j] + 128) >> 8
			x[j] -= carry * 256
			j += 1
		x[j] += carry
		x[i] = 0
		i -= 1
	carry = 0
	var top: int = x[31] >> 4
	for j in 32:
		x[j] += carry - top * int(_L_BYTES[j])
		carry = x[j] >> 8
		x[j] &= 255
	for j in 32:
		x[j] -= carry * int(_L_BYTES[j])
	var out := PackedByteArray()
	out.resize(32)
	for k in 32:
		if k < 31:
			x[k + 1] += x[k] >> 8
		out[k] = x[k] & 255
	return out


## True iff the 32-byte little-endian scalar is < L.
static func _scalar_lt_l(s: PackedByteArray) -> bool:
	for i in range(31, -1, -1):
		if s[i] < int(_L_BYTES[i]):
			return true
		if s[i] > int(_L_BYTES[i]):
			return false
	return false


# ---------------------------------------------------------------- verify

static func verify(pub: PackedByteArray, msg: PackedByteArray, sig: PackedByteArray) -> bool:
	_setup()
	if pub.size() != 32 or sig.size() != 64:
		return false
	var r_bytes := sig.slice(0, 32)
	var s_bytes := sig.slice(32, 64)
	if not _scalar_lt_l(s_bytes):
		return false
	var A := decode_point(pub)
	if A.is_empty():
		return false
	var buf := PackedByteArray()
	buf.append_array(r_bytes)
	buf.append_array(pub)
	buf.append_array(msg)
	var k := _reduce64(sha512(buf))
	# R' = [S]B + [k](-A), joint double-and-add (Straus/Shamir).
	var negA := _neg_point(A)
	var negA_c := _to_cached(negA)
	var both_c := _to_cached(_add_cached(_B_EXT, negA_c))
	var Q: Array = [fe_zero(), fe_one(), fe_one(), fe_zero()]
	var started := false
	for bit in range(255, -1, -1):
		if started:
			Q = _dbl(Q)
		var bs := (s_bytes[bit >> 3] >> (bit & 7)) & 1
		var bk := (k[bit >> 3] >> (bit & 7)) & 1
		if bs == 1 and bk == 1:
			Q = _add_cached(Q, both_c)
			started = true
		elif bs == 1:
			Q = _add_cached(Q, _B_CACHED)
			started = true
		elif bk == 1:
			Q = _add_cached(Q, negA_c)
			started = true
	return encode_point(Q) == r_bytes

