extends RefCounted
# @pkey-feature identity.redirect.native
# The system browser sheet of a registered-scheme native sign-in (I-48.17): a fake opener models the
# Swift ops (PolarisKeyPlatform/WebAuthHost.swift). The URL the OS hands back goes through
# handle_redirect: the state check, single use, and the redemption from this device.

const NR := preload("res://tests/identity/test_native_redirect.gd")
const B := preload("res://tests/identity/support.gd")


## What PKeyAppleAuth offers PKeyIdentity: open, cancel_sheet, sheet_id.
class FakeOpener:
	extends RefCounted
	var opens: Array = []
	var cancelled: Array = []
	var sheet_id := 0
	var shows := true
	var done := Callable()
	var fail := Callable()

	func open(url: String, scheme: String, issuer_host: String, on_done: Callable, on_fail: Callable, _ephemeral := false) -> bool:
		if not shows:
			return false
		sheet_id += 1
		opens.append({"url": url, "scheme": scheme, "issuer_host": issuer_host})
		done = on_done
		fail = on_fail
		return true

	func cancel_sheet(id: int) -> void:
		cancelled.append(id)


## The fake Worker is plain http; the sheet takes only an https authorize URL, so discovery names one.
func _https(bed) -> void:
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["authorize"] = "https://key.plrs.im/djdl/identity/authorize"


func run(t: PKeyTestContext) -> void:
	var nr = NR.new()
	var opener := FakeOpener.new()

	# A registered scheme with the sheet available: the sheet shows the authorize URL.
	var bed = await nr._bed()
	bed.sdk.identity.native_platform = "ios"
	bed.sdk.identity.auth_opener = opener
	_https(bed)
	var root: String = nr._root(bed)
	var s = await nr._start(bed, {"browser": true, "loopback": false, "registered_schemes": [NR.SCHEME]})
	t.check("sheet: a scheme sign-in opens the authorize URL in the sheet", s.ok and s.opened and opener.opens.size() == 1 and opener.opens[0]["url"] == s.authorize_url, str(s))
	var bound: bool = opener.opens[0]["scheme"] == "com.tidewater.studio" and opener.opens[0]["issuer_host"] == "127.0.0.1"
	t.check("sheet: the sheet is bound to the registered scheme and the issuer host", bound, str(opener.opens))
	var st: String = nr._param(bed.push_requests[0]["body"], "state")
	var good := "%s?code=C0DE&state=%s&iss=%s" % [NR.SCHEME, st, root.uri_encode()]
	var box := []
	s.outcome.connect(func(o): box.append(o))
	opener.done.call("%s?code=C0DE&state=wrong-state-0123456789&iss=%s" % [NR.SCHEME, root.uri_encode()])
	t.check("sheet: a delivery with another state is refused and sends nothing", bed.token_requests.is_empty() and not s._native.pending.is_empty())
	opener.done.call(good)
	await B.until(func(): return box.size() == 1, 400)
	var redeemed: bool = box.size() == 1 and box[0].kind == PKeySignInOutcome.KIND_SIGNED_IN and bed.token_requests.size() == 1
	t.check("sheet: the delivered URL redeems from this device", redeemed and bed.token_requests[0]["headers"].get("x-pkey-device") == bed.F["device_id"], str(box))
	var again: PKeySignInOutcome = await s.handle_redirect(good)
	t.check("sheet: single use, a second delivery sends nothing", again.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.size() == 1)
	bed.free_all()

	# The person closes the sheet: the sign-in waits, and opening again shows the same URL.
	opener = FakeOpener.new()
	bed = await nr._bed()
	bed.sdk.identity.native_platform = "ios"
	bed.sdk.identity.auth_opener = opener
	_https(bed)
	s = await nr._start(bed, {"browser": true, "loopback": false, "registered_schemes": [NR.SCHEME]})
	opener.fail.call("cancelled")
	t.check("sheet: a closed sheet leaves the sign-in waiting", s._settled == null and not s._native.pending.is_empty() and bed.token_requests.is_empty())
	t.check("sheet: reopen() shows the same authorize URL again", s.reopen() and opener.opens.size() == 2 and opener.opens[1]["url"] == opener.opens[0]["url"])

	# A sheet that failed ends the sign-in without a redemption.
	var box2 := []
	s.outcome.connect(func(o): box2.append(o))
	opener.fail.call("failed")
	await B.until(func(): return box2.size() == 1, 400)
	t.check("sheet: a failed sheet ends the sign-in as sign-in-failed, nothing redeemed", box2.size() == 1 and box2[0].code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.is_empty(), str(box2))
	t.check("sheet: the settled sign-in closes its own sheet", opener.cancelled.has(opener.sheet_id))
	bed.free_all()

	# cancel() closes the sheet.
	opener = FakeOpener.new()
	bed = await nr._bed()
	bed.sdk.identity.native_platform = "ios"
	bed.sdk.identity.auth_opener = opener
	_https(bed)
	s = await nr._start(bed, {"browser": true, "loopback": false, "registered_schemes": [NR.SCHEME]})
	s.cancel()
	t.check("sheet: cancel() closes the sheet", opener.cancelled == [1])
	bed.free_all()

	# A sheet that cannot be shown: not opened, not an error; reopen() says false.
	opener = FakeOpener.new()
	opener.shows = false
	bed = await nr._bed()
	bed.sdk.identity.native_platform = "ios"
	bed.sdk.identity.auth_opener = opener
	_https(bed)
	s = await nr._start(bed, {"browser": true, "loopback": false, "registered_schemes": [NR.SCHEME]})
	t.check("sheet: a sheet that could not be shown leaves opened false", s.ok and not s.opened and not s.reopen() and opener.opens.is_empty(), str(s))
	bed.free_all()

	# Loopback never uses the sheet.
	opener = FakeOpener.new()
	bed = await nr._bed()
	bed.sdk.identity.auth_opener = opener
	_https(bed)
	s = await nr._start(bed, {"browser": false, "registered_schemes": [NR.SCHEME]})
	t.check("sheet: the loopback class does not use the sheet", s.ok and s.redirect_class == "loopback" and s._native.opener == null and opener.opens.is_empty(), str(s))
	s.cancel()
	bed.free_all()
