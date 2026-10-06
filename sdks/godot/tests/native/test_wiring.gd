extends RefCounted
# @pkey-feature update.driver
# P3-10's hooks reach P5-07's facades:
#
#   bridges   PKeySparkleBridge, PKeyVelopackBridge, PKeyWinSparkleBridge and
#             PKeyStoreContextBridge fall back to their facade when no Engine singleton stands
#             in; the facade's own reason comes back through the bridge (`runtime` on the wrong
#             OS, `dependency` without the library); the bridge awaits a facade that awaits
#             (Velopack downloads before it applies); a singleton still wins
#   updater   PKeyUpdater configures each bridge: the headers read when the updater runs (the
#             bearer), the build's channel, WinSparkle's public key and identity
#   ms-store  a `store` answer in a Store MSIX with StoreContext available is a hook that falls
#             back to the listing; without it the listing opens as before
#   options   update_eddsa_public_key must be 32 bytes of standard base64

const F := preload("res://tests/native/fakes.gd")
const S := preload("res://tests/updater/support.gd")
const T := preload("res://tests/native/test_facades.gd")
const PUB := "rjbF4rUO7nUmHvDZ2pLxRrIjUKCQPvy1qTSl56Dp0hY="


class Singleton extends RefCounted:
	var calls: Array = []

	func install_and_relaunch(feed: String) -> int:
		calls.append(feed)
		return OK


class Host extends RefCounted:
	var ctx := {}
	var opened: Array = []
	var bridge_obj: PKeyNativeBridge

	func context(_d: Dictionary) -> Dictionary:
		return ctx

	func open_url(url: String) -> bool:
		opened.append(url)
		return true

	func bridge(_name: String) -> PKeyNativeBridge:
		return bridge_obj


func run(t: PKeyTestContext) -> void:
	await _bridges(t)
	await _updater(t)
	await _ms_store(t)
	_options(t)


func _bridges(t: PKeyTestContext) -> void:
	var cases := [
		[PKeySparkleBridge, "macos", PKeySparkle],
		[PKeyVelopackBridge, "windows", PKeyVelopack],
		[PKeyWinSparkleBridge, "windows", PKeyWinSparkle],
		[PKeyStoreContextBridge, "windows", PKeyStoreContext],
	]
	for c in cases:
		var home: PKeyNativeBridge = c[0].new(T.env_on(c[1]), "https://x/feed")
		var r: PKeyApplyResult = await home.install_and_relaunch()
		t.check("bridges: %s uses its facade (%s)" % [home.id(), c[2].new().id()], home.facade() != null and home.facade().id() == home.id() and home._native() == home.facade())
		t.check("bridges: %s on %s without the GDExtension is unsupported (dependency) through the bridge" % [home.id(), c[1]], not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "dependency" and r.detail.get("bridge") == home.id() and not home.is_available(), str(r))
		var away: PKeyNativeBridge = c[0].new(T.env_on("linux"), "https://x/feed")
		var w: PKeyApplyResult = await away.check_now()
		t.check("bridges: %s on linux is unsupported (runtime) through the bridge" % away.id(), not w.ok and w.detail.get("reason") == "runtime" and w.detail.get("bridge") == away.id(), str(w))

	# A facade that awaits: the bridge waits for Velopack's whole flow.
	var e := T.env_on("windows")
	e.files["C:/Games/Game/Update.exe"] = true
	var vb := PKeyVelopackBridge.new(e, "https://x/update/stable/velopack/")
	vb.headers_source = func(): return {"Authorization": "Bearer v"}
	var vn := F.Velopack.new()
	vb.facade().native = vn
	var r: PKeyApplyResult = await vb.install_and_relaunch()
	t.check("bridges: Velopack's hook awaits check, download and apply, with the bridge's headers", r.ok and r.behaviour == "hook" and r.bridge == "velopack" and vn.calls.size() == 5 and vn.calls[0][0] == "load_library" and vn.calls[1] == ["open", "https://x/update/stable/velopack/", {"Authorization": "Bearer v"}] and vn.calls[4] == ["apply_on_exit", true], "%s %s" % [r, vn.calls])

	# A 401/403 download refused twice (SP-09: one retry for a fresh ticket) comes back through
	# P3-10's hook as unsupported (product) with the cannot-sign message, not "answered 1".
	var vn2 := F.Velopack.new()
	vn2.download_ok = false
	vn2.download_message = "Network error: http status: 403 Forbidden"
	var vb2 := PKeyVelopackBridge.new(e, "https://x/update/stable/velopack/")
	vb2.facade().native = vn2
	r = await vb2.install_and_relaunch()
	t.check("bridges: a 403 Velopack download refused twice surfaces as unsupported (product) with the cannot-sign message", not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail.get("reason") == "product" and r.detail.get("bridge") == "velopack" and r.message.contains("cannot sign Velopack downloads") and vn2.calls.count(["download_async"]) == 2, "%s %s" % [r, r.detail])
	var vn3 := F.Velopack.new()
	vn3.check_answer = {"status": "none"}
	var vb3 := PKeyVelopackBridge.new(e, "https://x/update/stable/velopack/")
	vb3.facade().native = vn3
	r = await vb3.install_and_relaunch()
	t.check("bridges: a feed with no update is a typed not_found through the bridge", not r.ok and r.code == PKeyErrors.NOT_FOUND and r.detail.get("bridge") == "velopack", str(r))

	var sb := PKeySparkleBridge.new(T.env_on("macos"), "https://x/appcast.xml")
	sb.channels = PackedStringArray(["stable"])
	sb.options = {"mode": "headless"}
	var sn := F.Sparkle.new()
	sb.facade().native = sn
	OS.set_environment(PKeySparkle.HEADLESS_ENV, "1")
	r = await sb.install_and_relaunch()
	OS.unset_environment(PKeySparkle.HEADLESS_ENV)
	t.check("bridges: Sparkle's hook starts the facade with the bridge's options and channels", r.ok and sn.calls[0][1] == "headless" and sn.calls[0][2] == "https://x/appcast.xml" and sn.calls[0][4] == ["stable"] and sn.calls[1] == ["check_for_updates"], str(sn.calls))

	var se := T.env_on("macos")
	var single := Singleton.new()
	se.singletons["PolarisKeySparkle"] = single
	var sb2 := PKeySparkleBridge.new(se, "https://x/appcast.xml")
	r = await sb2.install_and_relaunch()
	t.check("bridges: an Engine singleton still wins over the facade", r.ok and single.calls == ["https://x/appcast.xml"])


func _updater(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var inst := S.install("native-wiring", S.bytes(64, 3), "windows", "Game.exe")
	var tweak := func(o: PKeyOptions) -> void:
		o.update_outlet = "direct"
		o.update_eddsa_public_key = PUB
	var sdk: Node = await sup.launch(inst, "1.4.0", tweak, "pkeyt_wiring")
	sup.discovered(sdk, {"winsparkle": sup.server.base_url() + "/djdl/update/{channel}/winsparkle.xml"}, S.DL)
	var u: PKeyUpdater = sdk.update.updater
	var b := u.bridge("winsparkle")
	var f := b.facade()
	var h: Dictionary = f.headers()
	t.check("updater: the WinSparkle bridge carries the public key, the identity and the running version", f.config.get("public_key") == PUB and f.config.get("company") == "PolarisKey" and f.config.get("app") == S.PRODUCT and f.config.get("version") == "1.4.0", str(f.config))
	t.check("updater: the headers are read when the updater runs and carry the bearer", h.get("Authorization") == "Bearer pkeyt_wiring" and h.has("X-PKey-Version"), str(h.keys()))
	t.check("updater: the bridge's channel is the build's", Array(b.channels) == [sdk.core.channel], str(b.channels))
	t.check("updater: the StoreContext bridge exists and is unavailable without the plugin", u.bridge("storecontext") is PKeyStoreContextBridge and not u.context({}).get("store_bridge_available"))
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _ms_store(t: PKeyTestContext) -> void:
	var listing := "https://apps.microsoft.com/detail/9NBLGGH4R32N"
	var decision := {"action": "store", "listingUrl": listing}
	var a := PKeyMsStoreAdapter.new()
	var p := a.describe(decision, {"store_bridge_available": true})
	t.check("ms-store: with StoreContext available a store answer is a hook that falls back to the listing", p["behaviour"] == "hook" and p["bridge"] == "storecontext" and p["fallback_url"] == listing, str(p))
	p = a.describe(decision, {})
	t.check("ms-store: without it the listing opens", p["behaviour"] == "link" and p["url"] == listing)
	t.check("ms-store: blocked never hooks", a.describe({"action": "blocked"}, {"store_bridge_available": true, "page_url": "https://example.com/p"})["behaviour"] == "link")

	var host := Host.new()
	host.ctx = {"store_bridge_available": true}
	var e := T.env_on("windows")
	var bridge := PKeyStoreContextBridge.new(e)
	var n := F.StoreContext.new()
	n.answer = {"ok": true, "state": "completed"}
	bridge.facade().native = n
	bridge.facade().config["window_handle"] = 7
	host.bridge_obj = bridge
	var r: PKeyApplyResult = await a.apply(decision, host)
	t.check("ms-store: apply asks the Store to install (consent dialog), no listing opened", r.ok and r.behaviour == "hook" and r.bridge == "storecontext" and host.opened.is_empty() and n.calls[-1] == ["request_async", "download_and_install", 7, false], "%s %s" % [r, n.calls])
	n.answer = {"ok": false, "hresult": "0x803F6101"}
	r = await a.apply(decision, host)
	t.check("ms-store: a StoreContext that says 'not a Store install' falls back to the listing", r.ok and r.behaviour == "link" and host.opened == [listing] and r.detail.get("fallback_from") == "storecontext", "%s %s" % [r, host.opened])


func _options(t: PKeyTestContext) -> void:
	var ok := PKeyCore.check_update_options(_opts(PUB))
	var bad := PKeyCore.check_update_options(_opts("rjbF4rUO7nUmHvDZ2pLxRrIjUKCQPvy1qTSl56Dp0h"))
	var url := PKeyCore.check_update_options(_opts("rjbF4rUO7nUmHvDZ2pLxRrIjUKCQPvy1qTSl56Dp0h_="))
	t.check("options: a 32-byte base64 EdDSA key is accepted, an empty one too", ok == "" and PKeyCore.check_update_options(_opts("")) == "")
	t.check("options: a short or base64url key is refused", bad.contains("update_eddsa_public_key") and url.contains("update_eddsa_public_key"), bad)


static func _opts(key: String) -> PKeyOptions:
	var o := PKeyOptions.new()
	o.product = "djdl"
	o.update_eddsa_public_key = key
	return o
