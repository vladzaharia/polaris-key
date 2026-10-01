# Polaris Key compact-JWS verify (WIRE-CONTRACT-V3 §1) in GDScript — feasibility port of
# packages/shared-jws/src/index.ts `verifyJws`. Same step order:
#   1. bound ENCODED segment lengths before decoding anything
#   2. header: strict base64url, <= 1024 B, duplicate-key rejection, must be an object
#   3. alg == "EdDSA", typ == expected, kid is a String present in the caller's trust set
#   4. Ed25519 over the ASCII bytes of "<h>.<p>" exactly as received
#   5. ONLY THEN decode + cap + duplicate-key-check + parse the payload
# Returns {"kid": String, "payload": Variant} or null on ANY failure.
class_name PKJws
extends RefCounted

const MAX_DOC_BYTES := 65536
const MAX_HEADER_BYTES := 1024

static var _b64url_re: RegEx


static func _b64cap(n: int) -> int:
	return int(ceil(n * 4.0 / 3.0)) + 4


## Strict base64url (unpadded, `A-Z a-z 0-9 - _` only). Returns null when invalid.
## Validation runs in native RegEx (PCRE2) so a 350 KB bundle segment costs no GDScript loop.
static func b64url_decode_strict(s: String) -> Variant:
	if _b64url_re == null:
		_b64url_re = RegEx.create_from_string("^[A-Za-z0-9_-]*$")
	if _b64url_re.search(s) == null:
		return null
	var n := s.length()
	if n % 4 == 1:
		return null  # impossible length; Marshalls would print an engine ERROR and return []
	if n == 0:
		return PackedByteArray()
	var std := s.replace("-", "+").replace("_", "/")
	match n % 4:
		2: std += "=="
		3: std += "="
	var out: PackedByteArray = Marshalls.base64_to_raw(std)
	if out.is_empty():
		return null
	return out


## Port of hasDuplicateKeys (shared-jws): tracks one key-set per open object; null for arrays.
static func has_duplicate_keys(text: String) -> bool:
	var stack: Array = []
	var expect_key := false
	var i := 0
	var n := text.length()
	while i < n:
		var c := text.unicode_at(i)
		if c == 34:  # "
			i += 1
			var start := i
			var has_escape := false
			while i < n:
				var d := text.unicode_at(i)
				if d == 92:  # backslash
					has_escape = true
					i += 2
					continue
				if d == 34:
					break
				i += 1
			var literal := text.substr(start, i - start)
			i += 1
			if expect_key:
				var top = stack.back() if not stack.is_empty() else null
				if top != null:
					var key: String = literal
					if has_escape:
						var j := JSON.new()
						if j.parse("\"" + literal + "\"") != OK or typeof(j.data) != TYPE_STRING:
							return true  # unparseable key — refuse rather than guess
						key = j.data
					if (top as Dictionary).has(key):
						return true
					(top as Dictionary)[key] = true
				expect_key = false
			continue
		if c == 123:  # {
			stack.append({})
			expect_key = true
		elif c == 91:  # [
			stack.append(null)
			expect_key = false
		elif c == 125 or c == 93:  # } ]
			if not stack.is_empty():
				stack.pop_back()
			expect_key = false
		elif c == 44:  # ,
			expect_key = not stack.is_empty() and stack.back() != null
		i += 1
	return false


static func _parse_strict_json(bytes: PackedByteArray) -> Variant:
	var text := bytes.get_string_from_utf8()
	if has_duplicate_keys(text):
		return null
	var j := JSON.new()
	if j.parse(text) != OK:
		return null
	return j.data


## trust: Dictionary kid -> base64url(raw 32-byte Ed25519 key). typ: required typ ("" = none).
static func verify(jws: String, trust: Dictionary, typ: String = "", max_payload_bytes: int = 0, fast := true) -> Variant:
	var parts := jws.split(".", true)
	if parts.size() != 3:
		return null
	var enc_header: String = parts[0]
	var enc_payload: String = parts[1]
	var enc_sig: String = parts[2]

	var payload_cap: int = max(MAX_DOC_BYTES, max_payload_bytes)
	if enc_header.length() > _b64cap(MAX_HEADER_BYTES):
		return null
	if enc_payload.length() > _b64cap(payload_cap):
		return null

	var header_bytes = b64url_decode_strict(enc_header)
	if header_bytes == null or (header_bytes as PackedByteArray).size() > MAX_HEADER_BYTES:
		return null
	var header = _parse_strict_json(header_bytes)
	if typeof(header) != TYPE_DICTIONARY:
		return null

	if not (header.get("alg") is String) or header["alg"] != "EdDSA":
		return null
	if typ != "" and (not (header.get("typ") is String) or header["typ"] != typ):
		return null
	if header.has("typ") and not (header["typ"] is String):
		return null
	if not (header.get("kid") is String):
		return null
	var kid: String = header["kid"]
	if not trust.has(kid) or not (trust[kid] is String):
		return null
	var raw_key = b64url_decode_strict(trust[kid])
	if raw_key == null or (raw_key as PackedByteArray).size() != 32:
		return null

	var sig = b64url_decode_strict(enc_sig)
	if sig == null:
		return null
	var signing_input := (enc_header + "." + enc_payload).to_ascii_buffer()
	var ok: bool
	if fast:
		ok = PKEd25519Fast.verify(sig, signing_input, raw_key)
	else:
		ok = PKEd25519Ref.verify(sig, signing_input, raw_key)
	if not ok:
		return null

	var payload_bytes = b64url_decode_strict(enc_payload)
	if payload_bytes == null or (payload_bytes as PackedByteArray).size() > payload_cap:
		return null
	var payload = _parse_strict_json(payload_bytes)
	if payload == null:
		return null
	return {"kid": kid, "payload": payload}
