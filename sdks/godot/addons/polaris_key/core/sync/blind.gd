@tool
class_name PKeySyncBlind
extends RefCounted
## Blinded names (WIRE-CONTRACT-V5 §13.10.3):
## `blind(kind, ctx, n) = "x:" + base64url(HMAC-SHA256(K_names, kind 0x00 ctx 0x00 n))`.
## The server compares blinded names by bytes and never learns the plaintext.

const PREFIX := "x:"
const KINDS := ["setting", "member", "record", "field", "element"]

static var _shape_re: RegEx


static func _static_init() -> void:
	_shape_re = RegEx.create_from_string("\\Ax:[A-Za-z0-9_-]{43}\\z")


## The blinded name, or "" for an unknown `kind` or a bad `root` (not 32 bytes). `n` of an element
## is its canonical JSON (`PKeySyncCanonicalJson`).
static func blind(root: PackedByteArray, kind: String, ctx: String, n: String) -> String:
	if root.size() != PKeySyncHkdf.ROOT_BYTES or not KINDS.has(kind):
		return ""
	return blind_with_key(PKeySyncHkdf.derive_names_key(root), kind, ctx, n)


## The same with `K_names` already derived (a caller blinds many names under one root).
static func blind_with_key(names_key: PackedByteArray, kind: String, ctx: String, n: String) -> String:
	var data := kind.to_utf8_buffer()
	data.append(0)
	data.append_array(ctx.to_utf8_buffer())
	data.append(0)
	data.append_array(n.to_utf8_buffer())
	var mac := PKeySyncHkdf.hmac(names_key, data)
	if mac.is_empty():
		return ""
	return PREFIX + PKeyB64Url.encode(mac)


## True for the shape of a blinded name (`^x:[A-Za-z0-9_-]{43}$`).
static func is_blinded_name(s: String) -> bool:
	return _shape_re.search(s) != null
