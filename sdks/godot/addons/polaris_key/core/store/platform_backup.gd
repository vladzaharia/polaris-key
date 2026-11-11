class_name PKeyPlatformBackup
extends RefCounted
## The backed-up platform items behind silent restore (I-49) and Cloud Sync's key custody (U-39):
## the GDScript interface of PlatformBackupStore. Two named items and nothing else:
##
##   restore(product)                  {"v":1,"restoreId","secret"}
##   sync_root(product, subject, ring) the Cloud Sync root item (a JSON object, at most 4 KB)
##
## Apple (iOS, and macOS with the desktop dylib): a synchronizable Keychain item (iCloud Keychain)
## through PolarisKeyPlatform's `bk_*` ops. Android: Block Store through the plugin's `bk_*` ops
## (I-49.14): one entry per product for each item, so the sync root's value carries the subject and the
## ring id itself (`{"v":1,"subject","ringId","epoch","kid","root"}`, as Kotlin's). Anywhere else, or when the app has no backup store (no keychain-access-groups
## entitlement, no iCloud Keychain, a direct Android build, no Play services), every call answers the
## typed Unsupported result (PARITY §2.2) and the caller goes on to the next rung. Windows, Linux and
## web have none. Every call is a coroutine (the Android ops are asynchronous): await it.
##
## Every call is a PKeyResult. A read is success with `detail.value`, a RestoreValue or a
## Dictionary, or null when the item is absent. Nothing logs or prints a secret: RestoreValue
## redacts it in `_to_string()`, holds the secret as bytes that `wipe()` zeroes in place, and the
## native reply (which carries the item text) is never kept. (A String cannot be zeroed in GDScript;
## the text that crosses the plugin boundary is the one copy this layer cannot reach.)
## A synchronizable delete reaches every device on the Apple ID, so only sign-out calls
## delete_restore(); a failed redeem never does (I-49 §1, rung 2).

const FEATURE := PKeyConstants.Feature.IDENTITY_RESTORE
const ITEM_RESTORE := "restore"
const ITEM_SYNC := "sync"
## The most a value may hold.
const MAX_VALUE_BYTES := 4096

var apple: PKeyApple
## The Android facade; null where the platform is not Android and none was given.
var android: PKeyAndroid = null
## The keychain access group (I-49 D-7), "" for the app's own default group.
var access_group := ""


## The `{"v":1,"restoreId","secret"}` value of the restore item. The secret is held as bytes so the
## holder can zero the very buffer when it is done with it (`wipe()`); `secret_bytes()` answers that
## buffer itself, not a copy.
class RestoreValue:
	extends RefCounted
	var restore_id: String
	var _secret := PackedByteArray()

	func _init(p_restore_id: String, p_secret: String) -> void:
		restore_id = p_restore_id
		_secret = p_secret.to_utf8_buffer()

	## The secret's bytes (the held buffer). Use it, then `wipe()`.
	func secret_bytes() -> PackedByteArray:
		return _secret

	## Zero the held secret in place. After this the value is spent: it encodes an empty secret.
	func wipe() -> void:
		_secret.fill(0)

	func is_wiped() -> bool:
		return _secret.count(0) == _secret.size()

	func encoded() -> String:
		return JSON.stringify({"v": 1, "restoreId": restore_id, "secret": _secret.get_string_from_utf8()}, "", true)

	## null for anything but a version-1 object with two non-empty strings.
	static func decode(text: String) -> RestoreValue:
		var json := JSON.new()
		if json.parse(text) != OK or not (json.data is Dictionary):
			return null
		var d: Dictionary = json.data
		if not (d.get("v") is float or d.get("v") is int) or int(d["v"]) != 1:
			return null
		if not (d.get("restoreId") is String) or not (d.get("secret") is String) or d["restoreId"] == "" or d["secret"] == "":
			return null
		return RestoreValue.new(d["restoreId"], d["secret"])

	func _to_string() -> String:
		return "RestoreValue(restoreId: %s, secret: <redacted>)" % restore_id


func _init(p_apple: PKeyApple = null, p_access_group := "", p_android: PKeyAndroid = null) -> void:
	apple = p_apple if p_apple != null else PKeyApple.shared()
	android = p_android
	access_group = p_access_group


## Whether a backup store can answer here (a plugin that runs here; the entitlement or Play services
## are only known on the first call, which then answers Unsupported).
func is_available() -> bool:
	return _uses_android() or (apple != null and apple.unsupported_reason(FEATURE) == "")


## Whether a refused redeem deletes the local item (Android's, which only this device holds). An
## Apple delete is synchronizable and reaches every device, so it never does.
func deletes_on_refusal() -> bool:
	return _uses_android()


func _uses_android() -> bool:
	if android == null:
		return false
	return apple == null or apple.unsupported_reason(FEATURE) != ""


# ── Restore item ─────────────────────────────────────────────────────────────────────────────

## detail.value: a RestoreValue, or null when absent or not a version-1 value.
func read_restore(product: String) -> PKeyResult:
	var r := await _transport("get", ITEM_RESTORE, product, "", "", "")
	if not r.ok:
		return r
	var text = r.detail.get("value") if r.detail is Dictionary else null
	return PKeyResult.success({"value": RestoreValue.decode(text) if text is String else null})


func write_restore(product: String, restore_id: String, secret: String) -> PKeyResult:
	return await _transport("set", ITEM_RESTORE, product, "", "", RestoreValue.new(restore_id, secret).encoded())


func delete_restore(product: String) -> PKeyResult:
	return await _transport("delete", ITEM_RESTORE, product, "", "", "")


# ── Sync root item ───────────────────────────────────────────────────────────────────────────

## detail.value: the item's Dictionary, or null when absent, unreadable as an object, or (Android, where
## one entry holds one person's one ring) for another subject or ring. The caller wipes what it decodes.
func read_sync_root(product: String, subject: String, ring_id: String) -> PKeyResult:
	var r := await _transport("get", ITEM_SYNC, product, subject, ring_id, "")
	if not r.ok:
		return r
	var item := _sync_object(r.detail.get("value") if r.detail is Dictionary else null)
	if item != null and _uses_android() and (item.get("subject") != subject or item.get("ringId") != ring_id):
		item = null
	return PKeyResult.success({"value": item})


## Writes the item. On Android the entry is the product's only one, so another person's entry is left
## alone (success, nothing written), and a failed write removes an entry for another ring (it names a
## ring that no longer stands).
func write_sync_root(product: String, subject: String, ring_id: String, value: Dictionary) -> PKeyResult:
	var body := value
	var current: Variant = null
	if _uses_android():
		var held := await _transport("get", ITEM_SYNC, product, subject, ring_id, "")
		current = _sync_object(held.detail.get("value") if held.ok and held.detail is Dictionary else null)
		if current != null and current.get("subject") != subject:
			return PKeyResult.success()
		body = value.duplicate()
		body["subject"] = subject
		body["ringId"] = ring_id
	var text := JSON.stringify(body, "", true)
	if text.to_utf8_buffer().size() > MAX_VALUE_BYTES:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The backup item is over %d bytes." % MAX_VALUE_BYTES)
	var w := await _transport("set", ITEM_SYNC, product, subject, ring_id, text)
	if not w.ok and current != null and current.get("ringId") != ring_id:
		await _transport("delete", ITEM_SYNC, product, subject, ring_id, "")
	return w


func delete_sync_root(product: String, subject: String, ring_id: String) -> PKeyResult:
	return await _transport("delete", ITEM_SYNC, product, subject, ring_id, "")


static func _sync_object(text: Variant) -> Variant:
	if not (text is String):
		return null
	var json := JSON.new()
	if json.parse(text) != OK or not (json.data is Dictionary):
		return null
	return json.data


# ── Transport ────────────────────────────────────────────────────────────────────────────────

## One call to the platform store; the only place a platform binding is chosen. The reply of a
## read is reduced to {value: String|null} here, so nothing downstream holds the raw reply.
func _transport(verb: String, item: String, product: String, subject: String, ring_id: String, value: String) -> PKeyResult:
	if _uses_android():
		return await _android_transport(verb, item, product, value)
	if apple == null:
		return PKeyResult.unsupported(FEATURE, PKeyConstants.UnsupportedReason.RUNTIME)
	var r: PKeyResult
	match verb:
		"get":
			r = apple.backup_get(item, product, subject, ring_id, access_group)
			if r.ok:
				return PKeyResult.success({"value": r.detail.get("value") if r.detail is Dictionary else null})
		"set":
			r = apple.backup_set(item, product, value, subject, ring_id, access_group)
		_:
			r = apple.backup_delete(item, product, subject, ring_id, access_group)
	return PKeyResult.success() if r.ok else r


## The Android plugin's ops: one Block Store entry per product for each item (`kind` "restore" or "sync").
func _android_transport(verb: String, item: String, product: String, value: String) -> PKeyResult:
	match verb:
		"get":
			var r := await android.backup_get(item, product)
			if not r.ok:
				return r
			return PKeyResult.success({"value": r.detail.get("value") if r.detail is Dictionary else null})
		"set":
			var w := await android.backup_set(item, product, value)
			return PKeyResult.success() if w.ok else w
	var d := await android.backup_delete(item, product)
	return PKeyResult.success() if d.ok else d
