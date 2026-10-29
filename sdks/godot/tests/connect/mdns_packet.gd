extends RefCounted
# @pkey-feature connect.lan
# The mDNS packet codec (PKeyMdnsPacket; WIRE-CONTRACT-V5 section 15.4, G5 bounds): round trips for
# PTR, SRV, TXT, A and AAAA, the bounds (9,000 bytes, 64 records, 16 backward jumps, 8 TXT entries,
# name and label lengths), the malformed packets (pointer loop, forward pointer, truncation), the
# address text codec and the learning rule. When the mirrored peer-matrix.json carries `mdnsAnswers`
# (CC-IPV6.2), every row runs too; until then only the cases written here do.

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const INST := "p1-abcdefghijklmnop"
const FQDN := INST + "." + PKeyMdnsPacket.PEER_SERVICE
const HOST := INST + ".local"


func run(t: PKeyTestContext) -> void:
	_round_trips(t)
	_compression(t)
	_skips(t)
	_txt(t)
	_pointers(t)
	_truncation(t)
	_bounds(t)
	_names(t)
	_builders(t)
	_addresses(t)
	_learn(t)
	_corpus(t)


# raw packet helpers

static func _header(qd := 0, an := 0, ns := 0, ar := 0, flags := 0x8400) -> PackedByteArray:
	var out := PackedByteArray()
	for n in [0, flags, qd, an, ns, ar]:
		out.append(n >> 8)
		out.append(n & 0xff)
	return out


static func _name(s: String) -> PackedByteArray:
	var out := PackedByteArray()
	for p in s.split("."):
		out.append(p.length())
		out.append_array(p.to_ascii_buffer())
	out.append(0)
	return out


static func _rr(name: PackedByteArray, rtype: int, rdata: PackedByteArray, ttl := 120, rclass := 1) -> PackedByteArray:
	var out := name.duplicate()
	for n in [rtype, rclass]:
		out.append(n >> 8)
		out.append(n & 0xff)
	out.append_array(PackedByteArray([ttl >> 24, (ttl >> 16) & 0xff, (ttl >> 8) & 0xff, ttl & 0xff]))
	out.append(rdata.size() >> 8)
	out.append(rdata.size() & 0xff)
	out.append_array(rdata)
	return out


static func _cat(parts: Array) -> PackedByteArray:
	var out := PackedByteArray()
	for p in parts:
		out.append_array(p)
	return out


static func _bytes(values: Array) -> PackedByteArray:
	return PackedByteArray(values)


static func _filled(fill: int, count: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(count)
	b.fill(fill)
	return b


static func _answers() -> Array:
	return [
		{"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR", "ttl": 120, "data": FQDN},
		{"name": FQDN, "type": &"SRV", "ttl": 120, "data": {"port": 4242, "target": HOST, "priority": 0, "weight": 0}},
		{"name": FQDN, "type": &"TXT", "ttl": 4500, "data": ["v=1", "k=abc"]},
		{"name": HOST, "type": &"A", "ttl": 120, "data": "192.168.1.20"},
		{"name": HOST, "type": &"AAAA", "ttl": 120, "data": "fd12::5"},
	]


static func _reason(data: PackedByteArray) -> String:
	var r := PKeyMdnsPacket.parse(data)
	return "" if r["ok"] else String(r["error"])


# cases

func _round_trips(t: PKeyTestContext) -> void:
	var q := PKeyMdnsPacket.parse(PKeyMdnsPacket.build_query([
		{"name": PKeyMdnsPacket.PEER_SERVICE, "type": "PTR"}, {"name": FQDN, "type": "SRV"},
		{"name": HOST, "type": "A"}, {"name": HOST, "type": "AAAA"}]))
	t.check("query parses", q["ok"] and not q["response"] and (q["answers"] as Array).is_empty())
	t.check("query questions", q["ok"] and q["questions"] == [
		{"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR"}, {"name": FQDN, "type": &"SRV"},
		{"name": HOST, "type": &"A"}, {"name": HOST, "type": &"AAAA"}])
	var r := PKeyMdnsPacket.parse(PKeyMdnsPacket.build_response(_answers()))
	t.check("response round trip (PTR, SRV, TXT, A, AAAA)", r["ok"] and r["response"] and r["answers"] == _answers())
	var wire := PKeyMdnsPacket.build_response([_answers()[3]])
	var at := 12 + _name(HOST).size() + 2
	t.check("an A record owns the cache-flush class", wire.slice(at, at + 2).hex_encode() == "8001")
	var ptr := PKeyMdnsPacket.build_response([_answers()[0]])
	at = 12 + _name(PKeyMdnsPacket.PEER_SERVICE).size() + 2
	t.check("a PTR record does not", ptr.slice(at, at + 2).hex_encode() == "0001")


func _compression(t: PKeyTestContext) -> void:
	# A PTR whose target is a label plus a pointer back to the owner name.
	var raw := _cat([_header(0, 1), _rr(_name(PKeyMdnsPacket.PEER_SERVICE), 12, _cat([_bytes([INST.length()]), INST.to_ascii_buffer(), _bytes([0xc0, 0x0c])]))])
	var r := PKeyMdnsPacket.parse(raw)
	t.check("a backward pointer is followed", r["ok"] and r["answers"][0]["data"] == FQDN, str(r))
	var up := PKeyMdnsPacket.parse(_cat([_header(0, 2), _rr(_name("_PkeyPeer._TCP.local"), 12, _name(FQDN.to_upper())), _rr(_name(FQDN), 16, _bytes([0]))]))
	t.check("names are lower-cased", up["ok"] and up["answers"][0] == {"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR", "ttl": 120, "data": FQDN}, str(up))
	t.check("an empty TXT is an empty list", up["ok"] and up["answers"][1]["data"] == [])
	var empty := PKeyMdnsPacket.parse(PKeyMdnsPacket.build_response([{"name": FQDN, "type": &"TXT", "ttl": 1, "data": []}]))
	t.check("an empty TXT round trips", empty["ok"] and empty["answers"][0]["data"] == [])


func _skips(t: PKeyTestContext) -> void:
	var a_data := _bytes([10, 0, 0, 1])
	var raw := _cat([_header(0, 4),
		_rr(_name(HOST), 99, _bytes([120, 121, 122])),
		_rr(_name(HOST), 1, a_data, 120, 3),
		_rr(_name(HOST), 1, a_data, 120, 0x8001),
		_rr(_name(HOST), 1, _bytes([10, 0, 0, 2]))])
	var r := PKeyMdnsPacket.parse(raw)
	t.check("unknown types and classes are skipped; the cache-flush bit is fine", r["ok"] and (r["answers"] as Array).size() == 2 and r["answers"][0]["data"] == "10.0.0.1", str(r))
	var split := PKeyMdnsPacket.parse(_cat([_header(0, 0, 1, 1), _rr(_name(HOST), 1, _bytes([10, 0, 0, 2])), _rr(_name(HOST), 1, a_data)]))
	t.check("the authority section is dropped, additionals are kept", split["ok"] and (split["answers"] as Array).size() == 1 and split["answers"][0]["data"] == "10.0.0.1")
	var bad_ns := _reason(_cat([_header(0, 0, 1), _rr(_name(HOST), 1, _bytes([10, 0, 0]))]))
	t.check("an authority record is bounds-checked but never read", bad_ns == "")


func _txt(t: PKeyTestContext) -> void:
	var rdata := PackedByteArray()
	for i in 12:
		var e := ("k%d" % i).to_ascii_buffer()
		rdata.append(e.size())
		rdata.append_array(e)
	var r := PKeyMdnsPacket.parse(_cat([_header(0, 1), _rr(_name(FQDN), 16, rdata)]))
	var want: Array = []
	for i in 8:
		want.append("k%d" % i)
	t.check("TXT keeps its first 8 entries", r["ok"] and r["answers"][0]["data"] == want, str(r))
	t.check("a TXT string past its record is refused", _reason(_cat([_header(0, 1), _rr(_name(FQDN), 16, _bytes([5, 97, 98]))])) == "bad_rdata")
	t.check("building a TXT of 9 entries is refused", PKeyMdnsPacket.build_response([{"name": FQDN, "type": &"TXT", "ttl": 1, "data": ["x", "x", "x", "x", "x", "x", "x", "x", "x"]}]).is_empty())


func _pointers(t: PKeyTestContext) -> void:
	t.check("a pointer to itself", _reason(_cat([_header(0, 1), _bytes([0xc0, 0x0c]), _filled(0, 10)])) == "bad_pointer")
	# Two pointers aimed at each other: the first points forward.
	t.check("a pointer loop", _reason(_cat([_header(1), _bytes([0xc0, 0x0e, 0xc0, 0x0c, 0, 0x0c, 0, 1])])) == "bad_pointer")
	t.check("a forward pointer", _reason(_cat([_header(1), _bytes([0xc0, 0x20, 0, 0x0c, 0, 1]), _filled(0, 40)])) == "bad_pointer")
	t.check("a forward pointer inside a name", _reason(_cat([_header(1), _bytes([1, 97, 0xc0, 0x10, 0, 0x0c, 0, 1])])) == "bad_pointer")
	t.check("15 jumps are followed", PKeyMdnsPacket.parse(_chain_packet(15))["ok"])
	t.check("16 jumps are followed (the limit)", PKeyMdnsPacket.parse(_chain_packet(16))["ok"])
	t.check("17 jumps are refused", _reason(_chain_packet(17)) == "too_many_jumps")
	t.check("the chain resolves to the first name", PKeyMdnsPacket.parse(_chain_packet(3))["answers"] == [{"name": "a", "type": &"A", "ttl": 120, "data": "10.0.0.1"}])


## Record 1 (type 99, skipped) owns the name "a" and holds `chain - 1` pointers in its rdata, each at the
## one before (the first at the name). Record 2 is an A record whose owner is a pointer to the last of
## them: reading it follows `chain` pointers.
static func _chain_packet(chain: int) -> PackedByteArray:
	var first_owner := _bytes([1, 97, 0])
	var rdata_at := 12 + first_owner.size() + 10
	var rdata := PackedByteArray()
	var prev := 12
	for i in chain - 1:
		rdata.append_array(_bytes([0xc0 | (prev >> 8), prev & 0xff]))
		prev = rdata_at + 2 * i
	var second := _rr(_bytes([0xc0 | (prev >> 8), prev & 0xff]), 1, _bytes([10, 0, 0, 1]))
	return _cat([_header(0, 2), _rr(first_owner, 99, rdata), second])


func _truncation(t: PKeyTestContext) -> void:
	var good := _cat([_header(0, 1), _rr(_name(HOST), 1, _bytes([10, 0, 0, 1]))])
	t.check("a record cut short", _reason(good.slice(0, good.size() - 2)) == "truncated")
	t.check("every cut of a valid packet is refused or whole", _every_cut_refused(good))
	t.check("an A record of 3 bytes", _reason(_cat([_header(0, 1), _rr(_name(HOST), 1, _bytes([10, 0, 0]))])) == "bad_rdata")
	t.check("an AAAA record of 4 bytes", _reason(_cat([_header(0, 1), _rr(_name(HOST), 28, _bytes([10, 0, 0, 1]))])) == "bad_rdata")
	var srv := _cat([_bytes([0, 0, 0, 0, 0, 80]), _name(HOST)])
	t.check("an SRV name past its record", _reason(_cat([_header(0, 1), _rr(_name(FQDN), 33, srv.slice(0, srv.size() - 3))])) in ["bad_rdata", "truncated"])
	t.check("an SRV record of 5 bytes", _reason(_cat([_header(0, 1), _rr(_name(FQDN), 33, srv.slice(0, 5))])) == "bad_rdata")
	var inst := _name(INST)
	t.check("a PTR name past its record", _reason(_cat([_header(0, 1), _rr(_name(FQDN), 12, inst.slice(0, inst.size() - 1))])) in ["bad_rdata", "truncated"])
	t.check("a short header", _reason(_filled(0, 11)) == "truncated")
	t.check("a missing record", _reason(_header(0, 1)) == "truncated")
	t.check("a question cut after its name", _reason(_cat([_header(1), _name(HOST)])) == "truncated")
	t.check("a record cut after its type", _reason(_cat([_header(0, 1), _name(HOST), _bytes([0, 1])])) == "truncated")
	t.check("a name that never ends", _reason(_cat([_header(1), _bytes([3, 97, 98, 99])])) == "truncated")
	t.check("a pointer cut after its first byte", _reason(_cat([_header(1), _bytes([0xc0])])) == "truncated")


## Every proper prefix of a valid packet is refused (it never answers ok with fewer records).
static func _every_cut_refused(p: PackedByteArray) -> bool:
	for n in p.size():
		if PKeyMdnsPacket.parse(p.slice(0, n))["ok"]:
			return false
	return true


func _bounds(t: PKeyTestContext) -> void:
	t.check("9,000 bytes are read", PKeyMdnsPacket.parse(_filled(0, 9000))["ok"])
	t.check("9,001 bytes are refused", _reason(_filled(0, 9001)) == "packet_too_large")
	for field in 4:
		var counts := [0, 0, 0, 0]
		counts[field] = 65
		t.check("65 records in section %d" % field, _reason(_header(counts[0], counts[1], counts[2], counts[3])) == "too_many_records")
	var rr := _rr(_name(HOST), 1, _bytes([10, 0, 0, 1]))
	var many := _header(0, 64)
	for i in 64:
		many.append_array(rr)
	var r := PKeyMdnsPacket.parse(many)
	t.check("64 records are read", r["ok"] and (r["answers"] as Array).size() == 64)
	var big: Array = []
	for i in 65:
		big.append(_answers()[3])
	t.check("building 65 records is refused", PKeyMdnsPacket.build_response(big).is_empty())
	# A response over 9,000 bytes is refused whole.
	var fat: Array = []
	for i in 40:
		fat.append({"name": FQDN, "type": &"TXT", "ttl": 1, "data": [("x".repeat(250)), ("y".repeat(250))]})
	t.check("building over 9,000 bytes is refused", PKeyMdnsPacket.build_response(fat).is_empty())


func _names(t: PKeyTestContext) -> void:
	var tail := _bytes([0, 12, 0, 1])
	t.check("a label of 64 bytes", _reason(_cat([_header(1), _bytes([64]), _filled(97, 64), _bytes([0]), tail])) == "bad_label")
	var ok := _bytes([63]) + _filled(97, 63) + _bytes([63]) + _filled(97, 63) + _bytes([63]) + _filled(97, 63) + _bytes([61]) + _filled(98, 61) + _bytes([0])
	t.check("a name of 255 wire bytes", ok.size() == 255 and PKeyMdnsPacket.parse(_cat([_header(1), ok, tail]))["ok"])
	var long := PackedByteArray()
	for i in 4:
		long.append(63)
		long.append_array(_filled(97, 63))
	long.append(0)
	t.check("a name of 257 wire bytes", _reason(_cat([_header(1), long, tail])) == "name_too_long")
	t.check("a 0x40 label type", _reason(_cat([_header(1), _bytes([0x40, 97, 0]), tail])) == "bad_label")
	t.check("a non-ASCII label", _reason(_cat([_header(1), _bytes([1, 0xe9, 0]), tail])) == "bad_label")


func _builders(t: PKeyTestContext) -> void:
	t.check("a label of 64 bytes is not built", PKeyMdnsPacket.build_query([{"name": "a".repeat(64) + ".local", "type": "PTR"}]).is_empty())
	t.check("an unknown type is not built", PKeyMdnsPacket.build_query([{"name": HOST, "type": "MX"}]).is_empty())
	t.check("an empty label is not built", PKeyMdnsPacket.build_query([{"name": "a..local", "type": "A"}]).is_empty())
	t.check("an A record needs an IPv4 address", PKeyMdnsPacket.build_response([{"name": HOST, "type": &"A", "ttl": 1, "data": "300.1.1.1"}]).is_empty())
	t.check("an A record refuses an IPv6 address", PKeyMdnsPacket.build_response([{"name": HOST, "type": &"A", "ttl": 1, "data": "fd12::5"}]).is_empty())
	t.check("an AAAA record refuses an IPv4 address", PKeyMdnsPacket.build_response([{"name": HOST, "type": &"AAAA", "ttl": 1, "data": "10.0.0.1"}]).is_empty())
	t.check("an SRV port over 65535", PKeyMdnsPacket.build_response([{"name": FQDN, "type": &"SRV", "ttl": 1, "data": {"port": 70000, "target": HOST}}]).is_empty())
	t.check("a TXT entry over 255 bytes", PKeyMdnsPacket.build_response([{"name": FQDN, "type": &"TXT", "ttl": 1, "data": ["x".repeat(256)]}]).is_empty())


func _addresses(t: PKeyTestContext) -> void:
	var text := {
		"192.168.1.20": "c0a80114", "0.0.0.0": "00000000", "fe80::1c2:3ff:fe4:5a6": "fe8000000000000001c203ff0fe405a6",
		"::": "00000000000000000000000000000000", "::1": "00000000000000000000000000000001",
		"2001:db8:0:0:1:0:0:1": "20010db8000000000001000000000001", "::ffff:192.168.1.20": "00000000000000000000ffffc0a80114",
		"::ffff:c0a8:114": "00000000000000000000ffffc0a80114", "FD12::5": "fd120000000000000000000000000005",
		"1:2:3:4:5:6:7:8": "00010002000300040005000600070008", "1::": "00010000000000000000000000000000",
	}
	for k in text:
		t.check("address_bytes %s" % k, PKeyMdnsPacket.address_bytes(k).hex_encode() == text[k])
	for bad in ["", "1.2.3", "1.2.3.4.5", "01.2.3.4", "256.1.1.1", "1.2.3.-4", "+1.2.3.4", "1::2::3",
			"1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "12345::", "g::", ":::", "1:::2", "::1.2.3.4:5", "1:2:3:4:5:6:7::8", "fe80::1%en0"]:
		t.check("address_bytes refuses '%s'" % bad, PKeyMdnsPacket.address_bytes(bad).is_empty())
	var canonical := {
		"fe80::1c2:3ff:fe4:5a6": "fe80::1c2:3ff:fe4:5a6", "0:0:0:0:0:0:0:0": "::", "2001:db8:0:0:1:0:0:1": "2001:db8::1:0:0:1",
		"2001:0:0:1:0:0:0:1": "2001:0:0:1::1", "1:0:2:0:3:0:4:0": "1:0:2:0:3:0:4:0", "::ffff:192.168.1.20": "::ffff:c0a8:114",
		"1:2:3:4:5:6:7:0": "1:2:3:4:5:6:7:0", "0:1:2:3:4:5:6:7": "0:1:2:3:4:5:6:7", "0:0:1:2:3:4:5:6": "::1:2:3:4:5:6",
	}
	for k in canonical:
		t.check("address_text of %s" % k, PKeyMdnsPacket.address_text(PKeyMdnsPacket.address_bytes(k)) == canonical[k], PKeyMdnsPacket.address_text(PKeyMdnsPacket.address_bytes(k)))
	t.check("address_text of 5 bytes", PKeyMdnsPacket.address_text(_filled(1, 5)) == "")


func _packet(records: Array) -> PackedByteArray:
	return PKeyMdnsPacket.build_response(records)


static func _a(name: String, ip: String, ttl := 120) -> Dictionary:
	return {"name": name, "type": &"A", "ttl": ttl, "data": ip}


static func _aaaa(name: String, ip: String, ttl := 120) -> Dictionary:
	return {"name": name, "type": &"AAAA", "ttl": ttl, "data": ip}


func _learn(t: PKeyTestContext) -> void:
	var h1 := "p1-aaaaaaaaaaaaaaaa.local"
	var r := PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20")]), "192.168.1.20", null)
	t.check("an A record equal to the source is learned", r["ok"] and r["learned"] == [{"name": h1, "address": "192.168.1.20"}])
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.99")]), "192.168.1.20", null)
	t.check("an A record that is not the source is dropped", r["ok"] and (r["learned"] as Array).is_empty())
	r = PKeyMdnsPacket.learn(_packet([_aaaa(h1, "fe80::1c2:3ff:fe4:5a6")]), "fe80::1c2:3ff:fe4:5a6", "en0")
	t.check("a link-local address takes the zone", r["ok"] and r["learned"] == [{"name": h1, "address": "fe80::1c2:3ff:fe4:5a6%en0"}])
	r = PKeyMdnsPacket.learn(_packet([_aaaa(h1, "fd12::5")]), "fd12::5", "en0")
	t.check("a ULA address has no zone", r["ok"] and r["learned"] == [{"name": h1, "address": "fd12::5"}])
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20")]), "fe80::1", "en0")
	t.check("an A record in an IPv6 packet is dropped", r["ok"] and (r["learned"] as Array).is_empty())
	r = PKeyMdnsPacket.learn(_packet([_aaaa(h1, "fd12::5")]), "192.168.1.20", null)
	t.check("an AAAA record in an IPv4 packet is dropped", r["ok"] and (r["learned"] as Array).is_empty())
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20")]), "::ffff:192.168.1.20", "en0")
	t.check("an IPv4-mapped source is its IPv4 address", r["ok"] and r["learned"] == [{"name": h1, "address": "192.168.1.20"}])
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20")]), "::ffff:c0a8:114", null)
	t.check("an IPv4-mapped source in hex form", r["ok"] and r["learned"] == [{"name": h1, "address": "192.168.1.20"}])
	r = PKeyMdnsPacket.learn(_packet([_aaaa(h1, "::ffff:c0a8:114")]), "::ffff:192.168.1.20", null)
	t.check("an AAAA record of a mapped address is never learned", r["ok"] and (r["learned"] as Array).is_empty())

	# Four addresses a name, first-seen order, a repeat is not a second one.
	var held: Array = []
	for ip in ["192.168.1.2", "192.168.1.3", "192.168.1.4", "192.168.1.5"]:
		held.append({"name": h1, "address": ip})
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.9")]), "192.168.1.9", null, held)
	t.check("a fifth address is dropped", r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_packet([_a("p1-bbbbbbbbbbbbbbbb.local", "192.168.1.9")]), "192.168.1.9", null, held)
	t.check("the cap is per name", r["ok"] and (r["learned"] as Array).size() == 5)
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.3")]), "192.168.1.3", null, held)
	t.check("a repeat is not a second address", r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_packet([_a(h1.to_upper(), "192.168.1.9")]), "192.168.1.9", null, held)
	t.check("names fold to lower case and share the cap", r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.3", 0)]), "192.168.1.3", null, held)
	t.check("an address goodbye removes it and keeps the others in order", r["ok"] and r["learned"] == [held[0], held[2], held[3]])
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.3", 0), _a(h1, "192.168.1.3")]), "192.168.1.3", null, held)
	t.check("an address that returns goes last", r["ok"] and r["learned"] == [held[0], held[2], held[3], held[1]])
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.3", 0)]), "192.168.1.99", null, held)
	t.check("a goodbye that is not from the source is ignored", r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20", 0)]), "192.168.1.20", null)
	t.check("a goodbye of an unheld address learns nothing", r["ok"] and (r["learned"] as Array).is_empty())
	r = PKeyMdnsPacket.learn(_packet([{"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR", "ttl": 0, "data": FQDN}]), "192.168.1.20", null, held)
	t.check("a PTR goodbye teaches and removes nothing", r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_filled(0, 3), "192.168.1.20", null, held)
	t.check("a malformed packet leaves the table as it was", not r["ok"] and r["learned"] == held)
	r = PKeyMdnsPacket.learn(_packet([_a(h1, "192.168.1.20")]), "not an address", null)
	t.check("a source that is not an address is refused", not r["ok"] and r["error"] == &"bad_source")


## Every `mdnsAnswers` row of the corpus, when the mirror holds the section.
func _corpus(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if j.parse(FileAccess.get_file_as_string(MATRIX)) != OK or not j.data is Dictionary:
		t.check("peer-matrix.json parses", false)
		return
	var section = (j.data as Dictionary).get("mdnsAnswers")
	if not section is Dictionary:
		t.info("peer-matrix.json has no mdnsAnswers yet (CC-IPV6.2); only the cases above ran")
		return
	var rows: Array = section["rows"]
	var good := 0
	for row in rows:
		var packet := (row["packet"] as String).hex_decode()
		var prior: Array = row.get("prior", [])
		var r := PKeyMdnsPacket.learn(packet, row["source"], row["zone"], prior)
		if t.check("mdnsAnswers %s" % row["id"], r["ok"] and r["learned"] == row["learned"], str(r.get("learned"))):
			good += 1
	t.check("mdnsAnswers coverage", good == rows.size() and rows.size() >= 36, "%d/%d" % [good, rows.size()])
