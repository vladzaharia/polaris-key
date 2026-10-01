@tool
class_name PKeyB64Url
extends RefCounted
## base64url (RFC 4648 §5) for the wire (WIRE-CONTRACT-V3 §1).
##
## `decode_strict` is the only decoder a JWS segment ever sees: the unpadded alphabet
## `A-Z a-z 0-9 - _` and nothing else, checked BEFORE Marshalls touches the text, because
## mbedTLS skips whitespace and Marshalls wants standard padded base64 (notes/A5 §2e). The
## order is: alphabet, then `len % 4 == 1` (an impossible length; Marshalls would print an engine
## ERROR), then map `-_` to `+/`, pad, decode. The patterns anchor with `\A…\z`: PCRE's `$`
## also matches before a final newline, which JS's does not, so `^…$` would pass "<segment>\n".
##
## `decode_lenient` is for trust-set keys only (packages/shared-jws `base64UrlDecode`, which uses
## `atob`): it also accepts the standard alphabet, `=` padding and ASCII whitespace.

static var _strict_re: RegEx
static var _lenient_re: RegEx
static var _ws_re: RegEx


static func _static_init() -> void:
	_strict_re = RegEx.create_from_string("\\A[A-Za-z0-9_-]*\\z")
	_lenient_re = RegEx.create_from_string("\\A[A-Za-z0-9+/]*\\z")
	_ws_re = RegEx.create_from_string("[\\t\\n\\f\\r ]+")


## Strict base64url. Returns a PackedByteArray, or null when the text is not strict base64url.
static func decode_strict(s: String) -> Variant:
	if _strict_re.search(s) == null:
		return null
	return _decode_mapped(s.replace("-", "+").replace("_", "/"))


## Lenient decode for trust-set keys, exactly as shared-jws `base64UrlDecode` does it: map `-_`
## to `+/`, pad to a multiple of four, then WHATWG forgiving-base64 (`atob`): strip ASCII
## whitespace, drop one or two trailing `=` from a length that divides by four, refuse a length
## of 1 mod 4 and anything outside the standard alphabet.
static func decode_lenient(s: String) -> Variant:
	var b64 := s.replace("-", "+").replace("_", "/")
	var data := _ws_re.sub(b64 + "=".repeat((4 - b64.length() % 4) % 4), "", true)
	if data.length() % 4 == 0:
		if data.ends_with("=="):
			data = data.substr(0, data.length() - 2)
		elif data.ends_with("="):
			data = data.substr(0, data.length() - 1)
	if _lenient_re.search(data) == null:
		return null
	return _decode_mapped(data)


## Unpadded base64url of `bytes`.
static func encode(bytes: PackedByteArray) -> String:
	if bytes.is_empty():
		return ""
	return Marshalls.raw_to_base64(bytes).replace("+", "-").replace("/", "_").rstrip("=")


static func _decode_mapped(std: String) -> Variant:
	var n := std.length()
	if n % 4 == 1:
		return null
	if n == 0:
		return PackedByteArray()
	match n % 4:
		2:
			std += "=="
		3:
			std += "="
	var out: PackedByteArray = Marshalls.base64_to_raw(std)
	if out.is_empty():
		return null
	return out
