@tool
class_name PKeyPeerAdvert
extends RefCounted
## WIRE-CONTRACT-V5 section 15.4: discovery adverts of `pkey-peer/1` (CC-14.6), ported from
## `packages/client-core/src/peer/advert.ts`.
##
## Pure functions over bytes and a clock; nothing here does I/O. The account instance name, the
## product tag, TXT parsing and the browse match. Results are Dictionaries: `parse_txt` answers
## {ok = true, mode, h?} or {ok = false, reason} (`duplicate`, `version`, `mode`, `tag`);
## `browse_account_instance` answers {} for no match, otherwise {device_id, epoch_back (0 the
## current epoch, 1 the previous one), key_index (0 the newest discovery key, 1 the previous)}.

const ADVERT_EPOCH_SECONDS := 900
## A roster holds at most 128 devices, so a browse is at most 4 x 128 = 512 HMACs.
const MAX_BROWSE_ROSTER := 128
const MAX_BROWSE_KEYS := 2
const _BASE32 := "abcdefghijklmnopqrstuvwxyz234567"

static var _device_re: RegEx
static var _instance_re: RegEx
static var _tag_re: RegEx


static func _static_init() -> void:
	_device_re = PKeyClaims.whole("[A-Za-z0-9_-]{32}")
	_instance_re = PKeyClaims.whole("p1-[a-z2-7]{16}")
	_tag_re = PKeyClaims.whole("[0-9a-f]{16}")


static func advert_epoch(now_seconds: int) -> int:
	return floori(float(now_seconds) / ADVERT_EPOCH_SECONDS)


## RFC 4648 base32, lower-case alphabet, no padding.
static func base32_lower(b: PackedByteArray) -> String:
	var bits := 0
	var acc := 0
	var out := ""
	for x in b:
		acc = (acc << 8) | x
		bits += 8
		while bits >= 5:
			out += _BASE32[(acc >> (bits - 5)) & 31]
			bits -= 5
		acc &= (1 << bits) - 1
	if bits > 0:
		out += _BASE32[(acc << (5 - bits)) & 31]
	return out


## A device id is 32 base64url characters: the 24 bytes the advert and the relay use. Null when
## `id` is not one.
static func device_id_bytes(id: String) -> Variant:
	if not PKeyClaims.matches_whole_re(_device_re, id):
		return null
	return PKeyB64Url.decode_strict(id)


## The mode-a instance name of a device in one epoch under one discovery key. "" for a device id
## that is not 32 base64url characters.
static func account_instance(disc_key: PackedByteArray, epoch: int, device_id: String) -> String:
	var id: Variant = device_id_bytes(device_id)
	if id == null:
		return ""
	var data := "pkey-peer/1 disc".to_utf8_buffer()
	data.append(0)
	data.append_array(_u64be(epoch))
	data.append_array(id)
	var mac := PKeySyncHkdf.hmac(disc_key, data)
	if mac.is_empty():
		return ""
	return "p1-" + base32_lower(mac).substr(0, 16)


## The `h` TXT value of the approver and pair adverts.
static func product_tag(slug: String, epoch: int) -> String:
	var seed := "pkey-peer/1 salt".to_utf8_buffer()
	seed.append(0)
	seed.append_array(slug.to_utf8_buffer())
	var salt := PKeySyncHkdf.sha256(seed)
	var data := "pkey-peer/1 pair".to_utf8_buffer()
	data.append(0)
	data.append_array(_u64be(epoch))
	return PKeySyncHkdf.hmac(salt, data).hex_encode().substr(0, 16)


static func is_instance_name(name: String) -> bool:
	return PKeyClaims.matches_whole_re(_instance_re, name)


## An entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated
## key refuses.
static func parse_txt(entries: Array) -> Dictionary:
	var kv := {}
	for e in entries:
		if not e is String:
			continue
		var entry: String = e
		var at := entry.find("=")
		if at < 1:
			continue
		var k := entry.substr(0, at)
		if kv.has(k):
			return {"ok": false, "reason": "duplicate"}
		kv[k] = entry.substr(at + 1)
	if kv.get("v") != "1":
		return {"ok": false, "reason": "version"}
	var m: Variant = kv.get("m")
	if m != "a" and m != "v" and m != "p":
		return {"ok": false, "reason": "mode"}
	if m == "a":
		return {"ok": true, "mode": "a"}
	var h: Variant = kv.get("h")
	if h == null or not PKeyClaims.matches_whole_re(_tag_re, h):
		return {"ok": false, "reason": "tag"}
	return {"ok": true, "mode": m, "h": h}


## Which roster device an account instance belongs to: the current and the previous epoch, the (at
## most two) delivered keys, newest first. At most 512 HMACs for a 128-device roster. {} for none.
static func browse_account_instance(
		instance: String, disc_keys: Array, now_seconds: int, roster: Array) -> Dictionary:
	if not is_instance_name(instance):
		return {}
	var epoch := advert_epoch(now_seconds)
	for epoch_back in 2:
		for i in mini(disc_keys.size(), MAX_BROWSE_KEYS):
			for device_id in roster.slice(0, MAX_BROWSE_ROSTER):
				var name := account_instance(disc_keys[i], epoch - epoch_back, String(device_id))
				if name == instance:
					return {"device_id": String(device_id), "epoch_back": epoch_back, "key_index": i}
	return {}


static func _u64be(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(8)
	for i in 8:
		b[i] = (n >> (56 - 8 * i)) & 0xff
	return b
