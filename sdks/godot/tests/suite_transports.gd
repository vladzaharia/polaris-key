extends RefCounted
# @pkey-feature packs.transport.apple packs.transport.play packs.transport.steam
# The store pack transports (P5-08; CONTENT §7): PKeyPackAppleBaTransport over PKeyApple and the
# fake PolarisKeyApple native, PKeyPackPlayPadTransport over PKeyAndroid and the fake
# PolarisKeyAndroid plugin, PKeyPackSteamTransport over a fake GodotSteam. For each: a copy whose
# marker and bytes match the signed record is accepted at boot and activated; a tampered payload,
# a forged marker and a marker for another pack are refused; without its plugin the transport is
# Unsupported and holds nothing; the platform pin rule (floating Apple and Steam copies, pinned
# Play copies); the engine's `platform` strategy (delivered, re-read, exactly the target) and
# `plan-transport-unsupported` while the platform is unavailable.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const PACK := "djdl.foes"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	PKeyPackClaims.warm()
	PKeyPck.warm()
	_ids(t)
	await _probe(t)
	await _apple(t)
	await _play(t)
	await _steam(t)
	await _absent(t)
	await _planner(t)
	await _service(t)
	return true


# ── Fixtures ────────────────────────────────────────────────────────────────────────────────

static func _tree(version := "1.0.0", seq := 1, pack_id := PACK) -> Dictionary:
	return F.tree_pack(pack_id, version, seq, {"foes/goblin.json": "{\"hp\": %d}" % seq, "foes/orc.json": "{\"hp\": 9}"})


static func _container(version := "1.0.0", seq := 1) -> Dictionary:
	var c := F.chunk_bytes("transport-%d" % seq, 4096)
	return F.chunk_pack(PACK, version, seq, [c], [[c]])


## Lay a tree pack out in `dir` the way `pkey transport …` writes it (files plus .pkey/pack.json).
static func _write_tree(dir: String, p: Dictionary, marker := "") -> void:
	for path in p["files"]:
		S.write_file(dir.path_join(path), p["files"][path])
	S.write_file(dir.path_join(".pkey/pack.json"), (marker if marker != "" else F.marker_for(p)).to_utf8_buffer())


static func _write_container(dir: String, p: Dictionary, name := "foes.blob") -> void:
	S.write_file(dir.path_join(name), p["payload"])
	S.write_file(dir.path_join(name + ".pkey.json"), F.marker_for(p).to_utf8_buffer())


static func _engine(root: String, packs: Array, stamp_packs: Array, platform: PKeyPackPlatformTransport) -> PKeyPackEngine:
	var tr := F.FakeTransport.new()
	for p in packs:
		tr.add(p)
	var e := F.engine(root.path_join("store"), tr, F.stamp_for(stamp_packs))
	e.register_handler(F.BlobHandler.new())
	e.platform = platform
	return e


static func _apple_facade(native: Object, p_platform := "ios") -> PKeyApple:
	var a := PKeyApple.new()
	a.platform = p_platform
	a.native = native
	a.timeout_s = 2.0
	return a


static func _android_facade(native: Object, p_platform := "android") -> PKeyAndroid:
	var a := PKeyAndroid.new()
	a.platform = p_platform
	a.native = native
	a.timeout_s = 2.0
	return a


static func _apple_transport(staging: String) -> Array:
	var f := PKeyFakeAppleNative.new()
	f.staging_root = staging
	var tr := PKeyPackAppleBaTransport.new(_apple_facade(f))
	tr.packs = [PACK]
	tr.content_api = 3
	return [tr, f]


static func _play_transport(assets_root: String) -> Array:
	var f := PKeyFakeAndroidNative.new()
	f.assets_root = assets_root
	f.packs = {"djdl_foes": 8}
	var tr := PKeyPackPlayPadTransport.new(_android_facade(f))
	tr.packs = [PACK]
	return [tr, f]


static func _steam_transport(install: String) -> Array:
	var s := PKeyFakeSteam.new()
	s.directory = install
	var tr := PKeyPackSteamTransport.new(s)
	tr.packs = [PACK]
	return [tr, s]


## The directory a transport reads `PACK` from, for each kind (what `pkey transport …` targets).
static func _apple_dir(staging: String) -> String:
	return staging.path_join("pkey/djdl-foes-c3")


static func _play_dir(assets_root: String, sub := "pkey") -> String:
	return assets_root.path_join("djdl_foes/11/11/assets").path_join(sub)


static func _steam_dir(install: String) -> String:
	return install.path_join("pkey_packs").path_join(PACK)


# ── Cases ───────────────────────────────────────────────────────────────────────────────────

func _ids(t: PKeyTestContext) -> void:
	t.check("ids: apple asset pack <pack>-c<contentApi>, dots to hyphens", PKeyPackAppleBaTransport.asset_pack_id("diceroll.foes", 3) == "diceroll-foes-c3" and PKeyPackAppleBaTransport.asset_pack_id("foes", 4) == "foes-c4")
	t.check("ids: a double hyphen is no asset pack", PKeyPackAppleBaTransport.asset_pack_id("x-.foes", 3) == "")
	t.check("ids: over 64 characters is no asset pack", PKeyPackAppleBaTransport.asset_pack_id("a" + "b".repeat(61), 3) == "" and PKeyPackAppleBaTransport.asset_pack_id("a" + "b".repeat(59), 3) != "")
	t.check("ids: an unknown content level is no asset pack", PKeyPackAppleBaTransport.asset_pack_id("foes", -1) == "")
	t.check("ids: Play asset pack names replace dots and hyphens", PKeyPackPlayPadTransport.pad_name("diceroll.big-foes") == "diceroll_big_foes")
	t.check("ids: transports name their transport and floating", PKeyPackAppleBaTransport.new().id() == "apple-ba" and PKeyPackPlayPadTransport.new().id() == "play-pad" and PKeyPackSteamTransport.new().id() == "steam-depot"
		and PKeyPackAppleBaTransport.new().floats() and not PKeyPackPlayPadTransport.new().floats() and PKeyPackSteamTransport.new().floats())
	t.check("ids: no platform transport makes range requests", not PKeyPackAppleBaTransport.new().supports_range() and not PKeyPackPlayPadTransport.new().supports_range() and not PKeyPackSteamTransport.new().supports_range())


func _probe(t: PKeyTestContext) -> void:
	var root := S.scratch("transports-probe")
	var p := _tree()
	_write_tree(root.path_join("tree"), p)
	var b := PKeyPackPlatformTransport.probe(root.path_join("tree"))
	t.check("probe: a tree with .pkey/pack.json", b.get("payload", {}).get("kind") == "tree" and b["payload"]["treeDigest"] == p["treeDigest"], S.canon(b))
	var c := _container()
	_write_container(root.path_join("file"), c)
	b = PKeyPackPlatformTransport.probe(root.path_join("file"))
	t.check("probe: a container with its marker beside it", b.get("payload", {}).get("kind") == "file" and b["payload"]["sha256"] == c["payloadSha256"] and b["location"].ends_with("foes.blob"), S.canon(b))
	_write_container(root.path_join("file"), c, "other.blob")
	t.check("probe: two markers in one directory are ambiguous", PKeyPackPlatformTransport.probe(root.path_join("file")).get("error") == "format")
	t.check("probe: a missing directory holds nothing", PKeyPackPlatformTransport.probe(root.path_join("nope")).is_empty())
	S.remove_tree(root)


## Boot acceptance and refusals through one transport. `make(root)` -> [transport, fake]; `dir(root)`
## is where the transport reads PACK.
func _boot_cases(t: PKeyTestContext, tag: String, make: Callable, dir: Callable, prepare := Callable()) -> void:
	var v1 := _tree("1.0.0", 1)
	# Accepted: the pinned release, marker and bytes matching.
	var root := S.scratch("transports-%s-ok" % tag)
	var made: Array = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	_write_tree(dir.call(root), v1)
	var copies: Array = await made[0].installed()
	t.check("%s: installed() reads the pack's copy" % tag, copies.size() == 1 and copies[0].get("packId") == PACK and copies[0].get("transport") == made[0].id(), S.canon(copies))
	var e := _engine(root, [v1], [v1], made[0])
	var loaded: Dictionary = await e.load_state([], copies)
	t.check("%s: a matching copy is accepted and activated" % tag, loaded["refused"].is_empty() and e.running.has(PACK) and e.running[PACK]["recordSha256"] == v1["recordSha256"] and e.running[PACK]["platform"] == made[0].id(), S.canon(loaded))
	var r := await e.ensure([PACK])
	t.check("%s: ensure finds it current (nothing fetched)" % tag, r.ok and (e.transport as F.FakeTransport).calls.is_empty(), str(r))
	t.check("%s: nothing is written to the state document" % tag, not e.doc["active"].has(PACK))
	S.remove_tree(root)

	# A tampered payload: one file's bytes differ from the files index.
	root = S.scratch("transports-%s-tamper" % tag)
	made = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	_write_tree(dir.call(root), v1)
	S.write_file(dir.call(root).path_join("foes/orc.json"), "{\"hp\": 99}".to_utf8_buffer())
	e = _engine(root, [v1], [v1], made[0])
	loaded = await e.load_state([], await made[0].installed())
	t.check("%s: a tampered file is refused (payload)" % tag, loaded["refused"].size() == 1 and loaded["refused"][0]["step"] == "payload" and not e.running.has(PACK), S.canon(loaded))
	S.remove_tree(root)

	# A forged marker: the record's signature broken.
	root = S.scratch("transports-%s-forged" % tag)
	made = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	var parts := String(v1["jws"]).split(".")
	var sig := parts[2]
	parts[2] = ("B" if sig[0] != "B" else "C") + sig.substr(1)
	var forged := JSON.stringify({"format": "pkey-marker/1", "packId": PACK, "version": "1.0.0", "release": ".".join(parts)})
	_write_tree(dir.call(root), v1, forged)
	e = _engine(root, [v1], [v1], made[0])
	loaded = await e.load_state([], await made[0].installed())
	t.check("%s: a forged marker is refused" % tag, loaded["refused"].size() == 1 and loaded["refused"][0]["step"] != "payload" and not e.running.has(PACK), S.canon(loaded))
	S.remove_tree(root)

	# Another pack's marker in this pack's place.
	root = S.scratch("transports-%s-other" % tag)
	made = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	var other := _tree("1.0.0", 1, "djdl.l10n")
	_write_tree(dir.call(root), other)
	e = _engine(root, [v1], [v1], made[0])
	loaded = await e.load_state([], await made[0].installed())
	t.check("%s: another pack's copy in this pack's place is refused" % tag, loaded["refused"].size() == 1 and loaded["refused"][0]["step"] == "cross-check" and e.running.is_empty(), S.canon(loaded))
	S.remove_tree(root)

	# The pin rule: a newer release floats (Apple, Steam) or is refused (Play); an older one never
	# replaces the pin.
	root = S.scratch("transports-%s-newer" % tag)
	made = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	var v2 := _tree("1.1.0", 2)
	_write_tree(dir.call(root), v2)
	e = _engine(root, [v1, v2], [v1], made[0])
	loaded = await e.load_state([], await made[0].installed())
	if made[0].floats():
		t.check("%s: a later release than the pin floats in" % tag, loaded["refused"].is_empty() and e.running.get(PACK, {}).get("recordSha256") == v2["recordSha256"], S.canon(loaded))
	else:
		t.check("%s: a later release than the pin is refused (pinned transport)" % tag, loaded["refused"].size() == 1 and loaded["refused"][0]["step"] == "pin" and not e.running.has(PACK), S.canon(loaded))
	S.remove_tree(root)
	root = S.scratch("transports-%s-older" % tag)
	made = make.call(root)
	if prepare.is_valid():
		prepare.call(made[1])
	_write_tree(dir.call(root), v1)
	e = _engine(root, [v1, v2], [v2], made[0])
	loaded = await e.load_state([], await made[0].installed())
	t.check("%s: an older release than the pin is refused (pin)" % tag, loaded["refused"].size() == 1 and loaded["refused"][0]["step"] == "pin" and not e.running.has(PACK), S.canon(loaded))
	S.remove_tree(root)


func _apple(t: PKeyTestContext) -> void:
	await _boot_cases(t, "apple", func(root: String) -> Array: return _apple_transport(root.path_join("staging")),
		func(root: String) -> String: return _apple_dir(root.path_join("staging")))
	# A container payload, and the transport's own ensure.
	var root := S.scratch("transports-apple-container")
	var made := _apple_transport(root.path_join("staging"))
	var c := _container()
	_write_container(_apple_dir(root.path_join("staging")), c)
	var e := _engine(root, [c], [c], made[0])
	var loaded: Dictionary = await e.load_state([], await made[0].installed())
	t.check("apple: a container copy is accepted", loaded["refused"].is_empty() and e.running.has(PACK), S.canon(loaded))
	var seen: Array = []
	made[0].pack_progress.connect(func(id: String, b: int, total: int) -> void: seen.append([id, b, total]))
	var r: PKeyResult = await made[0].ensure_pack(PACK)
	var call: Dictionary = {}
	for q in made[1].calls:
		if q.get("op") == "packs_ensure":
			call = q
	t.check("apple: ensure asks Background Assets for the level's asset pack", r.ok and call.get("packs") == [{"id": "djdl-foes-c3", "path": "pkey/djdl-foes-c3"}], S.canon(call))
	t.check("apple: progress is forwarded under the pack id", seen == [[PACK, 512, 1024]], S.canon(seen))
	made[1].not_ready = {"djdl-foes-c3": "BAManagedErrorDomain 0: No asset pack"}
	r = await made[0].ensure_pack(PACK)
	t.check("apple: a pack Background Assets cannot make ready fails (platform-error)", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR, str(r))
	made[0].content_api = -1
	r = await made[0].ensure_pack(PACK)
	t.check("apple: without a content level there is no asset pack to ask for", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS, str(r))
	S.remove_tree(root)


func _play(t: PKeyTestContext) -> void:
	var completed := func(f: PKeyFakeAndroidNative) -> void: f.packs["djdl_foes"] = 4
	await _boot_cases(t, "play", func(root: String) -> Array: return _play_transport(root.path_join("assetpacks")),
		func(root: String) -> String: return _play_dir(root.path_join("assetpacks")), completed)
	var root := S.scratch("transports-play-tcf")
	var made := _play_transport(root.path_join("assetpacks"))
	completed.call(made[1])
	var v1 := _tree()
	_write_tree(_play_dir(root.path_join("assetpacks"), "pkey#tcf_astc"), v1)
	var copies: Array = await made[0].installed()
	t.check("play: a texture-targeted directory that was not suffix-stripped is read", copies.size() == 1 and String(copies[0]["location"]).ends_with("pkey#tcf_astc"), S.canon(copies))
	S.remove_tree(root)
	# Not completed: Play holds no location, so nothing.
	root = S.scratch("transports-play-none")
	made = _play_transport(root.path_join("assetpacks"))
	_write_tree(_play_dir(root.path_join("assetpacks")), v1)
	t.check("play: a pack Play has not completed holds nothing", (await made[0].installed()).is_empty())
	# ensure: fetched to COMPLETED.
	var r: PKeyResult = await made[0].ensure_pack(PACK)
	t.check("play: ensure fetches the pack to COMPLETED", r.ok and made[1].ops_called("pad_fetch") == 1 and made[0].last_state(PACK).get("status") == 4 and int(made[0].last_state(PACK).get("totalBytes")) == 5000000, str(r))
	# Confirmation: the hook accepts, Play's dialog completes it.
	made[1].packs["djdl_foes"] = 8
	made[1].fetch_statuses = {"djdl_foes": [2, 9]}
	made[1].confirm_completes = true
	var asked: Array = []
	made[0].confirm_hook = func(id: String, state: Dictionary) -> bool:
		asked.append([id, state.get("status"), state.get("totalBytes")])
		return true
	r = await made[0].ensure_pack(PACK)
	t.check("play: a download needing confirmation asks the hook, then Play's dialog", r.ok and asked == [[PACK, 9, 5000000]] and made[1].ops_called("pad_confirm") == 1, "%s %s" % [r, S.canon(asked)])
	# The hook declines: cancelled, and the download is cancelled.
	made[1].packs["djdl_foes"] = 8
	made[1].fetch_statuses = {"djdl_foes": [2, 7]}
	made[0].confirm_hook = func(_id: String, _state: Dictionary) -> bool: return false
	r = await made[0].ensure_pack(PACK)
	t.check("play: a declined confirmation cancels (cancelled)", not r.ok and r.code == PKeyErrors.CANCELLED and made[1].ops_called("pad_cancel") == 1 and made[1].ops_called("pad_confirm") == 1, str(r))
	# No hook: Play's own dialog at once.
	made[1].packs["djdl_foes"] = 8
	made[1].fetch_statuses = {"djdl_foes": [9]}
	made[0].confirm_hook = Callable()
	r = await made[0].ensure_pack(PACK)
	t.check("play: without a hook Play's dialog is shown at once", r.ok and made[1].ops_called("pad_confirm") == 2, str(r))
	# Failed.
	made[1].packs["djdl_foes"] = 8
	made[1].fetch_statuses = {"djdl_foes": [2, 5]}
	r = await made[0].ensure_pack(PACK)
	t.check("play: a FAILED download fails (platform-error)", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR, str(r))
	# The direct build has no Play Asset Delivery.
	var direct := PKeyFakeAndroidNative.new()
	direct.flavor = "direct"
	var dt := PKeyPackPlayPadTransport.new(_android_facade(direct))
	dt.packs = [PACK]
	t.check("play: the direct build is Unsupported (outlet)", dt.availability().code == &"unsupported" and dt.availability().detail.get("reason") == "outlet" and (await dt.installed()).is_empty())
	S.remove_tree(root)


func _steam(t: PKeyTestContext) -> void:
	await _boot_cases(t, "steam", func(root: String) -> Array: return _steam_transport(root.path_join("install")),
		func(root: String) -> String: return _steam_dir(root.path_join("install")))
	var root := S.scratch("transports-steam-dlc")
	var made := _steam_transport(root.path_join("install"))
	made[0].dlc = {PACK: 2001}
	var v1 := _tree()
	_write_tree(_steam_dir(root.path_join("install")), v1)
	t.check("steam: a DLC pack Steam has not installed holds nothing", (await made[0].installed()).is_empty())
	var r: PKeyResult = await made[0].ensure_pack(PACK)
	t.check("steam: ensure installs the DLC and waits for dlc_installed", r.ok and made[1].calls.has(["installDLC", 2001]) and made[1].installed_dlc.has(2001), str(r))
	t.check("steam: then its depot's copy is read", (await made[0].installed()).size() == 1)
	t.check("steam: build id and beta branch are exposed", made[0].build_id() == 1234567 and made[0].beta_name() == "pkey-test")
	made[1].installed_dlc.clear()
	made[1].install_hangs = true
	made[0].install_timeout_s = 0.05
	r = await made[0].ensure_pack(PACK)
	t.check("steam: a DLC install that never finishes times out", not r.ok and r.code == PKeyErrors.TIMEOUT, str(r))
	var empty := _steam_transport(root.path_join("empty"))
	r = await empty[0].ensure_pack(PACK)
	t.check("steam: a depot not in this build fails (platform-error)", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR, str(r))
	made[1].running = false
	t.check("steam: Steam not running this copy is Unsupported (outlet)", made[0].availability().detail.get("reason") == "outlet")
	S.remove_tree(root)


func _absent(t: PKeyTestContext) -> void:
	var root := S.scratch("transports-absent")
	var v1 := _tree()
	var apple := PKeyPackAppleBaTransport.new(_apple_facade(null, "ios"))
	apple.packs = [PACK]
	apple.content_api = 3
	var apple_desk := PKeyPackAppleBaTransport.new(_apple_facade(null, "macos"))
	apple_desk.packs = [PACK]
	var play := PKeyPackPlayPadTransport.new(_android_facade(null, "android"))
	play.packs = [PACK]
	var steam := PKeyPackSteamTransport.new()
	steam.platform = "linux"
	steam.packs = [PACK]
	steam.install_dir = root
	_write_tree(_steam_dir(root), v1)
	var steam_mobile := PKeyPackSteamTransport.new()
	steam_mobile.platform = "ios"
	var cases := [
		["apple without the GDExtension", apple, "dependency", PKeyConstants.Feature.PACKS_TRANSPORT_APPLE],
		["apple on macOS (no binding)", apple_desk, "runtime", PKeyConstants.Feature.PACKS_TRANSPORT_APPLE],
		["play without the plugin", play, "dependency", PKeyConstants.Feature.PACKS_TRANSPORT_PLAY],
		["steam without GodotSteam", steam, "dependency", PKeyConstants.Feature.PACKS_TRANSPORT_STEAM],
		["steam on iOS", steam_mobile, "runtime", PKeyConstants.Feature.PACKS_TRANSPORT_STEAM],
	]
	for c in cases:
		var tr: PKeyPackPlatformTransport = c[1]
		var gate := tr.availability()
		var r: PKeyResult = await tr.ensure_pack(PACK)
		t.check("absent: %s is Unsupported (%s) for %s" % [c[0], c[2], c[3]], gate.code == &"unsupported" and gate.detail.get("reason") == c[2] and gate.detail.get("feature") == c[3]
			and r.code == &"unsupported" and r.detail.get("reason") == c[2], "%s %s" % [gate, r])
		t.check("absent: %s holds nothing" % c[0], (await tr.installed()).is_empty() and (await tr.baseline(PACK)).is_empty())
	S.remove_tree(root)


func _planner(t: PKeyTestContext) -> void:
	# Delivered by the platform during ensure: the plan is `platform`, nothing comes from the CDN.
	var root := S.scratch("transports-plan")
	var made := _apple_transport(root.path_join("staging"))
	var v1 := _tree()
	var e := _engine(root, [v1], [v1], made[0])
	await e.load_state([], [])
	_write_tree(_apple_dir(root.path_join("staging")), v1)
	var progress: Array = []
	e.progress.connect(func(ev: Dictionary) -> void: progress.append(ev))
	var est := await e.estimate([PACK])
	t.check("plan: a platform-bound pack is planned through the platform (no bytes from the CDN)", est["packs"] == [PACK] and est["bytes"] == 0 and est["refused"].is_empty(), S.canon(est))
	var r := await e.ensure([PACK])
	var fake_cdn := e.transport as F.FakeTransport
	t.check("plan: ensure delivers through the platform and activates the exact release", r.ok and e.running.get(PACK, {}).get("recordSha256") == v1["recordSha256"] and made[1].ensured == ["djdl-foes-c3"], str(r))
	t.check("plan: only the signed record came from the CDN transport", fake_cdn.calls.is_empty() and fake_cdn.record_calls.has(v1["recordSha256"]) and fake_cdn.record_calls.count(v1["recordSha256"]) == fake_cdn.record_calls.size(), S.canon(fake_cdn.calls))
	t.check("plan: platform progress reaches the engine's progress", progress.size() == 1 and progress[0]["phase"] == "download" and progress[0]["packId"] == PACK, S.canon(progress))
	S.remove_tree(root)

	# The platform delivers an OLDER release than the stamp's pin: record-mismatch (fail closed).
	root = S.scratch("transports-plan-mismatch")
	made = _apple_transport(root.path_join("staging"))
	var v2 := _tree("1.1.0", 2)
	e = _engine(root, [v1, v2], [v2], made[0])
	await e.load_state([], [])
	_write_tree(_apple_dir(root.path_join("staging")), v1)
	r = await e.ensure([PACK])
	t.check("plan: a delivered release older than the pin is refused (record-mismatch)", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and not e.running.has(PACK), str(r))
	# A decision targeting exactly v1 takes it.
	r = await e.ensure_releases([{"pack": PACK, "release": {"sha256": v1["recordSha256"], "seq": 1, "version": "1.0.0"}}])
	t.check("plan: a decision's exact target takes the delivered release", r.ok and e.running.get(PACK, {}).get("recordSha256") == v1["recordSha256"], str(r))
	S.remove_tree(root)

	# A newer release the platform delivers during ensure floats in for the stamp's pin (Apple).
	root = S.scratch("transports-plan-float-ensure")
	made = _apple_transport(root.path_join("staging"))
	e = _engine(root, [v1, v2], [v1], made[0])
	await e.load_state([], [])
	_write_tree(_apple_dir(root.path_join("staging")), v2)
	r = await e.ensure([PACK])
	t.check("plan: a newer delivered release floats in for the pin (apple)", r.ok and e.running.get(PACK, {}).get("recordSha256") == v2["recordSha256"], str(r))
	# A decision's exact target is never satisfied by another release.
	r = await e.ensure_releases([{"pack": PACK, "release": {"sha256": v1["recordSha256"], "seq": 1, "version": "1.0.0"}}])
	t.check("plan: a decision's exact target refuses the floated release (record-mismatch)", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH, str(r))
	S.remove_tree(root)

	# (a) A copy that floated in at boot is current for the pin: ensure is ok, nothing re-fetched.
	root = S.scratch("transports-plan-float-boot")
	made = _apple_transport(root.path_join("staging"))
	_write_tree(_apple_dir(root.path_join("staging")), v2)
	e = _engine(root, [v1, v2], [v1], made[0])
	var copies: Array = await made[0].installed()
	var loaded: Dictionary = await e.load_state([], copies)
	t.check("plan: the floated copy was accepted at boot", loaded["refused"].is_empty() and e._embedded.get(PACK, {}).get("recordSha256") == v2["recordSha256"], S.canon(loaded))
	r = await e.ensure([PACK])
	t.check("plan: a copy floated in at boot makes ensure ok (current), no platform delivery", r.ok and made[1].ensured.is_empty() and e.running.get(PACK, {}).get("recordSha256") == v2["recordSha256"], str(r))
	t.check("plan: the floated copy is never written to the state document", not e.doc["active"].has(PACK))
	S.remove_tree(root)

	# (b) A float refused at boot (Play stays pinned) still fails closed at ensure.
	root = S.scratch("transports-plan-float-refused")
	made = _play_transport(root.path_join("assets"))
	made[1].packs = {"djdl_foes": 4}
	_write_tree(_play_dir(root.path_join("assets")), v2)
	e = _engine(root, [v1, v2], [v1], made[0])
	copies = await made[0].installed()
	loaded = await e.load_state([], copies)
	t.check("plan: a play copy newer than the pin is refused at boot (pin)", loaded["refused"].size() == 1 and loaded["refused"][0]["step"] == "pin" and not e._embedded.has(PACK), S.canon(loaded))
	r = await e.ensure([PACK])
	t.check("plan: after a refused float, ensure fails closed (record-mismatch)", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH and not e.running.has(PACK), str(r))
	S.remove_tree(root)

	# The noop edge: a platform copy holding the target's payload under another record is used as
	# the install, never committed to the state.
	root = S.scratch("transports-plan-noop")
	made = _apple_transport(root.path_join("staging"))
	var same_files := {"foes/goblin.json": "{\"hp\": 1}", "foes/orc.json": "{\"hp\": 9}"}
	var a := F.tree_pack(PACK, "1.0.0", 1, same_files)
	var b := F.tree_pack(PACK, "1.0.1", 2, same_files)
	_write_tree(_apple_dir(root.path_join("staging")), b)
	e = _engine(root, [a, b], [a], made[0])
	copies = await made[0].installed()
	await e.load_state([], copies)
	r = await e.ensure_releases([{"pack": PACK, "release": {"sha256": a["recordSha256"], "seq": 1, "version": "1.0.0"}}])
	t.check("plan: a noop onto a platform copy returns it and commits nothing", r.ok and not e.doc["active"].has(PACK) and made[1].ensured.is_empty(), str(r) + " " + S.canon(e.doc["active"]))
	S.remove_tree(root)

	# A tampered delivery: marker-rejected at payload.
	root = S.scratch("transports-plan-tamper")
	made = _apple_transport(root.path_join("staging"))
	e = _engine(root, [v1], [v1], made[0])
	await e.load_state([], [])
	_write_tree(_apple_dir(root.path_join("staging")), v1)
	S.write_file(_apple_dir(root.path_join("staging")).path_join("foes/goblin.json"), "{}".to_utf8_buffer())
	r = await e.ensure([PACK])
	t.check("plan: a tampered delivery is refused (marker-rejected, payload)", not r.ok and r.code == &"marker-rejected" and r.detail.get("step") == "payload", str(r))
	S.remove_tree(root)

	# The platform's failure is returned as is.
	root = S.scratch("transports-plan-fail")
	made = _apple_transport(root.path_join("staging"))
	made[1].not_ready = {"djdl-foes-c3": "boom"}
	e = _engine(root, [v1], [v1], made[0])
	await e.load_state([], [])
	r = await e.ensure([PACK])
	t.check("plan: the platform's failure is the ensure's", not r.ok and r.code == PKeyErrors.PLATFORM_ERROR, str(r))
	S.remove_tree(root)

	# The platform unavailable: plan-transport-unsupported, never a CDN fallback.
	for c in [["apple", PKeyPackAppleBaTransport.new(_apple_facade(null, "ios"))], ["play", PKeyPackPlayPadTransport.new(_android_facade(null, "android"))], ["steam", PKeyPackSteamTransport.new()]]:
		root = S.scratch("transports-plan-off-%s" % c[0])
		var tr: PKeyPackPlatformTransport = c[1]
		tr.packs = [PACK]
		tr.content_api = 1
		if tr is PKeyPackSteamTransport:
			(tr as PKeyPackSteamTransport).platform = "linux"
		e = _engine(root, [v1], [v1], tr)
		await e.load_state([], [])
		r = await e.ensure([PACK])
		fake_cdn = e.transport as F.FakeTransport
		t.check("plan: %s unavailable is plan-transport-unsupported, no CDN fallback" % c[0], not r.ok and r.code == &"plan-transport-unsupported" and fake_cdn.calls.is_empty(), str(r))
		S.remove_tree(root)

	# A pack the platform does not carry keeps the CDN path.
	root = S.scratch("transports-plan-other")
	made = _apple_transport(root.path_join("staging"))
	var l10n := _tree("1.0.0", 1, "djdl.l10n")
	e = _engine(root, [l10n], [l10n], made[0])
	await e.load_state([], [])
	r = await e.ensure(["djdl.l10n"])
	t.check("plan: a pack the platform does not carry still comes from the CDN", r.ok and not (e.transport as F.FakeTransport).calls.is_empty() and made[1].ensured.is_empty(), str(r))
	S.remove_tree(root)


## PolarisKey.update.packs with a platform transport: start() reads its copies at boot.
func _service(t: PKeyTestContext) -> void:
	var root := S.scratch("transports-service")
	var made := _steam_transport(root.path_join("install"))
	var v1 := _tree()
	_write_tree(_steam_dir(root.path_join("install")), v1)
	var e := _engine(root, [v1], [v1], null)
	var copies: Array = await made[0].installed()
	e.platform = made[0]
	var loaded: Dictionary = await e.load_state([], copies)
	t.check("service: copies passed to load_state register as the pack's baseline", loaded["refused"].is_empty() and e._embedded.get(PACK, {}).get("platform") == "steam-depot")
	var svc := PKeyPacks.new()
	t.check("service: PKeyPacks takes a platform transport", "platform_transport" in svc and svc.platform_transport == null)
	S.remove_tree(root)
