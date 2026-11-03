class_name PKeyNativeSignIn
extends RefCounted
## The state of one native redirect sign-in (WIRE-CONTRACT-V5 §12.12), held by a PKeySignInSession
## whose `_native` is set. It owns the pending request (the PKCE verifier lives only here, until the
## code is redeemed), the loopback listener, and the one callback that arrived. Single use.

## The pending request (PKeyNativeRedirect.push_request's `pending`); {} once taken for redemption
## or dropped by a cancel.
var pending: Dictionary = {}
var authorize_url := ""
var redirect_class := ""
var redirect_uri := ""
## When the pushed request lapses on THIS client's clock (epoch seconds).
var expires_at := 0.0
## The loopback listener (a PKeyLoopbackListener, or the replayer's stand-in with the same
## members), or null on a scheme or claimed delivery.
var listener: Object = null
## The customer host's return page the loopback answers with a 303, or "".
var return_page := ""
## The first accepted callback ({} until it arrives): a PKeyNativeRedirect.parse_native_callback result.
var arrival: Dictionary = {}
## The mobile opener this sign-in was pushed with (an object with open / cancel, e.g. PKeyAndroidRedirect), or null:
## the system browser is opened through it and the OS delivers the redirect to it. Null on a desktop.
var opener: Object = null
## The host the opener may open (the issuer's); "" with no opener.
var issuer_host := ""
var closed := false
var opened := false
var _ticker: Node = null


## Attach the listener's frame driver under `host` (when it is in the tree).
func drive(host: Node) -> void:
	if listener == null or host == null or not host.is_inside_tree():
		return
	var t := PKeyLoopbackTicker.new()
	t.listener = listener
	host.add_child(t)
	_ticker = t


## The loopback listener's handler: `[location, final]`. A delivery that is not this sign-in's
## (another URL, a wrong `state`, an unreadable query) is a `404` that leaves the listener waiting.
func on_listener_callback(url: String) -> Array:
	if pending.is_empty():
		return ["", true]
	var result := PKeyNativeRedirect.parse_native_callback(pending, url)
	if result["kind"] == "failed" and result["reason"] in PKeyNativeRedirect.NOT_THIS_SIGN_IN:
		return ["", false]
	if not arrive(result):
		return ["", true]
	if result["kind"] != "failed" and result.get("request", "") != "" and return_page != "":
		return [_return_location(result["request"], result["kind"] == "cancelled"), true]
	return ["", true]


func _return_location(request: String, cancelled: bool) -> String:
	var sep := "&" if return_page.contains("?") else "?"
	return "%s%srequest=%s%s" % [return_page, sep, PKeyIdentityRedirect.form_encode(request), "&cancelled=1" if cancelled else ""]


## Record the first callback; false when one already arrived or the sign-in is closed.
func arrive(result: Dictionary) -> bool:
	if closed or not arrival.is_empty():
		return false
	arrival = result
	return true


## Close the listener and stop accepting; the sign-in cannot receive another callback.
func shut() -> void:
	closed = true
	if opener != null:
		opener.cancel()
	if listener != null:
		listener.close()
	if _ticker != null and is_instance_valid(_ticker):
		_ticker.queue_free()
	_ticker = null
