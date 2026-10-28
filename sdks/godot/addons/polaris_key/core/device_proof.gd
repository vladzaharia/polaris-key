class_name PKeyDeviceProof
extends RefCounted
## The device proof `pkey-proof/1` (WIRE-CONTRACT-V5 section 12.11.1 and 15.8; plans/CC-01.md R-6):
## the message a device signs and a strict verifier for it, both pure. The keys live in
## PKeyDeviceKeyStore; this file only builds the bytes to sign and checks a signature against
## them. The vectors are `device-proof.json` in the corpus mirror. Mirrors
## `packages/client-core/src/deviceProof.ts` and the Python `polaris_key.core.device_proof`.
##
## A proof is a Dictionary {purpose, product, device_id, value, token_hash, sign_key, sig}: the
## six message fields, the signing key (raw 32 bytes, base64url) and the 64-byte signature
## (base64url).

const VERSION := "pkey-proof/1"
## The `keys` proof's skew window, in seconds either side of now.
const KEYS_SKEW_SECONDS := 300
## The nine purposes, in the order of V5 section 12.11.1.
const PURPOSES := ["keys", "nonce", "exchange", "link", "nearby-start", "nearby-poll", "nearby-approve", "vouch", "restore"]
const _MAX_SAFE_INTEGER := 9007199254740991

static var _line_re: RegEx
static var _keys_re: RegEx


static func _static_init() -> void:
	_line_re = RegEx.create_from_string("\\A[\\x21-\\x7e]+\\z")
	_keys_re = RegEx.create_from_string("\\A([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})\\.(0|[1-9][0-9]{0,15})\\z")


## The `keys` purpose's value: `<signKey>.<agreeKey>.<issuedAt>`.
static func keys_value(sign_key: String, agree_key: String, issued_at: int) -> String:
	return "%s.%s.%d" % [sign_key, agree_key, issued_at]


## The bytes a device signs, or null when a field would break the line format (empty, or a byte
## outside 0x21..0x7e). `f` has purpose, product, device_id, value and token_hash.
static func message(f: Dictionary) -> Variant:
	var lines: Array = [VERSION, f.get("purpose"), f.get("product"), f.get("device_id"), f.get("value"), f.get("token_hash")]
	for line in lines:
		if not (line is String) or _line_re.search(line) == null:
			return null
	return "\n".join(PackedStringArray(lines)).to_ascii_buffer()


static func _raw32(s: Variant) -> Variant:
	if not (s is String) or (s as String).length() != 43:
		return null
	var b = PKeyB64Url.decode_strict(s)
	if b == null or (b as PackedByteArray).size() != 32:
		return null
	return b


## True when the key's u-coordinate is one of the low-order points (any spelling).
static func is_low_order(raw32: PackedByteArray) -> bool:
	return PKeyCurve25519.is_low_order(raw32)


static func _agree_key_ok(s: String) -> bool:
	var k = _raw32(s)
	if k == null:
		return false
	var kb: PackedByteArray = k
	if (kb[31] & 0x80) != 0 or PKeyCurve25519.is_low_order(kb):
		return false
	# u < p: only the values 2^255-19 .. 2^255-1 are not (the top byte is 0x7f, the rest 0xff).
	if kb[31] == 0x7f:
		var all_ff := true
		for i in range(1, 31):
			if kb[i] != 0xff:
				all_ff = false
				break
		if all_ff and kb[0] >= 0xed:
			return false
	return true


static func _keys_value_ok(p: Dictionary, now: Variant) -> bool:
	if p.get("token_hash") != "-" or not (now is int):
		return false
	var m := _keys_re.search(String(p.get("value", "")))
	if m == null or m.get_string(1) != p.get("sign_key") or not _agree_key_ok(m.get_string(2)):
		return false
	var digits := m.get_string(3)
	if digits.length() > 16 or digits.to_int() > _MAX_SAFE_INTEGER:
		return false
	return absi(digits.to_int() - int(now)) <= KEYS_SKEW_SECONDS


## True only for a strict Ed25519 proof by `sign_key` (V5 section 12.11.1, V4 section 1.1); it
## never says why not. `now` (epoch seconds) is needed for purpose `keys`. `verify` is a test
## seam: a Callable(sig, message, key) -> bool run after the byte prechecks.
static func verify(proof: Dictionary, now: Variant = null, verify_fn: Callable = Callable()) -> bool:
	if not PURPOSES.has(proof.get("purpose")):
		return false
	var key = _raw32(proof.get("sign_key"))
	if key == null:
		return false
	var msg = message(proof)
	if msg == null:
		return false
	if proof.get("purpose") == "keys" and not _keys_value_ok(proof, now):
		return false
	var sig_text = proof.get("sig")
	if not (sig_text is String) or (sig_text as String).length() != 86:
		return false
	var sig = PKeyB64Url.decode_strict(sig_text)
	if sig == null or (sig as PackedByteArray).size() != 64:
		return false
	if not PKeyEd25519.v4_prechecks(key, sig):
		return false
	if verify_fn.is_valid():
		return verify_fn.call(sig, msg, key) == true
	return PKeyEd25519.verify(sig, msg, key)
