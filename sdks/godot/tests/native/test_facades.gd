extends RefCounted
# @pkey-feature update.driver
# P5-07's GDScript facades (PKeySparkle, PKeyVelopack, PKeyWinSparkle, PKeyStoreContext):
#
#   unsupported  each facade on every other OS answers `unsupported` with `reason` `runtime`; on
#                its own OS without its GDExtension class (this project ships none) it answers
#                `dependency`, from availability(), check_now() and install_and_relaunch() alike
#   library      the GDExtension present but its updater library absent (Sparkle.framework not
#                loaded, velopack_libc.dll or WinSparkle.dll not loadable): `dependency`
#   sparkle      SUPublicEDKey missing: `invalid-options`, never a started updater; the mode, the
#                discovery feed URL, the headers (read at call time) and the channels reach the
#                native start(); will_relaunch quits only when the tree does not auto-accept
#   velopack     outside a Velopack install: `runtime`; a 401/403 download is `product` (public
#                delivery only); open() passes the headers; check and
#                download wait for the deferred native events; install_and_relaunch() applies on
#                exit and quits; no update or a failed download hands back FAILED
#   winsparkle   no public key: `invalid-options`; start() gets the appcast, key, identity and
#                headers; shutdown_request quits the game
#   storecontext no package identity: `runtime` (not a Store install); the HRESULTs a non-Store
#                install answers are `runtime`, any other failure a typed failure; the window
#                handle reaches the native request

const F := preload("res://tests/native/fakes.gd")
const PUB := "rjbF4rUO7nUmHvDZ2pLxRrIjUKCQPvy1qTSl56Dp0hY="


func run(t: PKeyTestContext) -> void:
	await _unsupported(t)
	await _sparkle(t)
	await _velopack(t)
	await _winsparkle(t)
	await _storecontext(t)


static func env_on(os: String, exe := "") -> PKeyFakeUpdaterEnv:
	var e := PKeyFakeUpdaterEnv.new()
	e.os = os
	e.exe = exe if exe != "" else ("C:/Games/Game/current/Game_godot.exe" if os == "windows" else "/Applications/Game.app/Contents/MacOS/Game")
	return e


static func is_unsupported(r: PKeyResult, reason: String) -> bool:
	return r != null and not r.ok and r.code == PKeyErrors.UNSUPPORTED and r.detail is Dictionary and r.detail.get("reason") == reason and r.detail.get("feature") == "update.driver"


func _unsupported(t: PKeyTestContext) -> void:
	var makers := {
		"sparkle": func(e): return PKeySparkle.new(e),
		"velopack": func(e): return PKeyVelopack.new(e),
		"winsparkle": func(e): return PKeyWinSparkle.new(e),
		"storecontext": func(e): return PKeyStoreContext.new(e),
	}
	var home := {"sparkle": "macos", "velopack": "windows", "winsparkle": "windows", "storecontext": "windows"}
	for name in makers:
		for os in ["macos", "windows", "linux", "android", "ios", "web"]:
			var f: PKeyNativeFacade = makers[name].call(env_on(os))
			var a := f.availability()
			if os != home[name]:
				t.check("unsupported: %s on %s is runtime" % [name, os], is_unsupported(a, "runtime") and not f.is_available(), str(a))
				t.check("unsupported: %s on %s check_now/install_and_relaunch fail" % [name, os], await f.check_now("https://x/feed") == FAILED and await f.install_and_relaunch("https://x/feed") == FAILED)
				continue
			# This project ships no GDExtension: the real class is absent.
			t.check("unsupported: %s on %s without its GDExtension is dependency" % [name, os], is_unsupported(a, "dependency"), str(a))
			f.native_class = "PKeyNoSuchNativeClass"
			t.check("unsupported: %s with its class missing is dependency" % name, is_unsupported(f.availability(), "dependency") and await f.install_and_relaunch("https://x/feed") == FAILED)
	t.check("unsupported: the facade class names match the GDExtension classes", PKeySparkle.new().native_class == "PKeySparkleNative" and PKeyVelopack.new().native_class == "PKeyVelopackNative" and PKeyWinSparkle.new().native_class == "PKeyWinSparkleNative" and PKeyStoreContext.new().native_class == "PKeyStoreContextNative")

	# The library the extension loads is missing.
	var sp := PKeySparkle.new(env_on("macos"))
	var sn := F.Sparkle.new()
	sn.loaded = false
	sp.native = sn
	t.check("library: Sparkle.framework not loaded is dependency", is_unsupported(sp.availability(), "dependency") and await sp.check_now("https://x/appcast.xml") == FAILED and sn.calls.is_empty(), str(sp.availability()))
	var vp := PKeyVelopack.new(env_on("windows"))
	var vn := F.Velopack.new()
	vn.load_answer = {"ok": false, "error": "dependency", "win32": 126}
	vp.native = vn
	var va := vp.availability()
	t.check("library: velopack_libc.dll missing is dependency (loaded from beside the executable)", is_unsupported(va, "dependency") and vn.calls[0] == ["load_library", "C:/Games/Game/current/velopack_libc.dll"], "%s %s" % [va, vn.calls])
	var ws := PKeyWinSparkle.new(env_on("windows", "C:/Games/Game/game.exe"))
	var wn := F.WinSparkle.new()
	wn.load_answer = {"ok": false, "error": "dependency", "win32": 126}
	ws.native = wn
	t.check("library: WinSparkle.dll missing is dependency", is_unsupported(ws.availability(), "dependency") and wn.calls[0] == ["load", "C:/Games/Game/WinSparkle.dll"] and await ws.install_and_relaunch("https://x/winsparkle.xml") == FAILED)


func _sparkle(t: PKeyTestContext) -> void:
	var bearer := ["Bearer one"]
	var quits := [0]
	var f := PKeySparkle.new(env_on("macos"), {"headers": func(): return {"Authorization": bearer[0]}, "channels": PackedStringArray(["beta"]), "quit": func(): quits[0] += 1})
	var n := F.Sparkle.new()
	n.start_answer = {"ok": false, "error": "missing_public_key"}
	f.native = n
	var r := f.start("https://x/appcast.xml")
	t.check("sparkle: SUPublicEDKey missing is invalid-options, the updater not started", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and r.message.contains("SUPublicEDKey") and await f.check_now("https://x/appcast.xml") == FAILED and not n.calls.has(["check_for_updates"]), str(r))
	n.start_answer = {"ok": false, "error": "not_main_thread"}
	t.check("sparkle: off the main thread is invalid-options", f.start("https://x/appcast.xml").code == PKeyErrors.INVALID_OPTIONS)
	n.start_answer = {"ok": false, "error": "dependency", "message": "Sparkle.framework not loaded"}
	t.check("sparkle: a native dependency answer is unsupported (dependency)", is_unsupported(f.start("https://x/appcast.xml"), "dependency"))

	n.start_answer = {"ok": true, "can_check": true}
	n.calls.clear()
	t.check("sparkle: install_and_relaunch starts the standard controller with the feed, headers and channels, then checks", await f.install_and_relaunch("https://x/appcast.xml?arch=arm64") == OK and n.calls[0] == ["start", "standard", "https://x/appcast.xml?arch=arm64", {"Authorization": "Bearer one"}, ["beta"]] and n.calls[1] == ["check_for_updates"], str(n.calls))
	bearer[0] = "Bearer two"
	n.calls.clear()
	t.check("sparkle: a second call reuses the updater with the current headers", await f.check_now("https://x/appcast.xml?arch=arm64") == OK and n.calls == [["set_feed_url", "https://x/appcast.xml?arch=arm64"], ["set_http_headers", {"Authorization": "Bearer two"}], ["check_for_updates"]], str(n.calls))
	f.set_automatically_checks(true)
	f.set_automatically_downloads(false)
	t.check("sparkle: background check and automatic switches reach the native side", f.check_in_background() == OK and n.calls.has(["check_in_background"]) and n.calls.has(["set_automatically_checks", true]) and n.calls.has(["set_automatically_downloads", false]))
	var h := PKeySparkle.new(env_on("macos"), {"mode": "headless"})
	var hn := F.Sparkle.new()
	h.native = hn
	var was := OS.get_environment(PKeySparkle.HEADLESS_ENV)
	OS.unset_environment(PKeySparkle.HEADLESS_ENV)
	var refused := h.start("")
	t.check("sparkle: mode headless without PKEY_SPARKLE_HEADLESS=1 is refused (test only)", not refused.ok and refused.code == PKeyErrors.INVALID_OPTIONS and hn.calls.is_empty(), str(refused))
	OS.set_environment(PKeySparkle.HEADLESS_ENV, "1")
	h.start("")
	t.check("sparkle: mode headless with the flag reaches the native start", hn.calls.size() == 1 and hn.calls[0][1] == "headless")
	if was == "":
		OS.unset_environment(PKeySparkle.HEADLESS_ENV)
	else:
		OS.set_environment(PKeySparkle.HEADLESS_ENV, was)

	var seen: Array = []
	f.event.connect(func(e, d): seen.append([e, d]))
	var tree := Engine.get_main_loop() as SceneTree
	n.fire("update_found", {"version": "2"})
	n.fire("will_relaunch")
	await tree.process_frame
	await tree.process_frame
	t.check("sparkle: native events are re-emitted; will_relaunch with auto_accept_quit on leaves quitting to Godot", seen.size() == 2 and seen[0] == ["update_found", {"version": "2"}] and quits[0] == 0, str(seen))
	tree.auto_accept_quit = false
	n.fire("will_relaunch")
	await tree.process_frame
	await tree.process_frame
	tree.auto_accept_quit = true
	t.check("sparkle: will_relaunch with auto_accept_quit off quits the game", quits[0] == 1)


func _velopack(t: PKeyTestContext) -> void:
	var quits := [0]
	var e := env_on("windows")
	var f := PKeyVelopack.new(e, {"headers": {"Authorization": "Bearer t"}, "quit": func(): quits[0] += 1})
	var n := F.Velopack.new()
	f.native = n
	t.check("velopack: outside a Velopack install is runtime", is_unsupported(f.availability(), "runtime") and await f.install_and_relaunch("https://x/velopack/") == FAILED, str(f.availability()))
	e.files["C:/Games/Game/Update.exe"] = true
	t.check("velopack: current/ under Update.exe is a Velopack install", f.is_available(), str(f.availability()))
	n.open_answer = {"ok": false, "error": "not_installed", "message": "Could not auto-locate app manifest"}
	t.check("velopack: an UpdateManager that finds no manifest is runtime", is_unsupported(f.open("https://x/velopack/"), "runtime"))
	n.open_answer = {"ok": true, "current_version": "1.0.0"}
	n.calls.clear()
	var r: int = await f.install_and_relaunch("https://x/update/stable/velopack/")
	t.check("velopack: install_and_relaunch opens with the headers, checks, downloads, applies on exit with restart and quits", r == OK and n.calls == [["open", "https://x/update/stable/velopack/", {"Authorization": "Bearer t"}], ["check_async"], ["download_async"], ["apply_on_exit", true]] and quits[0] == 1, str(n.calls))
	var progress: Array = []
	f.event.connect(func(ev, d): if ev == "progress": progress.append(d.get("percent")))
	var d := await f.download()
	t.check("velopack: download reports progress events", d.ok and progress == [50], str(progress))

	n.check_answer = {"status": "none"}
	n.calls.clear()
	t.check("velopack: no update in the feed is FAILED (the adapter falls back to the download link)", await f.install_and_relaunch("https://x/update/stable/velopack/") == FAILED and not n.calls.has(["download_async"]))
	n.check_answer = {"status": "available"}
	n.download_ok = false
	n.calls.clear()
	t.check("velopack: a failed download applies nothing", await f.install_and_relaunch("https://x/update/stable/velopack/") == FAILED and not n.calls.has(["apply_on_exit", true]) and quits[0] == 1)
	n.check_answer = {"status": "available"}
	n.download_message = "Network error: http status: 403 Forbidden"
	var refused := await f.download()
	t.check("velopack: a 403 on the download (non-public delivery, the redirect dropped Authorization) is unsupported (product)", is_unsupported(refused, "product") and refused.message.contains("public delivery"), str(refused))
	n.download_message = "os error 123"
	t.check("velopack: refused_by_delivery reads only 401/403", PKeyVelopack.refused_by_delivery("status 401") and PKeyVelopack.refused_by_delivery("Unauthorized") and not PKeyVelopack.refused_by_delivery("os error 123") and not PKeyVelopack.refused_by_delivery("size 4031 bytes"))
	n.check_answer = {"status": "error", "message": "IO error"}
	var c := await f.check()
	t.check("velopack: a check error is a typed failure", not c.ok and c.code == PKeyErrors.NETWORK and c.message.contains("IO error"))
	t.check("velopack: open without a feed URL is not-configured", f.open("").code == PKeyErrors.NOT_CONFIGURED)
	t.check("velopack: a plain-http feed off loopback is refused; https and loopback http are not", f.open("http://example.com/velopack/").code == PKeyErrors.INSECURE_BASE_URL and PKeyNativeFacade.feed_url_allowed("https://x/") and PKeyNativeFacade.feed_url_allowed("http://127.0.0.1:8711/velopack/") and PKeyNativeFacade.feed_url_allowed("http://[::1]:1/") and not PKeyNativeFacade.feed_url_allowed("http://localhost.example.com/") and not PKeyNativeFacade.feed_url_allowed("ftp://x/"))
	n.check_answer = {"status": "available"}
	n.download_ok = false
	n.download_message = "http status: 401 Unauthorized"
	t.check("velopack: install_and_relaunch keeps the typed reason in last_result", await f.install_and_relaunch("https://x/update/beta/velopack/") == FAILED and is_unsupported(f.last_result, "product"), str(f.last_result))
	n.download_message = "os error 123"
	var e2 := env_on("windows", "C:/Games/Game/Game_godot.exe")
	e2.files["C:/Games/Game/sq.version"] = true
	var g := PKeyVelopack.new(e2)
	g.native = F.Velopack.new()
	t.check("velopack: sq.version beside the executable is a Velopack install", g.is_available())


func _winsparkle(t: PKeyTestContext) -> void:
	var quits := [0]
	var f := PKeyWinSparkle.new(env_on("windows", "C:/Games/Game/game.exe"), {"headers": {"Authorization": "Bearer w"}, "quit": func(): quits[0] += 1, "app": "djdl", "version": "1.0.0"})
	var n := F.WinSparkle.new()
	f.native = n
	var r := f.start("https://x/update/stable/winsparkle.xml")
	t.check("winsparkle: without a public key it refuses (invalid-options), WinSparkle never initialised", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and n.calls == [["load", "C:/Games/Game/WinSparkle.dll"]], str(n.calls))
	f.config["public_key"] = PUB
	t.check("winsparkle: install_and_relaunch starts with the appcast, key, identity and headers, then checks with install", f.install_and_relaunch("https://x/update/stable/winsparkle.xml") == OK and n.calls[1] == ["start", "https://x/update/stable/winsparkle.xml", PUB, "PolarisKey", "djdl", "1.0.0", {"Authorization": "Bearer w"}] and n.calls[2] == ["check", "install"], str(n.calls))
	t.check("winsparkle: check_now is the UI check; a silent check after start", f.check_now("https://x/update/stable/winsparkle.xml") == OK and n.calls[-1] == ["check", "ui"] and f.check_silently() == OK and n.calls[-1] == ["check", "silent"] and n.calls.filter(func(c): return c[0] == "start").size() == 1)
	var bearer := ["Bearer one"]
	var g := PKeyWinSparkle.new(env_on("windows", "C:/Games/Game/game.exe"), {"headers": func(): return {"Authorization": bearer[0]}, "public_key": PUB})
	var gn := F.WinSparkle.new()
	g.native = gn
	g.check_now("https://x/update/stable/winsparkle.xml")
	bearer[0] = "Bearer two"
	g.install_and_relaunch("https://x/update/stable/winsparkle.xml")
	t.check("winsparkle: the headers are set again before every check, so a rotated bearer reaches the next request", gn.header_sets.size() == 2 and gn.header_sets[1] == {"Authorization": "Bearer two"} and gn.calls[-1] == ["check", "install"], str(gn.header_sets))
	var insecure := PKeyWinSparkle.new(env_on("windows", "C:/Games/Game/game.exe"), {"public_key": PUB})
	insecure.native = F.WinSparkle.new()
	t.check("winsparkle: a plain-http appcast off loopback is refused; loopback http is allowed", insecure.start("http://example.com/winsparkle.xml").code == PKeyErrors.INSECURE_BASE_URL and insecure.install_and_relaunch("http://example.com/w.xml") == FAILED and insecure.last_result.code == PKeyErrors.INSECURE_BASE_URL and insecure.start("http://127.0.0.1:8711/ws/appcast.xml").ok)
	var rel := PKeyWinSparkle.new(env_on("windows"), {"library": "WinSparkle.dll"})
	rel.native = F.WinSparkle.new()
	t.check("winsparkle: a relative library path is refused (dependency), never a search-path load", is_unsupported(rel.availability(), "dependency") and rel.native.calls.is_empty())
	var tree := Engine.get_main_loop() as SceneTree
	n.fire("did_find_update")
	n.fire("shutdown_request")
	await tree.process_frame
	await tree.process_frame
	t.check("winsparkle: shutdown_request quits the game", quits[0] == 1)


func _storecontext(t: PKeyTestContext) -> void:
	var f := PKeyStoreContext.new(env_on("windows"), {"window_handle": 4242})
	var n := F.StoreContext.new()
	n.identity = {"packaged": false, "rc": 15700}
	f.native = n
	var a := f.availability()
	t.check("storecontext: no package identity (15700) is runtime, not a Store install", is_unsupported(a, "runtime") and a.message.contains("Not a Store install") and await f.install_and_relaunch("") == FAILED and not n.calls.any(func(c): return c[0] == "request_async"), str(a))
	n.identity = {"packaged": true, "full_name": "Pub.Game_1.0.0.0_x64__abc", "rc": 0}
	var u := await f.updates()
	t.check("storecontext: updates() runs the query with the window handle and returns its result", u.ok and u.detail.get("count") == 1 and n.calls[-1] == ["request_async", "updates", 4242, false], str(n.calls))
	n.answer = {"ok": true, "state": "completed"}
	t.check("storecontext: install_and_relaunch is the consent-dialog install", await f.install_and_relaunch("") == OK and n.calls[-1] == ["request_async", "download_and_install", 4242, false])
	var s := await f.download_and_install(true)
	t.check("storecontext: the silent variant reaches the native side", s.ok and n.calls[-1] == ["request_async", "download_and_install", 4242, true])
	n.answer = {"ok": true, "state": "canceled"}
	t.check("storecontext: a cancelled install is FAILED", await f.install_and_relaunch("") == FAILED)
	for hr in ["0x803F6101", "0x803F6107", "0x80070002", "0x803f6101"]:
		n.answer = {"ok": false, "hresult": hr, "message": "x"}
		t.check("storecontext: %s is runtime (not a Store install), never 'no update'" % hr, is_unsupported(await f.updates(), "runtime"))
	n.answer = {"ok": false, "hresult": "0x80072EE7", "message": "network"}
	var other := await f.updates()
	t.check("storecontext: any other HRESULT is a typed failure", not other.ok and other.code == PKeyErrors.SERVICE_UNAVAILABLE and other.message.contains("0x80072EE7"))
	t.check("storecontext: interpret maps rc 15700 to runtime", is_unsupported(PKeyStoreContext.interpret({"ok": false, "rc": 15700}), "runtime"))
