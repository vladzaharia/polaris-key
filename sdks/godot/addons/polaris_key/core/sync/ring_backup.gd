@tool
class_name PKeySyncRingBackup
extends RefCounted
## The key ring's side of the platform backup of the Cloud Sync root (U-40.R; mirrors Swift's
## `SyncRootBackupPort` use in `SyncKeyring` and Kotlin's `RingBackup`). The item is
## `{"v":1,"ringId","epoch","kid","root"}` (the root as base64url), scoped to the product, the signed-in
## subject and the ring by PKeyPlatformBackup. Every call here is best effort: a store that is missing,
## unreadable or refusing is a miss, never a failure of a ring call (only `remove` reports one).
## The root is held as bytes and every buffer and decoded record is wiped; the plugin's text value is
## the one copy a String cannot be zeroed for. Nothing here logs, prints or returns key material in a
## message.

const VERSION := 1


## The root the backup holds for `served` ({ring_id, epoch, root_kid}), or null: no store (null `store` is
## also how the developer's switch reaches here), no subject, no item, another person or ring, an item that
## does not parse, a store that cannot be read, or a root that does not derive `kid`. A root that does not
## unwrap the ring is never trusted. The caller owns (and wipes) the bytes it gets.
static func find(store: PKeyPlatformBackup, subject: String, product: String, served: Dictionary, kid: PackedByteArray) -> Variant:
	if store == null or subject == "" or not store.is_available():
		return null
	var r: PKeyResult = await store.read_sync_root(product, subject, served["ring_id"])
	var item: Variant = r.detail.get("value") if r.ok and r.detail is Dictionary else null
	if not (item is Dictionary):
		return null
	var root: Variant = null
	if _names(item, served["ring_id"], int(served["epoch"]), served["root_kid"]) and item.get("root") is String:
		root = PKeyB64Url.decode_strict(item["root"])
	(item as Dictionary).clear()
	if not (root is PackedByteArray):
		return null
	var bytes: PackedByteArray = root
	if bytes.size() != PKeySyncHkdf.ROOT_BYTES or not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(bytes), kid):
		bytes.fill(0)
		return null
	return bytes


## Writes the root for the subject unless the same record is already there.
static func save(store: PKeyPlatformBackup, subject: String, product: String, ring_id: String, epoch: int, kid: PackedByteArray, root: PackedByteArray) -> void:
	if store == null or subject == "" or not store.is_available():
		return
	var record := {"v": VERSION, "ringId": ring_id, "epoch": epoch, "kid": kid.hex_encode(), "root": PKeyB64Url.encode(root)}
	var have: PKeyResult = await store.read_sync_root(product, subject, ring_id)
	var item: Variant = have.detail.get("value") if have.ok and have.detail is Dictionary else null
	var same: bool = item is Dictionary and _names(item, ring_id, epoch, record["kid"]) and item.get("root") == record["root"]
	if item is Dictionary:
		(item as Dictionary).clear()
	if not same:
		await store.write_sync_root(product, subject, ring_id, record)
	record.clear()


## Removes the items of `ring_ids` for the subject. No store or no subject has nothing to remove; a delete
## the store refuses is a failure (the first one), so the caller can say so.
static func remove(store: PKeyPlatformBackup, subject: String, product: String, ring_ids: Array) -> PKeyResult:
	if store == null or subject == "" or not store.is_available():
		return PKeyResult.success()
	var failure: PKeyResult = null
	for id: String in ring_ids:
		var d: PKeyResult = await store.delete_sync_root(product, subject, id)
		if not d.ok and failure == null:
			failure = PKeyResult.failure(d.code, "The platform backup of the root could not be removed.")
	return failure if failure != null else PKeyResult.success()


static func _names(item: Dictionary, ring_id: String, epoch: int, kid: String) -> bool:
	var v: Variant = item.get("v")
	var e: Variant = item.get("epoch")
	return (v is float or v is int) and int(v) == VERSION and item.get("ringId") == ring_id and item.get("kid") == kid and (e is float or e is int) and int(e) == epoch
