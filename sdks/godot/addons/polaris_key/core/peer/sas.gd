@tool
class_name PKeyPeerSas
extends RefCounted
## WIRE-CONTRACT-V5 section 15.5: the short authentication code of modes v and p, with its commit
## and reveal (CC-14.6), ported from `packages/client-core/src/peer/sas.ts`.
##
## Pure functions over bytes. Nonces and commitments travel as 43 canonical base64url characters;
## the body of SAS_COMMIT is the compact JSON object with the member `c`, SAS_NONCE `nM` and
## SAS_REVEAL `nD`. The decoders answer null for anything but the canonical spelling.

const MEMBERS := ["c", "nM", "nD"]
const VALUE_BYTES := 32
const _MAX_BODY_BYTES := 64


## `c = SHA-256(nD)`.
static func commit(n_d: PackedByteArray) -> PackedByteArray:
	return PKeySyncHkdf.sha256(n_d)


## 32 bytes as 43 base64url characters; "" for any other length.
static func encode_value(b: PackedByteArray) -> String:
	if b.size() != VALUE_BYTES:
		return ""
	return PKeyB64Url.encode(b)


## 43 canonical base64url characters to 32 bytes; anything else is null.
static func decode_value(text: String) -> Variant:
	if text.length() != 43:
		return null
	var b: Variant = PKeyB64Url.decode_strict(text)
	if b == null or (b as PackedByteArray).size() != VALUE_BYTES:
		return null
	return b


## The body of SAS_COMMIT (`c`), SAS_NONCE (`nM`) or SAS_REVEAL (`nD`): compact JSON, one member.
## Empty for a member that is not one of those or a value that is not 32 bytes.
static func body(member: String, value: PackedByteArray) -> PackedByteArray:
	if not MEMBERS.has(member) or value.size() != VALUE_BYTES:
		return PackedByteArray()
	return ('{"%s":"%s"}' % [member, encode_value(value)]).to_utf8_buffer()


## Read a body; null when it is anything but the canonical one-member object.
static func parse_body(member: String, bytes: PackedByteArray) -> Variant:
	if not MEMBERS.has(member) or bytes.size() > _MAX_BODY_BYTES or bytes.has(0):
		return null
	var text := bytes.get_string_from_utf8()
	var prefix := '{"%s":"' % member
	if not text.begins_with(prefix) or not text.ends_with('"}'):
		return null
	if text.length() != prefix.length() + 43 + 2:
		return null
	return decode_value(text.substr(prefix.length(), 43))


## The code, 0 to 999999, from the Noise handshake hash and both nonces.
static func value(
		h: PackedByteArray, n_d: PackedByteArray, n_m: PackedByteArray, mode: String) -> int:
	var info := "pkey-peer/1 sas".to_utf8_buffer()
	info.append(0)
	info.append_array(mode.to_utf8_buffer())
	var okm := PKeySyncHkdf.hkdf(n_d + n_m, h, info, 32)
	if okm.size() < 4:
		return -1
	return ((okm[0] << 24) | (okm[1] << 16) | (okm[2] << 8) | okm[3]) % 1000000


## Six digits with leading zeros, a space between the triples.
static func display(n: int) -> String:
	var s := "%06d" % n
	return "%s %s" % [s.substr(0, 3), s.substr(3)]


## Does the revealed nonce match the commitment? Both are the base64url spelling.
static func reveal_ok(c: String, n_d: String) -> bool:
	var commitment: Variant = decode_value(c)
	var nonce: Variant = decode_value(n_d)
	if commitment == null or nonce == null:
		return false
	var h := PKeySyncHkdf.sha256(nonce)
	var diff := 0
	for i in VALUE_BYTES:
		diff |= h[i] ^ (commitment as PackedByteArray)[i]
	return diff == 0
