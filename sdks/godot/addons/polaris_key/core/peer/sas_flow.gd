@tool
class_name PKeyPeerSasFlow
extends RefCounted
## The commit-reveal steps of the short authentication code (modes v and p; WIRE-CONTRACT-V5 section 15.6),
## kept out of the session's file. The initiator (D) commits to its nonce, the responder (M) answers with its
## own, D reveals; each side then derives the same code from the handshake hash. This holds the nonces and the
## step; it sends nothing: every call answers what the session is to send. The nonces are key material: they
## are zeroed on `wipe()` and in no `str()`.

var n_d := PackedByteArray()
var n_m := PackedByteArray()
var step := 0
var done := false

var _crypto: PKeyPeerCrypto
var _initiator: bool
var _commit := ""


func _init(crypto: PKeyPeerCrypto, initiator: bool) -> void:
	_crypto = crypto
	_initiator = initiator


func _to_string() -> String:
	return "PKeyPeerSasFlow()"


## D: draw the nonce and answer the body of `SAS_COMMIT`.
func commit_body() -> PackedByteArray:
	n_d = _crypto.random_bytes(32)
	step = 1
	return PKeyPeerSas.body("c", PKeyPeerSas.commit(n_d))


## One SAS record. Answers {code} (the close code, or ""), and when it did not fail {send: [type, body] or
## empty, deadline: M's code deadline starts now, finish: the code can be derived}.
func on_record(type: int, body: PackedByteArray, mode: String) -> Dictionary:
	var out := {"code": PKeyPeerSession.PEER_BAD_FRAME}
	if done:
		return out
	# Responder (M): COMMIT then REVEAL. Initiator (D): NONCE.
	if type == PKeyPeerRecord.SAS_COMMIT and not _initiator and step == 0:
		out = _commit_received(body, mode)
	elif type == PKeyPeerRecord.SAS_NONCE and _initiator and step == 1:
		out = _nonce_received(body)
	elif type == PKeyPeerRecord.SAS_REVEAL and not _initiator and step == 1:
		out = _reveal_received(body)
	return out


func _commit_received(body: PackedByteArray, mode: String) -> Dictionary:
	var c: Variant = PKeyPeerSas.parse_body("c", body)
	if c == null:
		return {"code": PKeyPeerSession.PEER_BAD_FRAME}
	_commit = PKeyPeerSas.encode_value(c)
	n_m = _crypto.random_bytes(32)
	step = 1
	# In mode v the code deadline counts from D's choice, as D's does from `start_sas()` (N5).
	return {"code": &"", "send": [PKeyPeerRecord.SAS_NONCE, PKeyPeerSas.body("nM", n_m)], "deadline": mode == "v"}


func _nonce_received(body: PackedByteArray) -> Dictionary:
	var m: Variant = PKeyPeerSas.parse_body("nM", body)
	if m == null:
		return {"code": PKeyPeerSession.PEER_BAD_FRAME}
	n_m = m
	return {"code": &"", "send": [PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", n_d)], "finish": true}


func _reveal_received(body: PackedByteArray) -> Dictionary:
	var d: Variant = PKeyPeerSas.parse_body("nD", body)
	if d == null or not PKeyPeerSas.reveal_ok(_commit, PKeyPeerSas.encode_value(d)):
		return {"code": PKeyPeerSession.PEER_BAD_FRAME}
	n_d = d
	return {"code": &"", "finish": true}


## The code both screens show.
func code(hash: PackedByteArray, mode: String) -> int:
	done = true
	return PKeyPeerSas.value(hash, n_d, n_m, mode)


## Zero the nonces (best effort).
func wipe() -> void:
	n_d.fill(0)
	n_m.fill(0)
