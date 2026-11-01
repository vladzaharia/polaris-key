@tool
class_name PKeyPeerRelayCodec
extends RefCounted
## WIRE-CONTRACT-V5 section 15.7: the relay envelopes, one binary WebSocket message each (CC-14.3),
## ported from `packages/client-core/src/peer/relay.ts`. A device is its 24 decoded device-id bytes.
## A message that does not match its layout exactly is refused.
##
## Pure functions over bytes. A message is a Dictionary with an `op` StringName:
##   &"send"    {to: 24 bytes, session: int 0..2^32-1, noise: 1..65535 bytes}    client to room
##   &"list"    {}                                                               client to room
##   &"ping"    {data: 8 bytes}                                                  client to room
##   &"recv"    {from: 24 bytes, session, noise}                                 room to client
##   &"members" {devices: Array of 24-byte devices, at most 255}                 room to client
##   &"ring"    {epoch: int 0..2^53-1}                                           room to client
##   &"pong"    {data: 8 bytes}                                                  room to client
##   &"gone"    {device: 24 bytes}                                               room to client
##   &"limit"   {reason: 1..4}                                                   room to client
## `encode` answers an empty array for a message its layout cannot hold; `decode` answers an empty
## Dictionary for a refused one (the caller closes the socket). `dir` is who sent the bytes.

const MAX_MESSAGE := 65564
const DEVICE_BYTES := 24
const DIR_TO_ROOM := &"toRoom"
const DIR_TO_CLIENT := &"toClient"

const OP_SEND := 0x01
const OP_LIST := 0x02
const OP_PING := 0x03
const OP_RECV := 0x81
const OP_MEMBERS := 0x82
const OP_RING := 0x83
const OP_PONG := 0x84
const OP_GONE := 0x85
const OP_LIMIT := 0x86

## The largest epoch a GDScript int and a JSON number both hold exactly: 2^53 - 1.
const MAX_EPOCH := 9007199254740991


static func _u32(n: int) -> PackedByteArray:
	return PackedByteArray([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])


static func _read_u32(b: PackedByteArray, at: int) -> int:
	return (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]


static func _is_bytes(v: Variant, length: int) -> bool:
	return v is PackedByteArray and (v as PackedByteArray).size() == length


static func _is_int(v: Variant) -> bool:
	return typeof(v) == TYPE_INT


static func _addressed(op: int, device: Variant, m: Dictionary) -> PackedByteArray:
	var noise: Variant = m.get("noise")
	var session: Variant = m.get("session")
	if not _is_bytes(device, DEVICE_BYTES) or not _is_int(session) or not noise is PackedByteArray:
		return PackedByteArray()
	if session < 0 or session > 0xffffffff or (noise as PackedByteArray).size() < 1 or (noise as PackedByteArray).size() > 65535:
		return PackedByteArray()
	var out := PackedByteArray([op])
	out.append_array(device)
	out.append_array(_u32(session))
	out.append_array(noise)
	return out


## Encode one message; empty when a value is outside what its layout can hold.
static func encode(m: Dictionary) -> PackedByteArray:
	var out := PackedByteArray()
	match m.get("op"):
		&"send":
			out = _addressed(OP_SEND, m.get("to"), m)
		&"recv":
			out = _addressed(OP_RECV, m.get("from"), m)
		&"list":
			out = PackedByteArray([OP_LIST])
		&"ping", &"pong":
			if _is_bytes(m.get("data"), 8):
				out = PackedByteArray([OP_PING if m["op"] == &"ping" else OP_PONG])
				out.append_array(m["data"])
		&"members":
			var devices: Variant = m.get("devices")
			if devices is Array and (devices as Array).size() <= 255:
				var body := PackedByteArray([OP_MEMBERS, (devices as Array).size()])
				for d in devices:
					if not _is_bytes(d, DEVICE_BYTES):
						return PackedByteArray()
					body.append_array(d)
				out = body
		&"ring":
			var epoch: Variant = m.get("epoch")
			if _is_int(epoch) and epoch >= 0 and epoch <= MAX_EPOCH:
				out = PackedByteArray([OP_RING])
				out.append_array(_u32(epoch >> 32))
				out.append_array(_u32(epoch & 0xffffffff))
		&"gone":
			if _is_bytes(m.get("device"), DEVICE_BYTES):
				out = PackedByteArray([OP_GONE])
				out.append_array(m["device"])
		&"limit":
			var reason: Variant = m.get("reason")
			if _is_int(reason) and reason >= 1 and reason <= 4:
				out = PackedByteArray([OP_LIMIT, reason])
	if out.size() > MAX_MESSAGE:
		return PackedByteArray()
	return out


## Decode one message sent in direction `dir` (DIR_TO_ROOM or DIR_TO_CLIENT); an empty Dictionary
## means refused.
static func decode(dir: StringName, b: PackedByteArray) -> Dictionary:
	if b.size() < 1 or b.size() > MAX_MESSAGE:
		return {}
	var op := int(b[0])
	var rest := b.slice(1)
	var n := rest.size()
	if dir == DIR_TO_ROOM:
		if op == OP_SEND and n >= 29:
			return {"op": &"send", "to": rest.slice(0, 24), "session": _read_u32(rest, 24), "noise": rest.slice(28)}
		if op == OP_LIST and n == 0:
			return {"op": &"list"}
		if op == OP_PING and n == 8:
			return {"op": &"ping", "data": rest}
		return {}
	if dir != DIR_TO_CLIENT:
		return {}
	if op == OP_RECV and n >= 29:
		return {"op": &"recv", "from": rest.slice(0, 24), "session": _read_u32(rest, 24), "noise": rest.slice(28)}
	if op == OP_MEMBERS and n >= 1 and n == 1 + int(rest[0]) * DEVICE_BYTES:
		var devices: Array[PackedByteArray] = []
		for i in int(rest[0]):
			devices.append(rest.slice(1 + i * DEVICE_BYTES, 1 + (i + 1) * DEVICE_BYTES))
		return {"op": &"members", "devices": devices}
	if op == OP_RING and n == 8:
		var high := _read_u32(rest, 0)
		# 2^53 is high word 2^21: anything at or above it is not a safe integer.
		if high >= 0x200000:
			return {}
		return {"op": &"ring", "epoch": (high << 32) | _read_u32(rest, 4)}
	if op == OP_PONG and n == 8:
		return {"op": &"pong", "data": rest}
	if op == OP_GONE and n == DEVICE_BYTES:
		return {"op": &"gone", "device": rest}
	if op == OP_LIMIT and n == 1 and rest[0] >= 1 and rest[0] <= 4:
		return {"op": &"limit", "reason": int(rest[0])}
	return {}
