@tool
class_name PKeyZipStore
extends RefCounted
## A streaming STORED zip32 writer for the Cloud Sync export (WIRE-CONTRACT-V5 section 13.12). A port of
## Python `ZipStoreWriter` and client-core `zipStore.ts`.
##
## The engine's `ZIPPacker` is not used: it writes each entry with its sizes in the local header (so it
## needs the whole entry first), with its own extra fields, and lists the central directory in the order
## written. The export streams entries of unknown size, writes the files before the records that cite
## their size and hash, and lists the entries in the order of section 13.12, so the layout is written
## here: per entry a 30-byte local header (bit 3 set, sizes zero), the data, a 16-byte data descriptor and
## a 46-byte central directory record; then the end record. UTF-8 names (bit 11), a fixed DOS date, no
## extra field, no comment, no zip64. That is the layout the overhead formula of 13.12 counts.
##
## Memory: the caller's piece and one central record per entry. CRC-32 runs per piece, off the main thread
## for a big one (a GDScript table loop takes about 25 ms a MiB).
##
## A write that would take the archive past zip32 (4 GiB - 1 for data, descriptors, central directory and
## end record together, or 65,535 entries) is refused with `sync-export-too-large` before it reaches the
## sink. A sink that answers false from `write` fails the writer with `destination`. `error` holds the
## first refusal, `{code, reason}`, after which every call answers false and writes nothing.

const Support := preload("res://addons/polaris_key/services/cloud_sync/transfer_support.gd")
const MAX_U32 := 0xFFFFFFFF
const MAX_ENTRIES := 0xFFFF
## 1980-01-01 00:00:00: an archive never says when it was made.
const DOS_TIME := 0
const DOS_DATE := 0x0021
## Bit 3 (sizes and CRC follow the data) and bit 11 (UTF-8 names).
const FLAGS := 0x0808
const VERSION := 20
const _LOCAL_SIG := 0x04034B50
const _DESCRIPTOR_SIG := 0x08074B50
const _CENTRAL_SIG := 0x02014B50
const _END_SIG := 0x06054B50
## A CRC piece at least this long runs on a worker thread.
const _THREAD_MIN_BYTES := 65536

static var _table := PackedInt64Array()

## The first refusal: `{code, reason}` (empty while none).
var error: Dictionary = {}

var _sink: Object
var _limit: int
var _offset := 0
var _done: Array = []
var _names := {}
var _cur: Dictionary = {}
var _finished := false
## What the archive still needs after the data written so far: the central records of the entries done, the
## open entry's descriptor and central record, and the end record.
var _reserve := PKeyConstants.SYNC_EXPORT_ZIP_END_BYTES



## `sink.write(bytes: PackedByteArray) -> bool`. `limit` is the zip32 ceiling (tests lower it).
func _init(sink: Object, limit := MAX_U32) -> void:
	_sink = sink
	_limit = limit
	# Built here, on the calling thread: a worker thread only reads it.
	_crc_table()


func bytes_written() -> int:
	return _offset


## The CRC-32 table, built once (entries are non-negative 64-bit ints so the loop never sign-extends).
static func _crc_table() -> PackedInt64Array:
	if _table.is_empty():
		var t := PackedInt64Array()
		t.resize(256)
		for n in 256:
			var c := n
			for _k in 8:
				c = (0xEDB88320 ^ (c >> 1)) if (c & 1) != 0 else (c >> 1)
			t[n] = c
		_table = t
	return _table


## The running CRC-32 state after `data`: start from 0xFFFFFFFF and take `crc32_final` of the last state.
static func crc32_update(state: int, data: PackedByteArray) -> int:
	var table := _crc_table()
	var crc := state
	for b in data:
		crc = table[(crc ^ b) & 255] ^ (crc >> 8)
	return crc


static func crc32_final(state: int) -> int:
	return state ^ 0xFFFFFFFF


func _fail(code: String, reason := "") -> bool:
	if error.is_empty():
		error = {"code": code, "reason": reason}
	return false


func _too_large() -> bool:
	return _fail(PKeyConstants.ErrorCode.SYNC_EXPORT_TOO_LARGE)


func _emit(b: PackedByteArray) -> bool:
	_offset += b.size()
	if not _sink.write(b):
		return _fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "destination")
	return true


## Opens an entry. False (and `error` set) on a name that is empty, over 65,535 bytes or repeated (a
## programming error: reason `internal`), the entry count or the size limit.
func begin(name: String) -> bool:
	if not error.is_empty():
		return false
	var raw := name.to_utf8_buffer()
	if _finished or not _cur.is_empty() or raw.is_empty() or raw.size() > 0xFFFF or _names.has(name):
		return _fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
	if _done.size() + 1 > MAX_ENTRIES:
		return _too_large()
	var need := 30 + raw.size() + (PKeyConstants.SYNC_EXPORT_ZIP_ENTRY_BYTES - 30) + raw.size()
	if _offset + need + _reserve > _limit:
		return _too_large()
	var header := PackedByteArray()
	header.resize(30)
	header.encode_u32(0, _LOCAL_SIG)
	header.encode_u16(4, VERSION)
	header.encode_u16(6, FLAGS)
	header.encode_u16(8, 0)
	header.encode_u16(10, DOS_TIME)
	header.encode_u16(12, DOS_DATE)
	header.encode_u32(14, 0)
	header.encode_u32(18, 0)
	header.encode_u32(22, 0)
	header.encode_u16(26, raw.size())
	header.encode_u16(28, 0)
	_reserve += 16 + 46 + raw.size()
	_names[name] = true
	_cur = {"name": name, "raw": raw, "offset": _offset, "crc": 0xFFFFFFFF, "size": 0}
	header.append_array(raw)
	return _emit(header)


## Appends to the open entry. A coroutine: a big piece's CRC runs on a worker thread.
func write(data: PackedByteArray) -> bool:
	if not error.is_empty():
		return false
	if _cur.is_empty() or _finished:
		return _fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
	if data.is_empty():
		return true
	if _offset + data.size() + _reserve > _limit:
		return _too_large()
	var state: int = _cur["crc"]
	if data.size() >= _THREAD_MIN_BYTES:
		_cur["crc"] = await Support.off_thread(func() -> int: return crc32_update(state, data), data.size())
	else:
		_cur["crc"] = crc32_update(state, data)
	_cur["size"] += data.size()
	return _emit(data)


func end() -> bool:
	if not error.is_empty():
		return false
	if _cur.is_empty():
		return _fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
	# The descriptor's 16 bytes were reserved at `begin`.
	_reserve -= 16
	var c := _cur
	_cur = {}
	c["crc"] = crc32_final(c["crc"])
	_done.append(c)
	var d := PackedByteArray()
	d.resize(16)
	d.encode_u32(0, _DESCRIPTOR_SIG)
	d.encode_u32(4, c["crc"])
	d.encode_u32(8, c["size"])
	d.encode_u32(12, c["size"])
	return _emit(d)


func add_bytes(name: String, data: PackedByteArray) -> bool:
	if not begin(name):
		return false
	if not await write(data):
		return false
	return end()


## The names of the entries in the order the central directory lists them (`order`, or as written when empty), or
## null when `order` does not name every entry once.
func _listing(order: PackedStringArray) -> Variant:
	var names: Array = []
	if order.is_empty():
		for d: Dictionary in _done:
			names.append(d["name"])
		return names
	var seen := {}
	for n in order:
		if not _names.has(n) or seen.has(n):
			return null
		seen[n] = true
		names.append(n)
	return names if names.size() == _done.size() else null


## Writes the central directory, listing the entries as `order` names them (every entry once; empty: as
## written), and the end record. Answers the archive's size, or -1 (and `error` set).
func finish(order: PackedStringArray = PackedStringArray()) -> int:
	if not error.is_empty():
		return -1
	var names: Variant = null if _finished or not _cur.is_empty() else _listing(order)
	if names == null:
		_fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "internal")
		return -1
	var by_name := {}
	for d: Dictionary in _done:
		by_name[d["name"]] = d
	_finished = true
	var cd_offset := _offset
	var cd_size := 0
	for n: String in names:
		var rec := _central_record(by_name[n])
		cd_size += rec.size()
		if not _emit(rec):
			return -1
	var end_rec := PackedByteArray()
	end_rec.resize(22)
	end_rec.encode_u32(0, _END_SIG)
	end_rec.encode_u16(4, 0)
	end_rec.encode_u16(6, 0)
	end_rec.encode_u16(8, names.size())
	end_rec.encode_u16(10, names.size())
	end_rec.encode_u32(12, cd_size)
	end_rec.encode_u32(16, cd_offset)
	end_rec.encode_u16(20, 0)
	return _offset if _emit(end_rec) else -1


static func _central_record(d: Dictionary) -> PackedByteArray:
	var raw: PackedByteArray = d["raw"]
	var rec := PackedByteArray()
	rec.resize(46)
	rec.encode_u32(0, _CENTRAL_SIG)
	rec.encode_u16(4, VERSION)
	rec.encode_u16(6, VERSION)
	rec.encode_u16(8, FLAGS)
	rec.encode_u16(10, 0)
	rec.encode_u16(12, DOS_TIME)
	rec.encode_u16(14, DOS_DATE)
	rec.encode_u32(16, d["crc"])
	rec.encode_u32(20, d["size"])
	rec.encode_u32(24, d["size"])
	rec.encode_u16(28, raw.size())
	rec.encode_u16(30, 0)
	rec.encode_u16(32, 0)
	rec.encode_u16(34, 0)
	rec.encode_u16(36, 0)
	rec.encode_u32(38, 0)
	rec.encode_u32(42, d["offset"])
	rec.append_array(raw)
	return rec
