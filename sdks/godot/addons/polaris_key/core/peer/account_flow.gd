@tool
class_name PKeyPeerAccountFlow
extends RefCounted
## The account half of a mode-a `PKeyPeerSession` (WIRE-CONTRACT-V5 section 15.3), kept out of the session's
## file: admitting the peer's certificate against the held roster, pushing and receiving `RING`, and
## judging the peer again against a roster stored later. It owns no socket and sends nothing; the session
## hands in the account options (`PKeyPeerSession`'s `account`), a clock and an event sink. No key,
## certificate or roster is put in `str()`.

var account: Dictionary
## The peer's certificate end (epoch seconds, 0 before admission): the session closes `peer_expired` at it.
var expires_at := 0
var peer_cert_jws := ""

var _now: Callable
var _emit: Callable
var _peer_ring := 0
var _ring_at := -INF
var _ring_dropped := 0


func _init(p_account: Dictionary, now: Callable, emit: Callable) -> void:
	account = p_account
	_now = now
	_emit = emit


func _to_string() -> String:
	return "PKeyPeerAccountFlow()"


## Mode a: the peer's certificate against the remote static key and the held ring (section 15.3).
## {code, device_id}; a code of "" admits. A held roster that is expired, unverifiable or another
## account's must not admit: ask for a fresh one and refuse. Only a device with no roster at all
## (first run) admits on the certificate.
func admit_account(verdict: Dictionary, remote: PackedByteArray) -> Dictionary:
	var a := account
	var held: Variant = (a["held_ring"] as Callable).call()
	var held_jws: Variant = null
	if held is Dictionary:
		held_jws = held["jws"]
		var v := PKeyPeerCert.verify_ring(held_jws, a["trust"], a["expected_aud"])
		if not v["ok"] or PKeyPeerCert.ring_expired(v["ring"], int(_now.call())) or v["ring"]["sub"] != a["own_sub"]:
			_emit.call({"type": &"ring_wanted"})
			return {"code": PKeyPeerSession.HANDSHAKE_FAILED}
	else:
		_emit.call({"type": &"ring_wanted"})
	var adm := _admit(verdict["cert"], held_jws, remote)
	if not adm["admit"]:
		return {"code": PKeyPeerSession.PEER_REVOKED if adm["reason"] == "peer_revoked" else PKeyPeerSession.HANDSHAKE_FAILED}
	peer_cert_jws = verdict["cert"]
	var wait: int = int(adm["cert"]["expires_at"]) - int(_now.call())
	if wait <= 0:
		return {"code": PKeyPeerSession.PEER_EXPIRED}
	expires_at = int(adm["cert"]["expires_at"])
	_peer_ring = int(verdict["ring"])
	if adm["ring_sync"] == "request":
		_emit.call({"type": &"ring_wanted"})
	return {"code": &"", "device_id": adm["cert"]["device_id"]}


func _admit(cert_jws: String, ring_jws: Variant, remote: PackedByteArray) -> Dictionary:
	var a := account
	return PKeyPeerCert.admit_peer(cert_jws, ring_jws, a["trust"], a["expected_aud"], int(_now.call()), {
		"mode": "a", "remote_static": PKeyB64Url.encode(remote), "own_sub": a["own_sub"], "own_device_id": a["own_device_id"],
	})


## Whether the peer is still admitted under `ring_jws`.
func admits(ring_jws: Variant, remote: PackedByteArray) -> bool:
	return bool(_admit(peer_cert_jws, ring_jws, remote)["admit"])


## The body of the `RING` to send when the held roster is newer than the peer's, else empty.
func ring_body() -> PackedByteArray:
	var held: Variant = (account["held_ring"] as Callable).call()
	if held is Dictionary and int(held["epoch"]) > _peer_ring:
		return PKeyJson.stringify({"ring": held["jws"]}).to_utf8_buffer()
	return PackedByteArray()


## One `RING` in RING_GAP_SECONDS is worked on; the rest are dropped without a parse or a verify, and a
## peer that keeps sending them is closed (R-6G B4). `t` is monotonic seconds. Answers {code} (a close
## code, or "" for nothing to do) or {ring: {jws, epoch}} for a roster that replaces the held one.
func on_ring(body: PackedByteArray, t: float) -> Dictionary:
	if t - _ring_at < PKeyPeerSession.RING_GAP_SECONDS:
		_ring_dropped += 1
		return {"code": PKeyPeerSession.PEER_BUSY if _ring_dropped >= PKeyPeerSession.RING_DROP_LIMIT else &""}
	_ring_at = t
	_ring_dropped = 0
	var a := account
	var o: Variant = PKeyPeerPayload.parse_strict_object(body)
	if o == null or not (o as Dictionary).get("ring") is String:
		return {"code": PKeyPeerSession.PEER_BAD_FRAME}
	var held: Variant = (a["held_ring"] as Callable).call()
	var r := PKeyPeerCert.replace_ring(held["jws"] if held is Dictionary else null, o["ring"], a["trust"], a["expected_aud"], int(_now.call()))
	# A roster that is stale, older or another account's changes nothing.
	if not r["replace"] or r["ring"]["sub"] != a["own_sub"]:
		return {"code": &""}
	return {"code": &"", "ring": {"jws": o["ring"], "epoch": int(r["ring"]["epoch"])}}
