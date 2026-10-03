@tool
# Ed25519 signature VERIFY in pure GDScript — optimized variant.
#
# ALTERED SOURCE: a GDScript port of orlp/ed25519 (zlib licence, Copyright (c) 2015 Orson
# Peters), itself carrying SUPERCOP "ref10" (public domain). Not the original software; the
# zlib notice and a description of the changes are in THIRD_PARTY_NOTICES beside this file.
#
# Port of the SUPERCOP "ref10" structure (via orlp/ed25519, public domain / zlib):
#   * field elements: 10 limbs in radix 2^25.5 (PackedInt64Array(10)); fe_mul / fe_sq are the
#     fully-unrolled ref10 schoolbook routines translated mechanically (ref/translate_fe.py),
#     so each multiply is ~100 int64 products on GDScript LOCALS instead of 256 on array slots;
#   * points in extended twisted-Edwards coordinates (p2 / p3 / p1p1 / cached / precomp);
#   * R' = h*(-A) + S*B computed with ONE interleaved double-scalar multiplication using
#     width-5 signed sliding windows (ref10 ge_double_scalarmult_vartime): ~253 doublings +
#     ~85 additions, instead of TweetNaCl's two separate 256-step ladders (1024 additions);
#   * the 8 odd multiples of B are the constant ref10 `Bi` table (precomp_data.h); the 8 odd
#     multiples of -A are built per call;
#   * temporaries are preallocated once per verify and reused (no per-op allocation).
#
# Variable-time is fine: verification handles only public data.
#
# Checks added beyond ref10 (to match WebCrypto/OpenSSL, CryptoKit, pyca/cryptography):
#   S < L (canonical scalar), public key y < p (canonical encoding).
class_name PKeyEd25519
extends RefCounted

const FE_D := [-10913610, 13857413, -15372611, 6949391, 114729, -8787816, -6275908, -3247719, -18696448, -12055116]
const FE_D2 := [-21827239, -5839606, -30745221, 13898782, 229458, 15978800, -12551817, -6495438, 29715968, 9444199]
const FE_SQRTM1 := [-32595792, -7943725, 9377950, 3500415, 12389472, -272473, -25146209, -2005654, 326686, 11406482]
const L := [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]

# ref10 precomp_data.h Bi[8]: odd multiples B, 3B, ..., 15B as (y+x, y-x, 2dxy).
const BI := [
	[[25967493, -14356035, 29566456, 3660896, -12694345, 4014787, 27544626, -11754271, -6079156, 2047605], [-12545711, 934262, -2722910, 3049990, -727428, 9406986, 12720692, 5043384, 19500929, -15469378], [-8738181, 4489570, 9688441, -14785194, 10184609, -12363380, 29287919, 11864899, -24514362, -4438546]],
	[[15636291, -9688557, 24204773, -7912398, 616977, -16685262, 27787600, -14772189, 28944400, -1550024], [16568933, 4717097, -11556148, -1102322, 15682896, -11807043, 16354577, -11775962, 7689662, 11199574], [30464156, -5976125, -11779434, -15670865, 23220365, 15915852, 7512774, 10017326, -17749093, -9920357]],
	[[10861363, 11473154, 27284546, 1981175, -30064349, 12577861, 32867885, 14515107, -15438304, 10819380], [4708026, 6336745, 20377586, 9066809, -11272109, 6594696, -25653668, 12483688, -12668491, 5581306], [19563160, 16186464, -29386857, 4097519, 10237984, -4348115, 28542350, 13850243, -23678021, -15815942]],
	[[5153746, 9909285, 1723747, -2777874, 30523605, 5516873, 19480852, 5230134, -23952439, -15175766], [-30269007, -3463509, 7665486, 10083793, 28475525, 1649722, 20654025, 16520125, 30598449, 7715701], [28881845, 14381568, 9657904, 3680757, -20181635, 7843316, -31400660, 1370708, 29794553, -1409300]],
	[[-22518993, -6692182, 14201702, -8745502, -23510406, 8844726, 18474211, -1361450, -13062696, 13821877], [-6455177, -7839871, 3374702, -4740862, -27098617, -10571707, 31655028, -7212327, 18853322, -14220951], [4566830, -12963868, -28974889, -12240689, -7602672, -2830569, -8514358, -10431137, 2207753, -3209784]],
	[[-25154831, -4185821, 29681144, 7868801, -6854661, -9423865, -12437364, -663000, -31111463, -16132436], [25576264, -2703214, 7349804, -11814844, 16472782, 9300885, 3844789, 15725684, 171356, 6466918], [23103977, 13316479, 9739013, -16149481, 817875, -15038942, 8965339, -14088058, -30714912, 16193877]],
	[[-33521811, 3180713, -2394130, 14003687, -16903474, -16270840, 17238398, 4729455, -18074513, 9256800], [-25182317, -4174131, 32336398, 5036987, -21236817, 11360617, 22616405, 9761698, -19827198, 630305], [-13720693, 2639453, -24237460, -7406481, 9494427, -5774029, -6554551, -15960994, -2449256, -14291300]],
	[[-3151181, -5046075, 9282714, 6866145, -31907062, -863023, -18940575, 15033784, 25105118, -7894876], [-24326370, 15950226, -31801215, -14592823, -11662737, -5090925, 1573892, -2625887, 2198790, -15804619], [-3099351, 10324967, -2241613, 7453183, -5446979, -2735503, -13812022, -16236442, -32461234, -12290683]],
]

static var _bi: Array = []  # Array of [PackedInt64Array x3], built from BI once.


static func warmup() -> void:
	if _bi.is_empty():
		for e in BI:
			_bi.append([PackedInt64Array(e[0]), PackedInt64Array(e[1]), PackedInt64Array(e[2])])


static func fe_new() -> PackedInt64Array:
	var r := PackedInt64Array()
	r.resize(10)
	return r


static func fe_0(h: PackedInt64Array) -> void:
	h.fill(0)


static func fe_1(h: PackedInt64Array) -> void:
	h.fill(0)
	h[0] = 1


static func fe_copy(h: PackedInt64Array, f: PackedInt64Array) -> void:
	for i in 10:
		h[i] = f[i]


static func _load3(s: PackedByteArray, o: int) -> int:
	return s[o] | (s[o + 1] << 8) | (s[o + 2] << 16)


static func _load4(s: PackedByteArray, o: int) -> int:
	return s[o] | (s[o + 1] << 8) | (s[o + 2] << 16) | (s[o + 3] << 24)


static func fe_frombytes(h: PackedInt64Array, s: PackedByteArray) -> void:
	var h0: int = _load4(s, 0)
	var h1: int = _load3(s, 4) << 6
	var h2: int = _load3(s, 7) << 5
	var h3: int = _load3(s, 10) << 3
	var h4: int = _load3(s, 13) << 2
	var h5: int = _load4(s, 16)
	var h6: int = _load3(s, 20) << 7
	var h7: int = _load3(s, 23) << 5
	var h8: int = _load3(s, 26) << 4
	var h9: int = (_load3(s, 29) & 8388607) << 2
	var carry0: int
	var carry1: int
	var carry2: int
	var carry3: int
	var carry4: int
	var carry5: int
	var carry6: int
	var carry7: int
	var carry8: int
	var carry9: int
	carry9 = (h9 + 16777216) >> 25
	h0 += carry9 * 19
	h9 -= carry9 * 33554432
	carry1 = (h1 + 16777216) >> 25
	h2 += carry1
	h1 -= carry1 * 33554432
	carry3 = (h3 + 16777216) >> 25
	h4 += carry3
	h3 -= carry3 * 33554432
	carry5 = (h5 + 16777216) >> 25
	h6 += carry5
	h5 -= carry5 * 33554432
	carry7 = (h7 + 16777216) >> 25
	h8 += carry7
	h7 -= carry7 * 33554432
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	carry2 = (h2 + 33554432) >> 26
	h3 += carry2
	h2 -= carry2 * 67108864
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry6 = (h6 + 33554432) >> 26
	h7 += carry6
	h6 -= carry6 * 67108864
	carry8 = (h8 + 33554432) >> 26
	h9 += carry8
	h8 -= carry8 * 67108864
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_tobytes(s: PackedByteArray, h: PackedInt64Array) -> void:
	var h0: int = h[0]
	var h1: int = h[1]
	var h2: int = h[2]
	var h3: int = h[3]
	var h4: int = h[4]
	var h5: int = h[5]
	var h6: int = h[6]
	var h7: int = h[7]
	var h8: int = h[8]
	var h9: int = h[9]
	var q: int
	var carry0: int
	var carry1: int
	var carry2: int
	var carry3: int
	var carry4: int
	var carry5: int
	var carry6: int
	var carry7: int
	var carry8: int
	var carry9: int
	q = (19 * h9 + 16777216) >> 25
	q = (h0 + q) >> 26
	q = (h1 + q) >> 25
	q = (h2 + q) >> 26
	q = (h3 + q) >> 25
	q = (h4 + q) >> 26
	q = (h5 + q) >> 25
	q = (h6 + q) >> 26
	q = (h7 + q) >> 25
	q = (h8 + q) >> 26
	q = (h9 + q) >> 25
	h0 += 19 * q
	carry0 = h0 >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	carry1 = h1 >> 25
	h2 += carry1
	h1 -= carry1 * 33554432
	carry2 = h2 >> 26
	h3 += carry2
	h2 -= carry2 * 67108864
	carry3 = h3 >> 25
	h4 += carry3
	h3 -= carry3 * 33554432
	carry4 = h4 >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry5 = h5 >> 25
	h6 += carry5
	h5 -= carry5 * 33554432
	carry6 = h6 >> 26
	h7 += carry6
	h6 -= carry6 * 67108864
	carry7 = h7 >> 25
	h8 += carry7
	h7 -= carry7 * 33554432
	carry8 = h8 >> 26
	h9 += carry8
	h8 -= carry8 * 67108864
	carry9 = h9 >> 25
	h9 -= carry9 * 33554432
	s[0] = (h0 >> 0)
	s[1] = (h0 >> 8)
	s[2] = (h0 >> 16)
	s[3] = ((h0 >> 24) | (h1 << 2))
	s[4] = (h1 >> 6)
	s[5] = (h1 >> 14)
	s[6] = ((h1 >> 22) | (h2 << 3))
	s[7] = (h2 >> 5)
	s[8] = (h2 >> 13)
	s[9] = ((h2 >> 21) | (h3 << 5))
	s[10] = (h3 >> 3)
	s[11] = (h3 >> 11)
	s[12] = ((h3 >> 19) | (h4 << 6))
	s[13] = (h4 >> 2)
	s[14] = (h4 >> 10)
	s[15] = (h4 >> 18)
	s[16] = (h5 >> 0)
	s[17] = (h5 >> 8)
	s[18] = (h5 >> 16)
	s[19] = ((h5 >> 24) | (h6 << 1))
	s[20] = (h6 >> 7)
	s[21] = (h6 >> 15)
	s[22] = ((h6 >> 23) | (h7 << 3))
	s[23] = (h7 >> 5)
	s[24] = (h7 >> 13)
	s[25] = ((h7 >> 21) | (h8 << 4))
	s[26] = (h8 >> 4)
	s[27] = (h8 >> 12)
	s[28] = ((h8 >> 20) | (h9 << 6))
	s[29] = (h9 >> 2)
	s[30] = (h9 >> 10)
	s[31] = (h9 >> 18)


static func fe_add(h: PackedInt64Array, f: PackedInt64Array, g: PackedInt64Array) -> void:
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
	var h0: int = f0 + g0
	var h1: int = f1 + g1
	var h2: int = f2 + g2
	var h3: int = f3 + g3
	var h4: int = f4 + g4
	var h5: int = f5 + g5
	var h6: int = f6 + g6
	var h7: int = f7 + g7
	var h8: int = f8 + g8
	var h9: int = f9 + g9
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_sub(h: PackedInt64Array, f: PackedInt64Array, g: PackedInt64Array) -> void:
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
	var h0: int = f0 - g0
	var h1: int = f1 - g1
	var h2: int = f2 - g2
	var h3: int = f3 - g3
	var h4: int = f4 - g4
	var h5: int = f5 - g5
	var h6: int = f6 - g6
	var h7: int = f7 - g7
	var h8: int = f8 - g8
	var h9: int = f9 - g9
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_neg(h: PackedInt64Array, f: PackedInt64Array) -> void:
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
	var h0: int = -f0
	var h1: int = -f1
	var h2: int = -f2
	var h3: int = -f3
	var h4: int = -f4
	var h5: int = -f5
	var h6: int = -f6
	var h7: int = -f7
	var h8: int = -f8
	var h9: int = -f9
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_mul(h: PackedInt64Array, f: PackedInt64Array, g: PackedInt64Array) -> void:
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
	var g1_19: int = 19 * g1
	var g2_19: int = 19 * g2
	var g3_19: int = 19 * g3
	var g4_19: int = 19 * g4
	var g5_19: int = 19 * g5
	var g6_19: int = 19 * g6
	var g7_19: int = 19 * g7
	var g8_19: int = 19 * g8
	var g9_19: int = 19 * g9
	var f1_2: int = 2 * f1
	var f3_2: int = 2 * f3
	var f5_2: int = 2 * f5
	var f7_2: int = 2 * f7
	var f9_2: int = 2 * f9
	var f0g0: int = f0 * g0
	var f0g1: int = f0 * g1
	var f0g2: int = f0 * g2
	var f0g3: int = f0 * g3
	var f0g4: int = f0 * g4
	var f0g5: int = f0 * g5
	var f0g6: int = f0 * g6
	var f0g7: int = f0 * g7
	var f0g8: int = f0 * g8
	var f0g9: int = f0 * g9
	var f1g0: int = f1 * g0
	var f1g1_2: int = f1_2 * g1
	var f1g2: int = f1 * g2
	var f1g3_2: int = f1_2 * g3
	var f1g4: int = f1 * g4
	var f1g5_2: int = f1_2 * g5
	var f1g6: int = f1 * g6
	var f1g7_2: int = f1_2 * g7
	var f1g8: int = f1 * g8
	var f1g9_38: int = f1_2 * g9_19
	var f2g0: int = f2 * g0
	var f2g1: int = f2 * g1
	var f2g2: int = f2 * g2
	var f2g3: int = f2 * g3
	var f2g4: int = f2 * g4
	var f2g5: int = f2 * g5
	var f2g6: int = f2 * g6
	var f2g7: int = f2 * g7
	var f2g8_19: int = f2 * g8_19
	var f2g9_19: int = f2 * g9_19
	var f3g0: int = f3 * g0
	var f3g1_2: int = f3_2 * g1
	var f3g2: int = f3 * g2
	var f3g3_2: int = f3_2 * g3
	var f3g4: int = f3 * g4
	var f3g5_2: int = f3_2 * g5
	var f3g6: int = f3 * g6
	var f3g7_38: int = f3_2 * g7_19
	var f3g8_19: int = f3 * g8_19
	var f3g9_38: int = f3_2 * g9_19
	var f4g0: int = f4 * g0
	var f4g1: int = f4 * g1
	var f4g2: int = f4 * g2
	var f4g3: int = f4 * g3
	var f4g4: int = f4 * g4
	var f4g5: int = f4 * g5
	var f4g6_19: int = f4 * g6_19
	var f4g7_19: int = f4 * g7_19
	var f4g8_19: int = f4 * g8_19
	var f4g9_19: int = f4 * g9_19
	var f5g0: int = f5 * g0
	var f5g1_2: int = f5_2 * g1
	var f5g2: int = f5 * g2
	var f5g3_2: int = f5_2 * g3
	var f5g4: int = f5 * g4
	var f5g5_38: int = f5_2 * g5_19
	var f5g6_19: int = f5 * g6_19
	var f5g7_38: int = f5_2 * g7_19
	var f5g8_19: int = f5 * g8_19
	var f5g9_38: int = f5_2 * g9_19
	var f6g0: int = f6 * g0
	var f6g1: int = f6 * g1
	var f6g2: int = f6 * g2
	var f6g3: int = f6 * g3
	var f6g4_19: int = f6 * g4_19
	var f6g5_19: int = f6 * g5_19
	var f6g6_19: int = f6 * g6_19
	var f6g7_19: int = f6 * g7_19
	var f6g8_19: int = f6 * g8_19
	var f6g9_19: int = f6 * g9_19
	var f7g0: int = f7 * g0
	var f7g1_2: int = f7_2 * g1
	var f7g2: int = f7 * g2
	var f7g3_38: int = f7_2 * g3_19
	var f7g4_19: int = f7 * g4_19
	var f7g5_38: int = f7_2 * g5_19
	var f7g6_19: int = f7 * g6_19
	var f7g7_38: int = f7_2 * g7_19
	var f7g8_19: int = f7 * g8_19
	var f7g9_38: int = f7_2 * g9_19
	var f8g0: int = f8 * g0
	var f8g1: int = f8 * g1
	var f8g2_19: int = f8 * g2_19
	var f8g3_19: int = f8 * g3_19
	var f8g4_19: int = f8 * g4_19
	var f8g5_19: int = f8 * g5_19
	var f8g6_19: int = f8 * g6_19
	var f8g7_19: int = f8 * g7_19
	var f8g8_19: int = f8 * g8_19
	var f8g9_19: int = f8 * g9_19
	var f9g0: int = f9 * g0
	var f9g1_38: int = f9_2 * g1_19
	var f9g2_19: int = f9 * g2_19
	var f9g3_38: int = f9_2 * g3_19
	var f9g4_19: int = f9 * g4_19
	var f9g5_38: int = f9_2 * g5_19
	var f9g6_19: int = f9 * g6_19
	var f9g7_38: int = f9_2 * g7_19
	var f9g8_19: int = f9 * g8_19
	var f9g9_38: int = f9_2 * g9_19
	var h0: int = f0g0 + f1g9_38 + f2g8_19 + f3g7_38 + f4g6_19 + f5g5_38 + f6g4_19 + f7g3_38 + f8g2_19 + f9g1_38
	var h1: int = f0g1 + f1g0 + f2g9_19 + f3g8_19 + f4g7_19 + f5g6_19 + f6g5_19 + f7g4_19 + f8g3_19 + f9g2_19
	var h2: int = f0g2 + f1g1_2 + f2g0 + f3g9_38 + f4g8_19 + f5g7_38 + f6g6_19 + f7g5_38 + f8g4_19 + f9g3_38
	var h3: int = f0g3 + f1g2 + f2g1 + f3g0 + f4g9_19 + f5g8_19 + f6g7_19 + f7g6_19 + f8g5_19 + f9g4_19
	var h4: int = f0g4 + f1g3_2 + f2g2 + f3g1_2 + f4g0 + f5g9_38 + f6g8_19 + f7g7_38 + f8g6_19 + f9g5_38
	var h5: int = f0g5 + f1g4 + f2g3 + f3g2 + f4g1 + f5g0 + f6g9_19 + f7g8_19 + f8g7_19 + f9g6_19
	var h6: int = f0g6 + f1g5_2 + f2g4 + f3g3_2 + f4g2 + f5g1_2 + f6g0 + f7g9_38 + f8g8_19 + f9g7_38
	var h7: int = f0g7 + f1g6 + f2g5 + f3g4 + f4g3 + f5g2 + f6g1 + f7g0 + f8g9_19 + f9g8_19
	var h8: int = f0g8 + f1g7_2 + f2g6 + f3g5_2 + f4g4 + f5g3_2 + f6g2 + f7g1_2 + f8g0 + f9g9_38
	var h9: int = f0g9 + f1g8 + f2g7 + f3g6 + f4g5 + f5g4 + f6g3 + f7g2 + f8g1 + f9g0
	var carry0: int
	var carry1: int
	var carry2: int
	var carry3: int
	var carry4: int
	var carry5: int
	var carry6: int
	var carry7: int
	var carry8: int
	var carry9: int
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry1 = (h1 + 16777216) >> 25
	h2 += carry1
	h1 -= carry1 * 33554432
	carry5 = (h5 + 16777216) >> 25
	h6 += carry5
	h5 -= carry5 * 33554432
	carry2 = (h2 + 33554432) >> 26
	h3 += carry2
	h2 -= carry2 * 67108864
	carry6 = (h6 + 33554432) >> 26
	h7 += carry6
	h6 -= carry6 * 67108864
	carry3 = (h3 + 16777216) >> 25
	h4 += carry3
	h3 -= carry3 * 33554432
	carry7 = (h7 + 16777216) >> 25
	h8 += carry7
	h7 -= carry7 * 33554432
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry8 = (h8 + 33554432) >> 26
	h9 += carry8
	h8 -= carry8 * 67108864
	carry9 = (h9 + 16777216) >> 25
	h0 += carry9 * 19
	h9 -= carry9 * 33554432
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_sq(h: PackedInt64Array, f: PackedInt64Array) -> void:
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
	var f0_2: int = 2 * f0
	var f1_2: int = 2 * f1
	var f2_2: int = 2 * f2
	var f3_2: int = 2 * f3
	var f4_2: int = 2 * f4
	var f5_2: int = 2 * f5
	var f6_2: int = 2 * f6
	var f7_2: int = 2 * f7
	var f5_38: int = 38 * f5
	var f6_19: int = 19 * f6
	var f7_38: int = 38 * f7
	var f8_19: int = 19 * f8
	var f9_38: int = 38 * f9
	var f0f0: int = f0 * f0
	var f0f1_2: int = f0_2 * f1
	var f0f2_2: int = f0_2 * f2
	var f0f3_2: int = f0_2 * f3
	var f0f4_2: int = f0_2 * f4
	var f0f5_2: int = f0_2 * f5
	var f0f6_2: int = f0_2 * f6
	var f0f7_2: int = f0_2 * f7
	var f0f8_2: int = f0_2 * f8
	var f0f9_2: int = f0_2 * f9
	var f1f1_2: int = f1_2 * f1
	var f1f2_2: int = f1_2 * f2
	var f1f3_4: int = f1_2 * f3_2
	var f1f4_2: int = f1_2 * f4
	var f1f5_4: int = f1_2 * f5_2
	var f1f6_2: int = f1_2 * f6
	var f1f7_4: int = f1_2 * f7_2
	var f1f8_2: int = f1_2 * f8
	var f1f9_76: int = f1_2 * f9_38
	var f2f2: int = f2 * f2
	var f2f3_2: int = f2_2 * f3
	var f2f4_2: int = f2_2 * f4
	var f2f5_2: int = f2_2 * f5
	var f2f6_2: int = f2_2 * f6
	var f2f7_2: int = f2_2 * f7
	var f2f8_38: int = f2_2 * f8_19
	var f2f9_38: int = f2 * f9_38
	var f3f3_2: int = f3_2 * f3
	var f3f4_2: int = f3_2 * f4
	var f3f5_4: int = f3_2 * f5_2
	var f3f6_2: int = f3_2 * f6
	var f3f7_76: int = f3_2 * f7_38
	var f3f8_38: int = f3_2 * f8_19
	var f3f9_76: int = f3_2 * f9_38
	var f4f4: int = f4 * f4
	var f4f5_2: int = f4_2 * f5
	var f4f6_38: int = f4_2 * f6_19
	var f4f7_38: int = f4 * f7_38
	var f4f8_38: int = f4_2 * f8_19
	var f4f9_38: int = f4 * f9_38
	var f5f5_38: int = f5 * f5_38
	var f5f6_38: int = f5_2 * f6_19
	var f5f7_76: int = f5_2 * f7_38
	var f5f8_38: int = f5_2 * f8_19
	var f5f9_76: int = f5_2 * f9_38
	var f6f6_19: int = f6 * f6_19
	var f6f7_38: int = f6 * f7_38
	var f6f8_38: int = f6_2 * f8_19
	var f6f9_38: int = f6 * f9_38
	var f7f7_38: int = f7 * f7_38
	var f7f8_38: int = f7_2 * f8_19
	var f7f9_76: int = f7_2 * f9_38
	var f8f8_19: int = f8 * f8_19
	var f8f9_38: int = f8 * f9_38
	var f9f9_38: int = f9 * f9_38
	var h0: int = f0f0 + f1f9_76 + f2f8_38 + f3f7_76 + f4f6_38 + f5f5_38
	var h1: int = f0f1_2 + f2f9_38 + f3f8_38 + f4f7_38 + f5f6_38
	var h2: int = f0f2_2 + f1f1_2 + f3f9_76 + f4f8_38 + f5f7_76 + f6f6_19
	var h3: int = f0f3_2 + f1f2_2 + f4f9_38 + f5f8_38 + f6f7_38
	var h4: int = f0f4_2 + f1f3_4 + f2f2 + f5f9_76 + f6f8_38 + f7f7_38
	var h5: int = f0f5_2 + f1f4_2 + f2f3_2 + f6f9_38 + f7f8_38
	var h6: int = f0f6_2 + f1f5_4 + f2f4_2 + f3f3_2 + f7f9_76 + f8f8_19
	var h7: int = f0f7_2 + f1f6_2 + f2f5_2 + f3f4_2 + f8f9_38
	var h8: int = f0f8_2 + f1f7_4 + f2f6_2 + f3f5_4 + f4f4 + f9f9_38
	var h9: int = f0f9_2 + f1f8_2 + f2f7_2 + f3f6_2 + f4f5_2
	var carry0: int
	var carry1: int
	var carry2: int
	var carry3: int
	var carry4: int
	var carry5: int
	var carry6: int
	var carry7: int
	var carry8: int
	var carry9: int
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry1 = (h1 + 16777216) >> 25
	h2 += carry1
	h1 -= carry1 * 33554432
	carry5 = (h5 + 16777216) >> 25
	h6 += carry5
	h5 -= carry5 * 33554432
	carry2 = (h2 + 33554432) >> 26
	h3 += carry2
	h2 -= carry2 * 67108864
	carry6 = (h6 + 33554432) >> 26
	h7 += carry6
	h6 -= carry6 * 67108864
	carry3 = (h3 + 16777216) >> 25
	h4 += carry3
	h3 -= carry3 * 33554432
	carry7 = (h7 + 16777216) >> 25
	h8 += carry7
	h7 -= carry7 * 33554432
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry8 = (h8 + 33554432) >> 26
	h9 += carry8
	h8 -= carry8 * 67108864
	carry9 = (h9 + 16777216) >> 25
	h0 += carry9 * 19
	h9 -= carry9 * 33554432
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_sq2(h: PackedInt64Array, f: PackedInt64Array) -> void:
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
	var f0_2: int = 2 * f0
	var f1_2: int = 2 * f1
	var f2_2: int = 2 * f2
	var f3_2: int = 2 * f3
	var f4_2: int = 2 * f4
	var f5_2: int = 2 * f5
	var f6_2: int = 2 * f6
	var f7_2: int = 2 * f7
	var f5_38: int = 38 * f5
	var f6_19: int = 19 * f6
	var f7_38: int = 38 * f7
	var f8_19: int = 19 * f8
	var f9_38: int = 38 * f9
	var f0f0: int = f0 * f0
	var f0f1_2: int = f0_2 * f1
	var f0f2_2: int = f0_2 * f2
	var f0f3_2: int = f0_2 * f3
	var f0f4_2: int = f0_2 * f4
	var f0f5_2: int = f0_2 * f5
	var f0f6_2: int = f0_2 * f6
	var f0f7_2: int = f0_2 * f7
	var f0f8_2: int = f0_2 * f8
	var f0f9_2: int = f0_2 * f9
	var f1f1_2: int = f1_2 * f1
	var f1f2_2: int = f1_2 * f2
	var f1f3_4: int = f1_2 * f3_2
	var f1f4_2: int = f1_2 * f4
	var f1f5_4: int = f1_2 * f5_2
	var f1f6_2: int = f1_2 * f6
	var f1f7_4: int = f1_2 * f7_2
	var f1f8_2: int = f1_2 * f8
	var f1f9_76: int = f1_2 * f9_38
	var f2f2: int = f2 * f2
	var f2f3_2: int = f2_2 * f3
	var f2f4_2: int = f2_2 * f4
	var f2f5_2: int = f2_2 * f5
	var f2f6_2: int = f2_2 * f6
	var f2f7_2: int = f2_2 * f7
	var f2f8_38: int = f2_2 * f8_19
	var f2f9_38: int = f2 * f9_38
	var f3f3_2: int = f3_2 * f3
	var f3f4_2: int = f3_2 * f4
	var f3f5_4: int = f3_2 * f5_2
	var f3f6_2: int = f3_2 * f6
	var f3f7_76: int = f3_2 * f7_38
	var f3f8_38: int = f3_2 * f8_19
	var f3f9_76: int = f3_2 * f9_38
	var f4f4: int = f4 * f4
	var f4f5_2: int = f4_2 * f5
	var f4f6_38: int = f4_2 * f6_19
	var f4f7_38: int = f4 * f7_38
	var f4f8_38: int = f4_2 * f8_19
	var f4f9_38: int = f4 * f9_38
	var f5f5_38: int = f5 * f5_38
	var f5f6_38: int = f5_2 * f6_19
	var f5f7_76: int = f5_2 * f7_38
	var f5f8_38: int = f5_2 * f8_19
	var f5f9_76: int = f5_2 * f9_38
	var f6f6_19: int = f6 * f6_19
	var f6f7_38: int = f6 * f7_38
	var f6f8_38: int = f6_2 * f8_19
	var f6f9_38: int = f6 * f9_38
	var f7f7_38: int = f7 * f7_38
	var f7f8_38: int = f7_2 * f8_19
	var f7f9_76: int = f7_2 * f9_38
	var f8f8_19: int = f8 * f8_19
	var f8f9_38: int = f8 * f9_38
	var f9f9_38: int = f9 * f9_38
	var h0: int = f0f0 + f1f9_76 + f2f8_38 + f3f7_76 + f4f6_38 + f5f5_38
	var h1: int = f0f1_2 + f2f9_38 + f3f8_38 + f4f7_38 + f5f6_38
	var h2: int = f0f2_2 + f1f1_2 + f3f9_76 + f4f8_38 + f5f7_76 + f6f6_19
	var h3: int = f0f3_2 + f1f2_2 + f4f9_38 + f5f8_38 + f6f7_38
	var h4: int = f0f4_2 + f1f3_4 + f2f2 + f5f9_76 + f6f8_38 + f7f7_38
	var h5: int = f0f5_2 + f1f4_2 + f2f3_2 + f6f9_38 + f7f8_38
	var h6: int = f0f6_2 + f1f5_4 + f2f4_2 + f3f3_2 + f7f9_76 + f8f8_19
	var h7: int = f0f7_2 + f1f6_2 + f2f5_2 + f3f4_2 + f8f9_38
	var h8: int = f0f8_2 + f1f7_4 + f2f6_2 + f3f5_4 + f4f4 + f9f9_38
	var h9: int = f0f9_2 + f1f8_2 + f2f7_2 + f3f6_2 + f4f5_2
	var carry0: int
	var carry1: int
	var carry2: int
	var carry3: int
	var carry4: int
	var carry5: int
	var carry6: int
	var carry7: int
	var carry8: int
	var carry9: int
	h0 += h0
	h1 += h1
	h2 += h2
	h3 += h3
	h4 += h4
	h5 += h5
	h6 += h6
	h7 += h7
	h8 += h8
	h9 += h9
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry1 = (h1 + 16777216) >> 25
	h2 += carry1
	h1 -= carry1 * 33554432
	carry5 = (h5 + 16777216) >> 25
	h6 += carry5
	h5 -= carry5 * 33554432
	carry2 = (h2 + 33554432) >> 26
	h3 += carry2
	h2 -= carry2 * 67108864
	carry6 = (h6 + 33554432) >> 26
	h7 += carry6
	h6 -= carry6 * 67108864
	carry3 = (h3 + 16777216) >> 25
	h4 += carry3
	h3 -= carry3 * 33554432
	carry7 = (h7 + 16777216) >> 25
	h8 += carry7
	h7 -= carry7 * 33554432
	carry4 = (h4 + 33554432) >> 26
	h5 += carry4
	h4 -= carry4 * 67108864
	carry8 = (h8 + 33554432) >> 26
	h9 += carry8
	h8 -= carry8 * 67108864
	carry9 = (h9 + 16777216) >> 25
	h0 += carry9 * 19
	h9 -= carry9 * 33554432
	carry0 = (h0 + 33554432) >> 26
	h1 += carry0
	h0 -= carry0 * 67108864
	h[0] = h0
	h[1] = h1
	h[2] = h2
	h[3] = h3
	h[4] = h4
	h[5] = h5
	h[6] = h6
	h[7] = h7
	h[8] = h8
	h[9] = h9


static func fe_isnegative(f: PackedInt64Array) -> int:
	var s := PackedByteArray()
	s.resize(32)
	fe_tobytes(s, f)
	return s[0] & 1


static func fe_isnonzero(f: PackedInt64Array) -> bool:
	var s := PackedByteArray()
	s.resize(32)
	fe_tobytes(s, f)
	var r: int = 0
	for i in 32:
		r |= s[i]
	return r != 0


static func fe_invert(out: PackedInt64Array, z: PackedInt64Array) -> void:
	var t0 := fe_new(); var t1 := fe_new(); var t2 := fe_new(); var t3 := fe_new()
	fe_sq(t0, z)
	fe_sq(t1, t0)
	fe_sq(t1, t1)
	fe_mul(t1, z, t1)
	fe_mul(t0, t0, t1)
	fe_sq(t2, t0)
	fe_mul(t1, t1, t2)
	fe_sq(t2, t1)
	for i in 4: fe_sq(t2, t2)
	fe_mul(t1, t2, t1)
	fe_sq(t2, t1)
	for i in 9: fe_sq(t2, t2)
	fe_mul(t2, t2, t1)
	fe_sq(t3, t2)
	for i in 19: fe_sq(t3, t3)
	fe_mul(t2, t3, t2)
	fe_sq(t2, t2)
	for i in 9: fe_sq(t2, t2)
	fe_mul(t1, t2, t1)
	fe_sq(t2, t1)
	for i in 49: fe_sq(t2, t2)
	fe_mul(t2, t2, t1)
	fe_sq(t3, t2)
	for i in 99: fe_sq(t3, t3)
	fe_mul(t2, t3, t2)
	fe_sq(t2, t2)
	for i in 49: fe_sq(t2, t2)
	fe_mul(t1, t2, t1)
	fe_sq(t1, t1)
	for i in 4: fe_sq(t1, t1)
	fe_mul(out, t1, t0)


static func fe_pow22523(out: PackedInt64Array, z: PackedInt64Array) -> void:
	var t0 := fe_new(); var t1 := fe_new(); var t2 := fe_new()
	fe_sq(t0, z)
	fe_sq(t1, t0)
	fe_sq(t1, t1)
	fe_mul(t1, z, t1)
	fe_mul(t0, t0, t1)
	fe_sq(t0, t0)
	fe_mul(t0, t1, t0)
	fe_sq(t1, t0)
	for i in 4: fe_sq(t1, t1)
	fe_mul(t0, t1, t0)
	fe_sq(t1, t0)
	for i in 9: fe_sq(t1, t1)
	fe_mul(t1, t1, t0)
	fe_sq(t2, t1)
	for i in 19: fe_sq(t2, t2)
	fe_mul(t1, t2, t1)
	fe_sq(t1, t1)
	for i in 9: fe_sq(t1, t1)
	fe_mul(t0, t1, t0)
	fe_sq(t1, t0)
	for i in 49: fe_sq(t1, t1)
	fe_mul(t1, t1, t0)
	fe_sq(t2, t1)
	for i in 99: fe_sq(t2, t2)
	fe_mul(t1, t2, t1)
	fe_sq(t1, t1)
	for i in 49: fe_sq(t1, t1)
	fe_mul(t0, t1, t0)
	fe_sq(t0, t0)
	fe_sq(t0, t0)
	fe_mul(out, t0, z)


# ---- group operations. Points are Arrays of PackedInt64Array:
#   p2 [X,Y,Z]   p3 [X,Y,Z,T]   p1p1 [X,Y,Z,T]   cached [YplusX,YminusX,Z,T2d]   precomp [yplusx,yminusx,xy2d]

static func ge_frombytes_negate_vartime(h: Array, s: PackedByteArray) -> bool:
	var hx: PackedInt64Array = h[0]
	var hy: PackedInt64Array = h[1]
	var hz: PackedInt64Array = h[2]
	var ht: PackedInt64Array = h[3]
	var u := fe_new(); var v := fe_new(); var v3 := fe_new(); var vxx := fe_new(); var check := fe_new()
	fe_frombytes(hy, s)
	fe_1(hz)
	fe_sq(u, hy)
	fe_mul(v, u, PackedInt64Array(FE_D))
	fe_sub(u, u, hz)
	fe_add(v, v, hz)
	fe_sq(v3, v)
	fe_mul(v3, v3, v)
	fe_sq(hx, v3)
	fe_mul(hx, hx, v)
	fe_mul(hx, hx, u)
	fe_pow22523(hx, hx)
	fe_mul(hx, hx, v3)
	fe_mul(hx, hx, u)
	fe_sq(vxx, hx)
	fe_mul(vxx, vxx, v)
	fe_sub(check, vxx, u)
	if fe_isnonzero(check):
		fe_add(check, vxx, u)
		if fe_isnonzero(check):
			return false
		fe_mul(hx, hx, PackedInt64Array(FE_SQRTM1))
	if fe_isnegative(hx) == (s[31] >> 7):
		fe_neg(hx, hx)
	fe_mul(ht, hx, hy)
	return true


static func ge_add(r: Array, p: Array, q: Array, t0: PackedInt64Array) -> void:
	var rx: PackedInt64Array = r[0]
	var ry: PackedInt64Array = r[1]
	var rz: PackedInt64Array = r[2]
	var rt: PackedInt64Array = r[3]
	fe_add(rx, p[1], p[0])
	fe_sub(ry, p[1], p[0])
	fe_mul(rz, rx, q[0])
	fe_mul(ry, ry, q[1])
	fe_mul(rt, q[3], p[3])
	fe_mul(rx, p[2], q[2])
	fe_add(t0, rx, rx)
	fe_sub(rx, rz, ry)
	fe_add(ry, rz, ry)
	fe_add(rz, t0, rt)
	fe_sub(rt, t0, rt)


static func ge_sub(r: Array, p: Array, q: Array, t0: PackedInt64Array) -> void:
	var rx: PackedInt64Array = r[0]
	var ry: PackedInt64Array = r[1]
	var rz: PackedInt64Array = r[2]
	var rt: PackedInt64Array = r[3]
	fe_add(rx, p[1], p[0])
	fe_sub(ry, p[1], p[0])
	fe_mul(rz, rx, q[1])
	fe_mul(ry, ry, q[0])
	fe_mul(rt, q[3], p[3])
	fe_mul(rx, p[2], q[2])
	fe_add(t0, rx, rx)
	fe_sub(rx, rz, ry)
	fe_add(ry, rz, ry)
	fe_sub(rz, t0, rt)
	fe_add(rt, t0, rt)


static func ge_madd(r: Array, p: Array, q: Array, t0: PackedInt64Array) -> void:
	var rx: PackedInt64Array = r[0]
	var ry: PackedInt64Array = r[1]
	var rz: PackedInt64Array = r[2]
	var rt: PackedInt64Array = r[3]
	fe_add(rx, p[1], p[0])
	fe_sub(ry, p[1], p[0])
	fe_mul(rz, rx, q[0])
	fe_mul(ry, ry, q[1])
	fe_mul(rt, q[2], p[3])
	fe_add(t0, p[2], p[2])
	fe_sub(rx, rz, ry)
	fe_add(ry, rz, ry)
	fe_add(rz, t0, rt)
	fe_sub(rt, t0, rt)


static func ge_msub(r: Array, p: Array, q: Array, t0: PackedInt64Array) -> void:
	var rx: PackedInt64Array = r[0]
	var ry: PackedInt64Array = r[1]
	var rz: PackedInt64Array = r[2]
	var rt: PackedInt64Array = r[3]
	fe_add(rx, p[1], p[0])
	fe_sub(ry, p[1], p[0])
	fe_mul(rz, rx, q[1])
	fe_mul(ry, ry, q[0])
	fe_mul(rt, q[2], p[3])
	fe_add(t0, p[2], p[2])
	fe_sub(rx, rz, ry)
	fe_add(ry, rz, ry)
	fe_sub(rz, t0, rt)
	fe_add(rt, t0, rt)


static func ge_p1p1_to_p2(r: Array, p: Array) -> void:
	fe_mul(r[0], p[0], p[3])
	fe_mul(r[1], p[1], p[2])
	fe_mul(r[2], p[2], p[3])


static func ge_p1p1_to_p3(r: Array, p: Array) -> void:
	fe_mul(r[0], p[0], p[3])
	fe_mul(r[1], p[1], p[2])
	fe_mul(r[2], p[2], p[3])
	fe_mul(r[3], p[0], p[1])


static func ge_p2_dbl(r: Array, p: Array, t0: PackedInt64Array) -> void:
	var rx: PackedInt64Array = r[0]
	var ry: PackedInt64Array = r[1]
	var rz: PackedInt64Array = r[2]
	var rt: PackedInt64Array = r[3]
	fe_sq(rx, p[0])
	fe_sq(rz, p[1])
	fe_sq2(rt, p[2])
	fe_add(ry, p[0], p[1])
	fe_sq(t0, ry)
	fe_add(ry, rz, rx)
	fe_sub(rz, rz, rx)
	fe_sub(rx, t0, ry)
	fe_sub(rt, rt, rz)


static func ge_p3_to_cached(r: Array, p: Array) -> void:
	fe_add(r[0], p[1], p[0])
	fe_sub(r[1], p[1], p[0])
	fe_copy(r[2], p[2])
	fe_mul(r[3], p[3], PackedInt64Array(FE_D2))


static func _pt(n: int) -> Array:
	var a := []
	for i in n:
		a.append(fe_new())
	return a


static func slide(a: PackedByteArray) -> PackedInt32Array:
	var r := PackedInt32Array()
	r.resize(256)
	for i in 256:
		r[i] = 1 & (a[i >> 3] >> (i & 7))
	for i in 256:
		if r[i] != 0:
			var b := 1
			while b <= 6 and i + b < 256:
				if r[i + b] != 0:
					var sh: int = r[i + b] << b
					if r[i] + sh <= 15:
						r[i] += sh
						r[i + b] = 0
					elif r[i] - sh >= -15:
						r[i] -= sh
						for k in range(i + b, 256):
							if r[k] == 0:
								r[k] = 1
								break
							r[k] = 0
					else:
						break
				b += 1
	return r


## r(p2) = a*A + b*B, variable time.
static func ge_double_scalarmult_vartime(r: Array, a: PackedByteArray, A: Array, b: PackedByteArray) -> void:
	var aslide := slide(a)
	var bslide := slide(b)
	var t0 := fe_new()
	var t := _pt(4)
	var u := _pt(4)
	var A2 := _pt(4)
	var Ai := []
	for i in 8:
		Ai.append(_pt(4))
	ge_p3_to_cached(Ai[0], A)
	ge_p2_dbl(t, A, t0)  # p3 -> p2 is just the first three coordinates
	ge_p1p1_to_p3(A2, t)
	for i in 7:
		ge_add(t, A2, Ai[i], t0)
		ge_p1p1_to_p3(u, t)
		ge_p3_to_cached(Ai[i + 1], u)
	fe_0(r[0])
	fe_1(r[1])
	fe_1(r[2])
	var i := 255
	while i >= 0:
		if aslide[i] != 0 or bslide[i] != 0:
			break
		i -= 1
	while i >= 0:
		ge_p2_dbl(t, r, t0)
		var ai: int = aslide[i]
		if ai > 0:
			ge_p1p1_to_p3(u, t)
			ge_add(t, u, Ai[ai >> 1], t0)
		elif ai < 0:
			ge_p1p1_to_p3(u, t)
			ge_sub(t, u, Ai[(-ai) >> 1], t0)
		var bi: int = bslide[i]
		if bi > 0:
			ge_p1p1_to_p3(u, t)
			ge_madd(t, u, _bi[bi >> 1], t0)
		elif bi < 0:
			ge_p1p1_to_p3(u, t)
			ge_msub(t, u, _bi[(-bi) >> 1], t0)
		ge_p1p1_to_p2(r, t)
		i -= 1


static func ge_tobytes(s: PackedByteArray, h: Array) -> void:
	var recip := fe_new(); var x := fe_new(); var y := fe_new()
	fe_invert(recip, h[2])
	fe_mul(x, h[0], recip)
	fe_mul(y, h[1], recip)
	fe_tobytes(s, y)
	s[31] ^= fe_isnegative(x) << 7


# ---- scalars (TweetNaCl modL: runs once per verify, not worth unrolling)

static func sc_reduce(h: PackedByteArray) -> PackedByteArray:
	# A local copy: on 4.4 two threads reading one const Array race (it hands elements out
	# through a single shared slot), so thread-reachable code never indexes or iterates one.
	var l := PackedInt64Array(L)
	var x := PackedInt64Array()
	x.resize(64)
	for i in 64:
		x[i] = h[i]
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
	var r := PackedByteArray()
	r.resize(32)
	for k in 32:
		x[k + 1] += x[k] >> 8
		r[k] = x[k] & 255
	return r


static func s_is_canonical(sig: PackedByteArray) -> bool:
	var l := PackedInt64Array(L)  # see sc_reduce
	for i in range(31, -1, -1):
		var si: int = sig[32 + i]
		if si < l[i]:
			return true
		if si > l[i]:
			return false
	return false


static func y_is_canonical(pk: PackedByteArray) -> bool:
	if (pk[31] & 0x7f) != 0x7f:
		return true
	for i in range(30, 0, -1):
		if pk[i] != 0xff:
			return true
	return pk[0] < 0xed


## Verify a detached Ed25519 signature. sig: 64 bytes, msg: any, pk: 32 bytes raw.
static func verify(sig: PackedByteArray, msg: PackedByteArray, pk: PackedByteArray) -> bool:
	if sig.size() != 64 or pk.size() != 32:
		return false
	if not s_is_canonical(sig) or not y_is_canonical(pk):
		return false
	warmup()
	var A := _pt(4)
	if not ge_frombytes_negate_vartime(A, pk):
		return false
	var hin := sig.slice(0, 32)
	hin.append_array(pk)
	hin.append_array(msg)
	var h := sc_reduce(PKeySha512.hash(hin))
	var R := _pt(3)
	ge_double_scalarmult_vartime(R, h, A, sig.slice(32, 64))
	var chk := PackedByteArray()
	chk.resize(32)
	ge_tobytes(chk, R)
	var d: int = 0
	for i in 32:
		d |= chk[i] ^ sig[i]
	return d == 0


# ---- P1-02: per-key precomputation (the per-kid cache in PKeyJws) and the stepwise verify in
# PKeyEd25519Job. Nothing above this line changed; these reuse it.

## The 8 odd multiples A, 3A, ..., 15A of a p3 point, in cached form (as built inside
## ge_double_scalarmult_vartime).
static func odd_multiples(A: Array) -> Array:
	var t0 := fe_new()
	var t := _pt(4)
	var u := _pt(4)
	var A2 := _pt(4)
	var Ai := []
	for i in 8:
		Ai.append(_pt(4))
	ge_p3_to_cached(Ai[0], A)
	ge_p2_dbl(t, A, t0)
	ge_p1p1_to_p3(A2, t)
	for i in 7:
		ge_add(t, A2, Ai[i], t0)
		ge_p1p1_to_p3(u, t)
		ge_p3_to_cached(Ai[i + 1], u)
	return Ai


## Decompress a public key once: [pk, -A (p3), odd multiples of -A], or [] when `pk` is not a
## canonical, on-curve 32-byte key. Read-only afterwards, so one prepared key can serve verifies
## on several threads. Call on the main thread: it runs `warmup()`.
static func prepare_key(pk: PackedByteArray) -> Array:
	if pk.size() != 32 or not y_is_canonical(pk):
		return []
	warmup()
	var A := _pt(4)
	if not ge_frombytes_negate_vartime(A, pk):
		return []
	return [pk.duplicate(), A, odd_multiples(A)]


# ---- P3-02: WIRE-CONTRACT-V4 §1.1, byte checks on the key A and on R before any curve math.

## The eight small-order point encodings (order 1, 2, the two of order 4, the four of order 8).
const SMALL_ORDER_ENCODINGS := [
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0000000000000000000000000000000000000000000000000000000000000080",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
]
## x = 0 with the sign bit set: no point (check 2). Godot's decoder read the first as the identity.
const NEGATIVE_ZERO_ENCODINGS := [
	"0100000000000000000000000000000000000000000000000000000000000080",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
]


## V4 §1.1 checks 1–3 on the trusted key `pk` and the signature `R ‖ S`: `S < L`, canonical
## encodings (a `y` below p, and not x = 0 with the sign bit), and neither `A` nor `R` of small
## order. Byte comparisons only; `verify` keeps its own `S` and `y` checks as a second line.
static func v4_prechecks(pk: PackedByteArray, sig: PackedByteArray) -> bool:
	if pk.size() != 32 or sig.size() != 64:
		return false
	if not s_is_canonical(sig):
		return false
	var r := sig.slice(0, 32)
	for enc in [pk, r]:
		if not y_is_canonical(enc):
			return false
		var h: String = (enc as PackedByteArray).hex_encode()
		if NEGATIVE_ZERO_ENCODINGS.has(h) or SMALL_ORDER_ENCODINGS.has(h):
			return false
	return true
