extends RefCounted
# @pkey-feature connect.transfer
# The `xfer` section of `peer-matrix.json` (WIRE-CONTRACT-V5 section 15.11) through PKeyPeerXfer:
# the constants, the 155 codec rows, the 22 name rows (partial path and shown name) and the 197
# machine rows (window, offer, hash, ending, resume, limits) replayed step by step, as the Node,
# Python and Kotlin runners do, with exact counts; plus what the corpus cannot say (the big-endian
# CHUNK offset, tokens that are not wire integers, a name that is not cut, the create effect's
# meta). Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const SECTIONS := ["window", "offer", "hash", "ending", "resume", "limits"]
const ID_A := "D9FghtxWIhxlaxzwysyg4w"
const ID_B := "mM6QZzGG1pHeEeIOBHXPjQ"
const SHA_EMPTY := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK \
			and j.data is Dictionary):
		return
	var x: Dictionary = (j.data as Dictionary)["xfer"]
	_constants(t, x["constants"])
	var c: Dictionary = x["codecs"]
	t.check("codec row counts", (c["offer"] as Array).size() == 69 \
			and (c["offsetBodies"] as Array).size() == 38 and (c["done"] as Array).size() == 12 \
			and (c["cancel"] as Array).size() == 18 and (c["chunk"] as Array).size() == 18)
	_codecs(t, c)
	t.check("name row counts", (x["name"]["paths"] as Array).size() == 7 \
			and (x["name"]["rows"] as Array).size() == 15)
	_names(t, x["name"])
	var want := {"window": 39, "offer": 54, "hash": 16, "ending": 38, "resume": 39, "limits": 11}
	var ran := 0
	for s in SECTIONS:
		var rows: Array = x[s]
		t.check("%s row count" % s, rows.size() == int(want[s]), "%d" % rows.size())
		for r in rows:
			ran += int(_row(t, s, r))
	t.check("every machine row ran green", ran == 197, "%d/197" % ran)
	# Mode l (section 15.12): the category rule of mode c applies, and the session runs transfers.
	var local_rows: Array = (j.data as Dictionary)["local"]["xfer"]
	t.check("mode l row count", local_rows.size() == 7, "%d" % local_rows.size())
	var local_ran := 0
	for r in local_rows:
		local_ran += int(_row(t, "local", r))
	t.check("every mode l row ran green", local_ran == local_rows.size(), "%d/%d" % [local_ran, local_rows.size()])
	_extras(t)
	_delivered(t)


func _constants(t: PKeyTestContext, c: Dictionary) -> void:
	t.check("constants", [
		PKeyPeerXfer.MAX_CONTROL_BYTES, PKeyPeerXfer.MAX_SIZE, PKeyPeerXfer.DEFAULT_CHUNK,
		PKeyPeerXfer.MAX_CHUNK, PKeyPeerXfer.WINDOW, PKeyPeerXfer.ACK_EVERY,
		PKeyPeerXfer.MAX_TRANSFERS, PKeyPeerXfer.CONSENT_SECONDS, PKeyPeerXfer.IDLE_SECONDS,
		PKeyPeerXfer.PARTIAL_SECONDS, PKeyPeerXfer.MAX_PARTIALS_PER_PEER, PKeyPeerXfer.ENDED_IDS,
	] == [
		int(c["maxControlBytes"]), int(c["maxSize"]), int(c["defaultChunk"]), int(c["maxChunk"]),
		int(c["window"]), int(c["ackEvery"]), int(c["maxTransfers"]), int(c["consentSeconds"]),
		int(c["idleSeconds"]), int(c["partialSeconds"]), int(c["maxPartialsPerPeer"]),
		int(c["endedIds"]),
	])


## JSON numbers come back as floats; integral ones are compared as ints.
static func _norm(v: Variant) -> Variant:
	if v is float and v == floorf(v):
		return int(v)
	if v is Array:
		var a: Array = []
		for e in v:
			a.append(_norm(e))
		return a
	if v is Dictionary:
		var d := {}
		for k in v:
			d[k] = _norm(v[k])
		return d
	return v


static func _same(a: Variant, b: Variant) -> bool:
	return JSON.stringify(_norm(a), "", true) == JSON.stringify(_norm(b), "", true)


static func _body(r: Dictionary) -> PackedByteArray:
	if r.has("bodyHex"):
		return String(r["bodyHex"]).hex_decode()
	if r.has("bodyPad"):
		var p: Dictionary = r["bodyPad"]
		return (String(p["prefix"]) + String(p["fill"]).repeat(int(p["count"])) + String(p["suffix"])).to_utf8_buffer()
	return String(r["body"]).to_utf8_buffer()


static func _content(lo: int, hi: int, flip := false) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(hi - lo)
	for i in range(lo, hi):
		var v := (i * 7 + 13) & 0xFF
		b[i - lo] = v ^ (0xFF if flip else 0)
	return b


## The Python runner's `_verdict`: {ok = false}, or {ok = true} plus the members (`key` wraps them).
static func _verdict(v: Dictionary, key := "") -> Dictionary:
	if not v["ok"]:
		return {"ok": false}
	if key == "":
		return v
	return {"ok": true, key: v[key]}


func _codecs(t: PKeyTestContext, c: Dictionary) -> void:
	var good := 0
	for r in c["offer"]:
		var b := _body(r)
		var ok := b.size() == int(r["length"]) and _same(
				PKeyPeerXfer.parse_offer(b, int(r["maxMessage"])), r["want"])
		good += int(t.check("offer %s" % r["id"], ok))
	for r in c["offsetBodies"]:
		var got := PKeyPeerXfer.parse_offset(r["kind"], _body(r), int(r["size"]), int(r["chunk"]))
		good += int(t.check("offset body %s" % r["id"], _same(got, r["want"])))
	for r in c["done"]:
		good += int(t.check("done %s" % r["id"],
				_same(PKeyPeerXfer.parse_done(_body(r), r["toward"]), r["want"])))
	for r in c["cancel"]:
		good += int(t.check("cancel %s" % r["id"],
				_same(PKeyPeerXfer.parse_cancel(_body(r)), r["want"])))
	for r in c["chunk"]:
		var body := String(r["head"]).hex_decode()
		var data := PackedByteArray()
		data.resize(int(r["dataLength"]))
		data.fill(0xAB)
		body.append_array(data)
		var got := PKeyPeerXfer.parse_chunk(body, int(r["size"]), int(r["chunk"]), int(r["expect"]))
		good += int(t.check("chunk %s" % r["id"], _same(got, r["want"])))
	t.check("every codec row ran green", good == 155, "%d/155" % good)


func _names(t: PKeyTestContext, n: Dictionary) -> void:
	var good := 0
	for r in n["paths"]:
		good += int(t.check("partial path %s" % r["id"], PKeyPeerXfer.partial_path(
				String(r["key"]).hex_decode(), r["xferId"], r["sha256"]) == r["path"]))
	var key := String(n["key"]).hex_decode()
	for r in n["rows"]:
		var p := PKeyPeerXfer.parse_offer(_body(r), 1048576)
		var ok: bool = p["ok"]
		if ok:
			var o: Dictionary = p["offer"]
			ok = PKeyDeviceLabel.clean_name(o.get("name")) == r["display"] \
					and o.get("type") == r.get("type") \
					and PKeyPeerXfer.partial_path(key, o["id"], o["sha256"]) == r["path"]
		good += int(t.check("name %s" % r["id"], ok))
	t.check("every name row ran green", good == 22, "%d/22" % good)


# the machine rows

## The Python runner's `_merge`: consecutive CHUNKS of one id, back to back, are one.
static func _merge(w: Dictionary) -> Dictionary:
	if not w.has("send"):
		return w
	var send: Array = []
	for s in w["send"]:
		var last: Variant = send.back() if not send.is_empty() else null
		if s["t"] == "CHUNKS" and last != null and last["t"] == "CHUNKS" and last["id"] == s["id"] \
				and int(last["offset"]) + int(last["bytes"]) == int(s["offset"]):
			last["bytes"] = int(last["bytes"]) + int(s["bytes"])
		else:
			send.append((s as Dictionary).duplicate())
	var out := w.duplicate()
	out["send"] = send
	return out


## An output as the corpus writes it: only the members that apply.
static func _want(o: Dictionary) -> Dictionary:
	var w := {}
	if not (o["send"] as Array).is_empty():
		w["send"] = o["send"]
	if String(o["close"]) != "":
		w["close"] = String(o["close"])
	if o["ask"] != null:
		w["ask"] = o["ask"]
	if not (o["withdraw"] as Array).is_empty():
		w["withdraw"] = o["withdraw"][0] if (o["withdraw"] as Array).size() == 1 else o["withdraw"]
	if not (o["results"] as Array).is_empty():
		w["result"] = o["results"][0] if (o["results"] as Array).size() == 1 else o["results"]
	var partial: Array = []
	for e in o["partial"]:
		if e.has("write"):
			continue
		var d: Dictionary = e.duplicate()
		d.erase("meta")
		partial.append(d)
	if not partial.is_empty():
		w["partial"] = partial
	if String(o["refused"]) != "":
		w["refused"] = o["refused"]
	if o["drop"]:
		w["drop"] = true
	return w


## The machine a corpus row describes (its ctx): the handlers, the kept partials and the re-read.
func machine_of(c: Dictionary) -> PKeyPeerXfer.Machine:
	var corrupt := {}
	var partials: Array = []
	for p in c["partials"]:
		corrupt[p["ref"]] = p.get("corrupt") == true
		if p.get("otherPeer") == true:
			continue
		var q: Dictionary = _norm(p)
		q.erase("corrupt")
		q.erase("otherPeer")
		partials.append(q)
	var nxt := [1]
	var handlers := {
		"none": Callable(),
		"ask": func(_a: Dictionary) -> String: return "ask",
		"decline": func(_a: Dictionary) -> String: return "decline",
		"accept": func(_a: Dictionary) -> String: return "accept",
	}
	var rehash := func(ref: String, offset: int) -> Variant:
		var h := PKeyPeerXfer.new_hasher()
		h.update(_content(0, offset, corrupt.get(ref, false)))
		return h
	var new_ref := func(_i: String, _s: String) -> String:
		var n: int = nxt[0]
		nxt[0] = n + 1
		return "n%d" % n
	var cats: Array = c["cats"]
	var free: int = -1 if c["free"] == null else int(c["free"])
	return PKeyPeerXfer.Machine.new({
		"mode": c["mode"],
		"caps": PKeyPeerPayload.caps_intersection(c["capsLocal"], c["capsRemote"]),
		"max_message": int(c["maxMessage"]),
		"host_limit": -1 if c["hostLimit"] == null else int(c["hostLimit"]),
		"free": func() -> int: return free,
		"handler": handlers[c["handler"]],
		"categories": cats,
		"peer_key": String(c["peerKey"]).hex_decode(),
		"partials": partials,
		"rehash": rehash,
		"new_ref": new_ref,
		"withhold_acks": c.get("withholdAcks") == true,
	})


func _row(t: PKeyTestContext, section: String, row: Dictionary) -> bool:
	var mach := machine_of(row["ctx"])
	var got: Array = []
	var wants: Array = []
	for w in row["want"]:
		wants.append(_merge(_norm(w)))
	for st in row["steps"]:
		var at := float(st["at"])
		var out: Dictionary
		if st.has("host"):
			match String(st["host"]):
				"tick":
					out = mach.tick(at)
				"offer":
					out = mach.offer(at, {
						"id": st["id"], "size": int(st["size"]), "chunk": int(st["chunk"]),
						"sha256": st["sha256"], "cat": st.get("cat"),
						"seekable": st.get("seekable", true),
					})
				"consent":
					out = mach.consent(at, st["id"], st["answer"])
				"cancel":
					out = mach.cancel(at, st["id"])
				"close":
					out = mach.close(at)
				"newSession":
					out = mach.new_session(at)
				_:
					return t.check("%s/%s: host step" % [section, row["id"]], false, String(st["host"]))
		else:
			var more: bool = st.get("more") == true
			match String(st["rx"]):
				"PING":
					out = mach.tick(at)
				"OFFER":
					out = mach.receive(at, PKeyPeerXfer.OFFER, String(st["body"]).to_utf8_buffer(), more)
				"ACCEPT", "ACK":
					var ty := PKeyPeerXfer.ACCEPT if st["rx"] == "ACCEPT" else PKeyPeerXfer.ACK
					out = mach.receive(at, ty, PKeyPeerXfer.offset_body(st["id"], int(st["offset"])), more)
				"CHUNK":
					var off := int(st["offset"])
					var data := _content(off, off + int(st["length"]), st.get("data") == "corrupt")
					out = mach.receive(at, PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(st["id"], off, data), more)
				"DONE":
					out = mach.receive(at, PKeyPeerXfer.DONE,
							PKeyPeerXfer.done_body(st["id"], st.get("sha256", "")), more)
				"CANCEL":
					out = mach.receive(at, PKeyPeerXfer.CANCEL,
							PKeyPeerXfer.cancel_body(st["id"], st["reason"]), more)
				_:
					return t.check("%s/%s: rx step" % [section, row["id"]], false, String(st["rx"]))
		got.append(_merge(_want(out)))
	return t.check("%s/%s" % [section, row["id"]], _same(got, wants))


# what the corpus cannot say

func _extras(t: PKeyTestContext) -> void:
	# CHUNK: the offset is big-endian, written by hand.
	var cb := PKeyPeerXfer.chunk_body(ID_A, 0x0102030405, PackedByteArray([9]))
	t.check("chunk body is id, u64 big-endian, data",
			cb.size() == 25 and cb.slice(16, 24) == PackedByteArray([0, 0, 0, 1, 2, 3, 4, 5]) and cb[24] == 9)
	t.check("chunk body round trip at 2^40 - 1",
			PKeyPeerXfer.parse_chunk(PKeyPeerXfer.chunk_body(ID_A, 1099511627775, PackedByteArray([1])),
					1099511627776, 4, 1099511627775)["ok"])
	var huge := PKeyPeerXfer.chunk_body(ID_A, 0, PackedByteArray([1]))
	huge[16] = 0x80
	t.check("an offset with the top bit set is refused", not PKeyPeerXfer.parse_chunk(huge, 10, 4, 0)["ok"])
	# OFFER: a size at the ceiling is exact; fraction and exponent tokens are not wire integers.
	var ob := PKeyPeerXfer.offer_body({"id": ID_A, "size": 1099511627776, "sha256": SHA_EMPTY, "chunk": 65492, "cat": "docs"})
	var po := PKeyPeerXfer.parse_offer(ob, 1048576)
	t.check("offer body round trip at 2^40", po["ok"] and po["offer"]["size"] == 1099511627776 \
			and po["offer"]["cat"] == "docs")
	for size_text in ["1.0", "6e4", "01", "1099511627777"]:
		var text := '{"id":"%s","size":%s,"sha256":"%s","chunk":1}' % [ID_A, size_text, SHA_EMPTY]
		t.check("offer refuses size %s" % size_text,
				not PKeyPeerXfer.parse_offer(text.to_utf8_buffer(), 1048576)["ok"])
	# The shown name: not cut at 64 code points; null when nothing is left or it is not a string.
	t.check("a long name is not cut", String(PKeyDeviceLabel.clean_name("n".repeat(200))).length() == 200)
	t.check("a non-string name has none", PKeyDeviceLabel.clean_name(5) == null)
	t.check("decomposed accents are composed (NFC)", PKeyDeviceLabel.clean_name("é") == "é")
	# The create effect names the transfer for the store.
	var m := PKeyPeerXfer.Machine.new({
		"mode": "a", "caps": ["xfer/1"], "max_message": 1048576,
		"peer_key": _key(),
		"handler": func(_a: Dictionary) -> String: return "accept",
	})
	var out := m.receive(0.0, PKeyPeerXfer.OFFER, ('{"id":"%s","size":10,"sha256":"%s","chunk":4}' % [ID_A, SHA_EMPTY]).to_utf8_buffer())
	var created: Dictionary = (out["partial"][0] as Dictionary) if not (out["partial"] as Array).is_empty() else {}
	t.check("create carries meta and the derived name", created.get("create") == PKeyPeerXfer.partial_path(_key(), ID_A, SHA_EMPTY) \
			and _same(created.get("meta"), {"id": ID_A, "sha256": SHA_EMPTY, "size": 10, "chunk": 4}))
	t.check("a machine does not print its state", str(m) == "PKeyPeerXfer.Machine()")
	# A write effect carries the bytes the record held.
	var wrote := m.receive(1.0, PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 0, _content(0, 4)))
	t.check("a write effect carries the data", not (wrote["partial"] as Array).is_empty() \
			and wrote["partial"][0]["write"] == created["create"] and wrote["partial"][0]["data"] == _content(0, 4))
	# An invalid host offer is refused locally, never thrown.
	t.check("an offer with a bad id is refused", m.offer(2.0, {"id": "x", "size": 1, "chunk": 1, "sha256": SHA_EMPTY})["refused"] == "invalid")


static func _key() -> PackedByteArray:
	var k := PackedByteArray()
	k.resize(32)
	k.fill(7)
	return k


# a re-offer of delivered content

static func _sha_of(b: PackedByteArray) -> String:
	var h := PKeyPeerXfer.new_hasher()
	h.update(b)
	return h.finish().hex_encode()


static func _done_body(id: String, sha := "") -> PackedByteArray:
	return PKeyPeerXfer.done_body(id, sha)


func _rx(mem: PKeyPeerXferDelivered, key: PackedByteArray) -> PKeyPeerXfer.Machine:
	var o := {
		"mode": "a", "caps": ["xfer/1"], "max_message": 1048576, "peer_key": key,
		"handler": func(_a: Dictionary) -> String: return "accept",
	}
	if mem != null:
		o["delivered"] = mem.for_peer(key)
	return PKeyPeerXfer.Machine.new(o)


static func _offer(id: String, size: int, sha: String, chunk: int) -> PackedByteArray:
	return PKeyPeerXfer.offer_body({"id": id, "size": size, "sha256": sha, "chunk": chunk})


func _delivered(t: PKeyTestContext) -> void:
	var key := _key()
	var sha := _sha_of(_content(0, 2500))
	# Delivered once, then offered again on a new session.
	var mem := PKeyPeerXferDelivered.new()
	var m1 := _rx(mem, key)
	var o1 := m1.receive(1.0, PKeyPeerXfer.OFFER, _offer(ID_A, 2500, sha, 1000))
	t.check("delivered: a first offer is accepted at 0", o1["send"] == [{"t": "ACCEPT", "id": ID_A, "offset": 0}])
	for off in [0, 1000, 2000]:
		m1.receive(2.0, PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, off, _content(off, mini(2500, off + 1000))))
	var d1 := m1.receive(3.0, PKeyPeerXfer.DONE, _done_body(ID_A, sha))
	t.check("delivered: and delivered", d1["results"] == [{"id": ID_A, "outcome": "delivered"}])
	# Nothing is remembered until the driver has delivered the content.
	t.check("delivered: not remembered before the delivery", _rx(mem, key).receive(5.0, PKeyPeerXfer.OFFER, _offer(ID_A, 2500, sha, 1000))["send"] == [{"t": "ACCEPT", "id": ID_A, "offset": 0}])
	m1.remember_delivered(d1["delivered"], 3.0)
	var m2 := _rx(mem, key)
	var r2 := m2.receive(10.0, PKeyPeerXfer.OFFER, _offer(ID_A, 2500, sha, 1000))
	t.check("delivered: a re-offer is answered at the last chunk boundary", r2["send"] == [{"t": "ACCEPT", "id": ID_A, "offset": 2000}])
	t.check("delivered: with no question, no partial and no room check", r2["ask"] == null and (r2["partial"] as Array).is_empty())
	var c2 := m2.receive(11.0, PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_A, 2000, _content(2000, 2500)))
	t.check("delivered: the tail is read and acknowledged but stores nothing", c2["send"] == [{"t": "ACK", "id": ID_A, "offset": 2500}] and (c2["partial"] as Array).is_empty())
	var f2 := m2.receive(12.0, PKeyPeerXfer.DONE, _done_body(ID_A, sha))
	t.check("delivered: DONE answers and the result is flagged again", f2["send"] == [{"t": "DONE", "id": ID_A}]
			and f2["results"] == [{"id": ID_A, "outcome": "delivered", "again": true}] and (f2["partial"] as Array).is_empty())
	# A size that is a whole number of chunks accepts at the size; a wrong hash is refused without a result.
	var sha2k := _sha_of(_content(0, 2000))
	var m3 := _rx(mem, key)
	m3.receive(20.0, PKeyPeerXfer.OFFER, _offer(ID_B, 2000, sha2k, 1000))
	for off in [0, 1000]:
		m3.receive(21.0, PKeyPeerXfer.CHUNK, PKeyPeerXfer.chunk_body(ID_B, off, _content(off, off + 1000)))
	m3.remember_delivered(m3.receive(22.0, PKeyPeerXfer.DONE, _done_body(ID_B, sha2k))["delivered"], 22.0)
	var m4 := _rx(mem, key)
	var r4 := m4.receive(30.0, PKeyPeerXfer.OFFER, _offer(ID_B, 2000, sha2k, 1000))
	t.check("delivered: a whole number of chunks accepts at the size", r4["send"] == [{"t": "ACCEPT", "id": ID_B, "offset": 2000}])
	var bad := m4.receive(31.0, PKeyPeerXfer.DONE, _done_body(ID_B, "0".repeat(64)))
	t.check("delivered: a wrong hash cancels with hash and reports nothing", bad["send"] == [{"t": "CANCEL", "id": ID_B, "reason": "hash"}] and (bad["results"] as Array).is_empty())
	# A short tail (DONE before the tail) is a size cancel, also unreported.
	var m5 := _rx(mem, key)
	m5.receive(40.0, PKeyPeerXfer.OFFER, _offer(ID_A, 2500, sha, 1000))
	var early := m5.receive(41.0, PKeyPeerXfer.DONE, _done_body(ID_A, sha))
	t.check("delivered: a DONE before the tail cancels with size", early["send"] == [{"t": "CANCEL", "id": ID_A, "reason": "size"}] and (early["results"] as Array).is_empty(), str(early))
	# Received again for another peer, another hash or size, no memory, or after expiry.
	var offer_send := func(m: PKeyPeerXfer.Machine, at: float, size := 2000, h := sha2k) -> Array:
		return m.receive(at, PKeyPeerXfer.OFFER, _offer(ID_B, size, h, 1000))["send"]
	var fresh := [{"t": "ACCEPT", "id": ID_B, "offset": 0}]
	var other_key := PackedByteArray()
	other_key.resize(32)
	other_key.fill(9)
	t.check("delivered: another peer receives again", offer_send.call(_rx(mem, other_key), 50.0) == fresh)
	t.check("delivered: another size receives again", offer_send.call(_rx(mem, key), 50.0, 3000) == fresh)
	t.check("delivered: another hash receives again", offer_send.call(_rx(mem, key), 50.0, 2000, "1".repeat(64)) == fresh)
	t.check("delivered: no memory receives again", offer_send.call(_rx(null, key), 50.0) == fresh)
	t.check("delivered: still known on the 24-hour mark", offer_send.call(_rx(mem, key), 22.0 + PKeyPeerXfer.DELIVERED_SECONDS) == [{"t": "ACCEPT", "id": ID_B, "offset": 2000}])
	t.check("delivered: after 24 hours it receives again", offer_send.call(_rx(mem, key), 22.0 + PKeyPeerXfer.DELIVERED_SECONDS + 1.0) == fresh)
	var known := PKeyPeerXferDelivered.new()
	known.for_peer(key).add(ID_B, sha2k, 2000, 1.0)
	known.forget(key)
	t.check("delivered: forgetting a peer forgets its entries", offer_send.call(_rx(known, key), 10.0) == fresh)
	# A re-offer skips the consent: no question even when the handler would ask or decline.
	var asking := PKeyPeerXfer.Machine.new({
		"mode": "a", "caps": ["xfer/1"], "max_message": 1048576, "peer_key": key,
		"handler": func(_a: Dictionary) -> String: return "decline",
		"free": func() -> int: return 0,
		"delivered": _seeded(key, ID_B, sha2k, 2000),
	})
	var skip := asking.receive(5.0, PKeyPeerXfer.OFFER, _offer(ID_B, 2000, sha2k, 1000))
	t.check("delivered: a re-offer needs neither consent nor room", skip["send"] == [{"t": "ACCEPT", "id": ID_B, "offset": 2000}] and skip["ask"] == null)
	# The bounds: 64 per peer, 256 peers, oldest first.
	var bounded := PKeyPeerXferDelivered.new()
	var v := bounded.for_peer(_key())
	for i in PKeyPeerXfer.MAX_DELIVERED_PER_PEER + 1:
		v.add("id%d" % i, "a".repeat(64), 1, float(i))
	t.check("delivered: the oldest entry of a full peer goes first", not v.has("id0", "a".repeat(64), 1, 70.0) and v.has("id1", "a".repeat(64), 1, 70.0))
	for i in PKeyPeerXfer.MAX_DELIVERED_PEERS + 2:
		var k := PackedByteArray()
		k.resize(32)
		k.encode_u32(0, i)
		bounded.for_peer(k).add("x", "b".repeat(64), 1, 1.0)
	t.check("delivered: at most 256 peers are held", bounded.peer_count() == PKeyPeerXfer.MAX_DELIVERED_PEERS)
	bounded.clear()
	t.check("delivered: clear forgets all", bounded.peer_count() == 0)
	t.check("delivered: the memory prints nothing", str(bounded) == "PKeyPeerXferDelivered()")


func _seeded(key: PackedByteArray, id: String, sha: String, size: int) -> Object:
	var mem := PKeyPeerXferDelivered.new()
	var view := mem.for_peer(key)
	view.add(id, sha, size, 1.0)
	return view
