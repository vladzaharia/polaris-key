extends RefCounted
# @pkey-feature connect.links connect.lan
# The contact half of the LAN service (PKeyConnectLan with PKeyConnectLanContacts, CC-19b.G3; WIRE-CONTRACT-V5
# sections 15.4 and 15.10). The 37 `contact.adverts` rows of `peer-matrix.json` run through the service's own
# code paths: the 6 names through the adverts it makes, the 18 TXT rows through its browse handler, the 13
# browse rows through its accepted names. Beyond the corpus: two services over real loopback TCP, a contact
# session opened both ways under the shared listener, the pin, a pending contact promoted on its first
# handshake, the gate (no contacts, no adverts and no mode-c answers) and the cap of 8 live adverts.
# Reads res://tests/corpus/v2/peer-matrix.json (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const Lan := preload("res://tests/connect/lan.gd")

var _pair: Dictionary
var _disc := PackedByteArray()


## What the host hands the service: the contacts (fresh copies on each call, the service zeroes them) and the
## promotions it was told about.
class Held extends RefCounted:
	var rows: Array = []
	var promoted: Array = []
	var calls := 0


	func contacts() -> Array:
		calls += 1
		var out: Array = []
		for r: Dictionary in rows:
			var c := r.duplicate(true)
			c["secret"] = (r["secret"] as PackedByteArray).duplicate()
			out.append(c)
		return out


	func established(c: Dictionary) -> void:
		promoted.append(c)


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var adverts: Dictionary = (j.data as Dictionary)["contact"]["adverts"]
	_pair = PKeyTestPeers.pair(1)
	_disc = PKeyTestPeers.random32()
	await _names(t, adverts["names"])
	await _txt(t, adverts["txt"], adverts["names"][0])
	await _browse(t, adverts["browse"])
	await _sessions(t)
	await _gate_and_caps(t)


# -- helpers ----------------------------------------------------------------------------------------


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _row(secret: PackedByteArray, agree: PackedByteArray, index: int, pending := false, reachable := true) -> Dictionary:
	return {"id": "link%d" % index, "agree_key": PKeyB64Url.encode(agree), "secret": secret, "label": "", "cats": [], "pending": pending, "reachable": reachable}


func _source(d: Dictionary, now: int, agree := PackedByteArray()) -> Lan.Env:
	var e := Lan.Env.new()
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = now + 1000
	s.ring = _pair["ring"]
	s.ring_epoch = 1
	s.roster = [_pair["a"]["id"], _pair["b"]["id"]]
	s.disc_current = _disc
	s.agree_public = agree if not agree.is_empty() else d["pub"]
	s.keys = Lan.FakeKeys.new(d["priv"])
	e.source = s
	e.now_value = now
	return e


func _service(d: Dictionary, held: Held, now: int, options := {}, agree := PackedByteArray(), mdns: Object = null) -> Dictionary:
	var env := _source(d, now, agree)
	var src := env.src()
	src.contacts = Callable(held, "contacts")
	src.contact_established = Callable(held, "established")
	var o := {"allow_loopback": true, "host": "127.0.0.1", "mdns": mdns if mdns != null else Lan.FakeMdns.new()}
	for k in options:
		o[k] = options[k]
	var r := PKeyConnectLan.start(src, o)
	return {"result": r, "env": env, "lan": r.detail if r.ok else null, "mdns": o["mdns"], "held": held}


func _stop(s: Dictionary) -> void:
	if s["lan"] != null:
		(s["lan"] as PKeyConnectLan).stop()


func _until(cond: Callable, frames := 900) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


# -- the corpus rows -------------------------------------------------------------------------------


func _names(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var held := Held.new()
		held.rows = [_row(String(r["secret"]).hex_decode(), PKeyB64Url.decode_strict(r["agreeKey"]), 0)]
		var s := _service(_pair["a"], held, int(r["epoch"]) * 900 + 5, {"browse": false}, PKeyB64Url.decode_strict(r["agreeKey"]))
		var seen: Array = []
		if s["lan"] != null:
			for ad: Dictionary in (s["mdns"] as Lan.FakeMdns).adverts:
				if (ad["txt"] as Array).has("m=c"):
					seen.append(ad["instance"])
		good += int(t.check("advert name %s through the service" % r["id"], seen == [r["instance"]], str(seen)))
		_stop(s)
	t.check("every advert name row ran", good == 6, "%d/6" % good)


func _txt(t: PKeyTestContext, rows: Array, name_row: Dictionary) -> void:
	var good := 0
	var secret := String(name_row["secret"]).hex_decode()
	var agree: PackedByteArray = PKeyB64Url.decode_strict(name_row["agreeKey"])
	var now := int(name_row["epoch"]) * 900 + 5
	for r: Dictionary in rows:
		var held := Held.new()
		held.rows = [_row(secret, agree, 0)]
		var s := _service(_pair["a"], held, now, {"advertise": false, "browse": false})
		var lan: PKeyConnectLan = s["lan"]
		lan._found({"instance": name_row["instance"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": 4000, "txt": r["entries"]})
		var want: bool = bool(r["want"]["ok"])
		var got := lan.contact_peers() == [{"id": "link0", "pending": false}]
		# A row that is not a contact advert is never taken as an account peer either.
		good += int(t.check("advert txt %s through the browse" % r["id"], got == want and lan.peers().is_empty()))
		_stop(s)
	t.check("every advert txt row ran", good == 18, "%d/18" % good)


func _browse(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var held := Held.new()
		var i := 0
		for c: Dictionary in r["contacts"]:
			held.rows.append(_row(String(c["secret"]).hex_decode(), PKeyB64Url.decode_strict(c["agreeKey"]), i))
			i += 1
		var s := _service(_pair["a"], held, int(r["now"]), {"advertise": false, "browse": false})
		var lan: PKeyConnectLan = s["lan"]
		lan._found({"instance": r["instance"], "host": "127.0.0.1", "hosts": ["127.0.0.1"], "port": 4000, "txt": ["v=1", "m=c"]})
		var want: Variant = r["want"]
		var seen := lan.contact_peers()
		var ok: bool = seen.is_empty() if want == null else (seen == [{"id": "link%d" % int(want["contact"]), "pending": false}])
		good += int(t.check("advert browse %s through the service" % r["id"], ok, str(seen)))
		_stop(s)
	t.check("every advert browse row ran", good == 13, "%d/13" % good)


# -- two services -----------------------------------------------------------------------------------


func _sessions(t: PKeyTestContext) -> void:
	var now := PKeyTestPeers.NOW
	var secret := PKeyTestPeers.random32()
	var a: Dictionary = _pair["a"]
	var b: Dictionary = _pair["b"]
	var bus := Lan.Bus.new()
	var held_a := Held.new()
	var held_b := Held.new()
	held_a.rows = [_row(secret, b["pub"], 0)]
	held_b.rows = [_row(secret, a["pub"], 0, true)]
	var sa := _service(a, held_a, now, {}, PackedByteArray(), Lan.FakeMdns.new(bus))
	var sb := _service(b, held_b, now, {}, PackedByteArray(), Lan.FakeMdns.new(bus))
	var la: PKeyConnectLan = sa["lan"]
	var lb: PKeyConnectLan = sb["lan"]
	t.check("both services start", la != null and lb != null)
	var opened: Array = []
	la.contact_session_opened.connect(func(s: PKeyConnectSession) -> void: opened.append(s))
	t.check("the pending contact is seen", await _until(func() -> bool: return lb.contact_peers() == [{"id": "link0", "pending": true}]))
	t.check("a held contact is seen", await _until(func() -> bool: return la.contact_peers() == [{"id": "link0", "pending": false}]))
	var got := await lb.connect_contact("link0", true)
	t.check("the dial opens a contact session", got.ok, str(got.code))
	if not got.ok:
		_stop(sa)
		_stop(sb)
		return
	var out: PKeyConnectSession = got.detail
	t.check("it names the link and has no device", out.contact == {"id": "link0", "pending": true} and out.peer_device_id == "")
	t.check("the listener opens the same", await _until(func() -> bool: return not opened.is_empty()))
	var inb: PKeyConnectSession = opened[0]
	t.check("the inbound session names its link", inb.contact == {"id": "link0", "pending": false} and inb.peer_device_id == "")
	t.check("the first handshake of a pending contact promotes it", held_b.promoted.size() == 1 and held_b.promoted[0]["id"] == "link0" and held_a.promoted.is_empty())
	out.send("hello".to_utf8_buffer())
	var m := await inb.receive()
	t.check("a message crosses the session", m.ok and (m.detail["body"] as PackedByteArray).get_string_from_utf8() == "hello")
	t.check("the secret is not in the sessions' text", not str(out).contains(secret.hex_encode()) and not str(inb).contains(secret.hex_encode()))
	out.close()
	await _until(func() -> bool: return inb.is_closed())
	# A name made with another key than the contact's is not accepted, so it is never dialled.
	var held_c := Held.new()
	var wrong := PKeyTestPeers.random32()
	held_c.rows = [_row(secret, PKeyCurve25519.x25519_public(wrong), 0)]
	var sc := _service(b, held_c, now, {"advertise": false}, PackedByteArray(), Lan.FakeMdns.new(bus))
	var lc: PKeyConnectLan = sc["lan"]
	await _until(func() -> bool: return not lc.contact_peers().is_empty())
	t.check("a contact advert under another key is not seen", lc.contact_peers().is_empty() and not (await lc.connect_contact("link0")).ok)
	_stop(sc)
	_stop(sa)
	_stop(sb)


func _gate_and_caps(t: PKeyTestContext) -> void:
	var now := PKeyTestPeers.NOW
	var a: Dictionary = _pair["a"]
	var held := Held.new()
	var s := _service(a, held, now, {"browse": false})
	t.check("with no contacts there is no contact advert", ((s["mdns"] as Lan.FakeMdns).adverts as Array).filter(func(x: Dictionary) -> bool: return (x["txt"] as Array).has("m=c")).is_empty())
	_stop(s)
	held = Held.new()
	for i in 12:
		held.rows.append(_row(PKeyTestPeers.random32(), PKeyTestPeers.random32(), i, false, i != 3))
	s = _service(a, held, now, {"browse": false})
	var live: Array = (s["lan"] as PKeyConnectLan)._cx.advert_names()
	t.check("at most 8 contact adverts are live", live.size() == 8)
	# The gate moves: no contacts, no adverts.
	held.rows = []
	(s["lan"] as PKeyConnectLan).refresh_contacts()
	t.check("a closed gate withdraws every contact advert", (s["lan"] as PKeyConnectLan)._cx.advert_names().is_empty())
	_stop(s)
	# A lane without slots gets no contact adverts, and the account advert stands.
	var lane := Lan.FakeMdns.new()
	var caps := CapsLane.new(lane)
	held = Held.new()
	held.rows = [_row(PKeyTestPeers.random32(), PKeyTestPeers.random32(), 0)]
	s = _service(a, held, now, {"browse": false}, PackedByteArray(), caps)
	t.check("an older lane gets no contact advert", s["lan"] != null and lane.adverts.size() == 1 and (lane.adverts[0]["txt"] as Array).has("m=a"))
	_stop(s)


## A lane that says it has no slots.
class CapsLane extends RefCounted:
	var _inner: Object


	func _init(inner: Object) -> void:
		_inner = inner


	func capabilities() -> Dictionary:
		return {"slots": false, "tags": false}


	func advertise(a: Dictionary) -> PKeyResult:
		return _inner.call("advertise", a)


	func browse(up: Callable, down := Callable(), accept := Callable(), _tags := {}) -> PKeyResult:
		return _inner.call("browse", up, down, accept)
