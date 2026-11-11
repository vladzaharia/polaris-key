@tool
class_name PKeyPeerCpace
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "The mode-q handshake": CPace for account-free local pairing (CC-29b.G1).
## Suite CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting: the draft's string
## functions, the Elligator 2 map, the share check, the ISK, the PSK that feeds Noise, and the two frames
## (C1, C2) that run before it. Nothing here does I/O. Errors are values: a refusal is a PKeyResult whose
## `code` says why, and the caller closes the connection silently and counts no failure.
##
## The field is the ref10 field of PKeyEd25519 (10 limbs, radix 2^25.5); GDScript has no big integers.
## Every scalar multiplication goes through a PKeyPeerCrypto port, so a native X25519 lane takes it
## where the build has one. The Elligator 2 map is NOT constant time (it branches on the quadratic
## character of a value derived from the password, and the engine promises nothing about integer
## timing anyway): make a generator ahead of the connection that needs it, never inside the reply to a
## peer's frame. The shower makes its generators at every rotation, a joiner that scanned a QR makes
## its own before it dials.
##
## Secrets: the scalar passed to `isk` and the working buffers made here are overwritten before
## returning. The arrays passed in otherwise belong to the caller, who clears them.

const DSI := "CPace255"
const DSI_ISK := "CPace255_ISK"
## SHA-512's input block size, the draft's `s_in_bytes`.
const S_IN_BYTES := 128
## The first byte of both frames.
const FRAME_VERSION := 0x01
## The kind byte of C1: 0x01 for a code, 0x02 for a QR.
const KIND_CODE := 0x01
const KIND_QR := 0x02
const C1_LENGTH := 34
const C2_LENGTH := 33
const SHARE_LENGTH := 32
## The QR secret, in bytes.
const QR_SECRET_BYTES := 16
## The refusal codes of `check_share`, `parse_c1` and `parse_c2`.
const REFUSALS := [&"length", &"version", &"kind", &"non-canonical", &"low-order"]

## The Montgomery coefficient A of Curve25519 (B = 1).
const _A := 486662


# ---- The draft's string functions (appendix A) ----


## `prepend_len`: the LEB128 length, then the data.
static func prepend_len(data: PackedByteArray) -> PackedByteArray:
	var out := PackedByteArray()
	var rest := data.size()
	while rest >= 128:
		out.append((rest & 127) + 128)
		rest = rest >> 7
	out.append(rest)
	out.append_array(data)
	return out


## `lv_cat`: every argument length-prefixed, then concatenated.
static func lv_cat(args: Array) -> PackedByteArray:
	var out := PackedByteArray()
	for a: PackedByteArray in args:
		out.append_array(prepend_len(a))
	return out


## `generator_string(DSI, PRS, CI, sid, s_in_bytes)`.
static func generator_string(dsi: PackedByteArray, prs: PackedByteArray, ci: PackedByteArray, sid: PackedByteArray, s_in_bytes: int) -> PackedByteArray:
	var zpad := maxi(0, s_in_bytes - 1 - prepend_len(prs).size() - prepend_len(dsi).size())
	var pad := PackedByteArray()
	pad.resize(zpad)
	return lv_cat([dsi, prs, pad, ci, sid])


## `transcript_ir(Ya, ADa, Yb, ADb)`.
static func transcript_ir(ya: PackedByteArray, ada: PackedByteArray, yb: PackedByteArray, adb: PackedByteArray) -> PackedByteArray:
	var out := lv_cat([ya, ada])
	out.append_array(lv_cat([yb, adb]))
	return out


# ---- The field and the Elligator 2 map ----


static func _fe_small(n: int) -> PackedInt64Array:
	var f := PKeyEd25519.fe_new()
	f[0] = n
	return f


## Re-reduces a field element to carried limbs, so a sum of values can feed a multiplication.
static func _norm(f: PackedInt64Array) -> void:
	var b := PackedByteArray()
	b.resize(32)
	PKeyEd25519.fe_tobytes(b, f)
	PKeyEd25519.fe_frombytes(f, b)


static func _add(h: PackedInt64Array, a: PackedInt64Array, b: PackedInt64Array) -> void:
	PKeyEd25519.fe_add(h, a, b)
	_norm(h)


static func _bytes_of(f: PackedInt64Array) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	PKeyEd25519.fe_tobytes(b, f)
	return b


## The draft's `map_to_curve_elligator2` for Curve25519 (Z = 2) on 32 input bytes: `decodeUCoordinate`
## clears bit 255 and the rest is read little-endian and reduced mod p (`r`); v = -A / (1 + 2 r^2); the
## result is v when v^3 + A v^2 + v is a square (`on_curve`) and -v - A otherwise. Answers
## {r, on_curve, u} (32 little-endian bytes each), or null for an input that is not 32 bytes.
static func elligator2(input: PackedByteArray) -> Variant:
	if input.size() != 32:
		return null
	var one := _fe_small(1)
	var a := _fe_small(_A)
	var r := PKeyEd25519.fe_new()
	PKeyEd25519.fe_frombytes(r, input)
	var t := PKeyEd25519.fe_new()
	PKeyEd25519.fe_sq(t, r)
	_add(t, t, t)
	_add(t, t, one)
	# 1 + 2 r^2 is never 0: -1/2 is a non-square mod p, since p = 5 (mod 8).
	var inv := PKeyEd25519.fe_new()
	PKeyEd25519.fe_invert(inv, t)
	var v := PKeyEd25519.fe_new()
	PKeyEd25519.fe_mul(v, inv, a)
	PKeyEd25519.fe_neg(v, v)
	_norm(v)
	# g(v) = v (v^2 + A v + 1).
	var w := PKeyEd25519.fe_new()
	PKeyEd25519.fe_sq(w, v)
	var av := PKeyEd25519.fe_new()
	PKeyEd25519.fe_mul(av, a, v)
	_add(w, w, av)
	_add(w, w, one)
	var gv := PKeyEd25519.fe_new()
	PKeyEd25519.fe_mul(gv, v, w)
	# eps = g(v)^((p-1)/2) = (g(v)^((p-5)/8))^4 * g(v)^2, which is 1 or p - 1 (g(v) is never 0).
	var e := PKeyEd25519.fe_new()
	PKeyEd25519.fe_pow22523(e, gv)
	PKeyEd25519.fe_sq(e, e)
	PKeyEd25519.fe_sq(e, e)
	var g2 := PKeyEd25519.fe_new()
	PKeyEd25519.fe_sq(g2, gv)
	PKeyEd25519.fe_mul(e, e, g2)
	var eps := _bytes_of(e)
	var on_curve := eps == _one_bytes()
	if not on_curve and eps != _minus_one_bytes():
		return null
	var u := PKeyEd25519.fe_new()
	if on_curve:
		PKeyEd25519.fe_copy(u, v)
	else:
		PKeyEd25519.fe_neg(u, v)
		PKeyEd25519.fe_sub(u, u, a)
	var out := {"r": _bytes_of(r), "on_curve": on_curve, "u": _bytes_of(u)}
	for f: PackedInt64Array in [r, t, inv, v, w, av, gv, e, g2, u]:
		f.fill(0)
	return out


static func _one_bytes() -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b[0] = 1
	return b


## p - 1 = 2^255 - 20, little-endian.
static func _minus_one_bytes() -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(0xff)
	b[0] = 0xec
	b[31] = 0x7f
	return b


# ---- The password-related string and the generator ----


## `"pkey-peer/1 code" || 0x00 || <the 6 ASCII password digits>`. Empty when `digits` is not 6 digits.
static func prs_code(digits: String) -> PackedByteArray:
	if digits.length() != 6 or not digits.is_valid_int() or digits.begins_with("-") or digits.begins_with("+"):
		return PackedByteArray()
	var out := "pkey-peer/1 code".to_utf8_buffer()
	out.append(0)
	out.append_array(digits.to_utf8_buffer())
	return out


## `"pkey-peer/1 qr" || 0x00 || <the 16 secret bytes>`. Empty when `secret` is not 16 bytes.
static func prs_qr(secret: PackedByteArray) -> PackedByteArray:
	if secret.size() != QR_SECRET_BYTES:
		return PackedByteArray()
	var out := "pkey-peer/1 qr".to_utf8_buffer()
	out.append(0)
	out.append_array(secret)
	return out


## The generator: `g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32])`, its
## u-coordinate as 32 bytes. `ci` is the mode-q prologue and `sid` the window's 10 bytes. Empty when
## `prs` is empty. Variable time: see the file header.
static func generator(prs: PackedByteArray, ci: PackedByteArray, sid: PackedByteArray) -> PackedByteArray:
	if prs.is_empty():
		return PackedByteArray()
	var gs := generator_string(DSI.to_utf8_buffer(), prs, ci, sid, S_IN_BYTES)
	var h := PKeySha512.hash(gs)
	var digest := h.slice(0, 32)
	var m: Variant = elligator2(digest)
	gs.fill(0)
	h.fill(0)
	digest.fill(0)
	return (m as Dictionary)["u"] if m != null else PackedByteArray()


# ---- Shares and the refusals (section 15.12 step 3) ----


## A share is 32 bytes, canonical (bit 255 clear and u < 2^255 - 19) and not one of the low-order
## points. The canonical check comes first, so the low-order points at or above p refuse as
## `non-canonical`. ok, or a failure whose code is `length`, `non-canonical` or `low-order`.
static func check_share(y: PackedByteArray) -> PKeyResult:
	if y.size() != SHARE_LENGTH:
		return PKeyResult.failure(&"length")
	if (y[31] & 0x80) != 0 or _at_least_p(y):
		return PKeyResult.failure(&"non-canonical")
	if PKeyCurve25519.is_low_order(y):
		return PKeyResult.failure(&"low-order")
	return PKeyResult.success()


## Whether the 32 bytes (bit 255 already known clear) are >= p = 2^255 - 19.
static func _at_least_p(y: PackedByteArray) -> bool:
	if y[31] != 0x7f:
		return false
	for i in range(1, 31):
		if y[i] != 0xff:
			return false
	return y[0] >= 0xed


## A fresh 32-byte scalar. X25519 clamps it.
static func scalar(crypto: PKeyPeerCrypto = null) -> PackedByteArray:
	return (crypto if crypto != null else PKeyPeerCrypto.for_platform()).random_bytes(32)


## `Y = X25519(y, g)`. Null when the backend refuses (a degenerate generator) or the result is all zero.
static func share(y: PackedByteArray, g: PackedByteArray, crypto: PKeyPeerCrypto = null) -> Variant:
	var port := crypto if crypto != null else PKeyPeerCrypto.for_platform()
	var out: Variant = port.x25519(y, g)
	return out if out is PackedByteArray and (out as PackedByteArray).size() == 32 else null


## `ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) || transcript_ir(Ya, "", Yb, ""))`, 64 bytes, or null
## when K is 32 zero bytes (or the backend refuses the peer's share): the attempt aborts silently.
## `role` is "initiator" (the joiner, which holds `ya`) or "responder". The peer's share must already
## have passed `check_share`. The scalar is overwritten.
static func isk(sid: PackedByteArray, scalar_bytes: PackedByteArray, ya: PackedByteArray, yb: PackedByteArray, role: String, crypto: PKeyPeerCrypto = null) -> Variant:
	var port := crypto if crypto != null else PKeyPeerCrypto.for_platform()
	var peer := yb if role == "initiator" else ya
	var k: Variant = port.x25519(scalar_bytes, peer)
	scalar_bytes.fill(0)
	if not (k is PackedByteArray) or (k as PackedByteArray).size() != 32:
		return null
	var kb: PackedByteArray = k
	var any := 0
	for b in kb:
		any |= b
	if any == 0:
		return null
	var empty := PackedByteArray()
	var input := lv_cat([DSI_ISK.to_utf8_buffer(), sid, kb])
	input.append_array(transcript_ir(ya, empty, yb, empty))
	var out := PKeySha512.hash(input)
	input.fill(0)
	kb.fill(0)
	return out


## The Noise PSK of a pairing attempt: HKDF-SHA256 with an empty salt, the ISK as input keying
## material and `"pkey-peer/1 cpace" || 0x00 || slug` as info, 32 bytes.
static func psk(isk_bytes: PackedByteArray, slug: String) -> PackedByteArray:
	var info := "pkey-peer/1 cpace".to_utf8_buffer()
	info.append(0)
	info.append_array(slug.to_utf8_buffer())
	return PKeySyncHkdf.hkdf(isk_bytes, PackedByteArray(), info, 32)


# ---- The frames C1 and C2 (section 15.12 step 2) ----


## C1, joiner to shower: `0x01 || kind || Ya`, 34 bytes. `kind` is "code" or "qr".
static func encode_c1(kind: String, ya: PackedByteArray) -> PackedByteArray:
	var out := PackedByteArray([FRAME_VERSION, KIND_CODE if kind == "code" else KIND_QR])
	out.append_array(ya)
	return out


## C2, shower to joiner: `0x01 || Yb`, 33 bytes.
static func encode_c2(yb: PackedByteArray) -> PackedByteArray:
	var out := PackedByteArray([FRAME_VERSION])
	out.append_array(yb)
	return out


## The receiver's judgement of C1: length, version, kind, then the share. ok with detail
## {kind: "code" or "qr", share}, or a failure whose code is one of `REFUSALS`.
static func parse_c1(frame: PackedByteArray) -> PKeyResult:
	if frame.size() != C1_LENGTH:
		return PKeyResult.failure(&"length")
	if frame[0] != FRAME_VERSION:
		return PKeyResult.failure(&"version")
	if frame[1] != KIND_CODE and frame[1] != KIND_QR:
		return PKeyResult.failure(&"kind")
	var y := frame.slice(2)
	var v := check_share(y)
	if not v.ok:
		return v
	return PKeyResult.success({"kind": "code" if frame[1] == KIND_CODE else "qr", "share": y})


## The receiver's judgement of C2: length, version, then the share. ok with detail {share}.
static func parse_c2(frame: PackedByteArray) -> PKeyResult:
	if frame.size() != C2_LENGTH:
		return PKeyResult.failure(&"length")
	if frame[0] != FRAME_VERSION:
		return PKeyResult.failure(&"version")
	var y := frame.slice(1)
	var v := check_share(y)
	if not v.ok:
		return v
	return PKeyResult.success({"share": y})
