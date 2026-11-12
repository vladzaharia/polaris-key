extends RefCounted
# @pkey-feature connect.protocol connect.noise connect.links
# `PKeyPeerSession` with the contact exchange (mode p) and mode c (CC-19b.G2; WIRE-CONTRACT-V5 section 15.10),
# ported from client-core's `peerContact.test.ts` and `peerListener.test.ts`. The `contact` rows of
# `peer-matrix.json` that concern a session run again here through one: the 24 exchange rows through the
# session's own exchange step, the 10 listener rows through a responder session over real Noise message 1
# (the order keys are tried in is counted on the AEAD port, the limiter on its clock), and the 6 pin rows
# through real mode-c pairs (what is sent is counted at the session's send callback). Beyond the corpus: the
# exchange end to end, mode c under the derived secret, the shared listener, the limiter's refusal, the
# 304-byte first message, one offloaded trial, RING and TRUST in mode c, and the option checks.
# Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const SLUG := PKeyTestPeers.SLUG


## An AEAD port that counts the opens (each key tried is one) and the X25519 calls.
class CountingCrypto extends PKeyPeerCrypto:
	var opens := 0
	var curve := 0


	func aes_gcm_open(key: PackedByteArray, nonce: PackedByteArray, aad: PackedByteArray, sealed: PackedByteArray) -> Variant:
		opens += 1
		return super.aes_gcm_open(key, nonce, aad, sealed)


	func x25519(private_key: PackedByteArray, peer_public: PackedByteArray) -> Variant:
		curve += 1
		return super.x25519(private_key, peer_public)


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var c: Dictionary = (j.data as Dictionary)["contact"]
	await _exchange_end_to_end(t)
	await _exchange_rows(t, c["exchange"])
	await _exchange_timeout_and_options(t)
	await _mode_c(t)
	await _pin_rows(t, c["pin"])
	await _listener_rows(t, c["listener"])
	await _shared_listener(t)
	await _first_message(t)
	await _offloaded_trial(t)
	await _refused_records(t)
	_options(t)


# -- helpers --------------------------------------------------------------------------------------

static func _keys() -> Dictionary:
	var priv := PKeyTestPeers.random32()
	var pub := PKeyPeerCrypto.for_platform().x25519_public(priv)
	return {"priv": priv, "pub": pub, "agree": PKeyB64Url.encode(pub)}


static func _contact_for(secret: PackedByteArray, peer_agree: String) -> Dictionary:
	return {"secret": secret.duplicate(), "agree_key": peer_agree}


## A mode-p pair with the exchange on, through the SAS (both show the code).
func _p_pair(offer_d: Dictionary, offer_m: Dictionary) -> Array:
	var d := PKeyTestPeers.side("p", "initiator", PKeyTestPeers.random32(), {"exchange": offer_d})
	var m := PKeyTestPeers.side("p", "responder", PKeyTestPeers.random32(), {"exchange": offer_m})
	if d.session == null or m.session == null:
		return [d, m]
	await d.session.start()
	await PKeyTestPeers.pump(d, m)
	return [d, m]


## A side that counts what it sends.
static func _counting_side(mode: String, role: String, key: Variant, extra: Dictionary, sent: Array) -> PKeyTestPeers.Peer:
	var peer := PKeyTestPeers.Peer.new()
	var o := extra.duplicate()
	# The peer holds its session, which holds this callback: a weak reference keeps the three from being a cycle.
	var weak_peer: WeakRef = weakref(peer)
	o["send"] = func(n: PackedByteArray) -> void:
		sent[0] += 1
		(weak_peer.get_ref() as PKeyTestPeers.Peer).out.append(n)
	return PKeyTestPeers.side(mode, role, key, o, peer)


# -- the exchange ---------------------------------------------------------------------------------

func _exchange_end_to_end(t: PKeyTestContext) -> void:
	var kd := _keys()
	var km := _keys()
	var sides := await _p_pair({"agree_key": kd["agree"], "cats": ["docs", "music"], "label": "Dee"}, {"agree_key": km["agree"], "cats": ["docs"], "label": "Em"})
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	t.check("exchange: both sessions are made", d.session != null and m.session != null)
	if d.session == null or m.session == null:
		return
	d.session.confirm_sas()
	await PKeyTestPeers.pump(d, m)
	t.check("exchange: nothing is stored on our CONFIRM alone", d.of(&"contact").is_empty() and m.of(&"contact").is_empty())
	m.session.confirm_sas()
	await PKeyTestPeers.pump(d, m)
	var cd := d.of(&"contact")
	var cm := m.of(&"contact")
	t.check("exchange: each side ends with one contact event", cd.size() == 1 and cm.size() == 1)
	if cd.size() != 1 or cm.size() != 1:
		return
	t.check("exchange: the same 32-byte secret on both sides", (cd[0]["secret"] as PackedByteArray).size() == 32 and cd[0]["secret"] == cm[0]["secret"] \
			and cd[0]["secret"] != PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
	t.check("exchange: each reads the other's key, label and categories", cd[0]["agree_key"] == km["agree"] and cm[0]["agree_key"] == kd["agree"] \
			and cd[0]["label"] == "Em" and cm[0]["label"] == "Dee" and cd[0]["cats"] == ["docs"] and cm[0]["cats"] == ["docs", "music"] \
			and cd[0]["pending"] == false and cm[0]["pending"] == false)
	t.check("exchange: the host sees neither CONFIRM nor CONTACT", d.of(&"record").is_empty() and m.of(&"record").is_empty())
	t.check("exchange: the event is not a closure", d.closes().is_empty() and m.closes().is_empty())
	t.check("exchange: a session never prints the secret", not str(d.session).contains((cd[0]["secret"] as PackedByteArray).hex_encode()))
	# Mode c under the secret the exchange made.
	var a := _counting_side_pair(cd[0]["secret"], kd, km)
	var ia: PKeyTestPeers.Peer = a[0]
	var ra: PKeyTestPeers.Peer = a[1]
	await ia.session.start()
	await PKeyTestPeers.pump(ia, ra)
	t.check("mode c: both ends are open on the derived secret", ia.session.is_open() and ra.session.is_open() and ia.of(&"established").size() == 1 and ra.of(&"established").size() == 1)
	var ei := ia.of(&"established")[0]
	t.check("mode c: the HELLO is not authenticated and there is no device id", ei["hello_authenticated"] == false and ei["peer_device_id"] == "" and ei["contact_index"] == 0)
	t.check("mode c: the session knows the contact it opened under", ra.session.contact_index() == 0 and ra.session.mode() == "c")
	t.check("mode c: the remote static key is the peer's agreeKey", ei["remote_static"] == km["pub"] and ra.of(&"established")[0]["remote_static"] == kd["pub"])
	t.check("mode c: no SAS is shown", ia.of(&"sas").is_empty() and ra.of(&"sas").is_empty())
	ia.session.send_record(0x0100, "hello".to_utf8_buffer())
	await PKeyTestPeers.pump(ia, ra)
	var got := ra.of(&"record")
	t.check("mode c: a host record is delivered at once", got.size() == 1 and got[0]["record_type"] == 0x0100 and got[0]["body"].get_string_from_utf8() == "hello")
	t.check("mode c: the handshake hash is shared", ia.session.handshake_hash() == ra.session.handshake_hash() and ia.session.handshake_hash().size() == 32)


## A mode-c pair under `secret`: the initiator is device D (key `kd`), the responder device M (key `km`).
func _counting_side_pair(secret: PackedByteArray, kd: Dictionary, km: Dictionary) -> Array:
	var i := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secret, km["agree"])]})
	var r := PKeyTestPeers.side("c", "responder", km["priv"], {"contacts": [_contact_for(secret, kd["agree"])]})
	return [i, r]


func _exchange_rows(t: PKeyTestContext, rows: Array) -> void:
	var kd := _keys()
	var km := _keys()
	var sides := await _p_pair({"agree_key": kd["agree"], "cats": ["docs"]}, {"agree_key": km["agree"], "cats": ["docs"]})
	var d: PKeyTestPeers.Peer = sides[0]
	var good := 0
	for r: Dictionary in rows:
		var s := d.session
		s._xchg = PKeyPeerContact.Exchange.new(r["own"], r["held"])
		s._xchg_offer = {"agree_key": r["own"], "cats": []}
		d.events.clear()
		d.out.clear()
		var ok := (r["steps"] as Array).size() == (r["want"] as Array).size()
		for i in (r["steps"] as Array).size():
			var step: Dictionary = r["steps"][i]
			var w: Dictionary = r["want"][i]
			d.events.clear()
			d.out.clear()
			var code: StringName = s._exchange_step(step["event"], String(step.get("body", "")).to_utf8_buffer())
			var want_close := "" if w.get("close") == null else String(w["close"])
			ok = ok and String(code) == want_close
			# CONFIRM is `confirm_sas`'s to send; CONTACT is the exchange's, and goes out as one record.
			var wants_contact: bool = (w["sends"] as Array).has("CONTACT")
			ok = ok and d.out.size() == (1 if wants_contact else 0)
			var got := d.of(&"contact")
			if w.has("stored"):
				var ws: Dictionary = w["stored"]
				ok = ok and got.size() == 1 and got[0]["agree_key"] == ws["agreeKey"] and got[0]["cats"] == ws["cats"] \
						and got[0].get("label") == ws.get("label") and got[0]["pending"] == ws["pending"] and (got[0]["secret"] as PackedByteArray).size() == 32
			else:
				ok = ok and got.is_empty()
		good += int(t.check("exchange through the session: %s" % r["id"], ok))
	t.check("every exchange row ran through the session", good == 24, "%d/24" % good)


func _exchange_timeout_and_options(t: PKeyTestContext) -> void:
	var kd := _keys()
	var km := _keys()
	var sides := await _p_pair({"agree_key": kd["agree"], "cats": []}, {"agree_key": km["agree"], "cats": []})
	var d: PKeyTestPeers.Peer = sides[0]
	var m: PKeyTestPeers.Peer = sides[1]
	d.session.confirm_sas()
	await PKeyTestPeers.pump(d, m)
	d.mono_value += 29.0
	d.session.tick()
	t.check("exchange: 29 s after our CONFIRM the session is still waiting", not d.session.is_closed())
	d.mono_value += 2.0
	d.session.tick()
	t.check("exchange: 30 s after our CONFIRM with no CONTACT closes peer_timeout", d.closes() == [[&"peer_timeout", false]], str(d.closes()))
	# The peer's CONFIRM arrives with the exchange on: held until our person confirms, then the exchange runs.
	sides = await _p_pair({"agree_key": kd["agree"], "cats": []}, {"agree_key": km["agree"], "cats": []})
	d = sides[0]
	m = sides[1]
	m.session.confirm_sas()
	await PKeyTestPeers.pump(d, m)
	t.check("exchange: the peer's CONFIRM before ours is the session's, not the host's", d.of(&"record").is_empty() and not d.session.is_closed() and d.of(&"contact").is_empty())
	d.session.confirm_sas()
	await PKeyTestPeers.pump(d, m)
	t.check("exchange: and both CONTACTs are read once both confirmed", d.of(&"contact").size() == 1 and m.of(&"contact").size() == 1 and d.of(&"record").is_empty() and m.of(&"record").is_empty())
	t.check("exchange: CONFIRM and CONTACT are the session's to send", d.session.send_record(PKeyPeerRecord.CONTACT, PackedByteArray()).code == &"state" \
			and d.session.send_record(PKeyPeerRecord.CONFIRM, PackedByteArray()).code == &"state")



# -- mode c ---------------------------------------------------------------------------------------

func _mode_c(t: PKeyTestContext) -> void:
	var kd := _keys()
	var km := _keys()
	var i := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(PKeyTestPeers.random32(), km["agree"])]})
	var r := PKeyTestPeers.side("c", "responder", km["priv"], {"contacts": [_contact_for(PKeyTestPeers.random32(), kd["agree"])]})
	await i.session.start()
	await PKeyTestPeers.pump(i, r)
	t.check("mode c: two different secrets close the responder handshake_failed, silently", r.closes() == [[&"handshake_failed", false]] and r.out.is_empty() and i.of(&"established").is_empty())
	t.check("mode c: and the initiator has been told nothing", i.closes().is_empty())


func _pin_rows(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var row_ok: bool = r["want"]["ok"]
		var role: String = r["role"]
		var kd := _keys()
		var km := _keys()
		var wrong: String = _keys()["agree"]
		var secret := PKeyTestPeers.random32()
		var sent_i := [0]
		var sent_r := [0]
		var held: Array = r["held"]
		var matched := int(r["matched"])
		var contacts_r: Array = []
		for k in held.size():
			if k == matched:
				contacts_r.append(_contact_for(secret, wrong if (role == "responder" and not row_ok) else kd["agree"]))
			else:
				contacts_r.append(_contact_for(PKeyTestPeers.random32(), _keys()["agree"]))
		var i := _counting_side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secret, wrong if (role == "initiator" and not row_ok) else km["agree"])]}, sent_i)
		var m := _counting_side("c", "responder", km["priv"], {"contacts": contacts_r}, sent_r)
		await i.session.start()
		await PKeyTestPeers.pump(i, m)
		var ok := false
		if row_ok:
			ok = i.of(&"established").size() == 1 and m.of(&"established").size() == 1 and i.closes().is_empty() and m.closes().is_empty()
		elif role == "initiator":
			# Checked after message 2: only message 1 was ever sent, and no CLOSE.
			ok = i.closes() == [[&"peer_revoked", false]] and sent_i[0] == 1 and sent_r[0] == 1 and i.of(&"established").is_empty()
		else:
			# Checked after message 3: our message 2 is all the responder ever sent, and the initiator is told nothing.
			ok = m.closes() == [[&"peer_revoked", false]] and sent_r[0] == 1 and m.of(&"established").is_empty() and i.closes().is_empty()
		good += int(t.check("pin through the session: %s" % r["id"], ok, "%s %s %s" % [i.closes(), m.closes(), [sent_i[0], sent_r[0]]]))
	t.check("every pin row ran through the session", good == 6, "%d/6" % good)


# -- the shared listener --------------------------------------------------------------------------

func _listener_rows(t: PKeyTestContext, rows: Array) -> void:
	var dev := PKeyTestPeers.pair()
	var good := 0
	for r: Dictionary in rows:
		var account: Variant = r["account"]
		var keys: Array = []
		if account is Array:
			for k in account:
				keys.append(null if k == null else PKeyTestPeers.random32())
		var secrets: Array = []
		for _n in (r["contacts"] as Array).size():
			secrets.append(PKeyTestPeers.random32())
		var opens: Variant = r["opens"]
		var mode := "c"
		var psk := PKeyTestPeers.random32()
		if opens != null and opens["mode"] == "a":
			mode = "a"
			psk = PKeyPeerNoise.psk(keys[int(opens["key"])], SLUG)
		elif opens != null:
			psk = secrets[int(opens["contact"])]
		var init := PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(SLUG, mode), PKeyTestPeers.random32(), psk).detail as PKeyPeerNoise.Handshake
		var msg1: PackedByteArray = init.write_message(PKeyPeerPayload.payload1()).detail
		var crypto := CountingCrypto.new()
		var asked := [0]
		var limiter := PKeyPeerLimiter.new(5 if r["limiter"] == "admit" else 0, 4, func() -> float:
			asked[0] += 1
			return 0.0)
		var contacts: Array = []
		for s in secrets:
			contacts.append(_contact_for(s, _keys()["agree"]))
		var extra := {"admission": limiter, "crypto": crypto}
		if not contacts.is_empty():
			extra["contacts"] = contacts
		var peer: PKeyTestPeers.Peer
		if account is Array:
			peer = PKeyTestPeers.account_side("responder", dev["b"], keys, "", 1, extra)
		else:
			peer = PKeyTestPeers.side("c", "responder", PKeyTestPeers.random32(), extra)
		await peer.session.receive(msg1)
		var w: Dictionary = r["want"]
		var tried: Array = w["tried"]
		var contacts_tried := tried.any(func(x: String) -> bool: return x.begins_with("c:"))
		var ok: bool = crypto.opens == tried.size() and asked[0] == (1 if (secrets.size() > 0 and (contacts_tried or w.get("close") == "peer_busy")) else 0)
		if w["hit"] != null:
			var hit: String = w["hit"]
			var idx := int(hit.substr(2))
			ok = ok and peer.out.size() == 1 and peer.closes().is_empty() and peer.session.mode() == hit.substr(0, 1) \
					and peer.session.contact_index() == (idx if hit.begins_with("c") else -1) and limiter.pending() == (1 if w["slot"] else 0)
		else:
			ok = ok and peer.out.is_empty() and peer.closes() == [[StringName(w["close"]), false]] and limiter.pending() == 0
			# No static DH ran for a key that never opened: only a hit makes the responder's two.
			ok = ok and crypto.curve == 0
		good += int(t.check("listener through the session: %s" % r["id"], ok, "%d %s %s" % [crypto.opens, peer.closes(), tried.size()]))
	t.check("every listener row ran through the session", good == 10, "%d/10" % good)


func _shared_listener(t: PKeyTestContext) -> void:
	var dev := PKeyTestPeers.pair()
	var disc := PKeyTestPeers.random32()
	var kd := _keys()
	var km := _keys()
	var secrets: Array = [PKeyTestPeers.random32(), PKeyTestPeers.random32(), PKeyTestPeers.random32()]
	var contacts: Array = [_contact_for(secrets[0], _keys()["agree"]), _contact_for(secrets[1], _keys()["agree"]), _contact_for(secrets[2], kd["agree"])]
	var limiter := PKeyPeerLimiter.new(5, 4)
	# A contact reaches the account's listener and opens under its third secret.
	var rc := PKeyTestPeers.account_side("responder", dev["b"], [disc], "", 1, {"contacts": contacts, "admission": limiter})
	var ic := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secrets[2], PKeyB64Url.encode(PKeyCurve25519.x25519_public(dev["b"]["priv"])))]})
	await ic.session.start()
	await rc.session.receive(ic.out.pop_front())
	t.check("listener: a contact's slot is held until message 3", limiter.pending() == 1 and rc.session.mode() == "c" and rc.session.contact_index() == 2)
	ic.out.clear()
	rc.out.clear()
	# The responder holds the account's device key as its static key; the contact's pin is against it.
	t.check("listener: the shared responder is in the contact's mode", rc.session.mode() == "c")
	# An account device reaches the same listener in mode a.
	var ra := PKeyTestPeers.account_side("responder", dev["b"], [disc], dev["ring"], 1, {"contacts": contacts, "admission": limiter})
	var ia := PKeyTestPeers.account_side("initiator", dev["a"], [disc], dev["ring"], 1)
	await ia.session.start()
	await PKeyTestPeers.pump(ia, ra)
	t.check("listener: an account device opens in mode a on the same listener", ia.of(&"established").size() == 1 and ra.of(&"established").size() == 1 \
			and ra.of(&"established")[0]["hello_authenticated"] == true and ra.of(&"established")[0]["peer_device_id"] == PKeyTestPeers.ID_A and ra.of(&"established")[0]["contact_index"] == -1)
	t.check("listener: an account peer holds no limiter slot", limiter.pending() == 1)
	# A contact that completes releases its slot at HELLO.
	var ic2 := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secrets[2], PKeyB64Url.encode(PKeyCurve25519.x25519_public(dev["b"]["priv"])))]})
	var rc2 := PKeyTestPeers.account_side("responder", dev["b"], [disc], dev["ring"], 1, {"contacts": [_contact_for(secrets[2], kd["agree"])], "admission": limiter})
	await ic2.session.start()
	await PKeyTestPeers.pump(ic2, rc2)
	t.check("listener: a contact session opens, with a contact ref and no device id", ic2.of(&"established").size() == 1 and rc2.of(&"established").size() == 1 \
			and rc2.of(&"established")[0]["peer_device_id"] == "" and rc2.of(&"established")[0]["hello_authenticated"] == false and rc2.of(&"established")[0]["contact_index"] == 0)
	t.check("listener: and its slot ends at HELLO", limiter.pending() == 1)


func _first_message(t: PKeyTestContext) -> void:
	var crypto := CountingCrypto.new()
	var asked := [0]
	var limiter := PKeyPeerLimiter.new(1, 4, func() -> float:
		asked[0] += 1
		return 0.0)
	var km := _keys()
	var r := PKeyTestPeers.side("c", "responder", km["priv"], {"contacts": [_contact_for(PKeyTestPeers.random32(), _keys()["agree"])], "admission": limiter, "crypto": crypto})
	var big := PackedByteArray()
	big.resize(PKeyPeerSession.FIRST_MESSAGE_MAX + 1)
	await r.session.receive(big)
	t.check("first message: 305 bytes close peer_bad_frame, silently", r.closes() == [[&"peer_bad_frame", false]] and r.out.is_empty())
	t.check("first message: no key was tried and the limiter was not asked", crypto.opens == 0 and asked[0] == 0 and limiter.pending() == 0)


func _offloaded_trial(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var ran: Array[int] = []
	var slow := func(work: Callable) -> Variant:
		ran.append(1)
		await tree.process_frame
		return work.call()
	var kd := _keys()
	var km := _keys()
	var secret := PKeyTestPeers.random32()
	var contacts: Array = [_contact_for(PKeyTestPeers.random32(), _keys()["agree"]), _contact_for(secret, kd["agree"])]
	var i := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secret, km["agree"])], "offload": slow})
	var r := PKeyTestPeers.side("c", "responder", km["priv"], {"contacts": contacts, "offload": slow})
	await i.session.start()
	await PKeyTestPeers.pump(i, r)
	t.check("offload: the handshake is the same through an offload that takes frames", i.of(&"established").size() == 1 and r.of(&"established").size() == 1 and r.session.contact_index() == 1)
	t.check("offload: the responder's whole trial is one task (then message 2 and message 3)", ran.size() == 6, str(ran.size()))


func _refused_records(t: PKeyTestContext) -> void:
	for record in [["RING", PKeyPeerRecord.RING], ["TRUST", PKeyPeerRecord.TRUST], ["CONTACT", PKeyPeerRecord.CONTACT]]:
		var kd := _keys()
		var km := _keys()
		var secret := PKeyTestPeers.random32()
		var i := PKeyTestPeers.side("c", "initiator", kd["priv"], {"contacts": [_contact_for(secret, km["agree"])]})
		var r := PKeyTestPeers.side("c", "responder", km["priv"], {"contacts": [_contact_for(secret, kd["agree"])]})
		await i.session.start()
		await PKeyTestPeers.pump(i, r)
		i.session.send_record(record[1], "{}".to_utf8_buffer())
		await PKeyTestPeers.pump(i, r)
		t.check("mode c: %s closes peer_not_allowed" % record[0], r.closes() == [[&"peer_not_allowed", false]] and r.of(&"record").is_empty(), str(r.closes()))
		t.check("mode c: and the sender is told (%s)" % record[0], i.closes() == [[&"peer_not_allowed", true]])


# -- options --------------------------------------------------------------------------------------

func _options(t: PKeyTestContext) -> void:
	var k := _keys()
	var one := [_contact_for(PKeyTestPeers.random32(), k["agree"])]
	t.check("options: a mode c session needs contacts", PKeyTestPeers.side("c", "initiator", k["priv"]).session == null)
	t.check("options: a mode c initiator names exactly one contact", PKeyTestPeers.side("c", "initiator", k["priv"], {"contacts": one + one}).session == null \
			and PKeyTestPeers.side("c", "initiator", k["priv"], {"contacts": one}).session != null)
	var many: Array = []
	for n in 73:
		many.append(_contact_for(PKeyTestPeers.random32(), k["agree"]))
	t.check("options: a responder tries at most 72 secrets", PKeyTestPeers.side("c", "responder", k["priv"], {"contacts": many}).session == null \
			and PKeyTestPeers.side("c", "responder", k["priv"], {"contacts": many.slice(0, 72)}).session != null)
	var short_secret := {"secret": PackedByteArray([1]), "agree_key": k["agree"]}
	var short_key := {"secret": PKeyTestPeers.random32(), "agree_key": "short"}
	t.check("options: a contact needs a 32-byte secret and a key", PKeyTestPeers.side("c", "initiator", k["priv"], {"contacts": [short_secret]}).session == null \
			and PKeyTestPeers.side("c", "initiator", k["priv"], {"contacts": [short_key]}).session == null)
	var hello := {"platform": "t", "app": "a"}
	var bare := {
		"mode": "c", "role": "responder", "slug": SLUG, "static_key": k["priv"], "contacts": one, "hello": hello,
		"send": func(_n: PackedByteArray) -> void: pass, "on_event": func(_e: Dictionary) -> void: pass,
	}
	t.check("options: a contact responder needs an admission limiter", not PKeyPeerSession.create(bare).ok)
	bare["admission"] = PKeyPeerLimiter.new()
	t.check("options: and works with one", PKeyPeerSession.create(bare).ok)
	t.check("options: contacts are for mode c and the account responder only", PKeyTestPeers.side("p", "initiator", k["priv"], {"contacts": one}).session == null \
			and PKeyTestPeers.side("v", "initiator", k["priv"], {"contacts": one}).session == null)
	t.check("options: the exchange is for mode p", PKeyTestPeers.side("v", "initiator", k["priv"], {"exchange": {"agree_key": k["agree"], "cats": []}}).session == null \
			and PKeyTestPeers.side("p", "initiator", k["priv"], {"exchange": {"agree_key": k["agree"], "cats": []}}).session != null)
	t.check("options: the exchange offer must be a body the peer would accept", PKeyTestPeers.side("p", "initiator", k["priv"], {"exchange": {"agree_key": "short", "cats": []}}).session == null \
			and PKeyTestPeers.side("p", "initiator", k["priv"], {"exchange": {"agree_key": k["agree"], "cats": ["Bad"]}}).session == null)
	var s := PKeyTestPeers.side("c", "initiator", k["priv"], {"contacts": one}).session
	t.check("options: str() of a contact session shows nothing", str(s) == "PKeyPeerSession(c initiator hs)")
