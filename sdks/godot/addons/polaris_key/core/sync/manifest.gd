@tool
class_name PKeySyncManifest
extends RefCounted
## `pkey-sync-chunks/1` (WIRE-CONTRACT-V5 §13.8.3): the file of a `chunks` upload, a manifest over
## content-defined chunks. It is stored sealed as a `pkey-sync-file/1` stream; this is the
## plaintext inside.
##
##   header, 64 bytes little-endian: "PKSYNCCH", version u16 (1), recordSize u16 (48),
##     flags u32 (0), chunkCount u32, reserved u32 (0), plainSize u64, plainSha256 (32 bytes)
##   record, 48 bytes: id (32 bytes) | plainLen u32 | flags u32 (0) | reserved u64 (0)
##
## A reader refuses the first violation, in the order of the reasons below. The plaintext hash
## binds the reassembled file and is checked by whoever reassembles it; a manifest alone cannot.
##
## A manifest is `{"plain_size": int, "plain_sha256": PackedByteArray (32), "records":
## [{"id": PackedByteArray (32), "plain_len": int}]}`.
##
## `parse` answers `{"ok": true, "manifest": m}` or `{"ok": false, "reason": r}`; r is, in the
## order a reader checks: `shape`, `magic`, `version`, `recordSize`, `flags`, `reserved` (the
## header), `count` (over `SYNC_MAX_CHUNKS_PER_FILE`), `length` (the bytes), `size` (a plainSize
## over `SYNC_FILE_MAX_BYTES`), then each record in file order: `record` (its flags or reserved
## are not zero) or `chunkLen` (its length is 0 or over `SYNC_CDC_MAX_BYTES`), and last `size`
## again: the lengths do not add up to plainSize.

const MAGIC := "PKSYNCCH"
const VERSION := 1
const HEADER_BYTES := 64
const RECORD_BYTES := 48


## The manifest bytes, or an empty array for a manifest that cannot be encoded (a hash or id
## that is not 32 bytes, a negative size or length, too many records).
static func encode(m: Dictionary) -> PackedByteArray:
	var sha: PackedByteArray = m.get("plain_sha256", PackedByteArray())
	var records: Array = m.get("records", [])
	var plain_size: int = m.get("plain_size", -1)
	if sha.size() != 32 or plain_size < 0 or records.size() > PKeyConstants.SYNC_MAX_CHUNKS_PER_FILE:
		return PackedByteArray()
	var out := PackedByteArray()
	out.resize(HEADER_BYTES + RECORD_BYTES * records.size())
	out.fill(0)
	var magic := MAGIC.to_ascii_buffer()
	for i in 8:
		out[i] = magic[i]
	out.encode_u16(8, VERSION)
	out.encode_u16(10, RECORD_BYTES)
	out.encode_u32(16, records.size())
	out.encode_u64(24, plain_size)
	for i in 32:
		out[32 + i] = sha[i]
	for n in records.size():
		var r: Dictionary = records[n]
		var id: PackedByteArray = r.get("id", PackedByteArray())
		var len: int = r.get("plain_len", -1)
		if id.size() != 32 or len < 0 or len > 0xFFFFFFFF:
			return PackedByteArray()
		var at := HEADER_BYTES + RECORD_BYTES * n
		for i in 32:
			out[at + i] = id[i]
		out.encode_u32(at + 32, len)
	return out


static func parse(b: PackedByteArray) -> Dictionary:
	if b.size() < HEADER_BYTES:
		return _bad("shape")
	var magic := MAGIC.to_ascii_buffer()
	for i in 8:
		if b[i] != magic[i]:
			return _bad("magic")
	if b.decode_u16(8) != VERSION:
		return _bad("version")
	if b.decode_u16(10) != RECORD_BYTES:
		return _bad("recordSize")
	if b.decode_u32(12) != 0:
		return _bad("flags")
	if b.decode_u32(20) != 0:
		return _bad("reserved")
	var count := b.decode_u32(16)
	if count > PKeyConstants.SYNC_MAX_CHUNKS_PER_FILE:
		return _bad("count")
	if b.size() != HEADER_BYTES + RECORD_BYTES * count:
		return _bad("length")
	# A u64 above 2^63 reads negative here; both it and a size over the cap are `size`.
	var plain_size := b.decode_u64(24)
	if plain_size < 0 or plain_size > PKeyConstants.SYNC_FILE_MAX_BYTES:
		return _bad("size")
	var records := []
	var sum := 0
	for n in count:
		var at := HEADER_BYTES + RECORD_BYTES * n
		if b.decode_u32(at + 36) != 0 or b.decode_u64(at + 40) != 0:
			return _bad("record")
		var plain_len := b.decode_u32(at + 32)
		if plain_len == 0 or plain_len > PKeyConstants.SYNC_CDC_MAX_BYTES:
			return _bad("chunkLen")
		sum += plain_len
		records.append({"id": b.slice(at, at + 32), "plain_len": plain_len})
	if sum != plain_size:
		return _bad("size")
	return {"ok": true, "manifest": {"plain_size": plain_size, "plain_sha256": b.slice(32, 64), "records": records}}


static func _bad(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}
