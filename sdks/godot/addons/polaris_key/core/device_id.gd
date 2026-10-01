class_name PKeyDeviceId
extends RefCounted
## The device id (fingerprint.json `deviceIds`; sdk-node `devices/deviceId.ts`):
##
##   deviceId = base64url(sha256(utf8("pkey-device:<slug>:<raw>")))[0:32]
##
## The raw value is hashed on the device and never transmitted (AGENTS.md rule 7). The default
## raw source is `PKeyFingerprint.device_id_raw()`: on the desktop the SAME value Node and Swift
## hash (MachineGuid on Windows, IOPlatformUUID on macOS, the rule-2 machine-id on Linux), and
## `OS.get_unique_id()` elsewhere (ANDROID_ID, identifierForVendor) or where those cannot be read.
## Where nothing is readable (web), a random 16-byte UUID, which is only stable as long as the
## store keeps the written id. `set_raw_source` replaces the default (a host, or tests).
##
## The desktop read runs a command, so Core calls `prepare()` (a WorkerThreadPool task) before
## a store that holds no id derives one; `raw()` then returns the prepared value.

## A Callable returning the raw identifier String ("" when unavailable), or empty for the default.
static var _raw_source: Callable
## The value `prepare()` read from the current source, or "" when none is prepared.
static var _prepared := ""


static func from_raw(slug: String, raw: String) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-device:%s:%s" % [slug, raw]).to_utf8_buffer())
	return PKeyB64Url.encode(ctx.finish()).substr(0, 32)


## Replace the raw source. An empty Callable restores the default. Drops a prepared value.
static func set_raw_source(source: Callable) -> void:
	_raw_source = source
	_prepared = ""


## The raw identifier from the installed source (or the prepared read of it), else a random
## UUID. Never empty.
static func raw() -> String:
	var r := _prepared if _prepared != "" else _read_source()
	return r if r != "" else random_uuid()


static func _read_source() -> String:
	if _raw_source.is_valid():
		var v = _raw_source.call()
		return v if v is String else ""
	return PKeyFingerprint.device_id_raw()


## Read the raw source once off the main thread (where the build has threads) and keep it for
## `raw()`, so first-launch derivation never runs a command on the main thread. A coroutine.
static func prepare() -> void:
	if _prepared != "":
		return
	var tree := Engine.get_main_loop() as SceneTree
	if not OS.has_feature("threads") or OS.has_feature("web") or tree == null:
		_prepared = _read_source()
		return
	var box: Array = []
	var id := WorkerThreadPool.add_task(func() -> void: box.append(_read_source()), false, "PolarisKey device id")
	while not WorkerThreadPool.is_task_completed(id):
		await tree.process_frame
	WorkerThreadPool.wait_for_task_completion(id)
	if not box.is_empty() and box[0] is String:
		_prepared = box[0]


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
