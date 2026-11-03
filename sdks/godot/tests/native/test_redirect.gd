extends RefCounted
# @pkey-feature identity.redirect.native
# The Android native redirect sign-in's GDScript side (I-48.17b), headless: the PKeyAndroid auth_* calls over
# PKeyFakeAndroidNative (modelling the plugin's ops), and the export's intent filter, which exists only for what the
# project registers. The session end to end is tests/identity/test_native_redirect.gd.

const E := preload("res://addons/polaris_key/native/android_export.gd")
const SCHEME := "com.tidewater.studio:/pkey/callback"
const PAGE := "https://key.plrs.im/djdl/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1"


static func _android(p_platform: String, p_native: Object = null) -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.platform = p_platform
	a.native = p_native
	a.timeout_s = 2.0
	return a


func run(t: PKeyTestContext) -> void:
	_facade(t)
	_export(t)


func _facade(t: PKeyTestContext) -> void:
	var fake := PKeyFakeAndroidNative.new()
	fake.auth_filters = [SCHEME]
	var a := _android("android", fake)
	t.check("redirect: the capability is found by a call", a.auth_redirect_available())
	var r := a.auth_open(PAGE, "com.tidewater.studio", "", "key.plrs.im")
	t.check("redirect: opens the issuer's page for the registered scheme", r.ok and fake.auth_opened.size() == 1 and fake.auth_opened[0]["issuerHost"] == "key.plrs.im")
	r = a.auth_open("https://evil.example/authorize", "com.tidewater.studio", "", "key.plrs.im")
	t.check("redirect: another host is refused", not r.ok and r.detail.get("reason") == "url" and fake.auth_opened.size() == 1)
	r = a.auth_open("http://key.plrs.im/authorize", "com.tidewater.studio", "", "key.plrs.im")
	t.check("redirect: a page that is not https is refused", not r.ok and fake.auth_opened.size() == 1)
	r = a.auth_open(PAGE, "com.other.app", "", "key.plrs.im")
	t.check("redirect: a redirect the manifest does not route is refused", not r.ok and r.detail.get("reason") == "not-registered")
	r = a.auth_open(PAGE, "", "", "key.plrs.im")
	t.check("redirect: no registered redirect is refused", not r.ok and r.detail.get("reason") == "unregistered")
	var seen: Array = []
	a.auth_event.connect(func(e): seen.append(e))
	r = a.auth_open(PAGE, "com.tidewater.studio", "", "key.plrs.im")
	t.check("redirect: no delivery before the OS brings one", seen.is_empty() and a.poll() == 0)
	t.check("redirect: the delivery arrives once as auth_event", fake.auth_deliver(SCHEME + "?code=a&state=b") and a.poll() == 1 and seen.size() == 1 and seen[0]["url"] == SCHEME + "?code=a&state=b")
	t.check("redirect: the same URL is not delivered twice", not fake.auth_deliver(SCHEME + "?code=a&state=b"))
	a.auth_cancel()
	t.check("redirect: after auth_cancel a delivery is dropped", not fake.auth_deliver(SCHEME + "?code=c&state=d"))
	a.free()

	var bare := PKeyFakeAndroidNative.new()
	bare.auth_redirect = false
	a = _android("android", bare)
	t.check("redirect: a plugin without the ops is not available", not a.auth_redirect_available())
	a.free()
	a = _android("linux")
	t.check("redirect: off Android it is unsupported (runtime), not available", not a.auth_redirect_available() and a.auth_open(PAGE, "x", "", "key.plrs.im").code == PKeyErrors.UNSUPPORTED)
	a.free()
	a = _android("android")
	t.check("redirect: without the plugin it is unsupported (dependency)", not a.auth_redirect_available() and a.auth_open(PAGE, "x", "", "key.plrs.im").code == PKeyErrors.UNSUPPORTED)
	a.free()


func _export(t: PKeyTestContext) -> void:
	t.check("redirect export: no scheme or link registered adds nothing", E.redirect_elements("play", "", "") == "" and E.redirect_elements("direct", "", "") == "")
	t.check("redirect export: a build with no plugin adds nothing", E.redirect_elements("none", "com.tidewater.studio", "") == "" and E.redirect_elements("", "com.tidewater.studio", "") == "")
	var s := E.redirect_elements("play", "com.tidewater.studio", "")
	t.check("redirect export: a scheme adds one filter on the redirect activity", s.contains("android:name=\"im.plrs.key.godot.PKeyGodotRedirectActivity\"")
		and s.contains("android:exported=\"true\"") and s.contains("android:scheme=\"com.tidewater.studio\"")
		and s.contains("android:path=\"/pkey/callback\"") and s.count("<intent-filter") == 1 and not s.contains("autoVerify"), s)
	var c := E.redirect_elements("direct", "", "https://game.example/open/pkey")
	t.check("redirect export: a claimed link adds a verified HTTPS filter", c.contains("android:autoVerify=\"true\"")
		and c.contains("android:host=\"game.example\"") and c.contains("android:path=\"/open/pkey\"") and c.contains("android:scheme=\"https\"")
		and not c.contains("com.tidewater"), c)
	t.check("redirect export: both register two filters", E.redirect_elements("play", "com.tidewater.studio", "https://game.example/open/pkey").count("<intent-filter") == 2)
	t.check("redirect export: scheme names are validated", E.redirect_scheme("com.tidewater.studio") == "com.tidewater.studio"
		and E.redirect_scheme("https") == "" and E.redirect_scheme("javascript") == "" and E.redirect_scheme("Bad Scheme") == ""
		and E.redirect_scheme("a\"><x") == "" and E.redirect_scheme(null) == "" and E.redirect_scheme("") == "")
	t.check("redirect export: claimed links are validated", E.redirect_claimed("https://game.example/open") == "https://game.example/open"
		and E.redirect_claimed("http://game.example/open") == "" and E.redirect_claimed("https://game.example/") == ""
		and E.redirect_claimed("https://game.example/open?x=1") == "" and E.redirect_claimed("https://u@game.example/open") == ""
		and E.redirect_claimed("https://game.example:8443/open") == "" and E.redirect_claimed("https://game.example/o\"><x") == ""
		and E.redirect_claimed(null) == "")
