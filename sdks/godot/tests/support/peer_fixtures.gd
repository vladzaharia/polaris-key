class_name PKeyTestPeers
extends RefCounted
## TEST ONLY: two or more `PKeyPeerSession`s wired in memory (CC-14.8 on): devices with certificates
## and rosters signed with a throwaway product key (never a production key), a `Peer` that records a
## session's events and outgoing Noise messages, and a pump that delivers between two sides. The
## signatures are slow (the reference Ed25519), so each document is minted once per process.

const SLUG := "djdl"
const KID := "peer-test-2026"
const SUB := "ps_AbCdEfGhIjKlMnOpQrStUv"
const OTHER_SUB := "ps_ZyXwVuTsRqPoNmLkJiHgFe"
const NOW := 1700001000
const ID_A := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const ID_B := "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
# Valid, distinct Ed25519 keys (the corpus's own roster entries); the certificates' signKey.
const SIGN_A := "fsLskZbwiyNDAOcvWdzjPaWTBxTRCkoUQnCQhe8eJBQ"
const SIGN_B := "5ZLajJkgtNiLNr5xhXSqncSGDOyxNIH5qIZb1ePKxxQ"

static var _seed := PackedByteArray()
static var _trust := {}
static var _signed := {}


static func product_seed() -> PackedByteArray:
	if _seed.is_empty():
		for i in 32:
			_seed.append(i + 1)
	return _seed


## The effective trust set: the throwaway product key under KID.
static func trust() -> Dictionary:
	if _trust.is_empty():
		_trust = {KID: PKeyB64Url.encode(PKeyTestSigner.public_key(product_seed()))}
	return _trust


static func random32() -> PackedByteArray:
	return Crypto.new().generate_random_bytes(32)


## A fixed private key (32 bytes of `n`): a certificate for it is signed once and cached.
static func fixed(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(n)
	return b


static func _sign(body: String, typ: String) -> String:
	var id := typ + " " + body
	if not _signed.has(id):
		_signed[id] = PKeyTestSigner.sign_jws(body, product_seed(), KID, typ)
	return _signed[id]


## A device: a random agreement key and a `pkey-peer+jws` for it. {id, priv, pub (raw), agree
## (base64url), sign, cert}.
static func device(id: String, sign_key: String, epoch := 1, sub := SUB, iat := NOW - 10, exp := NOW + 1000, priv := PackedByteArray()) -> Dictionary:
	var key := priv if not priv.is_empty() else random32()
	var pub := PKeyCurve25519.x25519_public(key)
	var agree := PKeyB64Url.encode(pub)
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","deviceId":"%s","signKey":"%s",' % [SLUG, sub, id, sign_key]
	body += '"agreeKey":"%s","ringEpoch":%d,"issuedAt":%d,"expiresAt":%d}' % [agree, epoch, iat, exp]
	return {"id": id, "priv": key, "pub": pub, "agree": agree, "sign": sign_key, "cert": _sign(body, "pkey-peer+jws")}


## A `pkey-ring+jws` listing `devices` (made by `device`, in device-id order).
static func ring(epoch: int, devices: Array, sub := SUB, iat := NOW - 100, exp := NOW + 600000) -> String:
	var rows: Array[String] = []
	for d in devices:
		rows.append('{"deviceId":"%s","signKey":"%s","agreeKey":"%s"}' % [d["id"], d["sign"], d["agree"]])
	var body := '{"iss":"key.plrs.im","aud":"%s","sub":"%s","epoch":%d,"issuedAt":%d,"expiresAt":%d,"devices":[%s]}' % [SLUG, sub, epoch, iat, exp, ",".join(rows)]
	return _sign(body, "pkey-ring+jws")


## The two devices of a person on a roster of `epoch`: {a, b, ring}.
static func pair(epoch := 1) -> Dictionary:
	var a := device(ID_A, SIGN_A, epoch, SUB, NOW - 10, NOW + 1000, fixed(1))
	var b := device(ID_B, SIGN_B, epoch, SUB, NOW - 10, NOW + 1000, fixed(2))
	return {"a": a, "b": b, "ring": ring(epoch, [a, b])}


## A session under test with its recorded events and outgoing Noise messages.
class Peer extends RefCounted:
	var session: PKeyPeerSession
	var events: Array[Dictionary] = []
	var out: Array[PackedByteArray] = []
	## The held roster, {jws, epoch} or null; the session reads it at use.
	var held: Variant = null
	## Seconds, and monotonic seconds: tests move them.
	var now_value := 1700001000
	var mono_value := 0.0


	func _to_string() -> String:
		return "PKeyTestPeers.Peer()"


	# The session's callbacks. They are Callables on this object, which hold no reference to it, so a
	# peer and its session do not keep each other alive.
	func on_send(noise: PackedByteArray) -> void:
		out.append(noise)


	func on_event(event: Dictionary) -> void:
		events.append(event)


	func now() -> int:
		return now_value


	func mono() -> float:
		return mono_value


	func held_ring() -> Variant:
		return held


	## The events of one type.
	func of(type: StringName) -> Array[Dictionary]:
		var r: Array[Dictionary] = []
		for e in events:
			if e["type"] == type:
				r.append(e)
		return r


	## The `closed` events' `code` and `by_peer`, as [[code, by_peer], ...].
	func closes() -> Array:
		return of(&"closed").map(func(e: Dictionary) -> Array: return [e["code"], e["by_peer"]])


## The options of a mode-a account for `d`. `held` is read through the side, at use.
static func account(d: Dictionary, side: Peer, disc_keys: Array, sub := SUB) -> Dictionary:
	return {
		"trust": trust(), "expected_aud": SLUG, "cert_jws": d["cert"], "own_sub": sub, "own_device_id": d["id"],
		"held_ring": Callable(side, "held_ring"), "disc_keys": disc_keys,
	}


## A side. `static_key` is the raw private key or a key port; `extra` overrides or adds options
## (`account`, `caps`, `hello`, `offload`, `admission`, `rekey_messages`, `crypto`, ...). `into` is an
## existing Peer to fill in.
static func side(mode: String, role: String, static_key: Variant, extra := {}, into: Peer = null) -> Peer:
	var s := into if into != null else Peer.new()
	var o := {
		"mode": mode, "role": role, "slug": SLUG, "static_key": static_key, "caps": ["app/1", "ring/1"],
		"hello": {"platform": "test", "app": "demo"},
		"send": Callable(s, "on_send"), "on_event": Callable(s, "on_event"), "now": Callable(s, "now"), "mono": Callable(s, "mono"),
	}
	if mode != "a" and role == "responder":
		o["admission"] = PKeyPeerLimiter.new(5, 4, Callable(s, "mono"))
	for k in extra:
		o[k] = extra[k]
	var r := PKeyPeerSession.create(o)
	s.session = r.detail if r.ok else null
	return s


## A mode-a side for device `d` with the discovery keys `disc`, holding `held_jws` (at `held_epoch`)
## or no roster.
static func account_side(role: String, d: Dictionary, disc: Array, held_jws := "", held_epoch := 1, extra := {}) -> Peer:
	var s := Peer.new()
	if held_jws != "":
		s.held = {"jws": held_jws, "epoch": held_epoch}
	var o := extra.duplicate()
	o["account"] = account(d, s, disc)
	return side("a", role, d["priv"], o, s)


## Deliver between two sides until both outboxes are empty.
static func pump(a: Peer, b: Peer) -> void:
	for i in 200:
		if a.out.is_empty() and b.out.is_empty():
			return
		var to_b := a.out.duplicate()
		a.out.clear()
		for m in to_b:
			await b.session.receive(m)
		var to_a := b.out.duplicate()
		b.out.clear()
		for m in to_a:
			await a.session.receive(m)
