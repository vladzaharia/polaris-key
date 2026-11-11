extends RefCounted
# @pkey-feature connect.local
# The `local` section of `peer-matrix.json` (WIRE-CONTRACT-V5 section 15.12, account-free local pairing) through
# PKeyPeerLocal and its machines, mirroring the Node, Python, Swift and Kotlin runners: the constants, the code,
# the QR, the adverts, the TXT parsers, the LOCAL_LINK body, the link secret, the handshake payloads, the window,
# the join plan with its dial budget, the nameplate memory, the renewal floor and the join reasons, the exchange
# guard, the pin, the listener's trial order, the record rules, the gate, and the `admission` rows of a listener
# that holds no account key. Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edited). The
# `xfer` rows of mode l run in the xfer group.

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var m: Dictionary = (j.data as Dictionary)["local"]
	_constants(t, m)
	_codes(t, m["codes"])
	_qr(t, m["qr"])
	_adverts(t, m["adverts"])
	_txt(t, m["txt"])
	_body(t, m["body"])
	_secrets(t, m["secrets"])
	_payloads(t, m["handshakePayloads"])
	_exchange(t, m["exchange"])
	_pin(t, m["pin"])
	_trial_order(t, m["trialOrder"], m["constants"])
	_records(t, m["records"])
	_gate(t, m["gate"])
	_admission(t, m["admission"], m["constants"])
	_windows(t, m["window"])
	_joins(t, m)
	_memory(t, m)


# -- helpers ----------------------------------------------------------------------------------

func _hex(s: Variant) -> PackedByteArray:
	return (s as String).hex_decode() if s is String else PackedByteArray()


## A byte stream drawn n bytes at a time; answers null when it runs out. `consumed()` is the bytes read.
class Stream extends RefCounted:
	var data: PackedByteArray
	var at := 0


	func _init(hex: String) -> void:
		data = hex.hex_decode()


	func _to_string() -> String:
		return "Stream(%d)" % at


	func draw(n: int) -> Variant:
		if at + n > data.size():
			return null
		var out := data.slice(at, at + n)
		at += n
		return out


## JSON numbers come back as floats; integral ones are compared as ints.
static func _norm(v: Variant) -> Variant:
	if v is float and v == floorf(v):
		return int(v)
	if v is Array:
		return (v as Array).map(_norm)
	if v is Dictionary:
		var out := {}
		for k: Variant in v:
			out[k] = _norm(v[k])
		return out
	return v


func _same(a: Variant, b: Variant) -> bool:
	return JSON.stringify(_norm(a), "", true) == JSON.stringify(_norm(b), "", true)


func _constants(t: PKeyTestContext, m: Dictionary) -> void:
	var c: Dictionary = m["constants"]
	t.check("constants", [
		PKeyPeerLocal.LOCAL_PAIR_SECONDS, PKeyPeerLocal.LOCAL_CODE_DIGITS, PKeyPeerLocal.LOCAL_PAIR_FAILURES,
		PKeyPeerLocal.LOCAL_QR_SECRET_BYTES, PKeyPeerLocal.LOCAL_JOIN_CANDIDATES, PKeyPeerLocal.LOCAL_JOIN_BROWSE_SECONDS,
		PKeyPeerLocal.MAX_LOCAL_LINKS, PKeyPeerLocal.MAX_LIVE_LOCAL_ADVERTS, PKeyPeerLocal.MAX_LINK_SECRETS,
		PKeyPeerLocal.LOCAL_LINK_BODY_MAX, PKeyPeerContact.MAX_CONTACT_SECRETS, PKeyPeerContact.CONTACT_EXCHANGE_SECONDS,
		PKeyPeerAdvert.ADVERT_EPOCH_SECONDS, PKeyPeerLimiter.GROUP_PER_MINUTE,
		PKeyPeerLocalWindow.C1_PER_WINDOW, PKeyPeerLocalJoin.KEPT, PKeyPeerLocalJoin.DialBudget.BUDGET_SECONDS,
		PKeyPeerLocalMemory.RenewFloor.COOLDOWN_SECONDS, PKeyPeerLocalMemory.RenewFloor.WRONG_SECONDS, PKeyPeerLocalMemory.RenewFloor.WRONG_LIMIT,
	] == [
		int(c["pairSeconds"]), int(c["codeDigits"]), int(c["pairFailures"]),
		int(c["qrSecretBytes"]), int(c["joinCandidates"]), int(c["joinBrowseSeconds"]),
		int(c["maxLinks"]), int(c["maxLiveAdverts"]), int(c["maxLinkSecrets"]),
		int(c["bodyMax"]), int(c["maxContactSecrets"]), int(c["exchangeSeconds"]),
		int(m["adverts"]["epochSeconds"]), int(c["admissionGroupPerMinute"]),
		5, 8, int(m["nameplateMemory"]["seconds"]),
		int(m["renewFloor"]["cooldownSeconds"]), int(m["renewFloor"]["wrongSeconds"]), int(m["renewFloor"]["wrongLimit"]),
	])
	t.check("the link secrets are the contact secrets and the links", int(c["maxLinkSecrets"]) == int(c["maxContactSecrets"]) + int(c["maxLinks"]))


# -- codes, QR, adverts -----------------------------------------------------------------------

func _codes(t: PKeyTestContext, c: Dictionary) -> void:
	t.check("codes: row counts", (c["nameplate"] as Array).size() > 0 and (c["password"] as Array).size() > 0)
	for r: Dictionary in c["nameplate"]:
		var s := Stream.new(r["stream"])
		var got := PKeyPeerLocal.draw_nameplate(s.draw, r["inUse"])
		var want: Variant = r["want"]["nameplate"]
		t.check("nameplate %s" % r["id"], (got == "" if want == null else got == want) and s.at == int(r["want"]["consumed"]))
	for r: Dictionary in c["password"]:
		var s := Stream.new(r["stream"])
		var got := PKeyPeerLocal.draw_password(s.draw)
		var want: Variant = r["want"]["password"]
		t.check("password %s" % r["id"], (got == "" if want == null else got == want) and s.at == int(r["want"]["consumed"]))
	for r: Dictionary in c["display"]:
		t.check("display %s" % r["id"], PKeyPeerLocal.display_code(r["nameplate"], r["password"]) == r["want"])
	for r: Dictionary in c["parse"]:
		var got := PKeyPeerLocal.parse_code(r["text"])
		var w: Dictionary = r["want"]
		t.check("parse %s" % r["id"], got["ok"] == w["ok"] and (not w["ok"] or (got["nameplate"] == w["nameplate"] and got["password"] == w["password"])))
	t.check("display refuses a short code", PKeyPeerLocal.display_code("4", "123456") == "")
	var back := PKeyPeerLocal.parse_code(PKeyPeerLocal.display_code("48", "000123"))
	t.check("a displayed code reads back", back["ok"] and back["nameplate"] == "48" and back["password"] == "000123")


func _qr(t: PKeyTestContext, q: Dictionary) -> void:
	for r: Dictionary in q["make"]:
		t.check("qr make %s" % r["id"], PKeyPeerLocal.pairing_instance(_hex(r["sid"])) == r["instance"] \
				and PKeyPeerLocal.make_qr(r["slug"], r["instance"], _hex(r["secret"])) == r["want"])
	for r: Dictionary in q["parse"]:
		var got := PKeyPeerLocal.parse_qr(r["text"], r["own"])
		var w: Dictionary = r["want"]
		var ok: bool = got["result"] == w["result"]
		if ok and w["result"] == "ok":
			ok = got["slug"] == w["slug"] and got["instance"] == w["instance"] and PKeyPeerAdvert.base32_lower(got["secret"]) == w["secret"]
		t.check("qr parse %s" % r["id"], ok)
	t.check("qr make refuses a short secret", PKeyPeerLocal.make_qr("demo", "p1-eivpnfxzf7kyktlm", PackedByteArray([1])) == "")
	t.check("qr make refuses a bad slug", PKeyPeerLocal.make_qr("De mo", "p1-eivpnfxzf7kyktlm", _hex("790aac25cde75796b76ca788a194f151")) == "")


func _adverts(t: PKeyTestContext, a: Dictionary) -> void:
	for r: Dictionary in a["pairing"]:
		t.check("advert pairing %s" % r["id"], PKeyPeerLocal.pairing_instance(_hex(r["sid"])) == r["instance"])
	for r: Dictionary in a["names"]:
		t.check("advert name %s" % r["id"], PKeyPeerLocal.local_instance(_hex(r["secret"]), _hex(r["ownLinkKey"]), int(r["epoch"])) == r["instance"])
	for r: Dictionary in a["browse"]:
		var links: Array = []
		for k: Dictionary in r["links"]:
			links.append({"secret": _hex(k["secret"]), "peer_key": _hex(k["peerKey"])})
		var got := PKeyPeerLocal.browse_local_instance(r["instance"], links, int(r["now"]))
		var w: Variant = r["want"]
		var ok: bool = got.is_empty() if w == null else (got.get("link") == int(w["link"]) and got.get("epoch_back") == int(w["epochBack"]))
		t.check("advert browse %s" % r["id"], ok)


func _txt(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var got := PKeyPeerAdvert.parse_txt(r["entries"]) if r["parser"] == "txt" else PKeyPeerLocal.parse_local_txt(r["entries"])
		t.check("txt %s" % r["id"], _same(got, r["want"]), "%s" % got)


func _body_bytes(r: Dictionary) -> PackedByteArray:
	if r.has("bodyHex"):
		return _hex(r["bodyHex"])
	if r.has("bodyPad"):
		var p: Dictionary = r["bodyPad"]
		return (String(p["prefix"]) + String(p["fill"]).repeat(int(p["count"])) + String(p["suffix"])).to_utf8_buffer()
	return String(r["body"]).to_utf8_buffer()


func _body(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var b := _body_bytes(r)
		var got := PKeyPeerLocal.parse_local_link(b)
		var w: Dictionary = r["want"]
		var ok: bool = b.size() == int(r["length"]) and got["ok"] == w["ok"]
		if ok and w["ok"]:
			ok = got.get("label") == w.get("label") and _same(got["cats"], w["cats"])
			# What a side builds, the peer reads back.
			var built := PKeyPeerLocal.build_local_link({"cats": got["cats"], "label": got.get("label")})
			ok = ok and built.ok and _same(PKeyPeerLocal.parse_local_link(built.detail), got)
		t.check("body %s" % r["id"], ok)
	t.check("build refuses nine categories", not PKeyPeerLocal.build_local_link({"cats": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}).ok)


func _secrets(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var got := PKeyPeerLocal.local_link_secret(_hex(r["h"]), _hex(r["isk"]), _hex(r["keyA"]), _hex(r["keyB"]))
		t.check("secret %s" % r["id"], got.hex_encode() == r["secret"])
	t.check("secret refuses a short key", PKeyPeerLocal.local_link_secret(_hex("00"), _hex("00"), _hex("00"), _hex("00")).is_empty())


func _payloads(t: PKeyTestContext, h: Dictionary) -> void:
	for r: Dictionary in h["payloads"]:
		var b := _hex(r["payloadHex"]) if r.has("payloadHex") else String(r["payload"]).to_utf8_buffer()
		var got := PKeyPeerPayload.parse_handshake_payload(r["mode"], int(r["message"]), b)
		var w: Dictionary = r["want"]
		var ok: bool = b.size() == int(r["length"]) and got["ok"] == w["ok"]
		if ok and got["ok"] and w.has("caps"):
			ok = _same(got["caps"], w["caps"])
		t.check("payload %s" % r["id"], ok)
	for r: Dictionary in h["negotiate"]:
		var got := PKeyPeerLocal.negotiate_local_caps(r["mode"], r["local"], r["remote"])
		var w: Dictionary = r["want"]
		t.check("negotiate %s" % r["id"], _same(got["caps"], w["caps"]) and got.get("close") == w.get("close") \
				and _same(PKeyPeerPayload.caps_intersection(r["local"], r["remote"]), got["caps"]))


# -- machines ---------------------------------------------------------------------------------

func _exchange(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var x := PKeyPeerLocalExchange.new(int(r["held"]), r["cats"])
		var got: Array = []
		for s: Dictionary in r["steps"]:
			var e := {"event": s["event"]}
			if s["event"] == "peer-link":
				e["body"] = String(s["body"]).to_utf8_buffer()
			got.append(x.step(e))
		t.check("exchange %s" % r["id"], _same(got, r["want"]), "%s" % JSON.stringify(got))


func _pin(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var got := {}
		if r["mode"] == "l":
			var ok := PKeyPeerLocal.local_pin(_hex(r["held"][int(r["matched"])]), _hex(r["remoteStatic"]))
			got = {"ok": true} if ok else {"ok": false, "close": "peer_revoked", "sends": 0}
		else:
			var ok := PKeyPeerLocal.pairing_remote_ok(_hex(r["own"]), _hex(r["remoteStatic"]))
			got = {"ok": true} if ok else {"ok": false, "close": "silent", "sends": 0}
		# The initiator asks after message 2, the responder after message 3.
		t.check("pin %s" % r["id"], _same(got, r["want"]) and int(r["checkedAfter"]) == (2 if r["role"] == "initiator" else 3))


func _trial_order(t: PKeyTestContext, rows: Array, c: Dictionary) -> void:
	for r: Dictionary in rows:
		var plan := PKeyPeerLocal.listener_trial_order(r["account"], (r["contacts"] as Array).size(), (r["locals"] as Array).size())
		var tried: Array = []
		var hit: Variant = null
		var close: Variant = null
		var asked := false
		for e: Dictionary in plan:
			if e["kind"] != "a" and not asked:
				# The contact limiter admits the secret trial once; a refusal tries no secret.
				asked = true
				if r["limiter"] == "refuse":
					close = "peer_busy"
					break
			var name := "%s:%d" % [e["kind"], e["index"]]
			tried.append(name)
			var o: Variant = r["opens"]
			if o != null and o["mode"] == e["kind"]:
				var key: Variant = o.get("key") if o["mode"] == "a" else (o.get("contact") if o["mode"] == "c" else o.get("link"))
				if key != null and int(key) == e["index"]:
					hit = name
					break
		if hit == null and close == null:
			close = "handshake_failed"
		var behind: bool = (r["contacts"] as Array).size() + (r["locals"] as Array).size() > 0
		var got := {
			"tried": tried, "hit": hit, "slot": hit != null and not String(hit).begins_with("a"), "close": close,
			"dummy": PKeyPeerLocal.trial_padding(tried.size()) if close == "handshake_failed" and behind else 0,
		}
		t.check("trial order %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))
	t.check("trial total", PKeyPeerLocal.TRIAL_TOTAL == 2 + int(c["maxContactSecrets"]) + int(c["maxLinks"]))


func _records(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var type := String(r["type"]).hex_to_int()
		var body := PackedByteArray()
		body.resize(8 if type == 0x0004 or type == 0x0005 else 0)
		var asm := PKeyPeerRecord.Assembler.new(r["mode"])
		var got := asm.push({"type": type, "flags": 0, "body": body})
		var w: Dictionary = r["want"]
		var ok: bool = false
		if w.get("ignored") == true:
			ok = got["kind"] == &"ignored"
		elif w.get("allowed") == true:
			var row := PKeyPeerRecord.row_of(type)
			ok = got["kind"] == &"message" and not row.is_empty() and row[2] == w["name"] and PKeyPeerRecord.needs_of(type) == String(w.get("needs", ""))
		else:
			ok = got["kind"] == &"close" and String(got["code"]) == w["close"]
		t.check("record %s" % r["id"], ok, "%s" % got)


func _gate(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var g := PKeyPeerLocalGate.new(r["start"])
		var got: Array = []
		for s: Dictionary in r["steps"]:
			if s.has("call"):
				got.append({"cached": g.state(), "call": g.check() if PKeyPeerLocalGate.GATED_CALLS.has(s["call"]) else "ok"})
				continue
			var effects: Array = []
			match s["read"]:
				"ok":
					effects = g.read_ok(s.get("body"))
				"not-found":
					effects = g.read_not_found()
				_:
					effects = g.read_error()
			var row := {"cached": g.state()}
			if not effects.is_empty():
				row["effects"] = effects
			got.append(row)
		t.check("gate %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))


func _admission(t: PKeyTestContext, rows: Array, c: Dictionary) -> void:
	for r: Dictionary in rows:
		var clock := [0.0]
		var lim := PKeyPeerLimiter.new(int(c["admissionSharedPerMinute"]), int(c["admissionWaiting"]), func() -> float: return clock[0], int(c["admissionGroupPerMinute"]))
		var holds := {}
		var verdicts := {}
		var got: Array = []
		var events: Array = r["events"]
		for i in events.size():
			var e: Dictionary = events[i]
			clock[0] = float(e["t"])
			if e.has("settle"):
				var k := int(e["settle"])
				var a0: PKeyPeerLimiter.LocalAdmission = verdicts[k]
				verdicts.erase(k)
				var opens: bool = events[k]["opens"]
				if opens:
					holds[k] = a0.hit()
				else:
					a0.miss()
				got.append({"result": "settled", "hit": opens})
				continue
			if e.has("release"):
				var k := int(e["release"])
				if holds.has(k):
					(holds[k] as PKeyPeerLimiter.Ticket).release()
					holds.erase(k)
				got.append({"result": "released"})
				continue
			var a := lim.begin_local(e["group"])
			if not a["ok"]:
				got.append({"result": "refused", "by": a["by"]})
				continue
			var adm: PKeyPeerLimiter.LocalAdmission = a["admission"]
			if e.get("later"):
				verdicts[i] = adm
				got.append({"result": "tried"})
				continue
			if e["opens"]:
				holds[i] = adm.hit()
			else:
				adm.miss()
			got.append({"result": "tried", "hit": e["opens"]})
		var want: Array = []
		for w: Dictionary in r["want"]:
			var kept := {}
			for k: String in w:
				if not ["group", "failed", "waiting"].has(k):
					kept[k] = w[k]
			want.append(kept)
		t.check("admission %s" % r["id"], _same(got, want), JSON.stringify(got))
		for h: Variant in holds.values():
			(h as PKeyPeerLimiter.Ticket).release()


func _windows(t: PKeyTestContext, rows: Array) -> void:
	for r: Dictionary in rows:
		var w := PKeyPeerLocalWindow.new()
		var last := 0
		var got: Array = []
		for s: Dictionary in r["steps"]:
			var tm := float(s.get("t", 0))
			var ident := int(s.get("id", last))
			var out := {}
			match s["event"]:
				"open":
					out = w.open(tm)
				"c1":
					out = w.c1(tm, s["valid"])
					if out.has("id"):
						last = int(out["id"])
				"begin-guess":
					out = {"result": "permit" if w.begin_guess(ident, tm) else "denied"}
				"msg1":
					var v: Variant = w.msg1(ident, tm, s["opens"])
					out = v if v != null else {"result": "denied"}
				"guess-opened":
					out = w.guess_opened(ident, tm)
				"guess-failed":
					out = w.guess_failed(ident, tm)
				"abandon":
					out = w.abandon(ident, tm)
				"rotated":
					w.rotated(tm)
				"session-end":
					out = w.session_end(tm, s["stored"])
				"tick":
					w.tick(tm)
				"close":
					out = w.close(tm)
			var row := {}
			for k in ["result", "id"]:
				if out.has(k):
					row[k] = out[k]
			var st := w.state()
			row["open"] = st["open"]
			row["holder"] = null if st["holder"] == "" else st["holder"]
			row["failures"] = st["failures"]
			row["rotations"] = st["rotations"]
			row["closed"] = null if st["closed"] == "" else st["closed"]
			if out.has("host"):
				row["host"] = out["host"]
			got.append(row)
		t.check("window %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))


func _joins(t: PKeyTestContext, m: Dictionary) -> void:
	for r: Dictionary in m["joinBudget"]:
		var budget := PKeyPeerLocalJoin.DialBudget.new()
		var got: Array = []
		for jn: Dictionary in r["joins"]:
			if jn["input"]["kind"] == "qr":
				got.append({"allowed": true, "used": 0})
				continue
			var verdict := budget.check(jn["input"]["nameplate"], float(jn["t"]))
			if verdict["allowed"]:
				budget.spend(jn["input"]["nameplate"], float(jn["t"]), int(jn["dials"]))
			got.append(verdict)
		t.check("join budget %s" % r["id"], _same(got, r["want"]))
	for r: Dictionary in m["join"]:
		var plan := PKeyPeerLocalJoin.new(r["input"])
		for a: Dictionary in r["adverts"]:
			plan.see(a["instance"], a["h"] == "current" or a["h"] == "previous", a["n"])
		var dialled: Array = []
		for outcome: String in r["dials"]:
			var nxt := plan.next()
			if nxt == "":
				break
			dialled.append(nxt)
			plan.ended(outcome)
		var got := {"browsed": plan.browses(), "kept": plan.kept(), "dialled": dialled, "result": plan.result()}
		t.check("join %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))
	t.check("join reasons precedence", _same(m["joinReasons"]["precedence"], ["invalid", "other-app", "spent-at-start", "wrong", "spent-mid-join"]))
	for r: Dictionary in m["joinReasons"]["rows"]:
		var input: Dictionary = r["input"]
		var plan := PKeyPeerLocalJoin.new(input)
		if input["kind"] == "code":
			var budget := PKeyPeerLocalJoin.DialBudget.new()
			budget.spend(input["nameplate"], 0.0, int(r["budget"]))
			if not budget.check(input["nameplate"], 1.0)["allowed"]:
				plan.start_spent()
		# Two matching adverts, so a plan that browses has a dial for each outcome.
		for n in ["a", "b"]:
			plan.see(input["instance"] if input["kind"] == "qr" else "p1-" + n, true, input["nameplate"] if input["kind"] == "code" else "00")
		for outcome: String in r["dials"]:
			if plan.next() == "":
				break
			plan.ended(outcome)
		var want: Dictionary = r["want"]
		var reason := plan.reason()
		t.check("join reason %s" % r["id"], plan.result() == want["result"] and (reason == "" if want["reason"] == null else reason == want["reason"]))
	var b := PKeyPeerLocalJoin.DialBudget.new()
	var texts := ["", "4", "ab12", "4 -", "４８"]
	var none := true
	for s: String in texts:
		none = none and PKeyPeerLocalJoin.dials_left(b, s, 0.0) == -1
	t.check("dials_left reads two ASCII digits only", none and PKeyPeerLocalJoin.dials_left(b, " 4-8 12 34", 0.0) == 2)
	b.spend("48", 0.0, 1)
	t.check("dials_left is two less the dials spent", PKeyPeerLocalJoin.dials_left(b, "48", 1.0) == 1 \
			and PKeyPeerLocalJoin.dials_left(b, "49", 1.0) == 2 and PKeyPeerLocalJoin.dials_left(b, "48", 300.0) == 2)


func _memory(t: PKeyTestContext, m: Dictionary) -> void:
	for r: Dictionary in m["nameplateMemory"]["rows"]:
		var memory := PKeyPeerLocalMemory.new()
		var got: Array = []
		for e: Dictionary in r["events"]:
			if e.has("shown"):
				memory.shown(e["shown"], float(e["t"]))
				continue
			var s := Stream.new(e["draw"])
			var n := memory.draw(s.draw, float(e["t"]))
			got.append({"nameplate": null if n == "" else n, "consumed": s.at})
		t.check("nameplate memory %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))
	for r: Dictionary in m["renewFloor"]["rows"]:
		var renew := PKeyPeerLocalMemory.RenewFloor.new()
		var got: Array = []
		for e: Dictionary in r["events"]:
			if e.has("ended"):
				renew.ended(e["ended"], float(e["t"]))
			else:
				var v := renew.check(float(e["t"]))
				got.append({"allowed": v["allowed"], "retryIn": v["retry_in"]})
		t.check("renew floor %s" % r["id"], _same(got, r["want"]), JSON.stringify(got))
