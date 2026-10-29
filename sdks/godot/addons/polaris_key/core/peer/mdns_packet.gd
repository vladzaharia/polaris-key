@tool
class_name PKeyMdnsPacket
extends RefCounted
## WIRE-CONTRACT-V5 section 15.4: the mDNS packet codec for `_pkeypeer._tcp.local` (CC-14.7), ported
## from the Python and Kotlin codecs (`peer_mdns_packet.py`, `MdnsPacket.kt`) with AAAA added
## (`mdnsAnswers`). Pure functions over bytes: no socket, no clock. It is the one place a
## neighbour's packet is decoded, so every limit is enforced here (G5):
##
## - a packet is at most 9,000 bytes and a section holds at most 64 records;
## - a name is at most 255 bytes and a label at most 63, ASCII only;
## - a compression pointer must point strictly backwards and a name follows at most 16 of them,
##   so a loop and a forward pointer are refused;
## - a record's data lies inside the packet and fills exactly what its length says;
## - a TXT record keeps its first 8 entries; unknown record types and classes are skipped.
##
## A packet that breaks a limit answers {ok = false, error = <code>} and the caller drops the whole
## packet. The codes: `packet_too_large`, `too_many_records`, `truncated`, `bad_pointer`,
## `too_many_jumps`, `bad_label`, `name_too_long`, `bad_rdata`. Names are lower-cased on the way in.
## Whether an address is believed needs the packet's UDP source: `learn` applies that rule.
##
## A decoded record is {name, type, ttl, data}: PTR a name; SRV {port, target, priority, weight};
## TXT an Array of strings; A and AAAA the address text (dotted, or RFC 5952).

const PEER_SERVICE := "_pkeypeer._tcp.local"
const MAX_PACKET := 9000
const MAX_RECORDS := 64
const MAX_NAME := 255
const MAX_LABEL := 63
const MAX_JUMPS := 16
const MAX_TXT := 8
## The addresses one name keeps, of any family, in first-seen order.
const MAX_ADDRESSES := 4

const _HEADER := 12
const _CLASS_IN := 1
const _CACHE_FLUSH := 0x8000
const _RESPONSE_FLAGS := 0x8400
const _TYPES := {1: &"A", 12: &"PTR", 16: &"TXT", 28: &"AAAA", 33: &"SRV"}
const _CODES := {&"A": 1, &"PTR": 12, &"TXT": 16, &"AAAA": 28, &"SRV": 33}


static func _fail(error: StringName) -> Dictionary:
	return {"ok": false, "error": error}


static func _u16(b: PackedByteArray, at: int) -> int:
	return (b[at] << 8) | b[at + 1]


static func _u32(b: PackedByteArray, at: int) -> int:
	return (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]


# parse

## Read a name at `pos`: {ok = true, name, next} (`next` is just after its first, uncompressed form).
static func _read_name(buf: PackedByteArray, pos: int) -> Dictionary:
	var labels: PackedStringArray = PackedStringArray()
	var total := 0
	var jumps := 0
	var end := -1
	var cur := pos
	while true:
		if cur >= buf.size():
			return _fail(&"truncated")
		var n := buf[cur]
		if n == 0:
			if end < 0:
				end = cur + 1
			break
		var kind := n & 0xc0
		if kind == 0xc0:
			if cur + 1 >= buf.size():
				return _fail(&"truncated")
			var target := ((n & 0x3f) << 8) | buf[cur + 1]
			if end < 0:
				end = cur + 2
			# Strictly backwards: a forward or self pointer, and so any loop, is refused.
			if target >= cur:
				return _fail(&"bad_pointer")
			jumps += 1
			if jumps > MAX_JUMPS:
				return _fail(&"too_many_jumps")
			cur = target
			continue
		if kind != 0 or n > MAX_LABEL:
			return _fail(&"bad_label")
		if cur + 1 + n > buf.size():
			return _fail(&"truncated")
		total += n + 1
		if total + 1 > MAX_NAME:
			return _fail(&"name_too_long")
		var label := buf.slice(cur + 1, cur + 1 + n)
		for c in label:
			if c >= 0x80:
				return _fail(&"bad_label")
		labels.append(label.get_string_from_ascii().to_lower())
		cur += 1 + n
	return {"ok": true, "name": ".".join(labels), "next": end}


static func _rdata(buf: PackedByteArray, type: StringName, start: int, end: int) -> Dictionary:
	match type:
		&"A", &"AAAA":
			if end - start != (4 if type == &"A" else 16):
				return _fail(&"bad_rdata")
			return {"ok": true, "data": address_text(buf.slice(start, end))}
		&"PTR":
			var n := _read_name(buf, start)
			if not n["ok"]:
				return n
			if n["next"] > end:
				return _fail(&"bad_rdata")
			return {"ok": true, "data": n["name"]}
		&"SRV":
			if end - start < 7:
				return _fail(&"bad_rdata")
			var t := _read_name(buf, start + 6)
			if not t["ok"]:
				return t
			if t["next"] > end:
				return _fail(&"bad_rdata")
			return {"ok": true, "data": {
				"port": _u16(buf, start + 4), "target": t["name"],
				"priority": _u16(buf, start), "weight": _u16(buf, start + 2),
			}}
	# TXT: length-prefixed strings that fill the record exactly.
	var out: Array[String] = []
	var cur := start
	while cur < end:
		var n := buf[cur]
		if cur + 1 + n > end:
			return _fail(&"bad_rdata")
		if n > 0 and out.size() < MAX_TXT:
			out.append(buf.slice(cur + 1, cur + 1 + n).get_string_from_utf8())
		cur += 1 + n
	return {"ok": true, "data": out}


static func _records(buf: PackedByteArray, start: int, count: int, keep: bool) -> Dictionary:
	var out: Array[Dictionary] = []
	var pos := start
	for i in count:
		var n := _read_name(buf, pos)
		if not n["ok"]:
			return n
		pos = n["next"]
		if pos + 10 > buf.size():
			return _fail(&"truncated")
		var code := _u16(buf, pos)
		var rclass := _u16(buf, pos + 2)
		var ttl := _u32(buf, pos + 4)
		var rdlen := _u16(buf, pos + 8)
		pos += 10
		var end := pos + rdlen
		if end > buf.size():
			return _fail(&"truncated")
		if keep and _TYPES.has(code) and (rclass & ~_CACHE_FLUSH) == _CLASS_IN:
			var type: StringName = _TYPES[code]
			var d := _rdata(buf, type, pos, end)
			if not d["ok"]:
				return d
			out.append({"name": n["name"], "type": type, "ttl": ttl, "data": d["data"]})
		pos = end
	return {"ok": true, "records": out, "next": pos}


## Decode a datagram: {ok = true, response, questions = [{name, type}], answers = [record]} (the
## answers, then the additionals; the authority section is checked and dropped), or {ok = false, error}.
static func parse(data: PackedByteArray) -> Dictionary:
	if data.size() > MAX_PACKET:
		return _fail(&"packet_too_large")
	if data.size() < _HEADER:
		return _fail(&"truncated")
	var flags := _u16(data, 2)
	var qd := _u16(data, 4)
	var an := _u16(data, 6)
	var ns := _u16(data, 8)
	var ar := _u16(data, 10)
	if maxi(maxi(qd, an), maxi(ns, ar)) > MAX_RECORDS:
		return _fail(&"too_many_records")
	var pos := _HEADER
	var questions: Array[Dictionary] = []
	for i in qd:
		var n := _read_name(data, pos)
		if not n["ok"]:
			return n
		pos = n["next"]
		if pos + 4 > data.size():
			return _fail(&"truncated")
		var code := _u16(data, pos)
		pos += 4
		if _TYPES.has(code):
			questions.append({"name": n["name"], "type": _TYPES[code]})
	var answers := _records(data, pos, an, true)
	if not answers["ok"]:
		return answers
	var authority := _records(data, answers["next"], ns, false)
	if not authority["ok"]:
		return authority
	var extra := _records(data, authority["next"], ar, true)
	if not extra["ok"]:
		return extra
	var all: Array[Dictionary] = []
	all.append_array(answers["records"])
	all.append_array(extra["records"])
	return {"ok": true, "response": (flags & 0x8000) != 0, "questions": questions, "answers": all}


# build

static func _encode_name(name: String) -> PackedByteArray:
	var out := PackedByteArray()
	var text := name.trim_suffix(".")
	if text != "":
		for label in text.split("."):
			var raw := label.to_ascii_buffer()
			if label.length() != raw.size() or raw.size() < 1 or raw.size() > MAX_LABEL:
				return PackedByteArray()
			out.append(raw.size())
			out.append_array(raw)
	out.append(0)
	return out if out.size() <= MAX_NAME else PackedByteArray()


static func _be16(out: PackedByteArray, n: int) -> void:
	out.append((n >> 8) & 0xff)
	out.append(n & 0xff)


static func _be32(out: PackedByteArray, n: int) -> void:
	_be16(out, (n >> 16) & 0xffff)
	_be16(out, n & 0xffff)


static func _encode_rdata(type: StringName, data: Variant) -> Array:
	var out := PackedByteArray()
	match type:
		&"PTR":
			out = _encode_name(str(data))
			return [out.size() > 0, out]
		&"SRV":
			if not data is Dictionary:
				return [false, out]
			var port := int(data.get("port", -1))
			var prio := int(data.get("priority", 0))
			var weight := int(data.get("weight", 0))
			var target := _encode_name(str(data.get("target", "")))
			if target.is_empty() or port < 0 or port > 0xffff or prio < 0 or prio > 0xffff or weight < 0 or weight > 0xffff:
				return [false, out]
			_be16(out, prio)
			_be16(out, weight)
			_be16(out, port)
			out.append_array(target)
			return [true, out]
		&"TXT":
			if not data is Array or (data as Array).size() > MAX_TXT:
				return [false, out]
			for e in data:
				var raw := str(e).to_utf8_buffer()
				if raw.size() > 255:
					return [false, out]
				out.append(raw.size())
				out.append_array(raw)
			if out.is_empty():
				out.append(0)
			return [true, out]
	out = address_bytes(str(data))
	return [out.size() == (4 if type == &"A" else 16), out]


static func _encode_record(r: Dictionary) -> PackedByteArray:
	var type: StringName = StringName(str(r.get("type", "")))
	if not _CODES.has(type):
		return PackedByteArray()
	var name := _encode_name(str(r.get("name", "")))
	var rd := _encode_rdata(type, r.get("data"))
	var ttl := int(r.get("ttl", 0))
	if name.is_empty() or not rd[0] or ttl < 0 or ttl > 0xffffffff:
		return PackedByteArray()
	var body: PackedByteArray = rd[1]
	var out := name
	_be16(out, _CODES[type])
	# The cache-flush bit is set on unique records, never on the shared PTR.
	_be16(out, _CLASS_IN if type == &"PTR" else _CLASS_IN | _CACHE_FLUSH)
	_be32(out, ttl)
	_be16(out, body.size())
	out.append_array(body)
	return out


## A query packet (flags 0). `questions` are {name, type} (PTR, SRV, TXT, A or AAAA). Empty when a
## name, a type or a count is refused, or the packet would be over MAX_PACKET.
static func build_query(questions: Array, packet_id: int = 0) -> PackedByteArray:
	var out := PackedByteArray()
	if questions.size() > MAX_RECORDS:
		return out
	_be16(out, packet_id & 0xffff)
	_be16(out, 0)
	_be16(out, questions.size())
	_be16(out, 0)
	_be16(out, 0)
	_be16(out, 0)
	for q in questions:
		var type: StringName = StringName(str(q.get("type", "")))
		var name := _encode_name(str(q.get("name", "")))
		if name.is_empty() or not _CODES.has(type):
			return PackedByteArray()
		out.append_array(name)
		_be16(out, _CODES[type])
		_be16(out, _CLASS_IN)
	return out if out.size() <= MAX_PACKET else PackedByteArray()


## An authoritative response (flags 0x8400) holding `answers`, each {name, type, ttl, data} as
## `parse` answers them. Empty when a record is refused or the packet would be over MAX_PACKET.
static func build_response(answers: Array) -> PackedByteArray:
	var out := PackedByteArray()
	if answers.size() > MAX_RECORDS:
		return out
	_be16(out, 0)
	_be16(out, _RESPONSE_FLAGS)
	_be16(out, 0)
	_be16(out, answers.size())
	_be16(out, 0)
	_be16(out, 0)
	for r in answers:
		var rec := _encode_record(r)
		if rec.is_empty():
			return PackedByteArray()
		out.append_array(rec)
	return out if out.size() <= MAX_PACKET else PackedByteArray()


# addresses

static func _digits(s: String) -> bool:
	if s.is_empty():
		return false
	for c in s.to_utf8_buffer():
		if c < 0x30 or c > 0x39:
			return false
	return true


static func _hex_group(s: String) -> int:
	if s.is_empty() or s.length() > 4:
		return -1
	for c in s.to_lower().to_utf8_buffer():
		if not ((c >= 0x30 and c <= 0x39) or (c >= 0x61 and c <= 0x66)):
			return -1
	return s.hex_to_int()


static func _v4(text: String) -> PackedByteArray:
	var parts := text.split(".")
	var out := PackedByteArray()
	if parts.size() != 4:
		return out
	for p in parts:
		if not _digits(p) or p.length() > 3 or (p.length() > 1 and p.begins_with("0")) or int(p) > 255:
			return PackedByteArray()
		out.append(int(p))
	return out


## The 4 or 16 bytes of an IPv4 text, or an IPv6 text (`::` once, an IPv4 tail allowed), without a
## zone. Empty when `text` is neither.
static func address_bytes(text: String) -> PackedByteArray:
	if not text.contains(":"):
		return _v4(text)
	var gaps := text.split("::")
	if gaps.size() > 2:
		return PackedByteArray()
	var sides: Array = []
	for gi in gaps.size():
		var groups: Array[int] = []
		if gaps[gi] != "":
			var parts := gaps[gi].split(":")
			for pi in parts.size():
				var g := parts[pi]
				if g.contains("."):
					var tail := _v4(g)
					# Only the last group of the whole address may be an IPv4 tail.
					if tail.is_empty() or pi != parts.size() - 1 or gi != gaps.size() - 1:
						return PackedByteArray()
					groups.append((tail[0] << 8) | tail[1])
					groups.append((tail[2] << 8) | tail[3])
				else:
					var v := _hex_group(g)
					if v < 0:
						return PackedByteArray()
					groups.append(v)
		sides.append(groups)
	var head: Array = sides[0]
	var tail_groups: Array = sides[1] if sides.size() == 2 else []
	var fill := 8 - head.size() - tail_groups.size()
	if (sides.size() == 2 and fill < 1) or (sides.size() == 1 and fill != 0):
		return PackedByteArray()
	var all: Array = []
	all.append_array(head)
	for i in fill:
		all.append(0)
	all.append_array(tail_groups)
	var out := PackedByteArray()
	for g in all:
		out.append(g >> 8)
		out.append(g & 0xff)
	return out


## Dotted IPv4, or RFC 5952 IPv6 text (lower case; the first longest run of two or more zero groups
## becomes `::`). Empty for any other length.
static func address_text(b: PackedByteArray) -> String:
	if b.size() == 4:
		return "%d.%d.%d.%d" % [b[0], b[1], b[2], b[3]]
	if b.size() != 16:
		return ""
	var g: Array[int] = []
	for i in 8:
		g.append(_u16(b, i * 2))
	for length in range(8, 1, -1):
		for at in range(0, 9 - length):
			var zero := true
			for k in length:
				if g[at + k] != 0:
					zero = false
					break
			if zero:
				return "%s::%s" % [_hex(g.slice(0, at)), _hex(g.slice(at + length))]
	return _hex(g)


static func _hex(groups: Array) -> String:
	var parts := PackedStringArray()
	for x in groups:
		parts.append("%x" % x)
	return ":".join(parts)


static func _is_link_local(b: PackedByteArray) -> bool:
	return b.size() == 16 and b[0] == 0xfe and (b[1] & 0xc0) == 0x80


# learning

## The address bytes a packet's source stands for: an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
## is its IPv4 address. Empty when `source` is not an address.
static func _source_bytes(source: String) -> PackedByteArray:
	var b := address_bytes(source)
	if b.size() == 16:
		var mapped := b[10] == 0xff and b[11] == 0xff
		for i in 10:
			if b[i] != 0:
				mapped = false
		if mapped:
			return b.slice(12)
	return b


## WIRE-CONTRACT-V5 section 15.4 "Addresses". A browser believes an A or AAAA record only when its
## address equals the packet's source (so never an A record in an IPv6 packet, nor an AAAA record in
## an IPv4 one); the section does not matter. A link-local address is learned as `<text>%<zone>`
## when the arrival interface `zone` is known. A name keeps at most MAX_ADDRESSES addresses of any
## family in first-seen order and a repeat is not a second one. A record with TTL 0 removes that
## address when it passes the same equality test and learns nothing. Names compare ASCII-folded and
## are held in lower case. `prior` is the table held before (`[{name, address}]`, first-seen order).
## Answers {ok = true, learned = [{name, address}]}, or {ok = false, error, learned = prior} for a
## packet that is malformed or a source that is not an address (the table is then unchanged).
static func learn(packet: PackedByteArray, source: String, zone: Variant, prior: Array = []) -> Dictionary:
	var table: Array[Dictionary] = []
	for e in prior:
		table.append({"name": String(e["name"]).to_lower(), "address": String(e["address"])})
	var p := parse(packet)
	if not p["ok"]:
		return {"ok": false, "error": p["error"], "learned": table}
	var src := _source_bytes(source)
	if src.is_empty():
		return {"ok": false, "error": &"bad_source", "learned": table}
	for r in p["answers"]:
		if r["type"] != &"A" and r["type"] != &"AAAA":
			continue
		var raw := address_bytes(r["data"])
		if raw != src:
			continue
		var address := String(r["data"])
		if _is_link_local(raw) and zone is String and zone != "":
			address = "%s%%%s" % [address, zone]
		var name: String = r["name"]
		var at := -1
		for i in table.size():
			if table[i]["name"] == name and table[i]["address"] == address:
				at = i
				break
		if int(r["ttl"]) == 0:
			if at >= 0:
				table.remove_at(at)
			continue
		if at >= 0:
			continue
		var held := 0
		for e in table:
			if e["name"] == name:
				held += 1
		if held < MAX_ADDRESSES:
			table.append({"name": name, "address": address})
	return {"ok": true, "learned": table}
