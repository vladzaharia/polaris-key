class_name PKeyFakeSealer
extends PKeyRecordSealer
## An in-memory sealer for the device key store's native-sealer contract (suite_devicekeys_native):
## a keyed transform with a tag, bound to the context, standing in for a platform key. It is not
## encryption: it only has to fail the way a real sealer does.
##
##   key          the platform key (empty = never made, or destroyed)
##   fault_seal / fault_open / fault_destroy   make that call answer STORE_FAULT
##   why          unavailable()'s answer
##   calls        every call name, in order
##   made         how many keys seal() made

var key := PackedByteArray()
var fault_seal := false
var fault_open := false
var fault_destroy := false
var why := ""
var calls: Array[String] = []
var made := 0
## What hardware_backed() answers.
var hardware := false
var _id := "keystore"


func _init(p_id := "keystore") -> void:
	_id = p_id


func id() -> String:
	return _id


func hardware_backed() -> bool:
	return hardware


func unavailable() -> String:
	return why


func seal(plain: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	calls.append("seal")
	if fault_seal:
		return PKeyRecordSealer._fault("fake seal")
	if key.is_empty():
		key = Crypto.new().generate_random_bytes(32)
		made += 1
	var body := PackedByteArray()
	for i in plain.size():
		body.append(plain[i] ^ key[i % 32])
	var blob := PackedByteArray([1])
	blob.append_array(_tag(plain, context))
	blob.append_array(body)
	return PKeyResult.success(blob)


func open(blob: PackedByteArray, context: PackedByteArray) -> PKeyResult:
	calls.append("open")
	if fault_open:
		return PKeyRecordSealer._fault("fake open")
	if key.is_empty() or blob.size() < 33 or blob[0] != 1:
		return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "device keys: the record is unreadable")
	var plain := PackedByteArray()
	for i in blob.size() - 33:
		plain.append(blob[33 + i] ^ key[i % 32])
	if _tag(plain, context) != blob.slice(1, 33):
		return PKeyResult.failure(PKeyDeviceKeyStore.KEYS_UNREADABLE, "device keys: the record is unreadable")
	return PKeyResult.success(plain)


func destroy() -> PKeyResult:
	calls.append("destroy")
	if fault_destroy:
		return PKeyRecordSealer._fault("fake destroy")
	key = PackedByteArray()
	return PKeyResult.success()


func _tag(plain: PackedByteArray, context: PackedByteArray) -> PackedByteArray:
	var msg := context.duplicate()
	msg.append_array(plain)
	return Crypto.new().hmac_digest(HashingContext.HASH_SHA256, key, msg)
