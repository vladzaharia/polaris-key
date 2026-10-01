class_name PKeyDeviceId
extends RefCounted
## The device id (fingerprint.json `deviceIds`; sdk-node `devices/deviceId.ts`):
##
##   deviceId = base64url(sha256(utf8("pkey-device:<slug>:<raw>")))[0:32]
##
## The raw value is hashed on the device and never transmitted (AGENTS.md rule 7). The default
## raw source is `OS.get_unique_id()` (`/etc/machine-id`, ANDROID_ID, identifierForVendor, the
## macOS serial, a Windows hardware-profile GUID); where it is empty (web) or fails, a random
## 16-byte UUID, which is only stable as long as the store keeps the written id. P1-05 installs
## the desktop sources that agree with Node and Swift (`set_raw_source`).

## A Callable returning the raw identifier String ("" when unavailable), or empty for the default.
static var _raw_source: Callable


static func from_raw(slug: String, raw: String) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-device:%s:%s" % [slug, raw]).to_utf8_buffer())
	return PKeyB64Url.encode(ctx.finish()).substr(0, 32)


## Replace the raw source (P1-05). An empty Callable restores the default.
static func set_raw_source(source: Callable) -> void:
	_raw_source = source


## The raw identifier from the installed source, else the default. Never empty.
static func raw() -> String:
	var r := ""
	if _raw_source.is_valid():
		var v = _raw_source.call()
		r = v if v is String else ""
	elif not OS.has_feature("web"):
		r = OS.get_unique_id()
	return r if r != "" else random_uuid()


## A fresh id for `slug` from the raw source.
static func derive(slug: String) -> String:
	return from_raw(slug, raw())


## A random RFC 4122 version-4 UUID string.
static func random_uuid() -> String:
	var b := Crypto.new().generate_random_bytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20, 12)]


## A plausible stored id: 32 base64url characters (the register route's `^[A-Za-z0-9_-]{32}$`).
static func is_well_formed(id: String) -> bool:
	if id.length() != 32:
		return false
	return PKeyB64Url.decode_strict(id) != null
