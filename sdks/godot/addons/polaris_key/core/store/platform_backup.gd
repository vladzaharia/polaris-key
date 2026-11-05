class_name PKeyPlatformBackup
extends RefCounted
## The backed-up platform items behind silent restore (I-49) and Cloud Sync's key custody (U-39):
## the GDScript interface of PlatformBackupStore. Two named items and nothing else:
##
##   restore(product)                  {"v":1,"restoreId","secret"}
##   sync_root(product, subject, ring) the Cloud Sync root item (a JSON object, at most 4 KB)
##
## Apple (iOS, and macOS with the desktop dylib): a synchronizable Keychain item (iCloud Keychain)
## through PolarisKeyPlatform's `bk_*` ops. Anywhere else, or when the app has no backup store
## (no keychain-access-groups entitlement, no iCloud Keychain), every call answers the typed
## Unsupported result (PARITY §2.2) and the caller goes on to the next rung. Android's Block Store
## binding (I-49.14) plugs in through `_transport`; Windows, Linux and web have none.
##
## Every call is a PKeyResult. A read is success with `detail.value`, a RestoreValue or a
## Dictionary, or null when the item is absent. Nothing logs or prints a secret: RestoreValue
## redacts it in `_to_string()`, and the native reply (which carries the item text) is never kept.
## A synchronizable delete reaches every device on the Apple ID, so only sign-out calls
## delete_restore(); a failed redeem never does (I-49 §1, rung 2).

const FEATURE := PKeyConstants.Feature.IDENTITY_RESTORE
const ITEM_RESTORE := "restore"
const ITEM_SYNC := "sync"
## The most a value may hold.
const MAX_VALUE_BYTES := 4096

var apple: PKeyApple
## The keychain access group (I-49 D-7), "" for the app's own default group.
var access_group := ""


## The `{"v":1,"restoreId","secret"}` value of the restore item.
class RestoreValue:
	extends RefCounted
	var restore_id: String
	var secret: String

	func _init(p_restore_id: String, p_secret: String) -> void:
		restore_id = p_restore_id
		secret = p_secret

	func encoded() -> String:
		return JSON.stringify({"v": 1, "restoreId": restore_id, "secret": secret}, "", true)

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


func _init(p_apple: PKeyApple = null, p_access_group := "") -> void:
	apple = p_apple if p_apple != null else PKeyApple.shared()
	access_group = p_access_group


## Whether a backup store can answer here (a plugin that runs here; the entitlement is only
## known on the first call, which then answers Unsupported).
func is_available() -> bool:
	return apple != null and apple.unsupported_reason(FEATURE) == ""


# ── Restore item ─────────────────────────────────────────────────────────────────────────────

## detail.value: a RestoreValue, or null when absent or not a version-1 value.
func read_restore(product: String) -> PKeyResult:
	var r := _transport("get", ITEM_RESTORE, product, "", "", "")
	if not r.ok:
		return r
	var text = r.detail.get("value") if r.detail is Dictionary else null
	return PKeyResult.success({"value": RestoreValue.decode(text) if text is String else null})


func write_restore(product: String, restore_id: String, secret: String) -> PKeyResult:
	return _transport("set", ITEM_RESTORE, product, "", "", RestoreValue.new(restore_id, secret).encoded())


func delete_restore(product: String) -> PKeyResult:
	return _transport("delete", ITEM_RESTORE, product, "", "", "")


# ── Sync root item ───────────────────────────────────────────────────────────────────────────

## detail.value: the item's Dictionary, or null when absent.
func read_sync_root(product: String, subject: String, ring_id: String) -> PKeyResult:
	var r := _transport("get", ITEM_SYNC, product, subject, ring_id, "")
	if not r.ok:
		return r
	var text = r.detail.get("value") if r.detail is Dictionary else null
	if not (text is String):
		return PKeyResult.success({"value": null})
	var json := JSON.new()
	if json.parse(text) != OK or not (json.data is Dictionary):
		return PKeyResult.success({"value": null})
	return PKeyResult.success({"value": json.data})


func write_sync_root(product: String, subject: String, ring_id: String, value: Dictionary) -> PKeyResult:
	var text := JSON.stringify(value, "", true)
	if text.to_utf8_buffer().size() > MAX_VALUE_BYTES:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The backup item is over %d bytes." % MAX_VALUE_BYTES)
	return _transport("set", ITEM_SYNC, product, subject, ring_id, text)


func delete_sync_root(product: String, subject: String, ring_id: String) -> PKeyResult:
	return _transport("delete", ITEM_SYNC, product, subject, ring_id, "")


# ── Transport ────────────────────────────────────────────────────────────────────────────────

## One call to the platform store; the only place a platform binding is chosen. The reply of a
## read is reduced to {value: String|null} here, so nothing downstream holds the raw reply.
func _transport(verb: String, item: String, product: String, subject: String, ring_id: String, value: String) -> PKeyResult:
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
