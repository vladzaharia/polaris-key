@tool
class_name PKeyPeerVouchPort
extends RefCounted
## The host's handle on one mode-v session's vouch flow (`PKeyPeerSession.vouch()`; CC-15b.G1). Each call
## is a step of WIRE-CONTRACT-V5 section 15.6.1: a verdict that closes ends the session (CLOSE sent), a
## record the flow hands over is delivered as a `record` event of the session (held first while the
## session's own code is unconfirmed). On a session that is not in mode v every call closes it
## `peer_not_allowed`. The handle holds only the session; nothing secret is printed.

var _s: PKeyPeerSession


func _init(session: PKeyPeerSession) -> void:
	_s = session


func _to_string() -> String:
	return "PKeyPeerVouchPort()"


## This side's screen shows the code (D) or the three codes (M). D may send VOUCH_REQ only after.
func shown() -> void:
	if _s._flow == null:
		_s.close(PKeyPeerSession.PEER_NOT_ALLOWED)
		return
	_s._flow.code_shown()


## M: the person picked the code D shows. The held VOUCH_REQ, if it arrived, is delivered.
func picked() -> void:
	_apply(_s._flow.picked() if _s._flow != null else _none())


## M: the session ends before a right pick (`wrong-pick`, `none-match`, `stop` or `timeout`): the request
## is never delivered and the session closes `peer_bye` (`peer_timeout` for a timeout).
func abandon(reason: String) -> void:
	_apply(_s._flow.abandon(reason) if _s._flow != null else _none())


## M: the delivered request verified (`PKeyPeerVouch.verify_request`).
func verified() -> void:
	if _s._flow != null:
		_s._flow.verified()


## M: may `nearby/approve` be called for this session? True only after the right pick and a verified
## request (rule 10).
func may_finish() -> bool:
	return _s._flow != null and not _s.is_closed() and _s._flow.may_finish()


## D: the person confirmed the signed-in account; the Sync records held meanwhile are delivered (rule 12).
func confirm_account() -> void:
	_apply(_s._flow.confirm_account() if _s._flow != null else _none())


## D: the person declined the account, or its screen timed out: held records are dropped and the
## session closes `peer_bye`.
func decline_account() -> void:
	_apply(_s._flow.decline_account() if _s._flow != null else _none())


static func _none() -> Dictionary:
	return {"ok": false, "close": PKeyPeerSession.PEER_NOT_ALLOWED}


func _apply(verdict: Dictionary) -> void:
	if not verdict["ok"]:
		_s.close(verdict["close"])
		return
	for r in verdict["deliver"]:
		if _s.is_closed():
			return
		var code: StringName = _s._deliver_host_record(r["type"], r["body"])
		if code != &"":
			_s.close(code)
			return
