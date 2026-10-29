@tool
class_name PKeyPeerRecord
extends RefCounted
## WIRE-CONTRACT-V5 section 15.6: the records inside one Noise transport plaintext (`u16be type ||
## u8 flags || body`), the type table, MORE reassembly and the order of checks (CC-14.3), ported from
## `packages/client-core/src/peer/record.ts`.
##
## Pure functions and a stateful `Assembler`; nothing here does I/O. A record is a Dictionary {type,
## flags, body}. Every refusal is a session close code (`CLOSE_*`), never an error code or a message
## that carries bytes.

## A reassembled message is at most 1 MiB.
const MAX_MESSAGE := 1048576
## A Noise message is at most 65,535 bytes; 16 are the tag and 3 the record header.
const MAX_RECORD_BODY := 65535 - 16 - 3
## Records in one MORE chain: a full 1 MiB message in the largest records is ceil(1048576 / 65516)
## = 17, plus one.
const MAX_CHAIN_RECORDS := 18
const FLAG_MORE := 1

const CLOSE_BAD_FRAME := &"peer_bad_frame"
const CLOSE_UNKNOWN_CRITICAL := &"peer_unknown_critical"
const CLOSE_NOT_ALLOWED := &"peer_not_allowed"

const HELLO := 0x8001
const RING := 0x0002
const TRUST := 0x0003
const PING := 0x0004
const PONG := 0x0005
const CANDIDATES := 0x0006
const VOUCH_REQ := 0x8010
const VOUCH_RESULT := 0x8011
const CONFIRM := 0x8012
const CONTACT := 0x0013
const SAS_COMMIT := 0x8014
const SAS_NONCE := 0x8015
const SAS_REVEAL := 0x8016
const KEYRING_WRAP := 0x0030
const REKEY := 0x80fe
const CLOSE := 0x80ff

## The type table: [from, to, name, modes, body length (-1: any)]. A mode is `a` (account), `v`
## (vouch), `p` (pairing) or `c` (contact).
const TYPES := [
	[0x8001, 0x8001, "HELLO", "avpc", -1],
	[0x0002, 0x0002, "RING", "a", -1],
	[0x0003, 0x0003, "TRUST", "a", -1],
	[0x0004, 0x0004, "PING", "avpc", 8],
	[0x0005, 0x0005, "PONG", "avpc", 8],
	[0x0006, 0x0006, "CANDIDATES", "a", -1],
	[0x8010, 0x8010, "VOUCH_REQ", "v", -1],
	[0x8011, 0x8011, "VOUCH_RESULT", "v", -1],
	[0x8012, 0x8012, "CONFIRM", "p", -1],
	[0x0013, 0x0013, "CONTACT", "p", -1],
	[0x8014, 0x8014, "SAS_COMMIT", "vp", -1],
	[0x8015, 0x8015, "SAS_NONCE", "vp", -1],
	[0x8016, 0x8016, "SAS_REVEAL", "vp", -1],
	[0x0020, 0x0025, "XFER", "ac", -1],
	[0x0030, 0x003f, "SYNC", "v", -1],
	[0x0100, 0x7fff, "APP", "ac", -1],
	[0x8100, 0xfffd, "APP_CRITICAL", "ac", -1],
	[0x80fe, 0x80fe, "REKEY", "avpc", 0],
	[0x80ff, 0x80ff, "CLOSE", "avpc", -1],
]


## The record in a Noise plaintext: {ok = true, type, flags, body}, or {ok = false} (the session
## closes with `peer_bad_frame`) when it is shorter than the three header bytes or sets a flag bit
## other than MORE.
static func parse(plain: PackedByteArray) -> Dictionary:
	if plain.size() < 3 or (plain[2] & 0xfe) != 0:
		return {"ok": false}
	return {"ok": true, "type": (plain[0] << 8) | plain[1], "flags": plain[2], "body": plain.slice(3)}


## `u16be type || u8 flags || body`, or an empty array when a field is out of range.
static func encode(type: int, flags: int, body: PackedByteArray) -> PackedByteArray:
	if type < 0 or type > 0xffff or flags < 0 or flags > 0xff:
		return PackedByteArray()
	var out := PackedByteArray()
	out.resize(3)
	out[0] = type >> 8
	out[1] = type & 0xff
	out[2] = flags
	out.append_array(body)
	return out


## A message split into encoded records, MORE on all but the last; empty when it is over 1 MiB.
static func split_message(type: int, body: PackedByteArray) -> Array[PackedByteArray]:
	var out: Array[PackedByteArray] = []
	if body.size() > MAX_MESSAGE:
		return out
	var at := 0
	while true:
		var end := mini(body.size(), at + MAX_RECORD_BODY)
		out.append(encode(type, FLAG_MORE if end < body.size() else 0, body.slice(at, end)))
		at = end
		if at >= body.size():
			break
	return out


## The type-table row of a type, or an empty array when the type is outside the table.
static func row_of(type: int) -> Array:
	for row in TYPES:
		if type >= row[0] and type <= row[1]:
			return row
	return []


## Reads records in order, in a session of one mode (the checks run in the order section 15.6 lists:
## flags, a continuation of another type, the type, the running size, a fixed body length). `push`
## answers {kind = &"message", type, body}, {kind = &"pending"}, {kind = &"ignored"} (an unknown
## non-critical type, MORE chain and all) or {kind = &"close", code}. After a close the session is
## over; the assembler is not used again.
class Assembler extends RefCounted:
	var _mode: String
	var _open_type := -1
	var _parts: Array[PackedByteArray] = []
	var _size := 0
	## Set while a chain of an unknown non-critical type is being dropped.
	var _dropping := -1


	func _init(mode: String) -> void:
		_mode = mode


	func _to_string() -> String:
		return "PKeyPeerRecord.Assembler(%s)" % _mode


	static func _close(code: StringName) -> Dictionary:
		return {"kind": &"close", "code": code}


	## Section 15.6 checks 1 and 2: the flags, then a continuation of another type. A chain being
	## dropped is a chain too.
	func _early_refusal(type: int, flags: int) -> StringName:
		if (flags & 0xfe) != 0 or type < 0 or type > 0xffff:
			return PKeyPeerRecord.CLOSE_BAD_FRAME
		var held := _dropping if _dropping >= 0 else _open_type
		if held >= 0 and held != type:
			return PKeyPeerRecord.CLOSE_BAD_FRAME
		return &""


	## Checks 3 to 5 for a type in the table: the mode, the running size over 1 MiB and the chain's
	## record count. The corpus (`more-empty-parts`) accepts an empty MORE record, so the record
	## count is what bounds the work.
	func _late_refusal(row: Array, body_size: int) -> StringName:
		if _mode.length() != 1 or not (row[3] as String).contains(_mode):
			return PKeyPeerRecord.CLOSE_NOT_ALLOWED
		if _size + body_size > PKeyPeerRecord.MAX_MESSAGE or _parts.size() >= PKeyPeerRecord.MAX_CHAIN_RECORDS:
			return PKeyPeerRecord.CLOSE_BAD_FRAME
		return &""


	func push(record: Dictionary) -> Dictionary:
		var type: int = record["type"]
		var flags: int = record["flags"]
		var body: PackedByteArray = record["body"]
		var refused := _early_refusal(type, flags)
		if refused != &"":
			return _close(refused)
		var more := (flags & PKeyPeerRecord.FLAG_MORE) != 0
		if _dropping >= 0:
			if not more:
				_dropping = -1
			return {"kind": &"ignored"}
		var row := PKeyPeerRecord.row_of(type)
		if row.is_empty():
			return _unknown(type, more)
		refused = _late_refusal(row, body.size())
		if refused != &"":
			return _close(refused)
		_parts.append(body)
		_size += body.size()
		if more:
			_open_type = type
			return {"kind": &"pending"}
		return _finish(type, int(row[4]))


	## A type outside the table: critical closes, otherwise it is dropped, MORE chain and all.
	func _unknown(type: int, more: bool) -> Dictionary:
		if (type & 0x8000) != 0:
			return _close(PKeyPeerRecord.CLOSE_UNKNOWN_CRITICAL)
		if more:
			_dropping = type
		return {"kind": &"ignored"}


	## The last record of a chain: the message, unless a fixed-length type has another length.
	func _finish(type: int, fixed_length: int) -> Dictionary:
		var whole := PackedByteArray()
		for part in _parts:
			whole.append_array(part)
		_parts = []
		_open_type = -1
		_size = 0
		if fixed_length >= 0 and whole.size() != fixed_length:
			return _close(PKeyPeerRecord.CLOSE_BAD_FRAME)
		return {"kind": &"message", "type": type, "body": whole}
