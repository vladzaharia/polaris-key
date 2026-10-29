extends RefCounted
# @pkey-feature connect.protocol
# The `frames`, `records` and `relayEnvelopes` rows of `peer-matrix.json` (WIRE-CONTRACT-V5 sections
# 15.6 and 15.7) through PKeyPeerFrame, PKeyPeerRecord and PKeyPeerRelayCodec, row for row as the
# Node, Python, Kotlin and Swift runners do, plus what the corpus cannot say: the reader's linear
# work, byte by byte reads, the type table against the corpus, a 1 MiB split and reassembly, and the
# refusals of the encoders. Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var m: Dictionary = j.data
	t.check("row counts", (m["frames"]["encode"] as Array).size() == 4 and (m["records"]["parse"] as Array).size() == 14 \
			and (m["records"]["sessions"] as Array).size() >= 85 \
			and (m["relayEnvelopes"]["messages"] as Array).size() + (m["relayEnvelopes"]["refused"] as Array).size() + (m["relayEnvelopes"]["sizes"] as Array).size() >= 56)
	_frames(t, m["frames"])
	_reader(t, m["frames"])
	_records(t, m["records"])
	_types(t, m["records"]["types"])
	_sessions(t, m["records"]["sessions"])
	_split(t)
	_relay(t, m["relayEnvelopes"])
	_relay_encode_refusals(t)


static func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


static func _sha(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


static func _filled(fill: int, count: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(count)
	b.fill(fill)
	return b


## A corpus body: a hex string, or {fill, count}.
static func _body(b: Variant) -> PackedByteArray:
	if b is String:
		return _hex(b)
	return _filled(String(b["fill"]).hex_to_int(), int(b["count"]))


# frames

func _frames(t: PKeyTestContext, f: Dictionary) -> void:
	for r in f["encode"]:
		t.check("frame encode %s" % String(r["noise"]).left(8), PKeyPeerFrame.encode(_hex(r["noise"])).hex_encode() == r["frame"])
	for r in f["limits"]:
		var frame := PKeyPeerFrame.encode(_filled(0x5a, int(r["len"])))
		var want: Dictionary = r["want"]
		var ok: bool = frame.is_empty() if want.get("refused", false) else (frame.slice(0, 2).hex_encode() == want["header"] and _sha(frame) == want["frameSha256"])
		t.check("frame limit len=%d" % int(r["len"]), ok)
	for r in f["decode"]:
		var got := PKeyPeerFrame.decode(_hex(r["stream"]))
		var want: Dictionary = r["want"]
		var ok: bool = false
		if want.has("error"):
			ok = not got["ok"] and got["error"] == &"peer_bad_frame" and String(got["error"]) == want["error"]
		else:
			ok = got["ok"] and _hexes(got["frames"]) == want["frames"] and (got["rest"] as PackedByteArray).hex_encode() == want["rest"]
		t.check("frame decode %s" % r["id"], ok)


static func _hexes(list: Array) -> Array:
	var out := []
	for b in list:
		out.append((b as PackedByteArray).hex_encode())
	return out


func _reader(t: PKeyTestContext, f: Dictionary) -> void:
	# The reader agrees with decode when fed one byte at a time.
	for r in f["decode"]:
		var stream := _hex(r["stream"])
		var rd := PKeyPeerFrame.Reader.new()
		var frames := []
		var closed := false
		for i in stream.size():
			var out := rd.push(stream.slice(i, i + 1))
			if not out["ok"]:
				closed = true
				break
			frames.append_array(out["frames"])
		var want: Dictionary = r["want"]
		var ok: bool = closed if want.has("error") else (not closed and _hexes(frames) == want["frames"])
		t.check("frame reader byte by byte %s" % r["id"], ok)
	# Linear work: three full frames trickled in a byte at a time (operations are counted, not timed).
	var big := PackedByteArray()
	for k in 3:
		big.append_array(PKeyPeerFrame.encode(_filled(7, 65535)))
	var rd2 := PKeyPeerFrame.Reader.new()
	var got := 0
	for i in big.size():
		got += (rd2.push(big.slice(i, i + 1))["frames"] as Array).size()
	t.check("frame reader trickle: three frames, linear copying", got == 3 and rd2.copied < 4 * big.size(), "%d copied for %d bytes" % [rd2.copied, big.size()])
	# A zero length kills the reader, and the dead reader refuses more.
	var dead := PKeyPeerFrame.Reader.new()
	t.check("frame reader: a zero length closes", not dead.push(PackedByteArray([0, 0]))["ok"])
	t.check("frame reader: and stays closed", not dead.push(PKeyPeerFrame.encode(PackedByteArray([1])))["ok"])
	# Many frames in one chunk, then a partial one.
	var chunk := PackedByteArray()
	for k in 5:
		chunk.append_array(PKeyPeerFrame.encode(PackedByteArray([k + 1])))
	chunk.append_array(PackedByteArray([0, 5, 1, 2]))
	var rd3 := PKeyPeerFrame.Reader.new()
	var first := rd3.push(chunk)
	t.check("frame reader: five frames, a partial held", first["ok"] and (first["frames"] as Array).size() == 5 and rd3.pending() == 4)
	var second := rd3.push(PackedByteArray([3, 4, 5]))
	t.check("frame reader: the partial completes", second["ok"] and _hexes(second["frames"]) == ["0102030405"] and rd3.pending() == 0)


# records

func _records(t: PKeyTestContext, r: Dictionary) -> void:
	t.check("record cap constants", PKeyPeerRecord.MAX_RECORD_BODY == 65516 and PKeyPeerRecord.MAX_CHAIN_RECORDS == 18 and PKeyPeerRecord.MAX_MESSAGE == 1048576 \
			and r["maxMessage"] == PKeyPeerRecord.MAX_MESSAGE)
	for p in r["parse"]:
		var got := PKeyPeerRecord.parse(_hex(p["plaintext"]))
		var want: Dictionary = p["want"]
		var ok: bool = false
		if want.has("error"):
			ok = not got["ok"]
		else:
			ok = got["ok"] and "%04x" % int(got["type"]) == want["type"] and ((int(got["flags"]) & 1) != 0) == want["more"] \
					and (got["body"] as PackedByteArray).hex_encode() == want["body"]
		t.check("record parse %s" % String(p["plaintext"]).left(12), ok)
	t.check("record encode", PKeyPeerRecord.encode(0x8001, 0, "ab".to_utf8_buffer()).hex_encode() == "8001006162" \
			and PKeyPeerRecord.encode(0x10000, 0, PackedByteArray()).is_empty() and PKeyPeerRecord.encode(1, 256, PackedByteArray()).is_empty())


func _types(t: PKeyTestContext, rows: Array) -> void:
	var ok: bool = rows.size() == PKeyPeerRecord.TYPES.size()
	for i in mini(rows.size(), PKeyPeerRecord.TYPES.size()):
		var c: Dictionary = rows[i]
		var row: Array = PKeyPeerRecord.TYPES[i]
		var body_len := int(c["bodyLen"]) if c.has("bodyLen") else -1
		ok = ok and row[0] == String(c["from"]).hex_to_int() and row[1] == String(c["to"]).hex_to_int() and row[2] == c["name"] \
				and row[3] == c["modes"] and row[4] == body_len
	t.check("the type table matches the corpus", ok)
	t.check("the named types are in the table", PKeyPeerRecord.row_of(PKeyPeerRecord.HELLO)[2] == "HELLO" and PKeyPeerRecord.row_of(PKeyPeerRecord.CLOSE)[2] == "CLOSE" \
			and PKeyPeerRecord.row_of(PKeyPeerRecord.KEYRING_WRAP)[2] == "SYNC" and PKeyPeerRecord.row_of(0x0007).is_empty())


func _sessions(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for s in rows:
		var asm := PKeyPeerRecord.Assembler.new(s["mode"])
		var delivered := []
		var close := {}
		var i := 0
		for rec in s["records"]:
			var r := asm.push({"type": String(rec["type"]).hex_to_int(), "flags": int(rec.get("flags", 0)), "body": _body(rec["body"])})
			if r["kind"] == &"close":
				close = {"close": String(r["code"]), "at": i}
				break
			if r["kind"] == &"message":
				delivered.append({"type": "%04x" % int(r["type"]), "length": (r["body"] as PackedByteArray).size(), "sha256": _sha(r["body"])})
			i += 1
		var want: Dictionary = s["want"]
		var ok: bool = false
		if want.has("close"):
			ok = not close.is_empty() and close["close"] == want["close"] and close["at"] == int(want["at"])
		else:
			ok = close.is_empty() and _same_delivered(delivered, want["delivered"])
		good += int(t.check("record session %s" % s["id"], ok))
	t.check("every record session ran", good == rows.size(), "%d/%d" % [good, rows.size()])


static func _same_delivered(got: Array, want: Array) -> bool:
	if got.size() != want.size():
		return false
	for i in got.size():
		if got[i]["type"] != want[i]["type"] or got[i]["length"] != int(want[i]["length"]) or got[i]["sha256"] != want[i]["sha256"]:
			return false
	return true


func _split(t: PKeyTestContext) -> void:
	var body := PackedByteArray()
	body.resize(1048576)
	for i in body.size():
		body[i] = i & 0xff
	var recs := PKeyPeerRecord.split_message(0x0100, body)
	t.check("split: 1 MiB is MAX_CHAIN_RECORDS - 1 records", recs.size() == PKeyPeerRecord.MAX_CHAIN_RECORDS - 1, str(recs.size()))
	var asm := PKeyPeerRecord.Assembler.new("a")
	var out := {}
	for raw in recs:
		var rec := PKeyPeerRecord.parse(raw)
		if not rec["ok"]:
			out = {"kind": &"close"}
			break
		out = asm.push(rec)
	t.check("split: the records reassemble to the message", out.get("kind") == &"message" and out["body"] == body)
	t.check("split: over 1 MiB is refused", PKeyPeerRecord.split_message(0x0100, _filled(0, 1048577)).is_empty())
	t.check("split: an empty body is one record", PKeyPeerRecord.split_message(0x0100, PackedByteArray()).size() == 1)
	# The assembler holds a bad mode out: nothing is allowed in a mode it does not know.
	var odd := PKeyPeerRecord.Assembler.new("")
	t.check("assembler: an unknown mode allows no type", odd.push({"type": 0x8001, "flags": 0, "body": PackedByteArray()}) == {"kind": &"close", "code": &"peer_not_allowed"})
	var odd2 := PKeyPeerRecord.Assembler.new("ax")
	t.check("assembler: a mode of two letters allows no type", odd2.push({"type": 0x8001, "flags": 0, "body": PackedByteArray()})["kind"] == &"close")
	t.check("assembler redacts itself", str(asm) == "PKeyPeerRecord.Assembler(a)")


# relay envelopes

static func _to_msg(x: Dictionary) -> Dictionary:
	var o := {"op": StringName(x["op"])}
	for k in x:
		if k == "op":
			continue
		var v: Variant = x[k]
		if k == "devices":
			var list: Array[PackedByteArray] = []
			for d in v:
				list.append(_hex(d))
			o[k] = list
		elif v is String:
			o[k] = _hex(v)
		else:
			o[k] = int(v)
	return o


static func _same_msg(a: Dictionary, b: Dictionary) -> bool:
	if a.size() != b.size():
		return false
	for k in a:
		if not b.has(k):
			return false
		if k == "devices":
			var da: Array = a[k]
			var db: Array = b[k]
			if da.size() != db.size():
				return false
			for i in da.size():
				if da[i] != db[i]:
					return false
		elif a[k] != b[k]:
			return false
	return true


func _relay(t: PKeyTestContext, r: Dictionary) -> void:
	t.check("relay max message", r["maxMessage"] == PKeyPeerRelayCodec.MAX_MESSAGE)
	for c in r["messages"]:
		var msg := _to_msg(c["message"])
		var bytes := _hex(c["bytes"])
		var got := PKeyPeerRelayCodec.decode(StringName(c["dir"]), bytes)
		t.check("relay %s encodes" % c["id"], PKeyPeerRelayCodec.encode(msg) == bytes)
		t.check("relay %s decodes" % c["id"], _same_msg(got, msg))
	for c in r["refused"]:
		t.check("relay refused %s" % c["id"], PKeyPeerRelayCodec.decode(StringName(c["dir"]), _hex(c["bytes"])).is_empty())
	for c in r["sizes"]:
		var b := _filled(String(c["bytes"]["fill"]).hex_to_int(), int(c["total"]))
		var prefix := _hex(c["bytes"]["prefix"])
		for i in prefix.size():
			b[i] = prefix[i]
		var got := PKeyPeerRelayCodec.decode(StringName(c["dir"]), b)
		t.check("relay size %s" % c["id"], got.is_empty() == c["want"].get("refused", false))
	var big := PackedByteArray([0x83])
	big.append_array(PackedByteArray([0, 0x20, 0, 0, 0, 0, 0, 0]))
	t.check("relay: a ring epoch of 2^53 is refused", PKeyPeerRelayCodec.decode(&"toClient", big).is_empty())
	big[2] = 0x1f
	for i in range(3, 9):
		big[i] = 0xff
	var ok_big := PKeyPeerRelayCodec.decode(&"toClient", big)
	t.check("relay: a ring epoch of 2^53 - 1 is read exactly", ok_big.get("epoch") == 9007199254740991)
	t.check("relay: a direction that is neither refuses", PKeyPeerRelayCodec.decode(&"sideways", PackedByteArray([2])).is_empty())


func _relay_encode_refusals(t: PKeyTestContext) -> void:
	var dev := _filled(0, 24)
	var noise := PackedByteArray([1])
	var bad := [
		{"op": &"send", "to": _filled(0, 23), "session": 1, "noise": noise},
		{"op": &"send", "to": dev, "session": 4294967296, "noise": noise},
		{"op": &"send", "to": dev, "session": -1, "noise": noise},
		{"op": &"send", "to": dev, "session": 1.0, "noise": noise},
		{"op": &"send", "to": dev, "session": true, "noise": noise},
		{"op": &"send", "to": dev, "session": 1, "noise": PackedByteArray()},
		{"op": &"send", "to": dev, "session": 1, "noise": _filled(0, 65536)},
		{"op": &"ping", "data": _filled(0, 7)},
		{"op": &"members", "devices": [dev, _filled(0, 23)]},
		{"op": &"ring", "epoch": -1},
		{"op": &"ring", "epoch": 9007199254740992},
		{"op": &"gone", "device": _filled(0, 25)},
		{"op": &"limit", "reason": 5},
		{"op": &"limit", "reason": 0},
		{"op": &"nope"},
		{},
	]
	var devices := []
	for i in 256:
		devices.append(dev)
	bad.append({"op": &"members", "devices": devices})
	var refused := 0
	for m in bad:
		refused += int(PKeyPeerRelayCodec.encode(m).is_empty())
	t.check("relay encode refuses what a layout cannot hold", refused == bad.size(), "%d/%d" % [refused, bad.size()])
	var maxed := PKeyPeerRelayCodec.encode({"op": &"send", "to": dev, "session": 4294967295, "noise": _filled(1, 65535)})
	t.check("relay encode: the largest send is exactly the maximum", maxed.size() == PKeyPeerRelayCodec.MAX_MESSAGE)
