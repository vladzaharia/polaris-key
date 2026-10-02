extends RefCounted
# @pkey-feature update.driver update.bootguard
# PKeySidecarSwap on a portable install in a scratch directory (P3-10):
#
#   - the refused locations, each with its reason and no request: MSIX (a `WindowsApps` segment,
#     either separator, any case, the fake's `C:/Program Files/WindowsApps/...` path), Program
#     Files (and x86), a macOS .app, Flatpak, Snap, AppImage, Velopack (sq.version, or `current`
#     beside Update.exe), an embedded pack, a directory that is not writable, mobile and web;
#   - stage: the record's pck build from discovery's builds URL, verified, staged with its meta
#     (channel = the UpdateCheck's canonical channel); a size or hash mismatch stages nothing;
#   - restart_to_update: the verified staged pack replaces `<exe-name>.pck`, the old one becomes
#     `previous`, the game restarts; a staged pack that no longer verifies changes nothing; a locked
#     rename keeps the staged pack, restarts, and the next launch's guard applies it;
#   - crash recovery: a journalled swap whose rename happened is finished at the next launch.

const S := preload("res://tests/updater/support.gd")


func _env(os: String, exe: String, vars := {}, files := {}) -> PKeyFakeUpdaterEnv:
	var e := PKeyFakeUpdaterEnv.new()
	e.os = os
	e.exe = exe
	e.vars = vars
	e.files = files
	return e


func run(t: PKeyTestContext) -> void:
	await _refusals(t)
	await _stage_and_swap(t)
	await _mismatch(t)
	await _locked(t)
	await _recovery(t)
	await _short_writes(t)
	await _telemetry(t)


func _refusals(t: PKeyTestContext) -> void:
	var win_pck := {"C:/Program Files/WindowsApps/Pub.Game_1.0.0.0_x64__abc/Game.pck": true}
	var rows := [
		["MSIX (C:/Program Files/WindowsApps/...)", _env("windows", "C:/Program Files/WindowsApps/Pub.Game_1.0.0.0_x64__abc/Game.exe", {}, win_pck), "msix"],
		["MSIX on another volume, backslashes, other case", _env("windows", "D:\\windowsAPPS\\Pub.Game_1.0.0.0_x64__abc\\Game.exe"), "msix"],
		["Program Files", _env("windows", "C:/Program Files/Game/Game.exe"), "program-files"],
		["Program Files (x86), any case", _env("windows", "C:/PROGRAM FILES (X86)/Game/Game.exe"), "program-files"],
		["a macOS .app", _env("macos", "/Applications/Game.app/Contents/MacOS/Game"), "app-bundle"],
		["Flatpak (FLATPAK_ID)", _env("linux", "/app/bin/game", {"FLATPAK_ID": "org.example.Game"}), "flatpak"],
		["Flatpak (/.flatpak-info)", _env("linux", "/app/bin/game", {}, {"/.flatpak-info": true}), "flatpak"],
		["Snap", _env("linux", "/snap/game/12/game", {"SNAP": "/snap/game/12"}), "snap"],
		["AppImage", _env("linux", "/tmp/.mount_GameXy/usr/bin/game", {"APPIMAGE": "/home/p/Game.AppImage"}), "appimage"],
		["Velopack (sq.version)", _env("windows", "C:/Users/p/AppData/Local/Game/current/Game.exe", {}, {"C:/Users/p/AppData/Local/Game/current/sq.version": true}), "velopack"],
		["Velopack (current beside Update.exe)", _env("windows", "C:/Users/p/AppData/Local/Game/current/Game.exe", {}, {"C:/Users/p/AppData/Local/Game/Update.exe": true}), "velopack"],
		["an embedded pack (no sidecar)", _env("linux", "/opt/game-nowhere/game.x86_64"), "no-sidecar"],
		["a directory that is not writable", _env("linux", "/nonexistent-pkey/game/game.x86_64", {}, {"/nonexistent-pkey/game/game.pck": true}), "not-writable"],
		["Android", _env("android", "/data/app/x/base.apk"), "platform"],
		["iOS", _env("ios", "/var/containers/Bundle/Application/X/Game.app/Game"), "platform"],
		["web", _env("web", ""), "platform"],
	]
	for row in rows:
		var s := PKeySidecarSwap.support(row[1])
		t.check("swap: refused for %s (%s)" % [row[0], row[2]], not s["ok"] and s["reason"] == row[2], str(s))
	var inst := S.install("swap-ok", S.bytes(32, 1), "windows", "Game.exe")
	var ok := PKeySidecarSwap.support(inst["env"])
	t.check("swap: a writable portable Windows install with Game.pck beside Game.exe is supported", ok["ok"] and ok["pck"] == inst["pck"], str(ok))
	PKeyTestFixtures.remove_tree(inst["dir"])

	# A refused install stages nothing and asks the server nothing.
	var sup := S.new()
	sup.serve()
	inst = S.install("swap-refused", S.bytes(32, 1))
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	inst["env"].vars["SNAP"] = "/snap/game/1"
	var r: PKeyApplyResult = await sdk.update.updater.stage_sidecar(S.sidecar_check("1.5.0", S.bytes(64, 2)))
	t.check("swap: staging on a refused install is swap-refused with its reason, and nothing is fetched", not r.ok and r.code == PKeyErrors.SWAP_REFUSED and r.detail.get("reason") == "snap" and sup.server.requests.is_empty(), str(r))
	t.check("swap: sidecar-pck is not offered to the decision where the swap is refused", not sdk.update.updater.methods().has("sidecar-pck"), str(sdk.update.updater.methods()))
	sdk.update.updater.enabled = false
	r = await sdk.update.updater.stage_sidecar(S.sidecar_check("1.5.0", S.bytes(64, 2)))
	t.check("swap: an inert updater stages nothing (swap-refused inert)", not r.ok and r.detail.get("reason") == "inert")
	t.check("swap: an inert updater passes the declared methods through unchanged", sdk.update.updater.methods() == ["native", "download", "sidecar-pck"])
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _stage_and_swap(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(40000, 1)
	var fresh := S.bytes(70000, 2)
	var inst := S.install("swap", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	var staged_seen: Array = []
	sdk.update.update_staged.connect(func(v): staged_seen.append(v))
	var u: PKeyUpdater = sdk.update.updater
	var r: PKeyApplyResult = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "beta"))
	var req: Array = sup.requests("/djdl/distribution/builds/")
	t.check("swap: the pack is fetched from discovery's builds URL ({selector} = version, {buildId} = build)", req.size() == 1 and req[0]["path"] == "/djdl/distribution/builds/1.5.0/linux-pck", str(req.map(func(q): return q["path"])))
	var meta = u.slots.meta("staged")
	t.check("swap: a verified pack is staged with its meta", r.ok and r.behaviour == "staged" and r.version == "1.5.0" and meta is Dictionary and meta["sha256"] == S.sha(fresh) and int(meta["size"]) == fresh.size() and S.read(u.slots.payload("staged")) == fresh, "%s %s" % [r, meta])
	t.check("swap: the staged meta records the UpdateCheck's canonical channel and the engine", meta is Dictionary and meta["channel"] == "beta" and meta["engine"] == PKeyBuildStamp.engine_id() and meta["scheme"] == "semver")
	t.check("swap: update_staged fired; the decision input is {version, channel}", staged_seen == ["1.5.0"] and u.staged_input() == {"version": "1.5.0", "channel": "beta"})
	t.check("swap: update_downloaded is recorded locally", u.events().map(func(e): return e["event"]).has("update_downloaded"))
	t.check("swap: nothing beside the executable changed yet", S.read(inst["pck"]) == old)
	sup.server.requests.clear()
	r = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "beta"))
	t.check("swap: the same pack staged again is not fetched again", r.ok and sup.server.requests.is_empty())

	var e: PKeyFakeUpdaterEnv = inst["env"]
	r = await sdk.update.restart_to_update()
	var st := u.slots.load_state()
	t.check("swap: restart_to_update replaces <exe-name>.pck with the verified pack and restarts", r.ok and r.behaviour == "restart" and S.read(inst["pck"]) == fresh and e.restarts == 1, "%s restarts=%d" % [r, e.restarts])
	var prev = u.slots.meta("previous")
	t.check("swap: the old pack becomes previous (the shipped one, with its hash)", prev is Dictionary and prev.get("shipped") == true and prev["version"] == "1.4.0" and prev["sha256"] == S.sha(old) and S.read(u.slots.payload("previous")) == old, str(prev))
	t.check("swap: current is the new pack's meta; staged is gone; nothing left beside the pack", u.slots.meta("current") is Dictionary and u.slots.meta("current")["version"] == "1.5.0" and u.slots.meta("staged") == null and not FileAccess.file_exists(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX))
	t.check("swap: the state remembers the binary's version and that the next launch reports applied", st["binaryVersion"] == "1.4.0" and st["notice"] == "applied" and float(st["failedBoots"]) == 0.0 and st["journal"] == null, str(st))
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _mismatch(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(5000, 1)
	var fresh := S.bytes(9000, 2)
	var inst := S.install("swap-mismatch", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	var u: PKeyUpdater = sdk.update.updater
	# The server sends other bytes of the right size: the hash refuses them.
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(S.bytes(9000, 3))]}
	var r: PKeyApplyResult = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	t.check("swap: a hash mismatch is payload-mismatch and stages nothing", not r.ok and r.code == PKeyErrors.PAYLOAD_MISMATCH and u.slots.meta("staged") == null and S.read(inst["pck"]) == old, str(r))
	t.check("swap: the refused bytes are not left behind as a part to resume", not FileAccess.file_exists(u.slots.dir("staged.tmp").path_join("payload.pck.part")))
	# The record says another size: the download stops at the size, then the hash refuses.
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	r = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "stable", "", {"size": 8000}))
	t.check("swap: a size mismatch stages nothing", not r.ok and u.slots.meta("staged") == null and S.read(inst["pck"]) == old, str(r))
	# Staged correctly, then corrupted on disk: the swap re-verifies and changes nothing.
	r = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	var f := FileAccess.open(u.slots.payload("staged"), FileAccess.READ_WRITE)
	f.seek(100)
	f.store_8(0)
	f.store_8(1)
	f.close()
	var e: PKeyFakeUpdaterEnv = inst["env"]
	var swap: PKeyApplyResult = await sdk.update.restart_to_update()
	t.check("swap: a staged pack that no longer verifies is payload-mismatch, dropped, and the pack is untouched", r.ok and not swap.ok and swap.code == PKeyErrors.PAYLOAD_MISMATCH and u.slots.meta("staged") == null and S.read(inst["pck"]) == old and e.restarts == 0, str(swap))
	r = await sdk.update.restart_to_update()
	t.check("swap: restart_to_update with nothing staged changes nothing", not r.ok and e.restarts == 0)
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _locked(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(4000, 1)
	var fresh := S.bytes(6000, 2)
	var inst := S.install("swap-locked", old, "windows", "Game.exe")
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	var u: PKeyUpdater = sdk.update.updater
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	var tries := [0]
	u.rename_hook = func(_a, _b) -> int:
		tries[0] += 1
		return ERR_FILE_CANT_WRITE
	var e: PKeyFakeUpdaterEnv = inst["env"]
	var r: PKeyApplyResult = await sdk.update.restart_to_update()
	t.check("swap: a pack Windows keeps open is retried %d times" % PKeySidecarSwap.RENAME_TRIES, tries[0] == PKeySidecarSwap.RENAME_TRIES, str(tries[0]))
	t.check("swap: then the staged pack is kept, nothing changed, and the game restarts anyway (deferred)", r.ok and r.behaviour == "restart" and r.detail.get("deferred") == true and e.restarts == 1 and u.slots.meta("staged") is Dictionary and S.read(inst["pck"]) == old and u.slots.load_state()["journal"] == null and not FileAccess.file_exists(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX), str(r))
	sdk.queue_free()
	# The next launch: the file is free; the guard applies it and restarts once more.
	var next: Node = await sup.launch(inst, "1.4.0")
	var g: Dictionary = await next.update.run_guard()
	t.check("swap: the next launch's guard applies the kept pack and restarts before guard.done", g["action"] == "apply-staged" and g["restart"] == true and S.read(inst["pck"]) == fresh and e.restarts == 2, str(g))
	next.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _recovery(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(3000, 1)
	var fresh := S.bytes(5000, 2)
	var inst := S.install("swap-crash", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	var u: PKeyUpdater = sdk.update.updater
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	# A crash right after the rename: the pack has the new bytes, the journal names the swap, the
	# slots were never updated.
	var st := u.slots.load_state()
	st["journal"] = {"kind": "apply", "pck": inst["pck"], "sha256": S.sha(fresh), "size": fresh.size()}
	st["binaryVersion"] = "1.4.0"
	u.slots.save_state(st)
	S.write(inst["pck"], fresh)
	sdk.queue_free()
	var next: Node = await sup.launch(inst, "1.5.0")
	var g: Dictionary = await next.update.run_guard()
	var nu: PKeyUpdater = next.update.updater
	t.check("swap: a journalled swap whose rename happened is finished at the next launch (applied, no restart)", g["result"] == "applied" and not g["restart"] and nu.slots.meta("current") is Dictionary and nu.slots.meta("current")["version"] == "1.5.0" and nu.slots.meta("staged") == null and nu.slots.load_state()["journal"] == null, "%s %s" % [g, nu.slots.load_state()])
	next.queue_free()
	# A journal whose rename never happened is discarded, and the staged pack applies normally.
	inst = S.install("swap-crash2", old)
	sdk = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	u = sdk.update.updater
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	st = u.slots.load_state()
	st["journal"] = {"kind": "apply", "pck": inst["pck"], "sha256": S.sha(fresh), "size": fresh.size()}
	u.slots.save_state(st)
	S.write(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX, fresh.slice(0, 100))
	sdk.queue_free()
	next = await sup.launch(inst, "1.4.0")
	g = await next.update.run_guard()
	t.check("swap: a journal whose rename never happened is discarded (the half-copied file removed) and the staged pack is applied", g["action"] == "apply-staged" and g["restart"] and S.read(inst["pck"]) == fresh, str(g))
	next.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


## A copy hook that writes only the first half of the source beside the pack (`.pkey-new`) or
## everywhere (`all`) while reporting the full source's size and hash, as a write that silently
## lost bytes would.
static func _short_copy(all: bool) -> Callable:
	return func(src: String, dst: String) -> Dictionary:
		var full := S.read(src)
		var d := PKeySlots._digest_sync(src, "")
		if all or dst.ends_with(PKeySidecarSwap.NEW_SUFFIX):
			S.write(dst, full.slice(0, full.size() / 2))
			return d
		return PKeySlots._digest_sync(src, dst)


func _short_writes(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(4000, 1)
	var fresh := S.bytes(6000, 2)
	var inst := S.install("swap-short", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	var u: PKeyUpdater = sdk.update.updater
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	var e: PKeyFakeUpdaterEnv = inst["env"]
	# The swap: a short write beside the pack is read back, removed, and the live pack untouched.
	u.copy_hook = _short_copy(false)
	var r: PKeyApplyResult = await sdk.update.restart_to_update()
	t.check("swap: a short write beside the pack fails on read-back; the live pack is untouched and nothing restarts", not r.ok and r.code == PKeyErrors.SWAP_FAILED and S.read(inst["pck"]) == old and e.restarts == 0 and not FileAccess.file_exists(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX), str(r))
	t.check("swap: after a short write the staged pack is kept and no journal or previous is left", u.slots.meta("staged") is Dictionary and u.slots.load_state()["journal"] == null and u.slots.meta("previous") == null and u.slots.meta("current") == null)
	# A short copy of the running pack into `previous` stops the swap before the pack is touched.
	u.copy_hook = _short_copy(true)
	r = await sdk.update.restart_to_update()
	t.check("swap: a short copy of the running pack into previous stops the swap first", not r.ok and r.code == PKeyErrors.SWAP_FAILED and S.read(inst["pck"]) == old and u.slots.meta("previous") == null, str(r))
	# A copy that reports failure outright.
	u.copy_hook = func(_s, _d) -> Dictionary: return {"ok": false, "size": -1, "sha256": ""}
	r = await sdk.update.restart_to_update()
	t.check("swap: a failed copy changes nothing", not r.ok and S.read(inst["pck"]) == old and e.restarts == 0)
	# A full volume: refused before writing anything, and before downloading.
	u.copy_hook = Callable()
	u.space_hook = func(_d, _n) -> bool: return false
	r = await sdk.update.restart_to_update()
	t.check("swap: no free space beside the pack refuses the swap before writing", not r.ok and r.code == PKeyErrors.SWAP_FAILED and S.read(inst["pck"]) == old and not FileAccess.file_exists(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX), str(r))
	u.slots.drop("staged")
	sup.server.requests.clear()
	r = await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	t.check("swap: no free space for the download refuses it without a request", not r.ok and r.code == PKeyErrors.STORE_FAILED and r.detail.get("reason") == "no-space" and sup.server.requests.is_empty(), str(r))
	u.space_hook = Callable()
	# The rollback path: two failed boots on an applied pack, and the copy of previous comes up short.
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	r = await sdk.update.restart_to_update()
	sdk.queue_free()
	var l: Node = await sup.launch(inst, "1.5.0")
	var st: Dictionary = l.update.updater.slots.load_state()
	st["failedBoots"] = 2
	st["notice"] = ""
	l.update.updater.slots.save_state(st)
	l.update.updater.copy_hook = _short_copy(false)
	var restarts := e.restarts
	var g: Dictionary = await l.update.run_guard()
	t.check("swap: a short write on the rollback path leaves the live pack untouched and does not restart", r.ok and g["action"] == "roll-back" and not g["restart"] and S.read(inst["pck"]) == fresh and e.restarts == restarts and not FileAccess.file_exists(inst["pck"] + PKeySidecarSwap.NEW_SUFFIX) and l.update.updater.slots.meta("previous") is Dictionary, "%s %s" % [g, r])
	l.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


## P6-03: the queued events ride on devices/report's `updates` key in boundedUpdates' shape, and
## leave the queue once the Worker accepted the report.
func _telemetry(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var fresh := S.bytes(3000, 2)
	var inst := S.install("swap-telemetry", S.bytes(2000, 1))
	var token := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	var sdk: Node = await sup.launch(inst, "1.4.0", func(o): o.update_outlet = "direct", token)
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)], "/djdl/devices/report": [{"status": 200, "headers": {"Content-Type": "application/json"}, "body": "{}"}]}
	var check := S.sidecar_check("1.5.0", fresh, "beta")
	check.record_doc["tag"] = "v1.5.0"
	await sdk.update.updater.stage_sidecar(check)
	await sdk.update.restart_to_update()
	var snap: Dictionary = sdk.devices.snapshot()
	var ev: Array = snap.get("updates", [])
	var names := ev.map(func(x): return x["event"])
	t.check("telemetry: the report carries update_downloaded and update_applied", names == ["update_downloaded", "update_applied"], str(ev))
	var id_re := RegEx.create_from_string("^[A-Za-z0-9._:-]{1,64}$")
	var shape_ok := not ev.is_empty()
	for x in ev:
		var keys: Array = x.keys()
		for k in keys:
			shape_ok = shape_ok and k in ["eventId", "event", "deliverable", "release", "fromRelease", "outlet", "channel", "at", "code"]
		shape_ok = shape_ok and id_re.search(x["eventId"]) != null and x["deliverable"] == "app" and x["release"] == "v1.5.0" and x["fromRelease"] == "1.4.0" and x["outlet"] == "direct" and x["channel"] == "beta" and x["at"] is int and x["at"] > 0
	t.check("telemetry: each entry has boundedUpdates' fields only (release = the record's tag, fromRelease, outlet, the staged channel)", shape_ok, str(ev))
	var ok: bool = await sdk.devices.report()
	var sent: Array = sup.requests("/djdl/devices/report")
	var body = JSON.parse_string((sent[0]["body"] as PackedByteArray).get_string_from_utf8()) if not sent.is_empty() else null
	t.check("telemetry: devices/report sends them in `updates`", ok and body is Dictionary and body.get("updates") is Array and body["updates"].size() == 2, str(body.get("updates") if body is Dictionary else body))
	t.check("telemetry: a delivered report empties the queue (state.json kept them until then)", sdk.update.updater.events().is_empty() and not sdk.devices.snapshot().has("updates"))
	sdk.queue_free()
	var l: Node = await sup.launch(inst, "1.5.0", func(o): o.update_outlet = "direct", token)
	await l.update.run_guard()
	l.update.updater.note_outcome("ready")
	l.update.confirm_boot()
	var c: Array = l.devices.snapshot().get("updates", [])
	t.check("telemetry: update_confirmed for the new release, from the shipped one", c.size() == 1 and c[0]["event"] == "update_confirmed" and c[0]["release"] == "v1.5.0" and c[0]["fromRelease"] == "1.4.0", str(c))
	l.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])
