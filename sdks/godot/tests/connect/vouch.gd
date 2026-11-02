extends RefCounted
# @pkey-feature connect.protocol identity.nearby
# The `vouch` rows of `peer-matrix.json` (WIRE-CONTRACT-V5 section 15.6.1; 165 rows: requests 80,
# results 26, flows 30, finish 29) through PKeyPeerVouch, row for row as the Node, Python, Kotlin and
# Swift runners do, plus what the corpus cannot say: building a request, the decoys, the failure
# budget, the flow guard inside PKeyPeerSession (both directions, the pick before any verify, the
# held Sync records, hold_sas and the restarted code deadline) and the redaction of every type that
# holds a record. Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"

var _verifies := 0


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var v: Dictionary = (j.data as Dictionary)["vouch"]
	# Exact: a row added or dropped is a deliberate corpus change, never a silent one.
	t.check("vouch row counts", (v["requests"] as Array).size() == 80 and (v["results"] as Array).size() == 26 \
			and (v["flows"] as Array).size() == 30 and (v["finish"] as Array).size() == 29)
	_requests(t, v["requests"])
	_results(t, v["results"])
	_flows(t, v["flows"])
	_finish(t, v["finish"])
	_build(t)
	_decoys(t)
	_instance_and_budget(t)
	_redaction(t)
	await _session_flow(t)
	await _session_guards(t)
	await _session_hold_sas(t)
	await _session_deadlines(t)
	await _session_chain(t)


static func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


# -- requests ----------------------------------------------------------------------------------

static func _body(r: Dictionary) -> PackedByteArray:
	if r.has("bodyHex"):
		return _hex(r["bodyHex"])
	if r.has("bodyPad"):
		var p: Dictionary = r["bodyPad"]
		return (String(p["prefix"]) + String(p["fill"]).repeat(int(p["count"])) + String(p["suffix"])).to_utf8_buffer()
	return String(r["body"]).to_utf8_buffer()


func _requests(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var body := _body(r)
		var length_ok: bool = not r.has("length") or body.size() == int(r["length"])
		var got: Variant = PKeyPeerVouch.verify_request({
			"slug": r["slug"], "h": _hex(r["hHex"]), "hello": r["hello"], "body": body,
		})
		var ok := length_ok
		if r["verdict"] == "ok":
			var want: Dictionary = r["result"]
			ok = ok and got is Dictionary and got["request"] == want["request"] and got["device_id"] == want["deviceId"] \
					and got["sign_key"] == want["signKey"] and got["agree_key"] == want["agreeKey"] \
					and got["label"] == want["label"] and got["platform"] == want["platform"] and not got.has("sig")
		else:
			ok = ok and got == null and r["close"] == "peer_bad_frame"
		good += int(t.check("request %s" % r["id"], ok, str(r["note"])))
	t.check("every request row ran", good == 80, "%d/80" % good)


# -- results -----------------------------------------------------------------------------------

func _results(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var got := PKeyPeerVouch.parse_result(_body(r))
		var ok: bool = (got.has("refuse") and got["refuse"] == r["refuse"] and not got.has("status")) if r.has("refuse") \
				else (got.get("status") == r["status"] and not got.has("refuse"))
		good += int(t.check("result %s" % r["id"], ok))
	t.check("every result row ran", good == 26, "%d/26" % good)


# -- flows -------------------------------------------------------------------------------------

## One requester flow and one approver flow, the receiving end checking each record first, as the two
## ends of one session.
static func _run_flow(steps: Array) -> Dictionary:
	var d := PKeyPeerVouch.Flow.new("requester")
	var m := PKeyPeerVouch.Flow.new("approver")
	var delivered: Array = []
	var take := func(verdict: Dictionary, on_m: bool) -> Variant:
		if not verdict["ok"]:
			return String(verdict["close"])
		for rec: Dictionary in verdict["deliver"]:
			delivered.append(rec["at"])
			if on_m and rec["type"] == PKeyPeerRecord.VOUCH_REQ:
				m.verified()
		return null
	for i in steps.size():
		var s: Dictionary = steps[i]
		var ev: Variant = s.get("ev")
		var code: Variant = null
		if ev == "handshake":
			code = take.call(d.negotiate(s["capsD"], s["capsM"]), false)
			if code == null:
				code = take.call(m.negotiate(s["capsM"], s["capsD"]), false)
		elif ev == "shown":
			d.code_shown()
			m.code_shown()
		elif ev == "picked":
			code = take.call(m.picked(), true)
		elif ev == "wrong-pick" or ev == "none-match" or ev == "timeout":
			code = take.call(m.abandon(ev), false)
		elif ev == "confirmed":
			code = take.call(d.confirm_account(), false)
		elif ev == null:
			var type := String(s["type"]).hex_to_int()
			var body := PKeyPeerVouch.build_result(s["status"]) if type == PKeyPeerRecord.VOUCH_RESULT \
					else PackedByteArray()
			if not s.has("status"):
				body.resize(int(s.get("bytes", 0)))
			var record := {"type": type, "body": body, "at": i}
			var d2m: bool = s["dir"] == "d2m"
			var sender := d if d2m else m
			var receiver := m if d2m else d
			code = take.call(receiver.receive(record), receiver == m)
			# The sender's verdict only gates: what the receiver delivers is what counts.
			var sent: Dictionary = sender.send(record)
			if code == null and not sent["ok"]:
				code = String(sent["close"])
		else:
			return {"close": "unknown event", "at": i, "delivered": delivered}
		if code != null:
			return {"close": code, "at": i, "delivered": delivered}
	return {"close": null, "at": null, "delivered": delivered}


func _flows(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var got := _run_flow(r["steps"])
		var want: Dictionary = r["want"]
		var ok: bool = got["close"] == want["close"] and got["at"] == (null if want["at"] == null else int(want["at"]))
		var want_delivered: Array = (want["delivered"] as Array).map(func(x: Variant) -> int: return int(x))
		ok = ok and got["delivered"] == want_delivered
		good += int(t.check("flow %s" % r["id"], ok, "%s vs %s" % [got, want]))
	t.check("every flow row ran", good == 30, "%d/30" % good)


# -- finish ------------------------------------------------------------------------------------

func _finish(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var got := PKeyPeerVouch.finish_map({
			"http": r["http"], "body": r["body"], "discovery_nearby": r["discoveryNearby"], "keys_retried": r["keysRetried"],
		})
		var want: Dictionary = r["result"]
		var ok := false
		if want.has("send"):
			ok = got.size() == 1 and got.get("send") == want["send"]
		elif want.has("wait"):
			ok = got.size() == 1 and got.get("wait") == want["wait"]
		else:
			ok = got.get("close") == true and got.get("stop_advert") == want["stopAdvert"] and got.size() == 2
		good += int(t.check("finish %s" % r["id"], ok))
	t.check("every finish row ran", good == 29, "%d/29" % good)


# -- build -------------------------------------------------------------------------------------

func _build(t: PKeyTestContext) -> void:
	var store := PKeyDeviceKeyStore.memory_only()
	var h := PKeyTestPeers.random32()
	var handle := "nr_" + "A".repeat(22)
	var device := "B".repeat(32)
	var o := {"port": store, "slug": "demo", "h": h, "request": handle, "device_id": device, "hello": {"label": "Ana's Switch", "platform": "linux"}}
	var built := PKeyPeerVouch.build_request(o)
	t.check("build: a request is built", built.ok and (built.detail as PackedByteArray).size() <= PKeyPeerVouch.VOUCH_REQ_MAX, str(built.code))
	if not built.ok:
		return
	var body: PackedByteArray = built.detail
	var text := body.get_string_from_utf8()
	t.check("build: the members are in the documented order", text.begins_with('{"v":1,"request":"nr_') and text.find('"deviceId"') < text.find('"signKey"') \
			and text.find('"signKey"') < text.find('"agreeKey"') and text.find('"agreeKey"') < text.find('"label"') \
			and text.find('"label"') < text.find('"platform"') and text.find('"platform"') < text.find('"sig"'))
	var back: Variant = PKeyPeerVouch.verify_request({"slug": "demo", "h": h, "hello": o["hello"], "body": body})
	t.check("build: M verifies what D built", back is Dictionary and back["request"] == handle and back["device_id"] == device and back["label"] == "Ana's Switch")
	t.check("build: another session's h does not verify it", PKeyPeerVouch.verify_request({"slug": "demo", "h": PKeyTestPeers.random32(), "hello": o["hello"], "body": body}) == null)
	t.check("build: another product does not verify it", PKeyPeerVouch.verify_request({"slug": "other", "h": h, "hello": o["hello"], "body": body}) == null)
	t.check("build: another HELLO label does not match", PKeyPeerVouch.verify_request({"slug": "demo", "h": h, "hello": {"label": "Bo", "platform": "linux"}, "body": body}) == null)
	var nolabel := o.duplicate()
	nolabel["hello"] = {"platform": "linux"}
	var plain := PKeyPeerVouch.build_request(nolabel)
	t.check("build: no label in the HELLO means none in the request", plain.ok and not (plain.detail as PackedByteArray).get_string_from_utf8().contains('"label"'))
	# Bad inputs are values, never a throw.
	for bad in [{"h": PackedByteArray([1])}, {"request": "nr_short"}, {"device_id": "short"}, {"hello": {}}]:
		var b := o.duplicate()
		b.merge(bad, true)
		t.check("build: a bad input is refused (%s)" % bad.keys()[0], not PKeyPeerVouch.build_request(b).ok)
	# The seam: a counting verifier is not called for a body refused before the proof.
	_verifies = 0
	var counter := func(_sig: PackedByteArray, _msg: PackedByteArray, _key: PackedByteArray) -> bool:
		_verifies += 1
		return true
	PKeyPeerVouch.verify_request({"slug": "demo", "h": h, "hello": o["hello"], "body": "{}".to_utf8_buffer(), "verify": counter})
	t.check("build: a body refused by its shape runs no signature check", _verifies == 0)
	PKeyPeerVouch.verify_request({"slug": "demo", "h": h, "hello": o["hello"], "body": body, "verify": counter})
	t.check("build: a well-formed one runs exactly one", _verifies == 1)


# -- decoys, instance, budget -------------------------------------------------------------------

## A source of fixed words: each draw of 4 bytes is the next word, big-endian.
class Words extends RefCounted:
	var words: Array
	var at := 0


	func _init(w: Array) -> void:
		words = w


	func next(n: int) -> PackedByteArray:
		var out := PackedByteArray()
		if n == 4:
			var x: int = words[at % words.size()]
			at += 1
			out.append_array(PackedByteArray([(x >> 24) & 255, (x >> 16) & 255, (x >> 8) & 255, x & 255]))
		else:
			out.resize(n)
			out.fill(7)
		return out


func _decoys(t: PKeyTestContext) -> void:
	# Real 123456; draws 5, 123456 (a repeat of the real one, redrawn), 5 (a repeat, redrawn), 999999,
	# then the shuffle draws.
	var w := Words.new([5, 123456, 5, 999999, 0, 0])
	var r := PKeyPeerVouch.decoy_codes(123456, Callable(w, "next"))
	t.check("decoys: three distinct codes with the real one among them", r.ok and (r.detail["codes"] as Array).size() == 3 \
			and (r.detail["codes"] as Array).has(123456) and r.detail["codes"][r.detail["index"]] == 123456)
	t.check("decoys: a repeat is drawn again", r.ok and r.detail["codes"].count(5) == 1 and r.detail["codes"].count(999999) == 1 and r.detail["codes"].count(123456) == 1, str(r.detail))
	# Rejection sampling: a word at or above the limit is discarded, never reduced.
	var limit := 4294000000
	var w2 := Words.new([limit, limit + 1, 7, 8, 0, 0])
	var r2 := PKeyPeerVouch.decoy_codes(1, Callable(w2, "next"))
	t.check("decoys: draws over the rejection limit are discarded", r2.ok and (r2.detail["codes"] as Array).has(7) and (r2.detail["codes"] as Array).has(8) \
			and not (r2.detail["codes"] as Array).has(limit % 1000000), str(r2.detail if r2.ok else r2.code))
	# Every position of the real code is reachable.
	var seen := {}
	for k in 60:
		var rr := PKeyPeerVouch.decoy_codes(424242)
		t.check("decoys: the system source answers", rr.ok)
		if rr.ok:
			seen[int(rr.detail["index"])] = true
			var codes: Array = rr.detail["codes"]
			if codes.size() != 3 or codes[0] == codes[1] or codes[1] == codes[2] or codes[0] == codes[2] or codes[rr.detail["index"]] != 424242:
				t.check("decoys: shape", false, str(codes))
	t.check("decoys: the real code lands at every position", seen.size() == 3, str(seen.keys()))
	# Misuse is a value.
	t.check("decoys: a code out of range is refused", not PKeyPeerVouch.decoy_codes(-1).ok and not PKeyPeerVouch.decoy_codes(1000000).ok)
	t.check("decoys: a source that repeats is given up on", not PKeyPeerVouch.decoy_codes(5, Callable(Words.new([5]), "next")).ok)
	t.check("decoys: a source that answers the wrong size is given up on", not PKeyPeerVouch.decoy_codes(5, func(_n: int) -> PackedByteArray: return PackedByteArray()).ok)


func _instance_and_budget(t: PKeyTestContext) -> void:
	var name := PKeyPeerVouch.approver_instance()
	t.check("instance: p1- and 16 base32 characters", PKeyPeerAdvert.is_instance_name(name) and name.length() == 19, name)
	t.check("instance: a fresh one each time", PKeyPeerVouch.approver_instance() != name)
	t.check("instance: a bad source gives none", PKeyPeerVouch.approver_instance(func(_n: int) -> PackedByteArray: return PackedByteArray()) == "")
	var now := [0.0]
	var b := PKeyPeerVouch.FailureBudget.new(func() -> float: return now[0])
	t.check("budget: the first failure leaves the advert on", not b.fail() and not b.stopped())
	now[0] = 599.0
	t.check("budget: the second within 600 s stops it", b.fail() and b.stopped())
	t.check("budget: it stays stopped", b.fail() and b.stopped())
	b.reopen()
	t.check("budget: reopening starts the count again", not b.stopped() and not b.fail())
	now[0] = 599.0 + 600.0
	t.check("budget: a failure older than the window is forgotten", not b.fail() and not b.stopped())


func _redaction(t: PKeyTestContext) -> void:
	var f := PKeyPeerVouch.Flow.new("approver")
	f.negotiate(["vouch/1"], ["vouch/1"])
	f.receive({"type": PKeyPeerRecord.VOUCH_REQ, "body": "secret-body".to_utf8_buffer()})
	t.check("redaction: a flow's str() shows its role only", str(f) == "PKeyPeerVouch.Flow(approver)" and not str(f).contains("secret"))
	t.check("redaction: the budget's str() shows nothing", str(PKeyPeerVouch.FailureBudget.new()) == "PKeyPeerVouch.FailureBudget()")


# -- inside the session ---------------------------------------------------------------------------

## A mode v pair, established, with the codes shown on both sides.
func _pair(extra_d := {}) -> Array:
	var d := PKeyTestPeers.side("v", "initiator", PKeyTestPeers.random32(), extra_d)
	var m := PKeyTestPeers.side("v", "responder", PKeyTestPeers.random32())
	await d.session.start()
	await PKeyTestPeers.pump(d, m)
	return [d, m]


func _session_flow(t: PKeyTestContext) -> void:
	var sides := await _pair()
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	t.check("session: both show the same code", d.of(&"sas").size() == 1 and m.of(&"sas").size() == 1 and d.of(&"sas")[0]["code"] == m.of(&"sas")[0]["code"])
	d.session.vouch().shown()
	m.session.vouch().shown()
	d.session.confirm_sas()
	# D builds its request over this session's h, from the label and platform its HELLO carried.
	var built := PKeyPeerVouch.build_request({
		"port": PKeyDeviceKeyStore.memory_only(), "slug": PKeyTestPeers.SLUG, "h": d.session.handshake_hash(),
		"request": "nr_" + "C".repeat(22), "device_id": "D".repeat(32), "hello": {"platform": "test"},
	})
	t.check("session: D builds its request", built.ok)
	var req: PackedByteArray = built.detail
	t.check("session: D sends the request once it confirmed", d.session.send_record(PKeyPeerRecord.VOUCH_REQ, req).ok)
	await PKeyTestPeers.pump(d, m)
	t.check("session: M holds the request before the pick", m.of(&"record").is_empty() and not m.session.is_closed())
	t.check("session: and may not finish", not m.session.vouch().may_finish())
	# The host checks the signature only on a record it was handed: none yet, so no check ran.
	_verifies = 0
	var counter := func(sig: PackedByteArray, msg: PackedByteArray, key: PackedByteArray) -> bool:
		_verifies += 1
		return PKeyEd25519.verify(sig, msg, key)
	var shown: Dictionary = m.of(&"established")[0]["hello"]
	var host := func() -> Variant:
		for e in m.of(&"record"):
			if e["record_type"] == PKeyPeerRecord.VOUCH_REQ:
				return PKeyPeerVouch.verify_request({
					"slug": PKeyTestPeers.SLUG, "h": m.session.handshake_hash(), "hello": shown, "hello_cleaned": true,
					"body": e["body"], "verify": counter,
				})
		return null
	t.check("session: no verify ran before the pick", host.call() == null and _verifies == 0)
	m.session.confirm_sas()
	t.check("session: M's own confirmation does not release the request", m.of(&"record").is_empty() and host.call() == null and _verifies == 0)
	m.session.vouch().picked()
	var got := m.of(&"record")
	t.check("session: the pick delivers the request", got.size() == 1 and got[0]["record_type"] == PKeyPeerRecord.VOUCH_REQ and got[0]["body"] == req)
	t.check("session: still no approval before the request verified", not m.session.vouch().may_finish())
	var verified: Variant = host.call()
	t.check("session: the host verifies it once, after the pick", verified is Dictionary and _verifies == 1 and verified["device_id"] == "D".repeat(32), str(_verifies))
	m.session.vouch().verified()
	t.check("session: after the pick and a verified request, M may finish", m.session.vouch().may_finish())
	t.check("session: M answers approved", m.session.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved")).ok)
	t.check("session: and the answer is final", not m.session.vouch().may_finish())
	t.check("session: a Sync record follows an approval", m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(40)).ok)
	await PKeyTestPeers.pump(d, m)
	var at_d := d.of(&"record")
	t.check("session: D gets the result, and holds the wrap until it confirms the account", at_d.size() == 1 and at_d[0]["record_type"] == PKeyPeerRecord.VOUCH_RESULT, str(at_d.size()))
	d.session.vouch().confirm_account()
	at_d = d.of(&"record")
	t.check("session: confirm_account delivers the wrap", at_d.size() == 2 and at_d[1]["record_type"] == PKeyPeerRecord.KEYRING_WRAP and d.closes().is_empty())
	t.check("session: a second wrap after the confirmation goes straight through", m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8)).ok)
	await PKeyTestPeers.pump(d, m)
	t.check("session: delivered at once", d.of(&"record").size() == 3)


func _session_guards(t: PKeyTestContext) -> void:
	# D sends no request before its screen shows the code.
	var sides := await _pair()
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	d.session.confirm_sas()
	var r := d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	var ended: bool = d.closes() == [[&"peer_not_allowed", false]] and m.closes() == [[&"peer_not_allowed", true]]
	t.check("guard: a request before the code was shown is refused and ends the session", not r.ok and ended, str(d.closes()))

	# M never sends a request, and D never sends a result.
	sides = await _pair()
	d = sides[0]
	m = sides[1]
	m.session.vouch().shown()
	m.session.confirm_sas()
	var from_m := m.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	t.check("guard: M sending a VOUCH_REQ closes peer_not_allowed", not from_m.ok and m.closes() == [[&"peer_not_allowed", false]])
	sides = await _pair()
	d = sides[0]
	d.session.vouch().shown()
	d.session.confirm_sas()
	var from_d := d.session.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	t.check("guard: D sending a VOUCH_RESULT closes peer_not_allowed", not from_d.ok and d.closes() == [[&"peer_not_allowed", false]])

	# A result before a verified request is not M's to send.
	sides = await _pair()
	m = sides[1]
	m.session.vouch().shown()
	m.session.confirm_sas()
	var early := m.session.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	t.check("guard: M's result before a verified request closes peer_not_allowed", not early.ok and m.closes() == [[&"peer_not_allowed", false]])

	# On the receiving side too: a D that sends a result to M, a second request, a wrap.
	for case in ["result", "twice", "wrap"]:
		var raw := await _raw_pair()
		var records: Array
		match case:
			"result":
				records = [[PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved")]]
			"twice":
				records = [[PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer()], [PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer()]]
			_:
				records = [[PKeyPeerRecord.KEYRING_WRAP, _bytes(4)]]
		for rec in records:
			await _raw_send(raw, raw["m"], rec[0], rec[1])
		var want: StringName = &"peer_bad_frame" if case == "twice" else &"peer_not_allowed"
		var closes: Array = (raw["m"] as PKeyTestPeers.Peer).closes()
		t.check("guard: a %s from the wrong end closes %s on M" % [case, want], closes == [[want, false]], str(closes))

	# A record while M is still in the code step is refused, as before the flow existed.
	var unsettled := await _raw_pair(false)
	await _raw_send(unsettled, unsettled["m"], PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	var unsettled_closes: Array = (unsettled["m"] as PKeyTestPeers.Peer).closes()
	t.check("guard: a request before M's code is settled closes peer_not_allowed", unsettled_closes == [[&"peer_not_allowed", false]], str(unsettled_closes))

	# Sync records are held by D until the account is confirmed (16 records, 16 KiB) and refuse beyond.
	for case in ["records", "bytes"]:
		sides = await _approved_pair()
		d = sides[0]
		m = sides[1]
		var ok := true
		if case == "records":
			for i in 16:
				ok = ok and m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8)).ok
			await PKeyTestPeers.pump(d, m)
			t.check("held: 16 wraps are held by D", ok and not d.session.is_closed() and d.of(&"record").size() == 1)
			m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8))
		else:
			ok = m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8192)).ok and m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8192)).ok
			await PKeyTestPeers.pump(d, m)
			t.check("held: 16 KiB of wraps are held by D", ok and not d.session.is_closed())
			m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(1))
		await PKeyTestPeers.pump(d, m)
		t.check("held: one more (%s) closes peer_busy" % case, d.closes() == [[&"peer_busy", false]] and d.of(&"record").size() == 1, str(d.closes()))
		d.session.vouch().confirm_account()
		t.check("held: and nothing is delivered after the close", d.of(&"record").size() == 1)

	# Declining drops what was held and closes peer_bye.
	sides = await _approved_pair()
	d = sides[0]
	m = sides[1]
	m.session.send_record(PKeyPeerRecord.KEYRING_WRAP, _bytes(8))
	await PKeyTestPeers.pump(d, m)
	d.session.vouch().decline_account()
	await PKeyTestPeers.pump(d, m)
	var declined: bool = d.closes() == [[&"peer_bye", false]] and m.closes() == [[&"peer_bye", true]]
	t.check("held: declining the account delivers nothing and closes peer_bye", d.of(&"record").size() == 1 and declined, str(d.closes()))

	# Abandoning before a right pick never delivers the request.
	for reason in [["wrong-pick", &"peer_bye"], ["none-match", &"peer_bye"], ["stop", &"peer_bye"], ["timeout", &"peer_timeout"]]:
		sides = await _pair()
		d = sides[0]
		m = sides[1]
		d.session.vouch().shown()
		m.session.vouch().shown()
		d.session.confirm_sas()
		d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
		await PKeyTestPeers.pump(d, m)
		m.session.vouch().abandon(reason[0])
		await PKeyTestPeers.pump(d, m)
		var both: bool = m.closes() == [[reason[1], false]] and d.closes() == [[reason[1], true]]
		t.check("abandon %s: the request is never delivered, the session closes %s" % [reason[0], reason[1]], m.of(&"record").is_empty() and both, str(m.closes()))
		t.check("abandon %s: and the pick afterwards delivers nothing" % reason[0], _picked_after(m))

	# Misuse in other modes.
	var a := PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32())
	a.session.vouch().shown()
	t.check("guard: the vouch calls close a mode p session peer_not_allowed", a.closes() == [[&"peer_not_allowed", false]])


func _picked_after(m: PKeyTestPeers.Peer) -> bool:
	m.session.vouch().picked()
	return m.of(&"record").is_empty()


## A pair where M answered approved and D holds the result.
func _approved_pair() -> Array:
	var sides := await _pair()
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	d.session.vouch().shown()
	m.session.vouch().shown()
	d.session.confirm_sas()
	d.session.send_record(PKeyPeerRecord.VOUCH_REQ, "{}".to_utf8_buffer())
	await PKeyTestPeers.pump(d, m)
	m.session.confirm_sas()
	m.session.vouch().picked()
	m.session.vouch().verified()
	m.session.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	await PKeyTestPeers.pump(d, m)
	return sides


## A raw Noise initiator in mode v against a responder session: {tp, hash, m}. With `settle` the code
## is shown on the responder and its person confirmed; without it the responder stops after SAS_COMMIT.
func _raw_pair(settle := true) -> Dictionary:
	var m := PKeyTestPeers.side("v", "responder", PKeyTestPeers.random32())
	var hs: PKeyPeerNoise.Handshake = PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name("v"), PKeyPeerNoise.prologue(PKeyTestPeers.SLUG, "v"), PKeyTestPeers.random32()).detail
	await m.session.receive(hs.write_message(PKeyPeerPayload.payload1()).detail)
	hs.read_message(m.out.pop_front())
	await m.session.receive(hs.write_message(PKeyPeerPayload.payload23("v", ["vouch/1"])).detail)
	var raw := {"tp": hs.transport().detail, "hash": hs.handshake_hash(), "m": m}
	await _raw_send(raw, m, PKeyPeerRecord.HELLO, PKeyPeerPayload.hello_body("", "t", "a", 1048576))
	var n_d := PKeyTestPeers.random32()
	await _raw_send(raw, m, PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d)))
	if settle:
		await _raw_send(raw, m, PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d))
		m.session.vouch().shown()
		m.session.confirm_sas()
	m.out.clear()
	return raw


func _raw_send(raw: Dictionary, side: PKeyTestPeers.Peer, type: int, body: PackedByteArray) -> void:
	var tp: PKeyPeerNoise.Transport = raw["tp"]
	await side.session.receive(tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(type, 0, body)).detail)


static func _bytes(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	return b


func _session_hold_sas(t: PKeyTestContext) -> void:
	# The option is for the mode v initiator only.
	for bad in [["p", "initiator"], ["v", "responder"]]:
		var r := PKeyPeerSession.create({
			"mode": bad[0], "role": bad[1], "slug": "demo", "static_key": PKeyTestPeers.random32(),
			"hello": {"platform": "t", "app": "a"}, "send": func(_b: PackedByteArray) -> void: pass, "on_event": func(_e: Dictionary) -> void: pass,
			"admission": PKeyPeerLimiter.new(), "hold_sas": true,
		})
		t.check("hold_sas: refused for %s %s" % bad, not r.ok)

	var sides := await _pair({"hold_sas": true})
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	var up: bool = d.of(&"established").size() == 1 and m.of(&"established").size() == 1
	t.check("hold_sas: D is established and sent no SAS_COMMIT", up and d.of(&"sas").is_empty() and m.of(&"sas").is_empty() and d.out.is_empty())
	d.session.start_sas()
	await PKeyTestPeers.pump(d, m)
	t.check("hold_sas: start_sas() runs the code on both sides", d.of(&"sas").size() == 1 and m.of(&"sas").size() == 1 and d.of(&"sas")[0]["code"] == m.of(&"sas")[0]["code"])

	# Once only.
	sides = await _pair({"hold_sas": true})
	d = sides[0]
	m = sides[1]
	d.session.start_sas()
	d.session.start_sas()
	await PKeyTestPeers.pump(d, m)
	t.check("hold_sas: a second start_sas() closes peer_not_allowed", d.closes().size() == 1 and d.closes()[0][0] == &"peer_not_allowed", str(d.closes()))

	# Without the option, start_sas() is not allowed.
	sides = await _pair()
	d = sides[0]
	d.session.start_sas()
	t.check("hold_sas: start_sas() without hold_sas closes peer_not_allowed", d.closes() == [[&"peer_not_allowed", false]])

	# Before established, it is not allowed either.
	var early := PKeyTestPeers.side("v", "initiator", PKeyTestPeers.random32(), {"hold_sas": true})
	early.session.start_sas()
	t.check("hold_sas: start_sas() before the handshake closes peer_not_allowed", early.closes() == [[&"peer_not_allowed", false]])


func _session_deadlines(t: PKeyTestContext) -> void:
	# D's code deadline starts again at start_sas(): 100 s of looking at the list leave a whole 120 s.
	var sides := await _pair({"hold_sas": true})
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	d.mono_value = 100.0
	m.mono_value = 100.0
	d.session.tick()
	t.check("deadline: D's 120 s counts from the first byte until start_sas()", d.closes().is_empty())
	d.session.start_sas()
	d.mono_value = 219.9
	d.session.tick()
	t.check("deadline: 119.9 s after start_sas() D is still open", d.closes().is_empty())
	d.mono_value = 220.0
	d.session.tick()
	t.check("deadline: 120 s after start_sas() D closes peer_timeout", d.closes() == [[&"peer_timeout", false]], str(d.closes()))

	# M's starts again when SAS_COMMIT arrives.
	sides = await _pair({"hold_sas": true})
	d = sides[0]
	m = sides[1]
	m.mono_value = 100.0
	d.mono_value = 100.0
	d.session.start_sas()
	await PKeyTestPeers.pump(d, m)
	m.mono_value = 219.9
	m.session.tick()
	t.check("deadline: M counts 120 s from SAS_COMMIT", m.closes().is_empty())
	m.mono_value = 220.0
	m.session.tick()
	t.check("deadline: and closes peer_timeout then", m.closes() == [[&"peer_timeout", false]], str(m.closes()))

	# Without a hold nothing restarts for D: the first byte counts.
	sides = await _pair()
	d = sides[0]
	d.mono_value = 120.0
	d.session.tick()
	t.check("deadline: D without hold_sas keeps the clock of the first byte", d.closes() == [[&"peer_timeout", false]])


func _session_chain(t: PKeyTestContext) -> void:
	# N7: a MORE chain over 16 KiB closes peer_bad_frame in modes v and p, and not in mode a.
	for mode in ["v", "p"]:
		var asm := PKeyPeerRecord.Assembler.new(mode)
		var part := {"type": PKeyPeerRecord.SAS_COMMIT, "flags": 1, "body": _bytes(8192)}
		t.check("N7 %s: two 8 KiB parts are pending" % mode, asm.push(part)["kind"] == &"pending" and asm.push(part)["kind"] == &"pending")
		var third: Dictionary = asm.push({"type": PKeyPeerRecord.SAS_COMMIT, "flags": 1, "body": _bytes(1)})
		t.check("N7 %s: one byte more closes peer_bad_frame" % mode, third["kind"] == &"close" and third["code"] == &"peer_bad_frame")
		var first: Dictionary = PKeyPeerRecord.Assembler.new(mode).push({"type": PKeyPeerRecord.SAS_COMMIT, "flags": 1, "body": _bytes(16385)})
		t.check("N7 %s: a first MORE record over 16 KiB closes" % mode, first["code"] == &"peer_bad_frame")
		var exact := PKeyPeerRecord.Assembler.new(mode)
		t.check("N7 %s: a 16 KiB chain is read" % mode, exact.push({"type": PKeyPeerRecord.SAS_COMMIT, "flags": 1, "body": _bytes(16384)})["kind"] == &"pending" \
				and exact.push({"type": PKeyPeerRecord.SAS_COMMIT, "flags": 0, "body": PackedByteArray()})["kind"] == &"message")
	var a := PKeyPeerRecord.Assembler.new("a")
	var big := {"type": 0x0100, "flags": 1, "body": _bytes(20000)}
	t.check("N7: mode a keeps the 1 MiB cap", a.push(big)["kind"] == &"pending" and a.push(big)["kind"] == &"pending")
