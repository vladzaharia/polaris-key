extends RefCounted
# @pkey-feature update.driver
# Every outlet kind of the plan (the 17 of outlet-matrix.json's vocabulary, plus `unknown`) ×
# every decision action -> the adapter's behaviour, through apply() with a recording host:
#
#   link     the URL opened (a listing, the compiled page, the build's download, the release page)
#   hook     the native bridge called (install_and_relaunch)
#   staged   the sidecar pack staged
#   restart  restart_to_update called
#   reload   the web page reloaded
#   silent   nothing at all
#
# and exactly that one side effect. A store, platform or unknown outlet never stages, restarts
# or calls a hook, whatever the decision says; capabilities only narrow (a feed entry cannot widen
# Steam into self-updating code).

const REL := "https://example.com/releases/1.5.0"
const PAGE := "https://example.com/altstore-source"
const BUILD := "https://dl.example.com/djdl/distribution/builds/1.5.0/b1"
const LISTING := "https://apps.apple.com/app/id1"
const STORE_KINDS := ["app-store", "testflight", "altstore", "altstore-pal", "play", "play-testing", "obtainium", "fdroid-repo", "ms-store"]
const PLATFORM_KINDS := ["app-installer", "winget", "steam", "itch", "flathub", "snap"]


class FakeBridge extends PKeyNativeBridge:
	var available := true
	var calls := 0
	var answer = OK

	func id() -> String:
		return "velopack"

	func is_available() -> bool:
		return available

	func install_and_relaunch() -> PKeyApplyResult:
		calls += 1
		if answer == OK:
			return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native"})
		return PKeyApplyResult.missing_dependency(id())


class FakeHost extends RefCounted:
	var ctx := {}
	var opened: Array = []
	var bridge_obj: FakeBridge = FakeBridge.new()
	var staged := 0
	var restarts := 0
	var reloads := 0
	var web := false

	func context(_d: Dictionary) -> Dictionary:
		return ctx

	func open_url(url: String) -> bool:
		opened.append(url)
		return true

	func bridge(_name: String) -> PKeyNativeBridge:
		return bridge_obj

	func stage_sidecar(_check: PKeyUpdateCheck) -> PKeyApplyResult:
		staged += 1
		return PKeyApplyResult.of(PKeyApplyResult.STAGED, {"version": "1.5.0"})

	func restart_to_update() -> PKeyApplyResult:
		restarts += 1
		return PKeyApplyResult.of(PKeyApplyResult.RESTART)

	func reload_web() -> bool:
		reloads += 1
		return web

	func effects() -> int:
		return opened.size() + bridge_obj.calls + staged + restarts + reloads


func cases() -> Dictionary:
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab".repeat(32)}
	var short := {"version": "1.5.0", "seq": 15}
	var binary := func(method: String) -> Dictionary:
		return {"action": "binary", "method": method, "release": rel, "build": "b1", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}
	var store := func(listing: Variant) -> Dictionary:
		return {"action": "store", "release": short, "listingUrl": listing, "mandatory": false, "critical": false, "discardStaged": false}
	return {
		"none": {"action": "none", "reason": "up-to-date", "behind": false, "discardStaged": false},
		"code-ready": {"action": "code-ready", "release": rel, "critical": false, "discardStaged": false},
		"binary native": binary.call("native"),
		"binary native (no plugin)": binary.call("native"),
		"binary download": binary.call("download"),
		"binary sidecar-pck": binary.call("sidecar-pck"),
		"store": store.call(LISTING),
		"store without a listing": store.call(null),
		"store with a deep link": store.call("itms-apps://apps.apple.com/app/id1"),
		"platform": {"action": "platform", "release": short, "mandatory": false, "critical": false, "discardStaged": false},
		"platform mandatory": {"action": "platform", "release": short, "mandatory": true, "critical": false, "discardStaged": false},
		"blocked": {"action": "blocked", "reason": "app-floor", "discardStaged": false},
	}


## [behaviour, what] for `kind` and case `name`: `what` is the URL for a link, the bridge for a
## hook, "" otherwise.
func expect(kind: String, name: String) -> Array:
	var store_link := {"store": LISTING, "store without a listing": PAGE, "store with a deep link": PAGE}
	if kind == "direct":
		match name:
			"code-ready":
				return ["restart", ""]
			"binary native":
				return ["hook", "velopack"]
			"binary native (no plugin)", "binary download":
				return ["link", BUILD]
			"binary sidecar-pck":
				return ["staged", ""]
			"store", "store without a listing", "store with a deep link":
				return ["link", store_link[name]]
			"blocked":
				return ["link", REL]
		return ["silent", ""]
	if STORE_KINDS.has(kind):
		if store_link.has(name):
			return ["link", store_link[name]]
		if name == "blocked":
			return ["link", PAGE]
		return ["silent", ""]
	# Platform kinds, web and unknown: only a store answer's own https listing (which the decision
	# never gives them) opens; the web reloads on a platform answer.
	if name == "store":
		return ["link", LISTING]
	if kind == "web" and name.begins_with("platform"):
		return ["reload", ""]
	return ["silent", ""]


func run(t: PKeyTestContext) -> void:
	var kinds: Array = Array(PKeyConstants.OUTLET_KIND_VALUES) + ["unknown"]
	t.check("adapters: the plan's 17 kinds plus unknown", kinds.size() == 18)
	var all := cases()
	var evaluated := 0
	var self_updates := 0
	for kind in kinds:
		var a := PKeyOutletAdapters.for_kind(kind)
		t.check("adapters: %s has its own adapter" % kind, a.kind == kind and (kind == "unknown" or a.get_script() != PKeyOutletAdapter), str(a.get_script().resource_path))
		for name in all:
			var d: Dictionary = all[name]
			var host := FakeHost.new()
			host.web = kind == "web"
			host.bridge_obj.available = name != "binary native (no plugin)"
			host.ctx = {"platform": "windows", "subkind": null, "release_url": REL, "page_url": PAGE, "build_url": BUILD, "native_bridge": "velopack", "native_available": host.bridge_obj.available}
			var r: PKeyApplyResult = await a.apply(d, host, PKeyUpdaterTestSupport.check_of(d))
			var want := expect(kind, name)
			var effect_ok := false
			match want[0]:
				"link":
					effect_ok = host.opened == [want[1]] and r.url == want[1] and host.effects() == 1
				"hook":
					effect_ok = host.bridge_obj.calls == 1 and r.bridge == want[1] and host.effects() == 1
				"staged":
					effect_ok = host.staged == 1 and host.effects() == 1
				"restart":
					effect_ok = host.restarts == 1 and host.effects() == 1
				"reload":
					effect_ok = host.reloads == 1 and host.effects() == 1
				"silent":
					effect_ok = host.effects() == 0
			var plan := a.describe(d, host.ctx)
			var label_ok: bool = (plan["action"] != "") == (want[0] != "silent")
			if t.check("adapters: %s / %s -> %s%s" % [kind, name, want[0], (" " + want[1]) if want[1] != "" else ""], r.ok and r.behaviour == want[0] and effect_ok and label_ok, "%s; opened %s, hooks %d, staged %d, restarts %d, reloads %d, action '%s'" % [r, host.opened, host.bridge_obj.calls, host.staged, host.restarts, host.reloads, plan["action"]]):
				evaluated += 1
			if kind != "direct" and r.behaviour in ["staged", "restart", "hook"]:
				self_updates += 1
	t.check("adapters: no store, platform or unknown outlet ever stages, restarts or calls a hook", self_updates == 0, str(self_updates))
	t.check("adapters: coverage", evaluated == kinds.size() * all.size(), "%d/%d" % [evaluated, kinds.size() * all.size()])

	# Platform messages: each platform outlet shows its own copy, and every key is real copy.
	var copy := PKeyUiCopy.new()
	for kind in PLATFORM_KINDS + ["web"]:
		var p := PKeyOutletAdapters.for_kind(kind).describe(all["platform"], {})
		t.check("adapters: %s's platform answer has its own message" % kind, p["body"] != "" and p["body"] != "update_platform_body" and copy.text(p["body"]) != p["body"], p["body"])
	var pkg := PKeyOutletAdapters.for_kind("direct").describe(all["platform"], {"subkind": "homebrew"})
	t.check("adapters: a package-managed direct install (narrowed to platform) names its package manager", pkg["behaviour"] == "silent" and pkg["body"] == "update_platform_package")

	# Capabilities only narrow.
	for kind in kinds:
		var a := PKeyOutletAdapters.for_kind(kind)
		t.check("adapters: %s capabilities are the compiled defaults" % kind, a.capabilities("windows") == PKeyDecision.effective_capabilities(kind, {"platform": "windows"}))
	var widen := {"binaryUpdates": "self", "codeUpdates": true, "channelSwitch": true, "downloadedScripts": true}
	for kind in STORE_KINDS + PLATFORM_KINDS + ["web", "unknown"]:
		var caps := PKeyOutletAdapters.for_kind(kind).capabilities("windows", null, widen)
		t.check("adapters: a feed entry cannot widen %s into self-updating code" % kind, caps["binaryUpdates"] != "self" and caps["codeUpdates"] == false)
	var narrowed := PKeyOutletAdapters.for_kind("direct").capabilities("linux", null, {"codeUpdates": false, "binaryUpdates": "store"})
	t.check("adapters: a feed entry narrows direct", narrowed["codeUpdates"] == false and narrowed["binaryUpdates"] == "store")
	t.check("adapters: iOS direct is narrowed to store, no code", PKeyOutletAdapters.for_kind("direct").capabilities("ios")["binaryUpdates"] == "store" and PKeyOutletAdapters.for_kind("direct").capabilities("ios")["codeUpdates"] == false)

	# The product's own outlet id is kept beside the kind.
	var custom := PKeyOutletAdapters.for_outlet({"id": "itch-beta", "kind": "itch", "subkind": null})
	t.check("adapters: for_outlet keeps a custom id with its kind's adapter", custom is PKeyItchAdapter and custom.id() == "itch-beta" and custom.kind == "itch")
	t.check("adapters: for_outlet of unknown is the silent base", PKeyOutletAdapters.for_outlet({"id": null, "kind": "unknown"}).get_script() == PKeyOutletAdapter)

	# A plan never links anything but https.
	var bad := PKeyOutletAdapters.for_kind("direct").describe(all["binary download"], {"build_url": "http://dl.example.com/x", "release_url": "file:///etc/passwd"})
	t.check("adapters: a non-https download URL is never offered", bad["behaviour"] == "silent" and bad["url"] == "")
