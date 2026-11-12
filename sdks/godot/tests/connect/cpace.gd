extends RefCounted
# @pkey-feature connect.local
# The `cpace` section of `noise-vectors.json` (WIRE-CONTRACT-V5 section 15.12) through PKeyPeerCpace and the
# GDScript PKeyPeerCrypto port, mirroring the Node, Python, Swift and Kotlin runners: the draft's anchors,
# the Elligator 2 map, the generators, the share check, the frames C1 and C2, whole attempts (shares, K, ISK
# and PSK, both sides), the all-zero K abort, and the mode-q and mode-l Noise handshakes and failures with the
# PSK the attempt derives. The file is a generator-owned mirror under res://tests/corpus/v2/ and is never edited.

const VECTORS := "res://tests/corpus/v2/noise-vectors.json"

var _crypto := PKeyPeerCrypto.new()


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("noise-vectors.json parses", j.parse(FileAccess.get_file_as_string(VECTORS)) == OK and j.data is Dictionary):
		return
	var c: Dictionary = (j.data as Dictionary).get("cpace", {})
	if not t.check("the cpace section exists", c.has("suite") and c["suite"] == "CPACE-X25519-SHA512"):
		return
	t.check("the suite constants", c["dsi"] == PKeyPeerCpace.DSI and c["dsiIsk"] == PKeyPeerCpace.DSI_ISK and int(c["sInBytes"]) == PKeyPeerCpace.S_IN_BYTES)
	_anchors(t, c)
	_elligator(t, c)
	_generators(t, c)
	_shares(t, c)
	_frames(t, c)
	_attempts(t, c)
	_abort(t, c)
	_handshakes(t, c)
	_failures(t, c)
	_misuse(t)
	_platform_lane(t, c)


## The same rows through the native lane this runtime selects (CryptoKit, CNG or JCA), when there is one: its
## scalar multiplications must give the draft's and the corpus's answers, and refuse the same inputs. SHA-512 and the
## Elligator 2 map are GDScript on every runtime, so the generators and the frames need no second run.
func _platform_lane(t: PKeyTestContext, c: Dictionary) -> void:
	var lane := PKeyPeerCrypto.for_platform()
	if lane.lane_name() == "gdscript":
		t.info("cpace: no native lane in this runtime; the GDScript lane ran every row")
		return
	_crypto = lane
	t.check("cpace: the %s lane is the selected one" % lane.lane_name(), lane.known_answers_ok())
	_shares(t, c)
	_attempts(t, c)
	_abort(t, c)
	_handshakes(t, c)
	_failures(t, c)


func _hex(s: Variant) -> PackedByteArray:
	return (s as String).hex_decode() if s is String else PackedByteArray()


func _hx(b: PackedByteArray) -> String:
	return b.hex_encode()


func _anchors(t: PKeyTestContext, c: Dictionary) -> void:
	for a: Dictionary in c["anchors"]["vectors"]:
		var x: Dictionary = a["vector"]
		match a["id"]:
			"B.1.1":
				var gs := PKeyPeerCpace.generator_string(_hex(x["DSI"]), _hex(x["PRS"]), _hex(x["CI"]), _hex(x["sid"]), 128)
				t.check("B.1.1 generator string", _hx(gs) == x["generatorString"])
				var h := PKeySha512.hash(gs).slice(0, 32)
				t.check("B.1.1 hash", _hx(h) == x["hashGeneratorString"])
				var m: Variant = PKeyPeerCpace.elligator2(h)
				t.check("B.1.1 decoded field element", m != null and _hx(m["r"]) == x["decodedFieldElement"])
				t.check("B.1.1 generator", m != null and _hx(m["u"]) == x["g"])
			"B.1.2-B.1.5":
				var g := _hex(c["anchors"]["vectors"][0]["vector"]["g"])
				var ya: Variant = PKeyPeerCpace.share(_hex(x["ya"]), g, _crypto)
				var yb: Variant = PKeyPeerCpace.share(_hex(x["yb"]), g, _crypto)
				t.check("B.1.2 Ya", ya != null and _hx(ya) == x["Ya"])
				t.check("B.1.3 Yb", yb != null and _hx(yb) == x["Yb"])
				var k: Variant = _crypto.x25519(_hex(x["ya"]), _hex(x["Yb"]))
				var kb: Variant = _crypto.x25519(_hex(x["yb"]), _hex(x["Ya"]))
				t.check("B.1.4 K both sides", k != null and kb != null and _hx(k) == x["K"] and _hx(kb) == x["Kb"])
				var sid := _hex(c["anchors"]["vectors"][0]["vector"]["sid"])
				t.check("B.1.4 transcript_ir", _hx(PKeyPeerCpace.transcript_ir(_hex(x["Ya"]), _hex(x["ADa"]), _hex(x["Yb"]), _hex(x["ADb"]))) == x["transcriptIr"])
				var input := PKeyPeerCpace.lv_cat([PKeyPeerCpace.DSI_ISK.to_utf8_buffer(), sid, _hex(x["K"])])
				t.check("B.1.5 ISK input", _hx(input) == x["iskInput"].substr(0, input.size() * 2))
				input.append_array(_hex(x["transcriptIr"]))
				t.check("B.1.5 ISK", _hx(PKeySha512.hash(input)) == x["isk"])
			"B.1.10":
				var s := _hex(x["s"])
				var rows := 0
				for key: String in x["u"]:
					var out := PKeyCurve25519.x25519(s, _hex(x["u"][key]))
					t.check("B.1.10 %s X25519" % key, _hx(out) == x["q"][key])
					rows += 1
				t.check("B.1.10 rows", rows == (x["q"] as Dictionary).size() and rows > 0)
			_:
				for cs: Dictionary in x["cases"]:
					var got := PackedByteArray()
					match x["fn"]:
						"prepend_len":
							got = PKeyPeerCpace.prepend_len(_hex(cs["in"]))
						"lv_cat":
							got = PKeyPeerCpace.lv_cat((cs["in"] as Array).map(func(s: String) -> PackedByteArray: return _hex(s)))
						"transcript_ir":
							var p: Array = cs["in"]
							got = PKeyPeerCpace.transcript_ir(_hex(p[0]), _hex(p[1]), _hex(p[2]), _hex(p[3]))
						"o_cat":
							continue  # the parallel setting; the initiator-responder suite does not use it
					t.check("%s case" % a["id"], _hx(got) == cs["out"])


func _elligator(t: PKeyTestContext, c: Dictionary) -> void:
	t.check("elligator has rows", (c["elligator"] as Array).size() >= 17)
	for r: Dictionary in c["elligator"]:
		var m: Variant = PKeyPeerCpace.elligator2(_hex(r["input"]))
		t.check("elligator %s" % r["id"], m != null and _hx(m["r"]) == r["r"] and m["on_curve"] == r["onCurve"] and _hx(m["u"]) == r["u"])
	t.check("elligator refuses a short input", PKeyPeerCpace.elligator2(PackedByteArray([1, 2])) == null)


func _prs(g: Dictionary) -> PackedByteArray:
	return PKeyPeerCpace.prs_code(g["secret"]) if g["kind"] == "code" else PKeyPeerCpace.prs_qr(_hex(g["secret"]))


func _generators(t: PKeyTestContext, c: Dictionary) -> void:
	for g: Dictionary in c["generators"]:
		var prs := _prs(g)
		t.check("generator %s prs" % g["id"], _hx(prs) == g["prs"])
		var gs := PKeyPeerCpace.generator_string(PKeyPeerCpace.DSI.to_utf8_buffer(), prs, _hex(g["ci"]), _hex(g["sid"]), 128)
		t.check("generator %s string" % g["id"], _hx(gs) == g["generatorString"])
		var h := PKeySha512.hash(gs).slice(0, 32)
		t.check("generator %s hash" % g["id"], _hx(h) == g["hash"])
		t.check("generator %s g" % g["id"], _hx(PKeyPeerCpace.generator(prs, _hex(g["ci"]), _hex(g["sid"]))) == g["g"])


func _shares(t: PKeyTestContext, c: Dictionary) -> void:
	for s: Dictionary in c["shares"]:
		var v := PKeyPeerCpace.check_share(_hex(s["share"]))
		var want: Dictionary = s["want"]
		t.check("share %s" % s["id"], v.ok == want["ok"] and (v.ok or String(v.code) == want["reason"]))


func _frames(t: PKeyTestContext, c: Dictionary) -> void:
	for f: Dictionary in c["frames"]["c1"]:
		var v := PKeyPeerCpace.parse_c1(_hex(f["frame"]))
		t.check("c1 %s" % f["id"], _frame_matches(v, f["want"]))
	for f: Dictionary in c["frames"]["c2"]:
		var v := PKeyPeerCpace.parse_c2(_hex(f["frame"]))
		t.check("c2 %s" % f["id"], _frame_matches(v, f["want"]))
	var good: Dictionary = c["attempts"][0]
	t.check("encode_c1 code", _hx(PKeyPeerCpace.encode_c1("code", _hex(good["Ya"]))) == good["c1"])
	t.check("encode_c2", _hx(PKeyPeerCpace.encode_c2(_hex(good["Yb"]))) == good["c2"])
	var qr: Dictionary = c["attempts"].filter(func(a: Dictionary) -> bool: return a["id"] == "qr")[0]
	t.check("encode_c1 qr", _hx(PKeyPeerCpace.encode_c1("qr", _hex(qr["Ya"]))) == qr["c1"])


func _frame_matches(v: PKeyResult, want: Dictionary) -> bool:
	if v.ok != want["ok"]:
		return false
	if not v.ok:
		return String(v.code) == want["reason"]
	var d: Dictionary = v.detail
	return _hx(d["share"]) == want["share"] and (not want.has("kind") or d["kind"] == want["kind"])


func _prs_of(kind: String, secret: String) -> PackedByteArray:
	return PKeyPeerCpace.prs_code(secret) if kind == "code" else PKeyPeerCpace.prs_qr(_hex(secret))


## One side of an attempt: the generator, then the share.
func _side(a: Dictionary, who: String, scalar: String) -> Dictionary:
	var prs := _prs_of(a["kind"], a[who + "Secret"])
	var g := PKeyPeerCpace.generator(prs, PKeyPeerNoise.prologue(a[who + "Slug"], "q"), _hex(a[who + "Sid"]))
	var y: Variant = PKeyPeerCpace.share(_hex(scalar), g, _crypto)
	return {"g": g, "y": y}


func _attempts(t: PKeyTestContext, c: Dictionary) -> void:
	for a: Dictionary in c["attempts"]:
		var id: String = a["id"]
		var joiner := _side(a, "joiner", a["ya"])
		var shower := _side(a, "shower", a["yb"])
		t.check("attempt %s generators" % id, _hx(joiner["g"]) == a["joinerG"] and _hx(shower["g"]) == a["showerG"])
		var ya: PackedByteArray = joiner["y"] if joiner["y"] != null else PackedByteArray()
		var yb: PackedByteArray = shower["y"] if shower["y"] != null else PackedByteArray()
		if a.get("reflect"):
			yb = ya.duplicate()  # the responder sends the initiator's share back
		else:
			t.check("attempt %s Yb" % id, _hx(yb) == a["Yb"])
		t.check("attempt %s Ya" % id, _hx(ya) == a["Ya"])
		t.check("attempt %s frames" % id, _hx(PKeyPeerCpace.encode_c1(a["kind"], ya)) == a["c1"] and _hx(PKeyPeerCpace.encode_c2(yb)) == a["c2"])
		t.check("attempt %s the frames parse" % id, PKeyPeerCpace.parse_c1(_hex(a["c1"])).ok and PKeyPeerCpace.parse_c2(_hex(a["c2"])).ok)
		var jk: Variant = _crypto.x25519(_hex(a["ya"]), yb)
		var sk: Variant = _crypto.x25519(_hex(a["yb"]), ya)
		t.check("attempt %s K" % id, jk != null and sk != null and _hx(jk) == a["joinerK"] and _hx(sk) == a["showerK"])
		var ji: Variant = PKeyPeerCpace.isk(_hex(a["joinerSid"]), _hex(a["ya"]), ya, yb, "initiator", _crypto)
		var si: Variant = PKeyPeerCpace.isk(_hex(a["showerSid"]), _hex(a["yb"]), ya, yb, "responder", _crypto)
		t.check("attempt %s ISK" % id, ji != null and si != null and _hx(ji) == a["joinerIsk"] and _hx(si) == a["showerIsk"])
		if ji == null or si == null:
			continue
		t.check("attempt %s agree" % id, (ji == si) == a["agree"])
		var jp := PKeyPeerCpace.psk(ji, a["joinerSlug"])
		var sp := PKeyPeerCpace.psk(si, a["showerSlug"])
		t.check("attempt %s PSK" % id, _hx(jp) == a["joinerPsk"] and _hx(sp) == a["showerPsk"] and (jp == sp) == a["agree"])


func _abort(t: PKeyTestContext, c: Dictionary) -> void:
	var scalar := _hex(c["abort"]["scalar"])
	for r: Dictionary in c["abort"]["rows"]:
		var u := _hex(r["u"])
		var k := PKeyCurve25519.x25519(scalar, u)
		t.check("abort %s K" % r["id"], _hx(k) == r["k"])
		t.check("abort %s the port refuses an all-zero K" % r["id"], r["kAllZero"] == (_crypto.x25519(scalar, u) == null))
		t.check("abort %s share" % r["id"], r["shareRefused"] == (not PKeyPeerCpace.check_share(u).ok))
		if r["kAllZero"]:
			var ya := _hex(c["attempts"][0]["Ya"])
			var sid := _hex(c["attempts"][0]["joinerSid"])
			t.check("abort %s ISK is null" % r["id"], PKeyPeerCpace.isk(sid, scalar.duplicate(), ya, u, "initiator", _crypto) == null)


func _hs_side(h: Dictionary, init: bool, psk: Variant) -> Dictionary:
	return {
		"prologue": h["prologue"], "psk": psk,
		"static": h["initStatic" if init else "respStatic"], "ephemeral": h["initEphemeral" if init else "respEphemeral"],
	}


## Runs `payloads` through two handshakes, alternating writers from the initiator. Answers
## {wire, failed_at (-1 none), reason, init, resp}.
func _run_handshake(protocol: String, init: Dictionary, resp: Dictionary, payloads: Array, swap: Variant = null) -> Dictionary:
	var made: Array = []
	for i in 2:
		var s: Dictionary = init if i == 0 else resp
		var psk: Variant = _hex(s["psk"]) if s.get("psk") else null
		var port: PKeyPeerCrypto = null
		if i == 0 and swap != null:
			port = SwapPublic.new(_hex(s["ephemeral"]), swap)
		var r := PKeyPeerNoise.start("initiator" if i == 0 else "responder", protocol, _hex(s["prologue"]), _hex(s["static"]), psk, _hex(s["ephemeral"]), port)
		if not r.ok:
			return {"wire": [], "failed_at": -2, "reason": String(r.code), "init": null, "resp": null}
		made.append(r.detail)
	var out := {"wire": [], "failed_at": -1, "reason": "", "init": made[0], "resp": made[1]}
	for idx in payloads.size():
		var w: PKeyPeerNoise.Handshake = made[idx % 2]
		var d: PKeyPeerNoise.Handshake = made[(idx + 1) % 2]
		var wr := w.write_message(payloads[idx])
		if not wr.ok:
			out["failed_at"] = idx
			out["reason"] = String(wr.code)
			return out
		out["wire"].append(wr.detail)
		var rd := d.read_message(wr.detail)
		if not rd.ok:
			out["failed_at"] = idx
			out["reason"] = String(rd.code)
			return out
	return out


## The reference swaps the initiator's ephemeral public key before it mixes it; so does this.
class SwapPublic extends PKeyPeerCrypto:
	var priv: PackedByteArray
	var pub: PackedByteArray

	func _init(p_priv: PackedByteArray, p_pub: PackedByteArray) -> void:
		priv = p_priv
		pub = p_pub

	func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
		return pub if private_key == priv else super.x25519_public(private_key)


func _handshakes(t: PKeyTestContext, c: Dictionary) -> void:
	var modes := []
	for h: Dictionary in c["handshakes"]:
		var id: String = h["id"]
		modes.append(h["mode"])
		t.check("%s prologue" % id, _hx(PKeyPeerNoise.prologue(h["slug"], h["mode"])) == h["prologue"])
		if h["mode"] == "q":
			var a: Dictionary = c["attempts"].filter(func(x: Dictionary) -> bool: return x["id"] == h["attempt"])[0]
			t.check("%s isk is the attempt's" % id, h["isk"] == a["joinerIsk"])
			t.check("%s psk from the ISK" % id, _hx(PKeyPeerCpace.psk(_hex(h["isk"]), h["slug"])) == h["psk"])
		var hs: Array = h["messages"].filter(func(m: Dictionary) -> bool: return m["kind"] == "handshake")
		var payloads: Array = hs.map(func(m: Dictionary) -> PackedByteArray: return _hex(m["payload"]))
		var run := _run_handshake(h["protocol"], _hs_side(h, true, h["psk"]), _hs_side(h, false, h["psk"]), payloads)
		t.check("%s handshake completes" % id, run["failed_at"] == -1, "%s at %d" % [run["reason"], run["failed_at"]])
		if run["failed_at"] != -1:
			continue
		var wire_ok: bool = (run["wire"] as Array).size() == hs.size()
		for k in hs.size():
			wire_ok = wire_ok and (run["wire"][k] as PackedByteArray).hex_encode() == hs[k]["ciphertext"]
		t.check("%s handshake messages byte for byte" % id, wire_ok)
		var i: PKeyPeerNoise.Handshake = run["init"]
		var r: PKeyPeerNoise.Handshake = run["resp"]
		t.check("%s handshake hash" % id, _hx(i.handshake_hash()) == h["handshakeHash"] and _hx(r.handshake_hash()) == h["handshakeHash"])
		t.check("%s remote statics" % id, _hx(i.remote_static()) == h["respStaticPublic"] and _hx(r.remote_static()) == h["initStaticPublic"])
		var ti: PKeyPeerNoise.Transport = i.transport().detail
		var tr: PKeyPeerNoise.Transport = r.transport().detail
		var good := true
		var records := 0
		for m: Dictionary in h["messages"]:
			if m["kind"] != "transport":
				continue
			records += 1
			var src: PKeyPeerNoise.Transport = ti if m["from"] == "i" else tr
			var dst: PKeyPeerNoise.Transport = tr if m["from"] == "i" else ti
			var ct := src.send.encrypt(PackedByteArray(), _hex(m["payload"]))
			good = good and ct.ok and _hx(ct.detail) == m["ciphertext"]
			var pt := dst.receive.decrypt(PackedByteArray(), ct.detail) if ct.ok else ct
			good = good and pt.ok and _hx(pt.detail) == m["payload"]
			if m.get("rekeyAfter"):
				good = good and src.send.rekey().ok and dst.receive.rekey().ok
		t.check("%s transport records and rekey byte for byte" % id, good and records > 0)
	modes.sort()
	t.check("the handshake rows cover modes l and q", modes == ["l", "q"])


func _failures(t: PKeyTestContext, c: Dictionary) -> void:
	t.check("there are failure rows for both modes", (c["failures"] as Array).size() >= 14)
	for f: Dictionary in c["failures"]:
		var rp: Variant = f.get("responderPsk") if f.get("responderPsk") else f.get("psk")
		var payloads: Array = (f["payloads"] as Array).map(func(p: String) -> PackedByteArray: return _hex(p))
		var run := _run_handshake(
				f["protocol"],
				{"prologue": f["prologue"], "psk": f.get("psk"), "static": f["initStatic"], "ephemeral": f["initEphemeral"]},
				{"prologue": f["responderPrologue"] if f.get("responderPrologue") else f["prologue"], "psk": rp, "static": f["respStatic"], "ephemeral": f["respEphemeral"]},
				payloads,
				_hex(f["initEphemeralPublic"]) if f.get("initEphemeralPublic") else null)
		t.check("failure %s" % f["id"], run["failed_at"] == int(f["failedAt"]) and run["reason"] == f["reason"], "%s at %s" % [run["reason"], run["failed_at"]])


func _misuse(t: PKeyTestContext) -> void:
	t.check("prs_code refuses a short password", PKeyPeerCpace.prs_code("12345").is_empty())
	t.check("prs_code refuses a signed password", PKeyPeerCpace.prs_code("-12345").is_empty() and PKeyPeerCpace.prs_code("+12345").is_empty())
	t.check("prs_code refuses letters", PKeyPeerCpace.prs_code("12a456").is_empty())
	t.check("prs_qr refuses a short secret", PKeyPeerCpace.prs_qr(PackedByteArray([1])).is_empty())
	t.check("generator refuses an empty PRS", PKeyPeerCpace.generator(PackedByteArray(), PackedByteArray(), PackedByteArray()).is_empty())
	var s := PackedByteArray()
	s.resize(32)
	s.fill(7)
	var peer := _crypto.x25519_public(s)
	var kept := s.duplicate()
	var out: Variant = PKeyPeerCpace.isk(PackedByteArray([1]), s, peer, peer, "initiator", _crypto)
	t.check("isk overwrites the scalar", out != null and s == _zeros(32) and kept != s)
	t.check("scalar is 32 random bytes", PKeyPeerCpace.scalar(_crypto).size() == 32)


func _zeros(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b
