@tool
class_name PKeySyncRecoveryCode
extends RefCounted
## The recovery code text (WIRE-CONTRACT-V5 §13.11.4): 16 random bytes and the first 4 bytes of
## their SHA-256, 160 bits as 32 Crockford base32 characters shown as 8 groups of 4. Text only:
## the `recovery.ct` blob needs an AEAD and lives with the envelope work. The code is a secret:
## nothing here logs it or keeps it.

const CODE_BYTES := 16
const CHECKSUM_BYTES := 4
const CODE_CHARS := 32
## The client error code for a bad checksum or a failed unwrap.
const INVALID := "recovery-code-invalid"
const _ALPHABET := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


## A fresh code from the engine's CSPRNG.
static func new_code() -> PackedByteArray:
	return Crypto.new().generate_random_bytes(CODE_BYTES)


static func _with_checksum(code: PackedByteArray) -> PackedByteArray:
	var out := code.duplicate()
	out.append_array(PKeySyncHkdf.sha256(code).slice(0, CHECKSUM_BYTES))
	return out


## The text shown to the person: 8 groups of 4, upper case, joined by hyphens. "" when `code` is
## not 16 bytes.
static func encode(code: PackedByteArray) -> String:
	if code.size() != CODE_BYTES:
		return ""
	var bytes := _with_checksum(code)
	var chars := ""
	var acc := 0
	var bits := 0
	for b in bytes:
		acc = (acc << 8) | b
		bits += 8
		while bits >= 5:
			chars += _ALPHABET[(acc >> (bits - 5)) & 31]
			bits -= 5
		acc &= (1 << bits) - 1
	var groups := PackedStringArray()
	for i in range(0, CODE_CHARS, 4):
		groups.append(chars.substr(i, 4))
	return "-".join(groups)


## The code's 16 bytes in a typed or pasted string, or `null`. It ignores case, white space and
## hyphens, maps `I` and `L` to `1` and `O` to `0`, and checks the length, the alphabet and the
## checksum (in constant time). Any non-ASCII character is a refusal.
static func parse(text: String) -> Variant:
	var clean := ""
	for i in text.length():
		var c := text.unicode_at(i)
		if c == 45 or _is_space(c):
			continue
		if c >= 97 and c <= 122:
			c -= 32
		if c == 73 or c == 76:  # I, L
			c = 49
		elif c == 79:  # O
			c = 48
		if c > 127:
			return null
		clean += char(c)
	if clean.length() != CODE_CHARS:
		return null
	var bytes := PackedByteArray()
	var acc := 0
	var bits := 0
	for i in CODE_CHARS:
		var v := _ALPHABET.find(clean[i])
		if v < 0:
			return null
		acc = (acc << 5) | v
		bits += 5
		if bits >= 8:
			bytes.append((acc >> (bits - 8)) & 0xff)
			bits -= 8
			acc &= (1 << bits) - 1
	var code := bytes.slice(0, CODE_BYTES)
	var want := _with_checksum(code)
	var diff := 0
	for i in range(CODE_BYTES, CODE_BYTES + CHECKSUM_BYTES):
		diff |= bytes[i] ^ want[i]
	return code if diff == 0 else null


## The white space of ECMAScript `\s`, which the other SDKs strip.
static func _is_space(c: int) -> bool:
	return (c >= 9 and c <= 13) or c == 32 or c == 0xA0 or c == 0x1680 \
			or (c >= 0x2000 and c <= 0x200A) or c == 0x2028 or c == 0x2029 \
			or c == 0x202F or c == 0x205F or c == 0x3000 or c == 0xFEFF
