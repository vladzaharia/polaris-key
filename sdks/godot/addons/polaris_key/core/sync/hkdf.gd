@tool
class_name PKeySyncHkdf
extends RefCounted
## HKDF-SHA256 (RFC 5869) over the engine's `HMACContext`, and the Cloud Sync key hierarchy of
## WIRE-CONTRACT-V5 §13.10.2. No AEAD lives here. Labels are ASCII; a label that scopes by name is
## followed by a NUL and the UTF-8 name. Every function returns a `PackedByteArray`, or an empty
## one when its arguments are unusable (an empty key, a length over 255 * 32).

const HASH_BYTES := 32
const ROOT_BYTES := 32
const KID_BYTES := 16
const VALUE_SALT_BYTES := 16
const FILE_SALT_BYTES := 32

const LABEL_KID := "pkey-sync/1 kid"
const LABEL_COLL := "pkey-sync/1 coll"
const LABEL_NAMES := "pkey-sync/1 names"
const LABEL_CHUNK_ID := "pkey-sync/1 chunk-id"
const LABEL_VALUE := "pkey-sync/1 value"
const LABEL_FILE := "pkey-sync/1 file"
const LABEL_CHUNK := "pkey-sync/1 chunk"
const LABEL_RECOVERY := "pkey-sync/1 recovery"
const LABEL_ADOPT := "pkey-sync/1 adopt"


static func sha256(data: PackedByteArray) -> PackedByteArray:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(data)
	return h.finish()


## HMAC-SHA256. An empty `key` returns an empty array (the engine refuses it).
static func hmac(key: PackedByteArray, data: PackedByteArray) -> PackedByteArray:
	if key.is_empty():
		return PackedByteArray()
	var c := HMACContext.new()
	if c.start(HashingContext.HASH_SHA256, key) != OK:
		return PackedByteArray()
	# The engine refuses an update of nothing; an empty message is a valid MAC input.
	if not data.is_empty() and c.update(data) != OK:
		return PackedByteArray()
	return c.finish()


## HKDF-SHA256. An empty `salt` is 32 zero bytes (RFC 5869 §2.2).
static func hkdf(ikm: PackedByteArray, salt: PackedByteArray, info: PackedByteArray, length: int) -> PackedByteArray:
	if length < 0 or length > 255 * HASH_BYTES:
		return PackedByteArray()
	var s := salt
	if s.is_empty():
		s.resize(HASH_BYTES)
		s.fill(0)
	var prk := hmac(s, ikm)
	if prk.is_empty():
		return PackedByteArray()
	var okm := PackedByteArray()
	var t := PackedByteArray()
	var counter := 1
	while okm.size() < length:
		var block := PackedByteArray()
		block.append_array(t)
		block.append_array(info)
		block.append(counter)
		t = hmac(prk, block)
		if t.is_empty():
			return PackedByteArray()
		okm.append_array(t)
		counter += 1
	okm.resize(length)
	return okm


## `label`, then (when `name` is not null) a NUL and the UTF-8 name.
static func info_of(label: String, name: Variant = null) -> PackedByteArray:
	var out := label.to_utf8_buffer()
	if name != null:
		out.append(0)
		out.append_array(String(name).to_utf8_buffer())
	return out


## The `kid` of a root: 16 bytes, in every envelope header, in the clear.
static func derive_kid(root: PackedByteArray) -> PackedByteArray:
	return hkdf(root, PackedByteArray(), info_of(LABEL_KID), KID_BYTES)


## `K_coll(c)`: `c` is "$settings" or the concrete collection name.
static func derive_coll_key(root: PackedByteArray, collection: String) -> PackedByteArray:
	return hkdf(root, PackedByteArray(), info_of(LABEL_COLL, collection), 32)


## `K_names`: keys every blinded name.
static func derive_names_key(root: PackedByteArray) -> PackedByteArray:
	return hkdf(root, PackedByteArray(), info_of(LABEL_NAMES), 32)


## `K_cid(c)`: keys the chunk ids of one collection.
static func derive_chunk_id_key(root: PackedByteArray, collection: String) -> PackedByteArray:
	return hkdf(root, PackedByteArray(), info_of(LABEL_CHUNK_ID, collection), 32)


## `K_msg`: one key per value, from `K_coll` and a 16-byte salt.
static func derive_value_key(coll_key: PackedByteArray, salt: PackedByteArray) -> PackedByteArray:
	return hkdf(coll_key, salt, info_of(LABEL_VALUE), 32)


## `K_file`: one key per file version, from `K_coll` and a 32-byte salt.
static func derive_file_key(coll_key: PackedByteArray, salt: PackedByteArray) -> PackedByteArray:
	return hkdf(coll_key, salt, info_of(LABEL_FILE), 32)


## `K_chunk`: one key per chunk id (its 32 raw bytes are the salt).
static func derive_chunk_key(coll_key: PackedByteArray, chunk_id: PackedByteArray) -> PackedByteArray:
	return hkdf(coll_key, chunk_id, info_of(LABEL_CHUNK), 32)


## `K_rec`: the 16-byte recovery code is the key material and the ring id text the salt.
static func derive_recovery_key(code: PackedByteArray, ring_id: String) -> PackedByteArray:
	return hkdf(code, ring_id.to_utf8_buffer(), info_of(LABEL_RECOVERY), 32)


## `K_adopt`: wraps a foreign root after an account merge.
static func derive_adopt_key(root: PackedByteArray) -> PackedByteArray:
	return hkdf(root, PackedByteArray(), info_of(LABEL_ADOPT), 32)
