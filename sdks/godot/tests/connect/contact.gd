extends RefCounted
# @pkey-feature connect.protocol
# The `contact` rows of `peer-matrix.json` (WIRE-CONTRACT-V5 section 15.10; 183 rows: secrets 10, bodies
# 46, categories 8, exchange 24, store 12, listener 10, pin 6, adverts 37, rooms 9, tickets 21) through
# PKeyPeerContact, row for row as the Node, Python, Kotlin and Swift runners do, plus what the corpus
# cannot say: building a body, the redaction of a stored contact, a mode-c handshake under a derived
# secret, and the limits. The listener rows run real Noise message 1 under each candidate key. Reads
# res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const SLUG := "demo"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var c: Dictionary = (j.data as Dictionary)["contact"]
	var adverts: Dictionary = c["adverts"]
	var rooms: Dictionary = c["rooms"]
	# Exact: a row added or dropped is a deliberate corpus change, never a silent one.
	t.check("contact row counts", (c["secrets"] as Array).size() == 10 and (c["bodies"] as Array).size() == 46 \
			and (c["categories"] as Array).size() == 8 and (c["exchange"] as Array).size() == 24 \
			and (c["store"] as Array).size() == 12 and (c["listener"] as Array).size() == 10 \
			and (c["pin"] as Array).size() == 6 and (c["tickets"] as Array).size() == 21)
	t.check("advert and room row counts", (adverts["names"] as Array).size() == 6 and (adverts["txt"] as Array).size() == 18 \
			and (adverts["browse"] as Array).size() == 13 and (rooms["rid"] as Array).size() == 3 and (rooms["alias"] as Array).size() == 6)
	_constants(t, c["constants"], adverts)
	_secrets(t, c["secrets"])
	_bodies(t, c["bodies"])
	_categories(t, c["categories"])
	_exchange(t, c["exchange"])
	_store(t, c["store"])
	_listener(t, c["listener"])
	_pin(t, c["pin"])
	_names(t, adverts["names"])
	_txt(t, adverts["txt"])
	_browse(t, adverts["browse"])
	_rids(t, rooms["rid"])
	_aliases(t, rooms["alias"])
	_tickets(t, c["tickets"])
	_build(t)
	_redaction(t)
	_handshake(t, (c["secrets"] as Array).back())


static func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


static func _key(s: String) -> PackedByteArray:
	return PKeyB64Url.decode_strict(s)


static func _text_body(r: Dictionary) -> PackedByteArray:
	if r.has("bodyHex"):
		return _hex(r["bodyHex"])
	if r.has("bodyPad"):
		var p: Dictionary = r["bodyPad"]
		return (String(p["prefix"]) + String(p["fill"]).repeat(int(p["count"])) + String(p["suffix"])).to_utf8_buffer()
	return String(r["body"]).to_utf8_buffer()


## A JSON number array as ints (every JSON number is a float here, and an Array of ints is not equal to it).
static func _ints(a: Array) -> Array:
	return a.map(func(x: Variant) -> int: return int(x))


## A JSON null reads as "".
static func _s(v: Variant) -> String:
	return "" if v == null else String(v)


static func _rand() -> PackedByteArray:
	return Crypto.new().generate_random_bytes(32)


## 32 bytes all equal to `n`, as the store and pin rows spell their keys and secrets.
static func _fill(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(n)
	return b


func _constants(t: PKeyTestContext, k: Dictionary, a: Dictionary) -> void:
	t.check("constants match the corpus", PKeyPeerContact.MAX_CONTACTS == int(k["maxContacts"]) \
			and PKeyPeerContact.MAX_CONTACT_CATS == int(k["maxCats"]) and PKeyPeerContact.MAX_PENDING_CONTACTS == int(k["maxPending"]) \
			and PKeyPeerContact.MAX_CONTACT_SECRETS == int(k["maxSecrets"]) and PKeyPeerContact.PENDING_CONTACT_SECONDS == int(k["pendingSeconds"]) \
			and PKeyPeerContact.CONTACT_BODY_MAX == int(k["bodyMax"]) and PKeyPeerContact.CONTACT_TICKET_BODY_MAX == int(k["ticketBodyMax"]) \
			and PKeyPeerContact.MAX_LIVE_CONTACT_ADVERTS == int(k["maxLiveAdverts"]) and PKeyPeerContact.CONTACT_LEASE_BYTES == int(k["leaseBytes"]) \
			and PKeyPeerContact.CONTACT_ROOM_IDLE_SECONDS == int(k["roomIdleSeconds"]) and PKeyPeerContact.CONTACT_EXCHANGE_SECONDS == int(k["exchangeSeconds"]))
	t.check("advert constants match the corpus", int(a["epochSeconds"]) == PKeyPeerAdvert.ADVERT_EPOCH_SECONDS \
			and int(a["maxSecrets"]) == PKeyPeerContact.MAX_CONTACT_SECRETS and int(a["maxLive"]) == PKeyPeerContact.MAX_LIVE_CONTACT_ADVERTS)


func _secrets(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var a := _key(r["agreeKeyA"])
		var b := _key(r["agreeKeyB"])
		var s := PKeyPeerContact.contact_secret(_hex(r["h"]), _hex(r["nD"]), _hex(r["nM"]), a, b)
		var swapped := PKeyPeerContact.contact_secret(_hex(r["h"]), _hex(r["nD"]), _hex(r["nM"]), b, a)
		good += int(t.check("secret %s" % r["id"], s.hex_encode() == r["secret"] and swapped == s))
	t.check("every secret row ran", good == 10, "%d/10" % good)
	var k := _fill(1)
	t.check("secret: a key of the wrong length makes none", PKeyPeerContact.contact_secret(k, k, k, k.slice(0, 31), k).is_empty() \
			and PKeyPeerContact.contact_secret(k, k, k, k, PackedByteArray()).is_empty())


func _bodies(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var body := _text_body(r)
		var got := PKeyPeerContact.parse_contact(body, r.get("own", ""))
		var want: Dictionary = r["want"]
		var ok: bool = body.size() == int(r["length"]) and got["ok"] == want["ok"]
		if ok and want["ok"]:
			ok = got["agree_key"] == want["agreeKey"] and got["cats"] == want["cats"] and got.get("label") == want.get("label")
		good += int(t.check("body %s" % r["id"], ok))
	t.check("every body row ran", good == 46, "%d/46" % good)


func _categories(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		good += int(t.check("categories %s" % r["id"], PKeyPeerContact.categories(r["local"], r["remote"]) == r["want"]))
	t.check("every categories row ran", good == 8, "%d/8" % good)


func _exchange(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var ex := PKeyPeerContact.Exchange.new(r["own"], r["held"])
		var ok := (r["steps"] as Array).size() == (r["want"] as Array).size()
		for i in (r["steps"] as Array).size():
			var s: Dictionary = r["steps"][i]
			var w: Dictionary = r["want"][i]
			var got := ex.step(s["event"], String(s.get("body", "")).to_utf8_buffer())
			ok = ok and got["sends"] == w["sends"] and String(got.get("close", "")) == _s(w.get("close"))
			var stored: Variant = got.get("stored")
			if w.has("stored"):
				var ws: Dictionary = w["stored"]
				ok = ok and stored is Dictionary and stored["agree_key"] == ws["agreeKey"] and stored["cats"] == ws["cats"] \
						and stored.get("label") == ws.get("label") and stored["pending"] == ws["pending"]
			else:
				ok = ok and stored == null
		good += int(t.check("exchange %s" % r["id"], ok))
	t.check("every exchange row ran", good == 24, "%d/24" % good)
	var ex := PKeyPeerContact.Exchange.new("", [])
	t.check("exchange: waiting from our CONFIRM to the peer's CONTACT", not ex.waiting())
	ex.step("own-confirm")
	t.check("exchange: waiting after CONFIRM", ex.waiting())
	ex.step("peer-confirm")
	ex.step("peer-contact", PKeyPeerContact.build_contact({"agree_key": PKeyB64Url.encode(_fill(9)), "cats": []}).detail)
	t.check("exchange: not waiting once the CONTACT is read", not ex.waiting())


## Each store row: `start` is [key, secret] pairs, held and active.
func _store(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var bad := ""
		var list: Array = []
		for p: Array in r["start"]:
			list.append(PKeyPeerContact.StoredContact.new(PKeyB64Url.encode(_fill(int(p[0]))), _fill(int(p[1]))))
		var ok := (r["ops"] as Array).size() == (r["want"] as Array).size()
		for i in (r["ops"] as Array).size():
			var op: Dictionary = r["ops"][i]
			var w: Dictionary = r["want"][i]
			match op["op"]:
				"pair":
					var inc := PKeyPeerContact.StoredContact.new(PKeyB64Url.encode(_fill(int(op["key"]))), _fill(int(op["secret"])), String(op.get("label", "")))
					var before := list.size()
					var v := PKeyPeerContact.store(list, inc, int(op["now"]))
					ok = ok and list.size() == before
					if v["ok"]:
						list = v["contacts"]
						ok = ok and w["result"] == ("pending" if v["pending"] else "active")
					else:
						ok = ok and w["result"] == "full" and v["reason"] == "full"
				"promote":
					list = PKeyPeerContact.promote(list, PKeyB64Url.encode(_fill(int(op["key"]))))
				"drop":
					list = PKeyPeerContact.drop_stale_pending(list, int(op["now"]))
			ok = ok and _secrets_of(list, false) == _ints(w["active"]) and _secrets_of(list, true) == _ints(w["pending"])
			if not ok and bad.is_empty():
				bad = "op %d: %s %s" % [i, _secrets_of(list, false), _secrets_of(list, true)]
			var order: Array = []
			for c: PKeyPeerContact.StoredContact in PKeyPeerContact.trial_order(list):
				order.append(int(c.secret[0]))
			ok = ok and order == _ints(w["order"])
		good += int(t.check("store %s" % r["id"], ok, bad))
	t.check("every store row ran", good == 12, "%d/12" % good)


static func _secrets_of(list: Array, pending: bool) -> Array:
	var out: Array = []
	for c: PKeyPeerContact.StoredContact in list:
		if c.is_pending() == pending:
			out.append(int(c.secret[0]))
	return out


## Real message 1 under each key the responder tries: a tag that verifies is a hit.
func _listener(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var account: Variant = r["account"]
		var account_keys: Array = []
		if account is Array:
			for k in account:
				account_keys.append(null if k == null else _rand())
		var secrets: Array = []
		for _i in (r["contacts"] as Array).size():
			secrets.append(_rand())
		var opens: Variant = r["opens"]
		var mode := "c"
		var psk := _rand()
		if opens != null and opens["mode"] == "a":
			mode = "a"
			psk = PKeyPeerNoise.psk(account_keys[int(opens["key"])], SLUG)
		elif opens != null:
			psk = secrets[int(opens["contact"])]
		var init := PKeyPeerNoise.start("initiator", PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(SLUG, mode), _rand(), psk).detail as PKeyPeerNoise.Handshake
		var msg1: PackedByteArray = init.write_message(PKeyPeerPayload.payload1()).detail
		var opens_called := [0]
		var try_open := func(kind: String, index: int) -> bool:
			opens_called[0] += 1
			var candidate: PackedByteArray = PKeyPeerNoise.psk(account_keys[index], SLUG) if kind == "a" else secrets[index]
			var m := "a" if kind == "a" else "c"
			var resp := PKeyPeerNoise.start("responder", PKeyPeerNoise.protocol_name(m), PKeyPeerNoise.prologue(SLUG, m), _rand(), candidate).detail as PKeyPeerNoise.Handshake
			return resp.read_message(msg1).ok
		var admit_count := [0]
		var admit := func() -> bool:
			admit_count[0] += 1
			return r["limiter"] == "admit"
		var got := PKeyPeerContact.listener_trial(account, secrets.size(), admit, try_open)
		var w: Dictionary = r["want"]
		var ok: bool = got["tried"] == w["tried"] and got["slot"] == w["slot"] and String(got["close"]) == _s(w.get("close")) \
				and (got["hit"] == "" if w["hit"] == null else got["hit"] == w["hit"]) and opens_called[0] == (w["tried"] as Array).size()
		# The limiter is asked once, before the first contact secret, and never for an account peer.
		var contacts_tried := (w["tried"] as Array).any(func(x: String) -> bool: return x.begins_with("c:"))
		ok = ok and admit_count[0] == (1 if (secrets.size() > 0 and (contacts_tried or w.get("close") == "peer_busy")) else 0)
		good += int(t.check("listener %s" % r["id"], ok, str(got["tried"].size())))
	t.check("every listener row ran", good == 10, "%d/10" % good)
	var capped := PKeyPeerContact.listener_trial(null, 100, func() -> bool: return true, func(_k: String, _i: int) -> bool: return false)
	t.check("listener: at most 72 contact secrets are tried", (capped["tried"] as Array).size() == 72)
	var three := PKeyPeerContact.listener_trial(["a", "b", "c"], 0, func() -> bool: return true, func(_k: String, _i: int) -> bool: return false)
	t.check("listener: only the first two account keys are tried", three["tried"] == ["a:0", "a:1"])


func _pin(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var held: Array = r["held"]
		var ok: bool = PKeyPeerContact.pin(held[int(r["matched"])], _key(r["remoteStatic"])) == r["want"]["ok"]
		if not r["want"]["ok"]:
			ok = ok and r["want"]["close"] == String(PKeyPeerContact.CLOSE_REVOKED) and int(r["want"]["sends"]) == 0
		ok = ok and int(r["checkedAfter"]) == (2 if r["role"] == "initiator" else 3)
		good += int(t.check("pin %s" % r["id"], ok))
	t.check("every pin row ran", good == 6, "%d/6" % good)


func _names(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		good += int(t.check("advert name %s" % r["id"],
				PKeyPeerContact.instance(_hex(r["secret"]), _key(r["agreeKey"]), int(r["epoch"])) == r["instance"]))
	t.check("every advert name row ran", good == 6, "%d/6" % good)
	t.check("advert name: a key of the wrong length has none", PKeyPeerContact.instance(_fill(1), _fill(1).slice(0, 31), 1) == "" \
			and PKeyPeerContact.instance(PackedByteArray(), _fill(1), 1) == "")


func _txt(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var got := PKeyPeerContact.parse_txt(r["entries"])
		var want: Dictionary = r["want"]
		var ok: bool = got["ok"] == want["ok"] and (want["ok"] or got["reason"] == want["reason"])
		good += int(t.check("advert txt %s" % r["id"], ok))
	t.check("every advert txt row ran", good == 18, "%d/18" % good)


func _browse(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var contacts: Array = []
		for c: Dictionary in r["contacts"]:
			contacts.append({"secret": _hex(c["secret"]), "agree_key": _key(c["agreeKey"])})
		var got := PKeyPeerContact.browse(r["instance"], contacts, int(r["now"]))
		var want: Variant = r["want"]
		var ok: bool = got.is_empty() if want == null else (got.get("contact") == int(want["contact"]) and got.get("epoch_back") == int(want["epochBack"]))
		good += int(t.check("advert browse %s" % r["id"], ok))
	t.check("every advert browse row ran", good == 13, "%d/13" % good)


func _rids(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		good += int(t.check("room id %s" % r["id"], PKeyPeerContact.rid(_hex(r["secret"])) == r["rid"]))
	t.check("every room id row ran", good == 3, "%d/3" % good)


func _aliases(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		good += int(t.check("room alias %s" % r["id"], PKeyPeerContact.alias(r["rid"], r["deviceId"]).hex_encode() == r["alias"]))
	t.check("every room alias row ran", good == 6, "%d/6" % good)
	t.check("room alias: a rid or device id that is not canonical has none", PKeyPeerContact.alias("short", "E5XdaoXZIoqOKNdOWtCy9x3cXVtlF_t9").is_empty() \
			and PKeyPeerContact.alias("lXg0MgIHVN5qAmGFUen7vA", "short").is_empty())


func _tickets(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var body := _text_body(r)
		var got := PKeyPeerContact.parse_ticket_body(body)
		var want: Dictionary = r["want"]
		var ok: bool = body.size() == int(r["length"]) and got["ok"] == want["ok"] and (not want["ok"] or got["rid"] == want["rid"])
		good += int(t.check("ticket %s" % r["id"], ok))
	t.check("every ticket row ran", good == 21, "%d/21" % good)
	var rid := "lXg0MgIHVN5qAmGFUen7vA"
	t.check("ticket body bytes", PKeyPeerContact.ticket_body(rid) == '{"room":"c","rid":"lXg0MgIHVN5qAmGFUen7vA"}' \
			and PKeyPeerContact.parse_ticket_body(PKeyPeerContact.ticket_body(rid).to_utf8_buffer())["rid"] == rid)
	t.check("ticket body refuses a rid that is not canonical", PKeyPeerContact.ticket_body("lXg0MgIHVN5qAmGFUen7vB") == "" and PKeyPeerContact.ticket_body("x") == "")


# -- beyond the corpus --------------------------------------------------------------------------

func _build(t: PKeyTestContext) -> void:
	var key := PKeyB64Url.encode(_fill(7))
	var built := PKeyPeerContact.build_contact({"agree_key": key, "label": "  Ana​ ", "cats": ["b", "a"]})
	t.check("build: a body that parses back", built.ok and PKeyPeerContact.parse_contact(built.detail) == {"ok": true, "agree_key": key, "label": "Ana", "cats": ["b", "a"]})
	t.check("build: the bytes", built.ok and (built.detail as PackedByteArray).get_string_from_utf8() == '{"v":1,"agreeKey":"%s","label":"Ana","cats":["b","a"]}' % key)
	t.check("build: the reader's own key is no contact", PKeyPeerContact.parse_contact(built.detail, key) == {"ok": false})
	var no_label := PKeyPeerContact.build_contact({"agree_key": key, "cats": []})
	t.check("build: no label member without a label", no_label.ok and not (no_label.detail as PackedByteArray).get_string_from_utf8().contains("label"))
	t.check("build refuses a category outside the charset", not PKeyPeerContact.build_contact({"agree_key": key, "cats": ["Bad"]}).ok)
	t.check("build refuses a repeated category", not PKeyPeerContact.build_contact({"agree_key": key, "cats": ["a", "a"]}).ok)
	t.check("build refuses nine categories", not PKeyPeerContact.build_contact({"agree_key": key, "cats": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}).ok)
	t.check("build refuses a short key", not PKeyPeerContact.build_contact({"agree_key": "short", "cats": []}).ok)
	t.check("build refuses a low-order key", not PKeyPeerContact.build_contact({"agree_key": PKeyB64Url.encode(_fill(0)), "cats": []}).ok)
	t.check("build refuses a body past 4 KiB", not PKeyPeerContact.build_contact({"agree_key": key, "label": "x".repeat(5000), "cats": []}).ok \
			or (PKeyPeerContact.build_contact({"agree_key": key, "label": "x".repeat(5000), "cats": []}).detail as PackedByteArray).size() <= 4096)


func _redaction(t: PKeyTestContext) -> void:
	var secret := _fill(0xab)
	var c := PKeyPeerContact.StoredContact.new("key", secret, "Ana", ["docs"])
	t.check("redaction: a stored contact's str() shows nothing", str(c) == "PKeyPeerContact.StoredContact()" and not str(c).contains("ab"))
	t.check("redaction: the exchange's str() shows nothing", str(PKeyPeerContact.Exchange.new("own", ["held"])) == "PKeyPeerContact.Exchange()")
	c.wipe()
	t.check("a stored contact wipes its own copy of the secret", c.secret == _fill(0) and secret == _fill(0xab))
	var kept := PKeyPeerContact.StoredContact.new("k", secret)
	var copy := kept.copy(5)
	t.check("a copy keeps the secret and takes the pending mark", copy.secret == secret and copy.pending_since == 5 and not kept.is_pending())


## Mode c end to end under a derived secret: both sides open the handshake, and each side's remote
## static passes the pin against the other's agreeKey.
func _handshake(t: PKeyTestContext, row: Dictionary) -> void:
	var crypto := PKeyPeerCrypto.for_platform()
	var a_priv := _rand()
	var b_priv := _rand()
	var a_pub := crypto.x25519_public(a_priv)
	var b_pub := crypto.x25519_public(b_priv)
	var secret := PKeyPeerContact.contact_secret(_hex(row["h"]), _hex(row["nD"]), _hex(row["nM"]), a_pub, b_pub)
	var proto := PKeyPeerNoise.protocol_name("c")
	var pro := PKeyPeerNoise.prologue(SLUG, "c")
	var i := PKeyPeerNoise.start("initiator", proto, pro, a_priv, secret).detail as PKeyPeerNoise.Handshake
	var r := PKeyPeerNoise.start("responder", proto, pro, b_priv, secret).detail as PKeyPeerNoise.Handshake
	var good := true
	for k in 3:
		var w := i if k % 2 == 0 else r
		var d := r if k % 2 == 0 else i
		var payload := PKeyPeerPayload.payload1() if k == 0 else PKeyPeerPayload.payload23("c", ["app/1"])
		var wr: PKeyResult = w.write_message(payload)
		good = good and wr.ok and d.read_message(wr.detail).ok
	t.check("mode c: a handshake under a derived secret completes", good and i.finished() and r.finished())
	t.check("mode c: each side's pin holds", PKeyPeerContact.pin(PKeyB64Url.encode(b_pub), i.remote_static()) and PKeyPeerContact.pin(PKeyB64Url.encode(a_pub), r.remote_static()))
	t.check("mode c: a payload names no certificate", PKeyPeerPayload.payload23("c", ["app/1"]).get_string_from_utf8() == '{"v":1,"caps":["app/1"]}')
