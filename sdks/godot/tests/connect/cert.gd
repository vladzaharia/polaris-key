extends RefCounted
# @pkey-feature connect.identity
# `cases.json` sections `peerCertCases`, `ringCases` and `peerAdmissionCases` (WIRE-CONTRACT-V5
# sections 15.2 and 15.3) through PKeyPeerCert, vector for vector as the Node, Python and Kotlin
# runners do, plus the checks the corpus cannot make: the corpus floor, a trust set that holds no
# pinned key, a non-object document, and the helpers on hostile input. Reads
# res://tests/corpus/v2/cases.json (generator-owned; never edit it).

const CASES := "res://tests/corpus/v2/cases.json"


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	# 4.4's parser drops a U+0000 escape and newer engines read it as U+FFFD with a warning; spell it
	# as U+FFFD so every engine reads the same text (suite_sync_vectors does the same).
	var nul_escape := RegEx.create_from_string("(?<!\\\\)((?:\\\\\\\\)*)\\\\u0000")
	var text := nul_escape.sub(FileAccess.get_file_as_string(CASES), "$1\\uFFFD", true)
	if not t.check("cases.json parses", j.parse(text) == OK and j.data is Dictionary):
		return
	var corpus: Dictionary = j.data
	t.check("peerCertCases floor", (corpus["peerCertCases"] as Array).size() >= 113, str((corpus["peerCertCases"] as Array).size()))
	t.check("ringCases floor", (corpus["ringCases"] as Array).size() >= 76, str((corpus["ringCases"] as Array).size()))
	t.check("peerAdmissionCases floor", (corpus["peerAdmissionCases"] as Array).size() >= 17, str((corpus["peerAdmissionCases"] as Array).size()))
	_certs(t, corpus["peerCertCases"])
	_rings(t, corpus["ringCases"])
	_admission(t, corpus["peerAdmissionCases"])
	_edges(t, corpus)


func _certs(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for c in rows:
		var session: Variant = null
		if c.has("session"):
			var s: Dictionary = c["session"]
			session = {"mode": s["mode"], "remote_static": s["remoteStatic"], "own_sub": s.get("ownSub"), "own_device_id": s.get("ownDeviceId")}
		var r := PKeyPeerCert.verify_peer_cert(c["jws"], c["trust"], c["expectedAud"], int(c["now"]), session)
		var e: Dictionary = c["expect"]
		var ok: bool = r["ok"] == e["valid"]
		if ok and r["ok"]:
			var want: Dictionary = e["cert"]
			var cert: Dictionary = r["cert"]
			ok = cert == {
				"sub": want["sub"], "device_id": want["deviceId"], "sign_key": want["signKey"], "agree_key": want["agreeKey"],
				"ring_epoch": int(want["ringEpoch"]), "issued_at": int(want["issuedAt"]), "expires_at": int(want["expiresAt"]),
			}
		elif ok:
			ok = r["reason"] == e["reason"]
		good += int(t.check("cert %s" % c["id"], ok, c["description"]))
	t.check("every cert case ran", good == rows.size(), "%d/%d" % [good, rows.size()])


func _rings(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for c in rows:
		var e: Dictionary = c["expect"]
		var ok := false
		if c["kind"] == "verify":
			var r := PKeyPeerCert.verify_ring(c["jws"], c["trust"], c["expectedAud"])
			ok = r["ok"] == e["valid"]
			if ok and r["ok"]:
				var ring: Dictionary = r["ring"]
				ok = ring["epoch"] == int(e["epoch"]) and (ring["devices"] as Array).size() == int(e["devices"]) \
						and PKeyPeerCert.ring_expired(ring, int(c["now"])) == e["expired"]
			elif ok:
				ok = r["reason"] == e["reason"]
		else:
			var p := PKeyPeerCert.replace_ring(c.get("heldJws"), c["jws"], c["trust"], c["expectedAud"], int(c["now"]))
			ok = p["replace"] == e["replace"]
			if ok and not p["replace"]:
				ok = p["reason"] == e["reason"]
		good += int(t.check("ring %s" % c["id"], ok, c["description"]))
	t.check("every ring case ran", good == rows.size(), "%d/%d" % [good, rows.size()])


func _admission(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for c in rows:
		var r := PKeyPeerCert.admit_peer(c["certJws"], c["ringJws"], c["trust"], c["expectedAud"], int(c["now"]))
		var e: Dictionary = c["expect"]
		var ok: bool = r["admit"] == e["admit"]
		if ok:
			ok = (r["ring_sync"] == e["ringSync"]) if r["admit"] else (r["reason"] == e["reason"])
		good += int(t.check("admission %s" % c["id"], ok, c["description"]))
	t.check("every admission case ran", good == rows.size(), "%d/%d" % [good, rows.size()])


func _edges(t: PKeyTestContext, corpus: Dictionary) -> void:
	var cert: Dictionary = corpus["peerCertCases"][0]
	var ring: Dictionary = corpus["ringCases"][0]
	var now := int(cert["now"])
	# A trust set with no pinned key, and one that names another key under the kid.
	var r := PKeyPeerCert.verify_peer_cert(cert["jws"], {}, cert["expectedAud"], now)
	t.check("empty trust set is jws-rejected", not r["ok"] and r["reason"] == "jws-rejected")
	var wrong := {}
	for kid in cert["trust"]:
		wrong[kid] = "A".repeat(43)
	r = PKeyPeerCert.verify_peer_cert(cert["jws"], wrong, cert["expectedAud"], now)
	t.check("another key under the kid is jws-rejected", not r["ok"] and r["reason"] == "jws-rejected")
	# A certificate is not a roster and a roster is not a certificate (the typ is demanded).
	r = PKeyPeerCert.verify_peer_cert(ring["jws"], ring["trust"], ring["expectedAud"], now)
	t.check("a roster is not a certificate", not r["ok"] and r["reason"] == "jws-rejected")
	var rr := PKeyPeerCert.verify_ring(cert["jws"], cert["trust"], cert["expectedAud"])
	t.check("a certificate is not a roster", not rr["ok"] and rr["reason"] == "jws-rejected")
	# Garbage in every shape is a refusal, never an error.
	for junk in ["", "a.b", "a.b.c", "....", "x".repeat(70000)]:
		r = PKeyPeerCert.verify_peer_cert(junk, cert["trust"], cert["expectedAud"], now)
		t.check("junk '%s' is refused" % junk.left(8), not r["ok"] and r["reason"] == "jws-rejected")
	# A null or empty held ring counts as none; a held ring that is not a ring too.
	var pr := PKeyPeerCert.replace_ring(null, ring["jws"], ring["trust"], ring["expectedAud"], now)
	t.check("a null held ring is none", pr["replace"] == true)
	pr = PKeyPeerCert.replace_ring("", ring["jws"], ring["trust"], ring["expectedAud"], now)
	t.check("an empty held ring is none", pr["replace"] == true)
	pr = PKeyPeerCert.replace_ring("not.a.jws", ring["jws"], ring["trust"], ring["expectedAud"], now)
	t.check("a held ring that does not verify is none", pr["replace"] == true)
	# The session's account and device id compare as strings whatever type the caller passes.
	var s := {"mode": "a", "remote_static": 7, "own_sub": null, "own_device_id": 5}
	r = PKeyPeerCert.verify_peer_cert(cert["jws"], cert["trust"], cert["expectedAud"], now, s)
	t.check("a session with the wrong types refuses without an error", not r["ok"] and r["reason"] == "sub-mismatch")
