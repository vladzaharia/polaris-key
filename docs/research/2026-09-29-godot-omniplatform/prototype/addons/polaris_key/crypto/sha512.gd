# Pure-GDScript SHA-512 (FIPS 180-4). Godot 4's HashingContext only exposes MD5/SHA-1/SHA-256,
# and Ed25519 (RFC 8032) is defined over SHA-512, so a GDScript verifier must carry its own.
#
# GDScript `int` is a signed 64-bit two's-complement value whose + and * wrap on overflow
# (verified empirically on 4.7.2), so mod-2^64 arithmetic is free. `>>` is ARITHMETIC, so a
# logical shift right is `(x >> n) & ((1 << (64 - n)) - 1)`.
#
# Big-endian word loading uses a trick that keeps the per-byte work in native code: pad the
# message, reverse the whole buffer, reinterpret as little-endian int64s (to_int64_array());
# word i of the original big-endian stream is then element (n - 1 - i).
class_name PKSha512
extends RefCounted

const K := [
	4794697086780616226, 8158064640168781261, -5349999486874862801, -1606136188198331460,
	4131703408338449720, 6480981068601479193, -7908458776815382629, -6116909921290321640,
	-2880145864133508542, 1334009975649890238, 2608012711638119052, 6128411473006802146,
	8268148722764581231, -9160688886553864527, -7215885187991268811, -4495734319001033068,
	-1973867731355612462, -1171420211273849373, 1135362057144423861, 2597628984639134821,
	3308224258029322869, 5365058923640841347, 6679025012923562964, 8573033837759648693,
	-7476448914759557205, -6327057829258317296, -5763719355590565569, -4658551843659510044,
	-4116276920077217854, -3051310485924567259, 489312712824947311, 1452737877330783856,
	2861767655752347644, 3322285676063803686, 5560940570517711597, 5996557281743188959,
	7280758554555802590, 8532644243296465576, -9096487096722542874, -7894198246740708037,
	-6719396339535248540, -6333637450476146687, -4446306890439682159, -4076793802049405392,
	-3345356375505022440, -2983346525034927856, -860691631967231958, 1182934255886127544,
	1847814050463011016, 2177327727835720531, 2830643537854262169, 3796741975233480872,
	4115178125766777443, 5681478168544905931, 6601373596472566643, 7507060721942968483,
	8399075790359081724, 8693463985226723168, -8878714635349349518, -8302665154208450068,
	-8016688836872298968, -6606660893046293015, -4685533653050689259, -4147400797238176981,
	-3880063495543823972, -3348786107499101689, -1523767162380948706, -757361751448694408,
	500013540394364858, 748580250866718886, 1242879168328830382, 1977374033974150939,
	2944078676154940804, 3659926193048069267, 4368137639120453308, 4836135668995329356,
	5532061633213252278, 6448918945643986474, 6902733635092675308, 7801388544844847127
]

const IV := [7640891576956012808, -4942790177534073029, 4354685564936845355, -6534734903238641935, 5840696475078001361, -7276294671716946913, 2270897969802886507, 6620516959819538809]


static func hash(msg: PackedByteArray) -> PackedByteArray:
	var ml: int = msg.size()
	var total: int = ((ml + 16 + 1 + 127) >> 7) << 7
	var buf: PackedByteArray = msg.duplicate()
	buf.resize(total)  # zero-fills
	buf[ml] = 0x80
	var bits: int = ml * 8
	# 128-bit big-endian length; messages < 2^61 bytes so the high 64 bits stay zero.
	for i in 8:
		buf[total - 1 - i] = (bits >> (8 * i)) & 0xff
	buf.reverse()
	var words: PackedInt64Array = buf.to_int64_array()
	var nw: int = words.size()
	var kk: PackedInt64Array = PackedInt64Array(K)
	var w: PackedInt64Array = PackedInt64Array()
	w.resize(80)
	var h0: int = IV[0]
	var h1: int = IV[1]
	var h2: int = IV[2]
	var h3: int = IV[3]
	var h4: int = IV[4]
	var h5: int = IV[5]
	var h6: int = IV[6]
	var h7: int = IV[7]
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
	var out: PackedByteArray = PackedInt64Array([h7, h6, h5, h4, h3, h2, h1, h0]).to_byte_array()
	out.reverse()
	return out
