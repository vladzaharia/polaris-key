@tool
class_name PKeySyncEnvelope
extends RefCounted
## The `pkey-sync-value/1` envelope (WIRE-CONTRACT-V5 §13.10): `0x01 || kid(16) || salt(16) ||
## AES-256-GCM(K_msg, zero nonce, aad = the 33 header bytes, pad(canonical({"k":name,"v":value})))`.
## `K_msg` is unique per value (a fresh salt), so the fixed nonce never repeats under a key.
##
## A name is a `String` or a `PackedByteArray` of UTF-8: a merge member is `setting NUL member`
## (`member_name`), and a `String` cannot hold U+0000. Nothing here puts a root, a key or a value
## in a message; a failure is a reason from the contract.
##
## A value read back is parsed by the engine's JSON after the strict canonical pass, so a number is
## a float (and an integral one is an int only if the caller converts it) and a string value with
## U+0000 reads U+FFFD; `canonical` is the exact canonical text of the value.

const VERSION := 0x01
const HEADER_BYTES := 33
const FIXED_BYTES := 49
const PAD_BLOCK := 64
const OVERHEAD_BYTES := 113
const SALT_BYTES := 16
const _MIN_BYTES := FIXED_BYTES + PAD_BLOCK


## `setting NUL member`, the `k` of a merge member.
static func member_name(setting: String, member: String) -> PackedByteArray:
	var b := setting.to_utf8_buffer()
	b.append(0)
	b.append_array(member.to_utf8_buffer())
	return b


## The envelope, or an empty array for a bad root, a salt that is not 16 bytes, a name that is not
## UTF-8 or a value that canonical JSON refuses.
static func seal_value(root: PackedByteArray, collection: String, name: Variant, value: Variant, salt: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	if root.size() != PKeySyncHkdf.ROOT_BYTES:
		return PackedByteArray()
	var s := salt
	if s.is_empty():
		s = Crypto.new().generate_random_bytes(SALT_BYTES)
	if s.size() != SALT_BYTES:
		return PackedByteArray()
	var nb: Variant = _name_bytes(name)
	if nb == null:
		return PackedByteArray()
	var units: Variant = _units_of_utf8(nb)
	if units == null:
		return PackedByteArray()
	var kq: Variant = PKeySyncCanonicalJson.quote_units(units)
	var v := PKeySyncCanonicalJson.canonicalize_value(value)
	if kq == null or not v["ok"]:
		return PackedByteArray()
	var body := "{\"k\":".to_utf8_buffer()
	body.append_array(kq)
	body.append_array(",\"v\":".to_utf8_buffer())
	body.append_array(v["bytes"])
	body.append(125)
	var header := PackedByteArray([VERSION])
	header.append_array(PKeySyncHkdf.derive_kid(root))
	header.append_array(s)
	var key := PKeySyncHkdf.derive_value_key(PKeySyncHkdf.derive_coll_key(root, collection), s)
	var sealed := PKeySyncAesGcm.seal(key, _zero_nonce(), _pad(body), header)
	if sealed.is_empty():
		return PackedByteArray()
	header.append_array(sealed)
	return header


## Opens an envelope for `name` (or one of `aliases`, source names the catalog renamed). Answers
## `{"ok": true, "name": String, "name_bytes": PackedByteArray, "value": Variant, "canonical": String}`
## (the `k` that matched, so an alias match answers the alias) or `{"ok": false, "reason": r}`, r one
## of shape, version, kid, auth, padding, json, name. `kid` is checked before any decryption.
static func open_value(root: PackedByteArray, collection: String, name: Variant, envelope: PackedByteArray, aliases: Array = []) -> Dictionary:
	var want: Array = []
	var nb: Variant = _name_bytes(name)
	if nb == null:
		return _bad("name")
	want.append(nb)
	for a in aliases:
		var ab: Variant = _name_bytes(a)
		if ab != null:
			want.append(ab)
	return _open(root, collection, envelope, want)


## For a name the caller learns from inside (a blinded open key or merge member). The caller MUST
## check that the answered name is the one it expected before it trusts the value.
static func open_value_any_name(root: PackedByteArray, collection: String, envelope: PackedByteArray) -> Dictionary:
	return _open(root, collection, envelope, [])


static func _open(root: PackedByteArray, collection: String, env: PackedByteArray, want: Array) -> Dictionary:
	var n := env.size()
	if n < _MIN_BYTES or (n - FIXED_BYTES) % PAD_BLOCK != 0:
		return _bad("shape")
	if env[0] != VERSION:
		return _bad("version")
	if root.size() != PKeySyncHkdf.ROOT_BYTES:
		return _bad("kid")
	if not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(root), env.slice(1, 17)):
		return _bad("kid")
	var key := PKeySyncHkdf.derive_value_key(PKeySyncHkdf.derive_coll_key(root, collection), env.slice(17, HEADER_BYTES))
	var padded: Variant = PKeySyncAesGcm.open(key, _zero_nonce(), env.slice(HEADER_BYTES), env.slice(0, HEADER_BYTES))
	if padded == null:
		return _bad("auth")
	var body: Variant = _unpad(padded)
	if body == null:
		return _bad("padding")
	var raw: PackedByteArray = body
	var text := raw.get_string_from_utf8()
	# A raw NUL is not strict JSON; invalid UTF-8 is repaired by the conversion, so compare back.
	if raw.has(0) or text.to_utf8_buffer() != raw:
		return _bad("json")
	var canon := PKeySyncCanonicalJson.canonicalize_text(text)
	if not canon["ok"]:
		return _bad("json")
	var cb: PackedByteArray = canon["bytes"]
	var parsed: Variant = JSON.parse_string(cb.get_string_from_utf8())
	if not (parsed is Dictionary) or (parsed as Dictionary).size() != 2 or not (parsed as Dictionary).has("k") or not (parsed as Dictionary).has("v") or not ((parsed as Dictionary)["k"] is String):
		return _bad("json")
	# Canonical text of an object starts `{"k":"`: sorted keys put "k" first.
	var k: Variant = _read_k(cb)
	if k == null:
		return _bad("json")
	var kb: PackedByteArray = k
	if not want.is_empty():
		var hit := false
		for w in want:
			if kb == w:
				hit = true
		if not hit:
			return _bad("name")
	var vtext := PKeySyncCanonicalJson.canonicalize_value((parsed as Dictionary)["v"])
	return {"ok": true, "name": kb.get_string_from_utf8(), "name_bytes": kb, "value": (parsed as Dictionary)["v"], "canonical": vtext.get("canonical", "")}


static func _bad(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}


static func _zero_nonce() -> PackedByteArray:
	var n := PackedByteArray()
	n.resize(12)
	return n


## A `String` or a `PackedByteArray` as UTF-8 bytes, or null.
static func _name_bytes(name: Variant) -> Variant:
	if name is String:
		return (name as String).to_utf8_buffer()
	if name is PackedByteArray:
		return name
	return null


## `0x80` then zeros, to the next multiple of 64 (a full block when already aligned less one).
static func _pad(p: PackedByteArray) -> PackedByteArray:
	var out := p.duplicate()
	out.append(0x80)
	out.resize((p.size() / PAD_BLOCK) * PAD_BLOCK + PAD_BLOCK)
	return out


static func _unpad(p: PackedByteArray) -> Variant:
	var end := p.size()
	while end > 0 and p[end - 1] == 0:
		end -= 1
	if end == 0 or p[end - 1] != 0x80:
		return null
	return p.slice(0, end - 1)


## UTF-16 code units of UTF-8 bytes (U+0000 allowed), or null for invalid UTF-8.
static func _units_of_utf8(b: PackedByteArray) -> Variant:
	var u := PackedInt32Array()
	var i := 0
	var n := b.size()
	while i < n:
		var c := b[i]
		var extra := 0
		var min_cp := 0
		if c < 0x80:
			extra = 0
		elif c >= 0xC2 and c <= 0xDF:
			extra = 1
			c &= 0x1F
			min_cp = 0x80
		elif c >= 0xE0 and c <= 0xEF:
			extra = 2
			c &= 0x0F
			min_cp = 0x800
		elif c >= 0xF0 and c <= 0xF4:
			extra = 3
			c &= 0x07
			min_cp = 0x10000
		else:
			return null
		if i + extra >= n:
			return null
		for j in extra:
			var t := b[i + 1 + j]
			if t & 0xC0 != 0x80:
				return null
			c = (c << 6) | (t & 0x3F)
		if c < min_cp or c > 0x10FFFF or (c >= 0xD800 and c <= 0xDFFF):
			return null
		i += 1 + extra
		if c > 0xFFFF:
			c -= 0x10000
			u.append(0xD800 + (c >> 10))
			u.append(0xDC00 + (c & 0x3FF))
		else:
			u.append(c)
	return u


## The UTF-8 bytes of the first member's string in canonical text that starts `{"k":"`.
static func _read_k(cb: PackedByteArray) -> Variant:
	var head := "{\"k\":\"".to_utf8_buffer()
	if cb.size() < head.size() or cb.slice(0, head.size()) != head:
		return null
	var out := PackedByteArray()
	var i := head.size()
	while i < cb.size():
		var c := cb[i]
		if c == 34:
			return out
		if c == 92:
			i += 1
			if i >= cb.size():
				return null
			match cb[i]:
				34, 92, 47: out.append(cb[i])
				98: out.append(8)
				102: out.append(12)
				110: out.append(10)
				114: out.append(13)
				116: out.append(9)
				117:
					if i + 4 >= cb.size():
						return null
					var v := ("0x" + cb.slice(i + 1, i + 5).get_string_from_ascii()).hex_to_int()
					# Canonical text escapes only controls (U+0000 to U+001F).
					if v > 0x1F:
						return null
					out.append(v)
					i += 4
				_:
					return null
		else:
			out.append(c)
		i += 1
	return null
