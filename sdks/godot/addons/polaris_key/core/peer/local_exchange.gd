@tool
class_name PKeyPeerLocalExchange
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12, "Consent and LOCAL_LINK": one side's order guard over the records of the
## pairing, ported from `LocalExchange` in `packages/client-core/src/peer/local.ts`. A `LOCAL_LINK` goes out once
## this side has sent its `CONFIRM` and read the peer's; the peer's arrives only after both. The first valid
## `LOCAL_LINK` is stored and the side closes `peer_bye`; after any close nothing happens, so a second
## `LOCAL_LINK` is never answered.
##
## An event is {event = "own-confirm" | "own-decline" | "peer-confirm" | "peer-link" | "timeout-confirm" |
## "timeout-exchange", body (PackedByteArray, for peer-link)}. A step answers {sends: Array of "CONFIRM" |
## "LOCAL_LINK", close? (a code), stored? ({label?, cats})}.

var _held: int
var _cats: Array
var _own_confirmed := false
var _peer_confirmed := false
var _link_sent := false
var _dead := false


## `held` is the number of local links the device holds; `cats` are this side's approved ones.
func _init(held: int, cats: Array) -> void:
	_held = held
	_cats = cats


func _to_string() -> String:
	return "PKeyPeerLocalExchange()"


## Both `CONFIRM`s are done (this side's sent, the peer's read), and no link has closed the session.
func both_confirmed() -> bool:
	return not _dead and _own_confirmed and _peer_confirmed


func _end(r: Dictionary, close: String) -> void:
	_dead = true
	r["close"] = close


func _maybe_link(r: Dictionary) -> void:
	if _own_confirmed and _peer_confirmed and not _link_sent:
		_link_sent = true
		r["sends"].append("LOCAL_LINK")


func step(e: Dictionary) -> Dictionary:
	var r := {"sends": []}
	if _dead:
		return r
	match e["event"]:
		"own-confirm":
			if not _own_confirmed:
				_own_confirmed = true
				r["sends"].append("CONFIRM")
				_maybe_link(r)
		"own-decline":
			# A decline after this side's CONFIRM is not an event: the person already agreed.
			if not _own_confirmed:
				_end(r, "peer_bye")
		"peer-confirm":
			if _peer_confirmed:
				_end(r, "peer_bad_frame")
			else:
				_peer_confirmed = true
				_maybe_link(r)
		"peer-link":
			_on_link(r, e["body"])
		"timeout-confirm":
			if not (_own_confirmed and _peer_confirmed):
				_end(r, "peer_timeout")
		"timeout-exchange":
			if _own_confirmed and _peer_confirmed:
				_end(r, "peer_timeout")
	return r


func _on_link(r: Dictionary, body: PackedByteArray) -> void:
	if not _own_confirmed or not _peer_confirmed:
		_end(r, "peer_bad_frame")
		return
	var v := PKeyPeerLocal.parse_local_link(body)
	if not v["ok"]:
		_end(r, "peer_bad_frame")
	elif _held >= PKeyPeerLocal.MAX_LOCAL_LINKS:
		_end(r, "peer_not_allowed")
	else:
		var stored := {"cats": PKeyPeerLocal.local_categories(_cats, v["cats"])}
		if v.has("label"):
			stored["label"] = v["label"]
		r["stored"] = stored
		_end(r, "peer_bye")
