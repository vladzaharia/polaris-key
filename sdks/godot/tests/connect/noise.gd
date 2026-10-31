extends RefCounted
# @pkey-feature connect.noise
# `noise-vectors.json` and the `prologue` and `psk` rows of `peer-matrix.json` (WIRE-CONTRACT-V5
# sections 15.5 and 15.6) through PKeyPeerNoise and the GDScript PKeyPeerCrypto port, mirroring the
# Python, Kotlin and Node runners: the X25519 and AES-256-GCM known answers, the low-order points,
# the three handshake modes byte for byte with rekey, the 15 failure rows and the external anchors.
# Beyond the corpus: the device key store as the static key (G1), the engine's refusals, nonce
# exhaustion and the redaction of every type that holds a key. Both files are generator-owned
# mirrors under res://tests/corpus/v2/ and are never edited.

const VECTORS := "res://tests/corpus/v2/noise-vectors.json"
const MATRIX := "res://tests/corpus/v2/peer-matrix.json"


## The reference swaps the initiator's ephemeral public key before it mixes it; so does this.
class SwapPublic extends PKeyPeerCrypto:
	var priv: PackedByteArray
	var pub: PackedByteArray

	func _init(p_priv: PackedByteArray, p_pub: PackedByteArray) -> void:
		priv = p_priv
		pub = p_pub

	func x25519_public(private_key: PackedByteArray) -> PackedByteArray:
		return pub if private_key == priv else super.x25519_public(private_key)


## A port whose DH answers a fixed value.
class FixedDh extends PKeyPeerCrypto:
	var answer: Variant

	func _init(p_answer: Variant) -> void:
		answer = p_answer

	func x25519(_private_key: PackedByteArray, _peer_public: PackedByteArray) -> Variant:
		return answer


## A port whose AEAD refuses (a native lane gone wrong).
class RefusingSeal extends PKeyPeerCrypto:
	func aes_gcm_seal(_key: PackedByteArray, _nonce: PackedByteArray, _aad: PackedByteArray, _plain: PackedByteArray) -> PackedByteArray:
		return PackedByteArray()


## A static key port that counts its DH calls and answers from a raw key.
class CountingStatic extends RefCounted:
	var raw: PackedByteArray
	var public: PackedByteArray
	var calls := 0

	func _init(p_raw: PackedByteArray, p_public: PackedByteArray) -> void:
		raw = p_raw
		public = p_public

	func public_key() -> PackedByteArray:
		return public

	func dh(remote: PackedByteArray) -> Variant:
		calls += 1
		return PKeyPeerCrypto.new().x25519(raw, remote)


var _crypto := PKeyPeerCrypto.new()


func run(t: PKeyTestContext) -> void:
	var v := _json(t, VECTORS)
	var m := _json(t, MATRIX)
	if v.is_empty() or m.is_empty():
		return
	t.check("noiseVectorsVersion is 1", v["noiseVectorsVersion"] == 1)
	_x25519(t, v)
	_low_order(t, v)
	_aes_gcm(t, v)
	_handshakes(t, v)
	_failures(t, v)
	_anchors(t, v)
	_matrix(t, m)
	_dh_refusals(t, v)
	_key_ports(t, v)
	_misuse(t)
	_ciphers(t)
	_redaction(t)


func _json(t: PKeyTestContext, path: String) -> Dictionary:
	var j := JSON.new()
	if not t.check("%s parses" % path.get_file(), j.parse(FileAccess.get_file_as_string(path)) == OK and j.data is Dictionary, path):
		return {}
	return j.data


func _hex(s: Variant) -> PackedByteArray:
	return (s as String).hex_decode() if s is String else PackedByteArray()


func _x25519(t: PKeyTestContext, v: Dictionary) -> void:
	for c in v["x25519"]["scalarMult"]:
		var out: Variant = _crypto.x25519(_hex(c["scalar"]), _hex(c["u"]))
		t.check("x25519 %s" % c["id"], out is PackedByteArray and (out as PackedByteArray).hex_encode() == c["expect"])
	for c in v["x25519"]["agreement"]:
		var a := _hex(c["alicePrivate"])
		var b := _hex(c["bobPrivate"])
		t.check("agreement %s public keys" % c["id"], _crypto.x25519_public(a).hex_encode() == c["alicePublic"] and _crypto.x25519_public(b).hex_encode() == c["bobPublic"])
		var ab: Variant = _crypto.x25519(a, _hex(c["bobPublic"]))
		var ba: Variant = _crypto.x25519(b, _hex(c["alicePublic"]))
		t.check("agreement %s shared secret" % c["id"], ab is PackedByteArray and ba is PackedByteArray and ab == ba and (ab as PackedByteArray).hex_encode() == c["shared"])


func _low_order(t: PKeyTestContext, v: Dictionary) -> void:
	var scalar := _hex(v["lowOrder"]["scalar"])
	var rows: Array = v["lowOrder"]["rows"]
	t.check("lowOrder has 17 rows", rows.size() == 17)
	for r in rows:
		var u := _hex(r["u"])
		t.check("low order %s classified" % r["id"], PKeyCurve25519.is_low_order(u) == r["lowOrder"])
		var out: Variant = _crypto.x25519(scalar, u)
		if r["allZero"]:
			t.check("low order %s refused" % r["id"], out == null)
		else:
			t.check("low order %s output" % r["id"], out is PackedByteArray and (out as PackedByteArray).hex_encode() == r["output"])


func _aes_gcm(t: PKeyTestContext, v: Dictionary) -> void:
	t.check("aesGcm has 4 rows", (v["aesGcm"] as Array).size() == 4)
	for c in v["aesGcm"]:
		var key := _hex(c["key"])
		var nonce := _hex(c["nonce"])
		var aad := _hex(c["aad"])
		var sealed := _crypto.aes_gcm_seal(key, nonce, aad, _hex(c["plaintext"]))
		t.check("gcm %s seals" % c["id"], sealed.hex_encode() == c["ciphertext"] + c["tag"])
		var opened: Variant = _crypto.aes_gcm_open(key, nonce, aad, sealed)
		t.check("gcm %s opens" % c["id"], opened is PackedByteArray and (opened as PackedByteArray).hex_encode() == c["plaintext"])
		var bad := sealed.duplicate()
		bad[bad.size() - 1] ^= 1
		t.check("gcm %s a flipped bit fails" % c["id"], _crypto.aes_gcm_open(key, nonce, aad, bad) == null)
	var k := PackedByteArray()
	k.resize(32)
	var n := PackedByteArray()
	n.resize(12)
	t.check("gcm refuses a short key", _crypto.aes_gcm_seal(k.slice(0, 31), n, PackedByteArray(), PackedByteArray()).is_empty())
	t.check("gcm refuses a long nonce", _crypto.aes_gcm_seal(k, n + PackedByteArray([0]), PackedByteArray(), PackedByteArray()).is_empty())
	var big := PackedByteArray()
	big.resize(PKeyPeerCrypto.MAX_AEAD_BYTES - 15)
	t.check("gcm refuses a plaintext past a Noise message", _crypto.aes_gcm_seal(k, n, PackedByteArray(), big).is_empty())
	big.resize(PKeyPeerCrypto.MAX_AEAD_BYTES - 16)
	t.check("gcm seals the largest plaintext", _crypto.aes_gcm_seal(k, n, PackedByteArray(), big).size() == PKeyPeerCrypto.MAX_AEAD_BYTES)
	t.check("gcm refuses a short sealed", _crypto.aes_gcm_open(k, n, PackedByteArray(), PackedByteArray([1, 2, 3])) == null)
	t.check("x25519 refuses a short key", _crypto.x25519(k.slice(0, 31), k) == null)
	t.check("x25519 refuses a short peer key", _crypto.x25519(k, k.slice(0, 31)) == null)
	t.check("x25519_public refuses a short key", _crypto.x25519_public(k.slice(0, 31)).is_empty())
	t.check("random_bytes", _crypto.random_bytes(32).size() == 32)


## Runs `payloads` through two handshakes, alternating writers from the initiator. Returns
## {wire: Array of PackedByteArray, failed_at: int (-1 none), reason: String, init, resp}.
func _run_handshake(protocol: String, init: Dictionary, resp: Dictionary, payloads: Array, swap: Variant = null) -> Dictionary:
	var ports := [null, null]
	if swap != null:
		ports[0] = SwapPublic.new(_hex(init["ephemeral"]), swap)
	var made: Array = []
	for i in 2:
		var s: Dictionary = init if i == 0 else resp
		var psk: Variant = _hex(s["psk"]) if s.get("psk") else null
		var static_hex: String = s["static"] if s.get("static") else "00".repeat(32)
		var role := "initiator" if i == 0 else "responder"
		var r := PKeyPeerNoise.start(role, protocol, _hex(s["prologue"]), _hex(static_hex), psk, _hex(s["ephemeral"]), ports[i])
		if not r.ok:
			return {"wire": [], "failed_at": -2, "reason": String(r.code), "init": null, "resp": null}
		made.append(r.detail)
	var out := {"wire": [], "failed_at": -1, "reason": "", "init": made[0], "resp": made[1]}
	for idx in payloads.size():
		var w = made[idx % 2]
		var d = made[(idx + 1) % 2]
		var wr: PKeyResult = w.write_message(payloads[idx])
		if not wr.ok:
			out["failed_at"] = idx
			out["reason"] = String(wr.code)
			return out
		out["wire"].append(wr.detail)
		var rd: PKeyResult = d.read_message(wr.detail)
		if not rd.ok:
			out["failed_at"] = idx
			out["reason"] = String(rd.code)
			return out
		if rd.detail != payloads[idx]:
			out["failed_at"] = idx
			out["reason"] = "payload"
			return out
	return out


func _side(h: Dictionary, init: bool) -> Dictionary:
	return {
		"prologue": h["prologue"], "psk": h.get("psk"),
		"static": h["initStatic" if init else "respStatic"], "ephemeral": h["initEphemeral" if init else "respEphemeral"],
	}


func _handshake_rows(h: Dictionary) -> Array:
	var rows: Array = []
	for m in h["messages"]:
		if m["kind"] == "handshake":
			rows.append(m)
	return rows


func _handshakes(t: PKeyTestContext, v: Dictionary) -> void:
	var modes := []
	for h in v["handshakes"]:
		modes.append(h["mode"])
		var id: String = h["id"]
		t.check("%s protocol name" % id, PKeyPeerNoise.protocol_name(h["mode"]) == h["protocol"])
		t.check("%s prologue" % id, PKeyPeerNoise.prologue(h["slug"], h["mode"]).hex_encode() == h["prologue"])
		if h.get("psk"):
			var k_disc := PKeySyncHkdf.sha256("pkey-peer/1 noise vector k_disc".to_utf8_buffer())
			t.check("%s psk from k_disc" % id, PKeyPeerNoise.psk(k_disc, h["slug"]).hex_encode() == h["psk"])
		var hs := _handshake_rows(h)
		var payloads: Array = []
		for m in hs:
			payloads.append(_hex(m["payload"]))
		var run := _run_handshake(h["protocol"], _side(h, true), _side(h, false), payloads)
		t.check("%s handshake completes" % id, run["failed_at"] == -1, "%s at %d" % [run["reason"], run["failed_at"]])
		if run["failed_at"] != -1:
			continue
		var wire_ok := (run["wire"] as Array).size() == hs.size()
		for k in hs.size():
			wire_ok = wire_ok and (run["wire"][k] as PackedByteArray).hex_encode() == hs[k]["ciphertext"]
		t.check("%s handshake messages byte for byte" % id, wire_ok)
		var i: PKeyPeerNoise.Handshake = run["init"]
		var r: PKeyPeerNoise.Handshake = run["resp"]
		t.check("%s finished" % id, i.finished() and r.finished())
		t.check("%s handshake hash" % id, i.handshake_hash().hex_encode() == h["handshakeHash"] and r.handshake_hash().hex_encode() == h["handshakeHash"])
		t.check("%s remote statics" % id, i.remote_static().hex_encode() == h["respStaticPublic"] and r.remote_static().hex_encode() == h["initStaticPublic"])
		var ti: PKeyPeerNoise.Transport = i.transport().detail
		var tr: PKeyPeerNoise.Transport = r.transport().detail
		t.check("%s a spent handshake refuses the transport again" % id, not i.transport().ok and i.transport().code == &"state")
		var good := true
		var records := 0
		for m in h["messages"]:
			if m["kind"] != "transport":
				continue
			records += 1
			var src: PKeyPeerNoise.Transport = ti if m["from"] == "i" else tr
			var dst: PKeyPeerNoise.Transport = tr if m["from"] == "i" else ti
			var ct := src.send.encrypt(PackedByteArray(), _hex(m["payload"]))
			good = good and ct.ok and (ct.detail as PackedByteArray).hex_encode() == m["ciphertext"]
			var pt := dst.receive.decrypt(PackedByteArray(), ct.detail) if ct.ok else ct
			good = good and pt.ok and (pt.detail as PackedByteArray).hex_encode() == m["payload"]
			if m.get("rekeyAfter"):
				good = good and src.send.rekey().ok and dst.receive.rekey().ok
		t.check("%s transport records and rekey byte for byte" % id, good and records > 0, "%d records" % records)
		_tamper(t, h)
	modes.sort()
	t.check("the three modes cover a, v and p", modes == ["a", "p", "v"])


func _tamper(t: PKeyTestContext, h: Dictionary) -> void:
	var payloads: Array = []
	for m in _handshake_rows(h):
		payloads.append(_hex(m["payload"]))
	var run := _run_handshake(h["protocol"], _side(h, true), _side(h, false), payloads)
	var ti: PKeyPeerNoise.Transport = (run["init"] as PKeyPeerNoise.Handshake).transport().detail
	var tr: PKeyPeerNoise.Transport = (run["resp"] as PKeyPeerNoise.Handshake).transport().detail
	var ct: PackedByteArray = ti.send.encrypt(PackedByteArray(), PackedByteArray([1, 2])).detail
	var bad := ct.duplicate()
	bad[0] ^= 1
	var r := tr.receive.decrypt(PackedByteArray(), bad)
	t.check("%s a tampered record fails with decrypt" % h["id"], not r.ok and r.code == &"decrypt")
	var good := tr.receive.decrypt(PackedByteArray(), ct)
	t.check("%s the failed read did not advance the counter" % h["id"], good.ok and good.detail == PackedByteArray([1, 2]))
	var replay := tr.receive.decrypt(PackedByteArray(), ct)
	t.check("%s a replayed record fails" % h["id"], not replay.ok and replay.code == &"decrypt")


func _failures(t: PKeyTestContext, v: Dictionary) -> void:
	t.check("there are 15 failure rows", (v["failures"] as Array).size() == 15)
	for f in v["failures"]:
		var rp: Variant = f.get("responderPsk") if f.get("responderPsk") else f.get("psk")
		var payloads: Array = []
		for p in f["payloads"]:
			payloads.append(_hex(p))
		var run := _run_handshake(
				f["protocol"],
				{"prologue": f["prologue"], "psk": f.get("psk"), "static": f["initStatic"], "ephemeral": f["initEphemeral"]},
				{"prologue": f["responderPrologue"] if f.get("responderPrologue") else f["prologue"], "psk": rp, "static": f["respStatic"], "ephemeral": f["respEphemeral"]},
				payloads,
				_hex(f["initEphemeralPublic"]) if f.get("initEphemeralPublic") else null)
		t.check("failure %s" % f["id"], run["failed_at"] == int(f["failedAt"]) and run["reason"] == f["reason"], "%s at %s" % [run["reason"], run["failed_at"]])
		if run["init"] != null:
			var again: PKeyResult = (run["init"] as PKeyPeerNoise.Handshake).write_message(PackedByteArray())
			var again2: PKeyResult = (run["resp"] as PKeyPeerNoise.Handshake).write_message(PackedByteArray())
			t.check("failure %s leaves a dead handshake" % f["id"], (not again.ok) and (not again2.ok) and ((run["init"] as PKeyPeerNoise.Handshake).dead() or (run["resp"] as PKeyPeerNoise.Handshake).dead()))


func _anchors(t: PKeyTestContext, v: Dictionary) -> void:
	var ran := 0
	for a in v["anchors"]["vectors"]:
		var x: Dictionary = a["vector"]
		if x["protocol_name"] != "Noise_XX_25519_AESGCM_SHA256":
			continue  # the engine implements XX and XXpsk0 only; NNpsk0 anchors the reference
		ran += 1
		var payloads: Array = []
		for k in 3:
			payloads.append(_hex(x["messages"][k]["payload"]))
		var run := _run_handshake(
				x["protocol_name"],
				{"prologue": x["init_prologue"], "static": x["init_static"], "ephemeral": x["init_ephemeral"]},
				{"prologue": x["resp_prologue"], "static": x["resp_static"], "ephemeral": x["resp_ephemeral"]},
				payloads)
		t.check("anchor %s #%d completes" % [a["source"], ran], run["failed_at"] == -1)
		if run["failed_at"] != -1:
			continue
		var wire_ok := true
		for k in 3:
			wire_ok = wire_ok and (run["wire"][k] as PackedByteArray).hex_encode() == x["messages"][k]["ciphertext"]
		t.check("anchor %s #%d handshake messages" % [a["source"], ran], wire_ok)
		var i: PKeyPeerNoise.Handshake = run["init"]
		if x.get("handshake_hash"):
			t.check("anchor %s #%d handshake hash" % [a["source"], ran], i.handshake_hash().hex_encode() == x["handshake_hash"])
		var ti: PKeyPeerNoise.Transport = i.transport().detail
		var tr: PKeyPeerNoise.Transport = (run["resp"] as PKeyPeerNoise.Handshake).transport().detail
		var good := true
		for k in range(3, (x["messages"] as Array).size()):
			var src := ti if k % 2 == 0 else tr
			var dst := tr if k % 2 == 0 else ti
			var ct := src.send.encrypt(PackedByteArray(), _hex(x["messages"][k]["payload"]))
			good = good and ct.ok and (ct.detail as PackedByteArray).hex_encode() == x["messages"][k]["ciphertext"]
			var pt := dst.receive.decrypt(PackedByteArray(), ct.detail) if ct.ok else ct
			good = good and pt.ok and (pt.detail as PackedByteArray).hex_encode() == x["messages"][k]["payload"]
		t.check("anchor %s #%d transport" % [a["source"], ran], good)
	t.check("two XX anchors ran", ran == 2)


func _matrix(t: PKeyTestContext, m: Dictionary) -> void:
	t.check("peerMatrixVersion is 1", m["peerMatrixVersion"] == 1)
	t.check("prologue has 6 rows", (m["prologue"] as Array).size() == 6)
	for r in m["prologue"]:
		t.check("prologue %s %s" % [r["slug"], r["mode"]], PKeyPeerNoise.prologue(r["slug"], r["mode"]).hex_encode() == r["prologue"])
	t.check("psk has 4 rows", (m["psk"] as Array).size() == 4)
	for r in m["psk"]:
		t.check("psk %s" % r["slug"], PKeyPeerNoise.psk(_hex(r["kDisc"]), r["slug"]).hex_encode() == r["psk"])
	t.check("psk refuses a short discovery key", PKeyPeerNoise.psk(PackedByteArray([1, 2]), "demo").is_empty())


## An all-zero or a refused DH output aborts with dh_zero, and the handshake is dead afterwards.
func _dh_refusals(t: PKeyTestContext, v: Dictionary) -> void:
	var row: Dictionary = v["handshakes"][1]  # v: the responder reads message 1, then writes the DH in message 2
	var answers := {"zeros": PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "refused": null, "short": PackedByteArray([1, 2, 3])}
	for name in answers:
		var r := PKeyPeerNoise.start("responder", row["protocol"], _hex(row["prologue"]), _hex(row["respStatic"]), null, _hex(row["respEphemeral"]), FixedDh.new(answers[name]))
		var i := PKeyPeerNoise.start("initiator", row["protocol"], _hex(row["prologue"]), _hex(row["initStatic"]), null, _hex(row["initEphemeral"]))
		var resp: PKeyPeerNoise.Handshake = r.detail
		var init: PKeyPeerNoise.Handshake = i.detail
		t.check("dh %s: message 1 reads" % name, resp.read_message(init.write_message(PackedByteArray([120])).detail).ok)
		var w := resp.write_message(PackedByteArray([121]))
		t.check("dh %s refuses with dh_zero" % name, not w.ok and w.code == &"dh_zero")
		var w2 := resp.write_message(PackedByteArray([121]))
		t.check("dh %s leaves a dead handshake" % name, not w2.ok and w2.code == &"state" and resp.dead())


## The static key as a port (G1): the device key store's agreement key never leaves the store.
func _key_ports(t: PKeyTestContext, v: Dictionary) -> void:
	var h: Dictionary = v["handshakes"][1]
	var port := CountingStatic.new(_hex(h["respStatic"]), _hex(h["respStaticPublic"]))
	var hs := _handshake_rows(h)
	var i := PKeyPeerNoise.start("initiator", h["protocol"], _hex(h["prologue"]), _hex(h["initStatic"]), null, _hex(h["initEphemeral"])).detail as PKeyPeerNoise.Handshake
	var r := PKeyPeerNoise.start("responder", h["protocol"], _hex(h["prologue"]), port, null, _hex(h["respEphemeral"])).detail as PKeyPeerNoise.Handshake
	var good := true
	for k in hs.size():
		var w := i if k % 2 == 0 else r
		var d := r if k % 2 == 0 else i
		var ct := w.write_message(_hex(hs[k]["payload"]))
		good = good and ct.ok and (ct.detail as PackedByteArray).hex_encode() == hs[k]["ciphertext"] and d.read_message(ct.detail).ok
	t.check("a key port stands in for the static key, byte for byte", good)
	t.check("only the es token (message 2) used the responder static", port.calls == 1, str(port.calls))

	# The real device key store, behind StoreStatic, against a raw static key.
	var store := PKeyDeviceKeyStore.memory_only()
	t.check("store makes keys", store.ensure().ok)
	var adapter := PKeyPeerNoise.StoreStatic.new(store)
	var agree: String = store.public_keys().detail["agree_key"]
	t.check("StoreStatic.public_key is the store's agreement key", PKeyB64Url.encode(adapter.public_key()) == agree)
	var proto := PKeyPeerNoise.protocol_name("a")
	var pro := PKeyPeerNoise.prologue("demo", "a")
	var psk := _hex(v["handshakes"][0]["psk"])
	var raw := _crypto.random_bytes(32)
	var a := PKeyPeerNoise.start("initiator", proto, pro, adapter, psk).detail as PKeyPeerNoise.Handshake
	var b := PKeyPeerNoise.start("responder", proto, pro, raw, psk).detail as PKeyPeerNoise.Handshake
	var ok := true
	for k in 3:
		var w := a if k % 2 == 0 else b
		var d := b if k % 2 == 0 else a
		var ct := w.write_message(PackedByteArray([k]))
		ok = ok and ct.ok and d.read_message(ct.detail).ok
	t.check("an XXpsk0 handshake with the store as initiator static completes", ok and a.finished() and b.finished())
	var agree_ok: bool = ok and a.handshake_hash() == b.handshake_hash()
	agree_ok = agree_ok and b.remote_static() == adapter.public_key() and a.remote_static() == _crypto.x25519_public(raw)
	t.check("both sides agree on the hash and the statics", agree_ok)
	t.check("StoreStatic refuses a low-order point", adapter.dh(PackedByteArray([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) == null)
	var empty := PKeyPeerNoise.StoreStatic.new(PKeyDeviceKeyStore.memory_only())
	t.check("StoreStatic of a store with no keys has no public key and no DH", empty.public_key().is_empty() and empty.dh(_crypto.x25519_public(raw)) == null)


func _misuse(t: PKeyTestContext) -> void:
	var p := "Noise_XX_25519_AESGCM_SHA256"
	var pro := PackedByteArray([112])
	var s := PackedByteArray()
	s.resize(32)
	s.fill(7)
	t.check("a PSK on plain XX is bad_key", PKeyPeerNoise.start("initiator", p, pro, s, s).code == &"bad_key")
	t.check("XXpsk0 without a PSK is bad_key", PKeyPeerNoise.start("initiator", "Noise_XXpsk0_25519_AESGCM_SHA256", pro, s).code == &"bad_key")
	t.check("a short PSK is bad_key", PKeyPeerNoise.start("initiator", "Noise_XXpsk0_25519_AESGCM_SHA256", pro, s, PackedByteArray([1])).code == &"bad_key")
	t.check("a short ephemeral key is bad_key", PKeyPeerNoise.start("initiator", p, pro, s, null, PackedByteArray([1])).code == &"bad_key")
	t.check("a short static key is bad_key", PKeyPeerNoise.start("initiator", p, pro, PackedByteArray([1])).code == &"bad_key")
	t.check("a static that is not a key or a port is bad_key", PKeyPeerNoise.start("initiator", p, pro, "nope").code == &"bad_key")
	t.check("another pattern is refused", PKeyPeerNoise.start("initiator", "Noise_NN_25519_AESGCM_SHA256", pro, s).code == &"state")
	t.check("another cipher is refused", PKeyPeerNoise.start("initiator", "Noise_XX_25519_ChaChaPoly_SHA256", pro, s).code == &"state")
	t.check("a protocol with a trailing newline is refused", PKeyPeerNoise.start("initiator", p + "\n", pro, s).code == &"state")
	t.check("an unknown role is refused", PKeyPeerNoise.start("both", p, pro, s).code == &"state")
	var h := PKeyPeerNoise.start("initiator", p, pro, s).detail as PKeyPeerNoise.Handshake
	var early := h.read_message(PackedByteArray())
	t.check("reading out of turn is state", not early.ok and early.code == &"state")
	t.check("the handshake hash is empty before the end", h.handshake_hash().is_empty())
	t.check("the transport is refused before the end", h.transport().code == &"state")
	t.check("a refusal by turn does not kill the handshake", not h.dead())
	var r := PKeyPeerNoise.start("responder", p, pro, s).detail as PKeyPeerNoise.Handshake
	var big := PackedByteArray()
	big.resize(PKeyPeerNoise.MAX_MESSAGE + 1)
	var over := r.read_message(big)
	t.check("a message over 65,535 bytes is malformed", not over.ok and over.code == &"malformed")
	var short := PKeyPeerNoise.start("responder", p, pro, s).detail as PKeyPeerNoise.Handshake
	t.check("a truncated message 1 is malformed", short.read_message(PackedByteArray([1, 2, 3])).code == &"malformed")
	var huge := PKeyPeerNoise.start("initiator", p, pro, s).detail as PKeyPeerNoise.Handshake
	var too_big := PackedByteArray()
	too_big.resize(PKeyPeerNoise.MAX_MESSAGE - 31)
	t.check("a payload that overflows a message is malformed", huge.write_message(too_big).code == &"malformed")


func _ciphers(t: PKeyTestContext) -> void:
	var key := PackedByteArray()
	key.resize(32)
	var c := PKeyPeerNoise.CipherState.new(key, _crypto)
	t.check("a keyed cipher has a key", c.has_key())
	var short := c.decrypt(PackedByteArray(), PackedByteArray([1, 2, 3]))
	t.check("a short ciphertext is malformed", not short.ok and short.code == &"malformed")
	var long_plain := PackedByteArray()
	long_plain.resize(PKeyPeerNoise.MAX_MESSAGE - 15)
	var over := c.encrypt(PackedByteArray(), long_plain)
	t.check("an oversize plaintext is malformed", not over.ok and over.code == &"malformed")
	long_plain.resize(PKeyPeerNoise.MAX_MESSAGE - 16)
	var edge := c.encrypt(PackedByteArray(), long_plain)
	t.check("the largest plaintext seals to a 65,535-byte message", edge.ok and (edge.detail as PackedByteArray).size() == PKeyPeerNoise.MAX_MESSAGE)
	t.check("a sealed record advanced the counter", c.n == 1)
	# The nonce layout: four zero bytes, then the counter big endian; 2^64-1 is eight 0xFF bytes.
	t.check("nonce 0", PKeyPeerNoise.nonce_of(0).hex_encode() == "000000000000000000000000")
	t.check("nonce 258", PKeyPeerNoise.nonce_of(258).hex_encode() == "000000000000000000000102")
	t.check("nonce 2^63-1", PKeyPeerNoise.nonce_of(9223372036854775807).hex_encode() == "00000000" + "7fffffffffffffff")
	t.check("nonce 2^64-1 is eight 0xFF bytes", PKeyPeerNoise.nonce_of(PKeyPeerNoise.MAX_NONCE).hex_encode() == "00000000" + "ffffffffffffffff")
	# Exhaustion: park the counter one below the end; one record seals, the next refuses.
	var e := PKeyPeerNoise.CipherState.new(key, _crypto)
	e.n = PKeyPeerNoise.MAX_NONCE - 1
	t.check("the last nonce seals", e.encrypt(PackedByteArray(), PackedByteArray([1])).ok)
	var done := e.encrypt(PackedByteArray(), PackedByteArray([1]))
	t.check("past the last nonce is nonce_exhausted", not done.ok and done.code == &"nonce_exhausted")
	t.check("decrypt at the end is nonce_exhausted", e.decrypt(PackedByteArray(), PackedByteArray([1])).code == &"nonce_exhausted")
	# A key-less cipher passes data through, and cannot rekey.
	var plain := PKeyPeerNoise.CipherState.new(PackedByteArray(), _crypto)
	var five := PackedByteArray([5])
	t.check("a key-less cipher passes data through", plain.encrypt(PackedByteArray(), five).detail == five and plain.decrypt(PackedByteArray(), five).detail == five)
	t.check("a key-less cipher cannot rekey", plain.rekey().code == &"state")
	# Rekey changes the key, keeps the counter, and both ends stay in step.
	var a := PKeyPeerNoise.CipherState.new(key, _crypto)
	var b := PKeyPeerNoise.CipherState.new(key, _crypto)
	var one := a.encrypt(PackedByteArray(), PackedByteArray([9])).detail as PackedByteArray
	t.check("before rekey the peer reads it", b.decrypt(PackedByteArray(), one).ok)
	t.check("both rekey", a.rekey().ok and b.rekey().ok and a.n == 1 and b.n == 1)
	var two := a.encrypt(PackedByteArray(), PackedByteArray([9])).detail as PackedByteArray
	t.check("after rekey the peer reads it", b.decrypt(PackedByteArray(), two).ok)
	var stale := PKeyPeerNoise.CipherState.new(key, _crypto)
	stale.n = 2
	t.check("a cipher that did not rekey cannot read it", stale.decrypt(PackedByteArray(), two).code == &"decrypt")
	# An engine that refuses (a native lane gone wrong) is state, never a crash.
	var refusing := PKeyPeerNoise.CipherState.new(key, RefusingSeal.new())
	var refused := refusing.encrypt(PackedByteArray(), PackedByteArray([1]))
	t.check("an engine that refuses is state", not refused.ok and refused.code == &"state" and refusing.n == 0)
	t.check("rekey on an engine that refuses is state", refusing.rekey().code == &"state")


func _redaction(t: PKeyTestContext) -> void:
	var s := PackedByteArray()
	s.resize(32)
	for i in 32:
		s[i] = i + 1
	var h := PKeyPeerNoise.start("initiator", "Noise_XX_25519_AESGCM_SHA256", PackedByteArray([112]), s).detail as PKeyPeerNoise.Handshake
	var c := PKeyPeerNoise.CipherState.new(s, _crypto)
	var tr := PKeyPeerNoise.Transport.new(c, c)
	var adapter := PKeyPeerNoise.StoreStatic.new(PKeyDeviceKeyStore.memory_only())
	for obj in [h, c, tr, adapter]:
		var text := str(obj)
		t.check("%s shows nothing secret" % text, text.length() < 30 and not text.contains("0102") and not text.contains("AQID"))
