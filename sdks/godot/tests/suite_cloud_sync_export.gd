extends RefCounted
# @pkey-feature sync.export
# Cloud Sync export (U-51.8; WIRE-CONTRACT-V5 13.12): PolarisKey.cloud_sync.export() and cancel_export() over a
# loopback Worker that speaks the sync pull, the file routes and the chunk route.
#
#   * the archive of a signed-in person's synced data, opened back with the engine's ZIPReader: settings, a record,
#     its file (a ranged read of more than one range), a revision on request, the counts the result carries;
#   * the destination: a stale `.partial` removed, a directory or a link refused, a missing parent refused, a write
#     that fails (a directory without write access) is `sync-export-failed` / `destination` with the partial gone
#     and the old destination whole, a cancel mid-file leaves the old destination and no partial, a refused plan
#     creates nothing, a second call while one runs is `busy`;
#   * the bounds: an endless `more`, a throttle that never lifts (the waits add up to the bound, then `network`), a
#     cancel that ends a wait;
#   * the preconditions: a signed-out device is `account_required`, a sink that fails is `destination`.
# The corpus rows (every entry of every exportCases row) run in suite_sync_vectors.

const Exporter := preload("res://addons/polaris_key/services/cloud_sync/export_host.gd")
const PRODUCT := "diceroll"
const MIB := 1048576
const CLOCK_MS := 1767225600000


## One signed-in record store: the sync pull and the file routes of a Worker.
class Worker:
	extends RefCounted
	## wire id -> {version, value, revs: [{version, size, sha256, format, data}]}
	var records := {}
	var settings := {}
	var paths: Array = []
	var pulls := 0
	var more_forever := false
	## Answers every file GET with a 429 and this Retry-After until it is -1.
	var throttle_seconds := -1
	var throttled := 0
	var etag := "\"e1\""
	## The next pulls answer 429 with this Retry-After while the count is above zero.
	var throttle_pulls := 0
	## Wire ids of records the pull reports as deleted.
	var tombstones: Array = []
	var file_gets: Array = []

	func add(wire: String, version: int, value: Dictionary, data: Array) -> void:
		var revs: Array = []
		for i in data.size():
			var d: PackedByteArray = data[i]
			revs.push_front({"version": version - (data.size() - 1 - i), "size": d.size(), "sha256": PKeySyncHkdf.sha256(d).hex_encode(), "format": "whole", "data": d})
		records[wire] = {"version": version, "value": value, "revs": revs}

	func _file_of(r: Dictionary) -> Variant:
		if r["revs"].is_empty():
			return null
		var e: Dictionary = r["revs"][0]
		return {"version": e["version"], "size": e["size"], "sha256": e["sha256"], "format": e["format"]}

	func _json(status: int, body: Variant) -> Dictionary:
		return {"status": status, "headers": {"content-type": "application/json"}, "body": JSON.stringify(body)}

	func handle(req: Dictionary) -> Dictionary:
		var path: String = req["path"]
		paths.append("%s %s" % [req["method"], path])
		if path == "/diceroll/config/schema":
			return _json(200, {"schemaVersion": 1, "entries": [], "cloudSync": {"collections": [{"name": "saves", "template": "saves"}]}})
		if path.begins_with("/diceroll/sync?"):
			pulls += 1
			if throttle_pulls > 0:
				throttle_pulls -= 1
				return {"status": 429, "headers": {"retry-after": "3", "content-type": "application/json"}, "body": "{}"}
			var changes: Array = []
			for k in settings:
				changes.append({"setting": k, "scope": "user", "value": settings[k], "version": 1, "editedHlc": "000000000001:0000", "updatedBy": "c_AAAAAAAAAAAAAAAAAAAAAA"})
			for w: String in records:
				var r: Dictionary = records[w]
				var row := {"record": ["saves", w], "version": r["version"], "value": r["value"]}
				var f: Variant = _file_of(r)
				if f != null:
					row["file"] = f
				changes.append(row)
			var tombs: Array = tombstones.map(func(w: String) -> Dictionary: return {"record": ["saves", w], "version": 9})
			return _json(200, {"cursor": pulls + 1, "changes": changes, "tombstones": tombs, "serverNow": 1760000000000, "more": more_forever})
		if path == "/diceroll/sync/ops":
			return _json(200, {"results": [], "cursor": pulls + 1, "serverNow": 1760000000000})
		var base := "/diceroll/sync/files/saves/"
		if path.begins_with(base):
			return _files(req, path.substr(base.length()))
		return {"status": 404}

	func _files(req: Dictionary, rest: String) -> Dictionary:
		var q := rest.find("?")
		var version := -1
		if q >= 0:
			version = int(rest.substr(q + 1).trim_prefix("version="))
			rest = rest.substr(0, q)
		var parts := rest.split("/")
		var r: Variant = records.get(parts[0])
		if r == null:
			return {"status": 404}
		if parts.size() == 2 and parts[1] == "revisions":
			var out: Array = []
			for e: Dictionary in r["revs"]:
				out.append({"version": e["version"], "size": e["size"], "sha256": e["sha256"], "format": e["format"]})
			return _json(200, {"revisions": out})
		file_gets.append(req["headers"].get("range", ""))
		if throttle_seconds >= 0:
			throttled += 1
			return {"status": 429, "headers": {"retry-after": str(throttle_seconds), "content-type": "application/json"}, "body": JSON.stringify({"error": {"code": "rate_limited"}})}
		var entry: Dictionary = r["revs"][0]
		if version >= 0:
			for e: Dictionary in r["revs"]:
				if e["version"] == version:
					entry = e
		var data: PackedByteArray = entry["data"]
		var rng: String = req["headers"].get("range", "")
		if rng.begins_with("bytes="):
			var span := rng.substr(6).split("-")
			var from := int(span[0])
			var to := mini(data.size(), int(span[1]) + 1)
			return {"status": 206, "headers": {"content-range": "bytes %d-%d/%d" % [from, to - 1, data.size()], "etag": etag}, "body": data.slice(from, to)}
		return {"status": 200, "headers": {"etag": etag}, "body": data}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _archive(t)
	await _destination(t)
	await _write_failure(t)
	await _cancel_and_busy(t)
	await _bounds(t)
	await _preconditions(t)
	await _pulls(t)
	await _zip(t)
	return true


# ── rig ──────────────────────────────────────────────────────────────────────────────────────

func _noise(label: String, n: int) -> PackedByteArray:
	return PKeyExportFixtures.stream(label, n)


## An SDK over a loopback Worker, signed in as ps_a, and an exporter with an injected clock and sleep.
func _rig(worker: Worker, sign_in := true) -> Dictionary:
	var server := PKeyTestFixtures.new_server(worker.handle)
	var dir := PKeyTestFixtures.scratch_dir("export")
	var o := PKeyOptions.new()
	o.product_slug = PRODUCT
	o.version = "1.0.0"
	o.base_url = server.base_url()
	o.store = PKeyMemoryStore.new("", "pkeyt_cached")
	o.expected_services = PackedStringArray(["license", "config", "sync"])
	o.build_stamp_path = ""
	o.persist_settings = false
	o.store_root = dir
	o.cloud_sync_encryption = "server"
	o.cloud_sync_saves_delta = false
	var sdk: Node = PKeyTestFixtures.new_sdk()
	sdk.configure(o)
	await sdk.start()
	if sign_in:
		sdk.core.cache.set_subject("ps_a")
		sdk.cloud_sync.on_identity("signedIn", "ps_a", "")
		await sdk.cloud_sync._drain()
		await sdk.cloud_sync.host.idle()
	var sleeps: Array = []
	var api: PKeyCloudSync = sdk.cloud_sync
	var exporter := Exporter.new({
		"host": func() -> Node: return api.host,
		"attach": Callable(api, "attach"),
		"flush": Callable(api, "flush"),
		"subject": func() -> String: return "ps_a" if sign_in else "",
		"local_only": false,
		"now": func() -> int: return CLOCK_MS,
		"sleep": func(seconds: float) -> void: sleeps.append(seconds),
	})
	return {"sdk": sdk, "server": server, "dir": dir, "exporter": exporter, "sleeps": sleeps, "worker": worker}


static func _is_destination_failure(r: PKeyResult) -> bool:
	return not r.ok and r.code == &"sync-export-failed" and r.detail["reason"] == "destination"


static func _tiny_row() -> Dictionary:
	return {"product": PRODUCT, "exportedAt": 1, "unsynced": 0, "includeRevisions": false, "changes": [{"setting": "a", "scope": "user", "value": 1, "version": 1}], "files": []}


func _free(rig: Dictionary) -> void:
	rig["sdk"].cloud_sync.close()
	rig["sdk"].queue_free()
	rig["server"].stop()
	PKeyTestFixtures.remove_tree(rig["dir"])


func _entries(path: String) -> Dictionary:
	var out := {}
	var z := ZIPReader.new()
	if z.open(path) != OK:
		return out
	for name in z.get_files():
		out[name] = z.read_file(name)
	z.close()
	return out


func _text(entries: Dictionary, name: String) -> String:
	return (entries.get(name, PackedByteArray()) as PackedByteArray).get_string_from_utf8()


func _write_file(path: String, text: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)
	f.close()


func _read_file(path: String) -> String:
	return FileAccess.get_file_as_string(path)


func _scratch_worker() -> Worker:
	var w := Worker.new()
	w.settings = {"audio.volume": 7}
	w.add("slot1", 3, {"chapter": "two"}, [_noise("export-host-old", 40), _noise("export-host-new", 9 * MIB + 5)])
	return w


# ── the archive ──────────────────────────────────────────────────────────────────────────────

func _archive(t: PKeyTestContext) -> void:
	var worker := _scratch_worker()
	var rig := await _rig(worker)
	var dest: String = rig["dir"].path_join("out.zip")
	var progress: Array = []
	var res: PKeyResult = await rig["exporter"].run(dest, {"on_progress": func(s: Dictionary) -> void: progress.append(s)})
	t.check("archive: the export is ok", res.ok, str(res.code) + str(res.detail))
	if res.ok:
		var d: Dictionary = res.detail
		var counts: bool = d["settings"] == 1 and d["records"] == 1 and d["files"] == 1 and d["skipped"] == [] and d["unsynced"] == 0
		t.check("archive: the result carries the path and the counts", d["path"] == dest and counts, str(d))
		var e := _entries(dest)
		t.check("archive: ZIPReader opens it, the names in the portal's layout", e.keys() == [
			"README.txt", "stores/sync.cloudSync/settings.json", "stores/sync.cloudSync/records/0.ndjson", "stores/sync.cloudSync/files/0.bin",
			"stores/sync.cloudSync/files.json", "stores/sync.cloudSync/index.json", "data.json"], str(e.keys()))
		t.check("archive: the settings", _text(e, "stores/sync.cloudSync/settings.json") == "{\"audio.volume\":7}\n")
		var plain := _noise("export-host-new", 9 * MIB + 5)
		t.check("archive: the file is the plaintext, byte for byte", e.get("stores/sync.cloudSync/files/0.bin", PackedByteArray()) == plain)
		var line := _text(e, "stores/sync.cloudSync/records/0.ndjson")
		var names_file: bool = line.contains("\"size\":%d" % plain.size()) and line.contains("\"sha256\":\"%s\"" % PKeySyncHkdf.sha256(plain).hex_encode())
		t.check("archive: the record line names its file by size and hash", names_file and line.contains("\"id\":\"slot1\"") and line.contains("\"value\":{\"chapter\":\"two\"}"), line)
		var meta := _text(e, "data.json")
		var says: bool = meta.contains("\"exportedAt\":%d" % CLOCK_MS) and meta.contains("\"source\":\"device\"") and meta.contains("\"encryption\":\"server\"")
		t.check("archive: data.json says what it is, with the injected clock and no subject", says and not meta.contains("ps_a"), meta)
		t.check("archive: the file was read in more than one range", worker.file_gets.size() >= 2 and worker.file_gets[0] == "bytes=0-%d" % (8 * MIB - 1), str(worker.file_gets))
		t.check("archive: no partial is left", not FileAccess.file_exists(dest + ".partial"))
		var counted: bool = not progress.is_empty() and progress.back()["done"] == plain.size() and progress.back()["total"] == plain.size()
		t.check("archive: progress counted the file's bytes", counted, str(progress.back()) if not progress.is_empty() else "none")
	# Revisions on request: the live file first, the kept revision after it.
	var dest2: String = rig["dir"].path_join("rev.zip")
	var with_revs: PKeyResult = await rig["exporter"].run(dest2, {"include_revisions": true})
	t.check("revisions: ok", with_revs.ok, str(with_revs.code))
	if with_revs.ok:
		var e2 := _entries(dest2)
		var older: PackedByteArray = e2["stores/sync.cloudSync/files/1.bin"]
		t.check("revisions: two files, the live one first", with_revs.detail["files"] == 2 and older == _noise("export-host-old", 40), str(with_revs.detail))
		t.check("revisions: files.json marks the revision not live", _text(e2, "stores/sync.cloudSync/files.json").contains("\"live\":false"))
	_free(rig)


# ── the destination ──────────────────────────────────────────────────────────────────────────

func _destination(t: PKeyTestContext) -> void:
	var worker := Worker.new()
	worker.add("slot1", 1, {"a": 1}, [_noise("export-small", 100)])
	var rig := await _rig(worker)
	var dir: String = rig["dir"]
	var exporter: Exporter = rig["exporter"]
	# A stale partial from a crash is removed, and the old destination is replaced.
	var dest := dir.path_join("a.zip")
	_write_file(dest, "old")
	_write_file(dest + ".partial", "crashed")
	var ok: PKeyResult = await exporter.run(dest)
	t.check("destination: a stale partial does not stop the export", ok.ok, str(ok.code))
	t.check("destination: the destination was replaced and the partial is gone", _entries(dest).has("data.json") and not FileAccess.file_exists(dest + ".partial"))
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		t.check("destination: the file is owner-only", FileAccess.get_unix_permissions(dest) & 63 == 0, "%o" % FileAccess.get_unix_permissions(dest))
	# A directory as the destination is refused, nothing is requested for it, and it is untouched.
	var as_dir := dir.path_join("dir.zip")
	DirAccess.make_dir_absolute(as_dir)
	var before: int = worker.pulls
	var refused: PKeyResult = await exporter.run(as_dir)
	t.check("destination: a directory is refused as sync-export-failed / destination", _is_destination_failure(refused), str(refused.code))
	t.check("destination: a refused destination sends no pull and leaves the directory", worker.pulls == before and DirAccess.dir_exists_absolute(as_dir))
	# A directory where the partial goes is refused too.
	var part_dir := dir.path_join("p.zip")
	DirAccess.make_dir_absolute(part_dir + ".partial")
	var refused2: PKeyResult = await exporter.run(part_dir)
	t.check("destination: a directory as the partial is refused", _is_destination_failure(refused2), str(refused2.code))
	# A missing parent, an empty path, a res:// path and a relative one.
	for bad in [dir.path_join("nope/out.zip"), "", "res://out.zip", "out.zip", dir.path_join("x/../..")]:
		var r: PKeyResult = await exporter.run(bad)
		t.check("destination: '%s' is refused" % bad.get_file(), not r.ok and r.code == &"sync-export-failed" and r.detail["reason"] == "destination", str(r.code))
	# A link at the partial is refused and its target is not touched (where the OS can make one).
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		var target := dir.path_join("target.txt")
		_write_file(target, "keep")
		var link_dest := dir.path_join("l.zip")
		OS.execute("ln", ["-s", ProjectSettings.globalize_path(target), ProjectSettings.globalize_path(link_dest + ".partial")])
		var lr: PKeyResult = await exporter.run(link_dest)
		t.check("destination: a link as the partial is refused", not lr.ok and lr.detail["reason"] == "destination", str(lr.code))
		t.check("destination: the link's target is untouched", _read_file(target) == "keep")
		var link2 := dir.path_join("m.zip")
		OS.execute("ln", ["-s", ProjectSettings.globalize_path(target), ProjectSettings.globalize_path(link2)])
		var lr2: PKeyResult = await exporter.run(link2)
		t.check("destination: a link as the destination is refused and its target is untouched", not lr2.ok and lr2.detail["reason"] == "destination" and _read_file(target) == "keep", str(lr2.code))
	_free(rig)


## A directory without write access: the partial cannot be made, the export is `destination`, nothing is left
## and the old destination is whole. (As root the directory is writable anyway: the check is skipped.)
func _write_failure(t: PKeyTestContext) -> void:
	if not (OS.has_feature("macos") or OS.has_feature("linuxbsd")):
		t.info("write failure: needs POSIX modes; skipped here")
		return
	var worker := Worker.new()
	worker.add("slot1", 1, {"a": 1}, [_noise("export-small", 100)])
	var rig := await _rig(worker)
	var sub: String = rig["dir"].path_join("ro")
	DirAccess.make_dir_absolute(sub)
	var dest := sub.path_join("out.zip")
	_write_file(dest, "old")
	FileAccess.set_unix_permissions(sub, 320)
	var probe := FileAccess.open(sub.path_join("probe"), FileAccess.WRITE)
	if probe != null:
		probe.close()
		DirAccess.remove_absolute(sub.path_join("probe"))
		t.info("write failure: the directory is writable anyway (root); skipped")
	else:
		var r: PKeyResult = await rig["exporter"].run(dest)
		t.check("write failure: sync-export-failed / destination", not r.ok and r.code == &"sync-export-failed" and r.detail["reason"] == "destination", str(r.code))
		t.check("write failure: the old destination is whole and no partial is left", _read_file(dest) == "old" and not FileAccess.file_exists(dest + ".partial"))
	FileAccess.set_unix_permissions(sub, 448)
	# The core's own sink failure (a full disk): destination, with nothing more written.
	var row := _tiny_row()
	var works: Dictionary = await PKeyExportFixtures.run_row(row)
	t.check("write failure: a sink that works writes an archive", works["result"]["ok"] and works["sink"].writes > 0)
	var source := PKeyExportFixtures.FakeSource.new(row, PKeyExportFixtures.Transport.new())
	var sink := PKeyExportFixtures.CollectSink.new()
	sink.fail_after = 2
	var failed: Dictionary = await PKeySyncExport.run(PKeyExportFixtures.input_of(row, source), sink)
	var is_destination: bool = not failed["ok"] and failed["code"] == "sync-export-failed" and failed["reason"] == "destination"
	t.check("write failure: a sink that fails is sync-export-failed / destination", is_destination and sink.writes == 2, str(failed))
	_free(rig)


## Starts an export and does not wait: its answer lands in `out`.
func _start(exporter: Exporter, dest: String, out: Array) -> void:
	out.append(await exporter.run(dest))


# ── cancel and busy ──────────────────────────────────────────────────────────────────────────

func _cancel_and_busy(t: PKeyTestContext) -> void:
	var worker := Worker.new()
	worker.add("slot1", 1, {"a": 1}, [_noise("export-cancel", 3 * MIB)])
	var rig := await _rig(worker)
	var exporter: Exporter = rig["exporter"]
	var api: PKeyCloudSync = rig["sdk"].cloud_sync
	var dest: String = rig["dir"].path_join("c.zip")
	_write_file(dest, "old")
	# Cancel from the first progress report, in the middle of the file.
	var res: PKeyResult = await exporter.run(dest, {"on_progress": func(_s: Dictionary) -> void: exporter.cancel()})
	t.check("cancel: the answer is cancelled", not res.ok and res.code == &"cancelled", str(res.code))
	t.check("cancel: the old destination is whole and no partial is left", _read_file(dest) == "old" and not FileAccess.file_exists(dest + ".partial"))
	t.check("cancel: the export is over (not busy) and can run again", not exporter.running())
	var again: PKeyResult = await exporter.run(dest)
	t.check("cancel: a new export after a cancel works", again.ok, str(again.code))
	# Busy: a second call while one runs.
	var dest2: String = rig["dir"].path_join("b.zip")
	var first: Array = []
	_start(exporter, dest2, first)
	var second: PKeyResult = await exporter.run(rig["dir"].path_join("b2.zip"))
	t.check("busy: a second export while one runs is sync-export-failed / busy", not second.ok and second.code == &"sync-export-failed" and second.detail["reason"] == "busy", str(second.code))
	while first.is_empty():
		await (Engine.get_main_loop() as SceneTree).process_frame
	var done: PKeyResult = first[0]
	t.check("busy: the first export finishes whole", done.ok and _entries(dest2).has("data.json"), str(done.code))
	# The API's own entry points: cancel_export with nothing running is a no-op, and a refused plan creates nothing.
	api.cancel_export()
	t.check("cancel_export: nothing running is a no-op", true)
	var big := Worker.new()
	big.add("slot1", 1, {"a": 1}, [_noise("export-small", 10)])
	big.records["slot1"]["revs"][0]["size"] = 5000000000
	var rig2 := await _rig(big)
	var dest3: String = rig2["dir"].path_join("big.zip")
	var refused: PKeyResult = await rig2["exporter"].run(dest3)
	t.check("too large: a file over zip32 is sync-export-too-large", not refused.ok and refused.code == &"sync-export-too-large", str(refused.code))
	t.check("too large: nothing is created", not FileAccess.file_exists(dest3) and not FileAccess.file_exists(dest3 + ".partial"))
	_free(rig2)
	_free(rig)


# ── bounds ───────────────────────────────────────────────────────────────────────────────────

func _bounds(t: PKeyTestContext) -> void:
	# An endless `more`: sync-export-failed / network, nothing written.
	var worker := Worker.new()
	worker.add("slot1", 1, {"a": 1}, [_noise("export-small", 10)])
	var rig := await _rig(worker)
	var dest: String = rig["dir"].path_join("n.zip")
	worker.more_forever = true
	var res: PKeyResult = await rig["exporter"].run(dest)
	worker.more_forever = false
	t.check("bounds: an endless more is network", not res.ok and res.code == &"sync-export-failed" and res.detail["reason"] == "network", str(res.code))
	t.check("bounds: nothing is created", not FileAccess.file_exists(dest) and not FileAccess.file_exists(dest + ".partial"))
	# A throttle that never lifts: the waits add up to the bound (900 s each, 5,400 s in all), then network.
	worker.throttle_seconds = 99999
	var throttled: PKeyResult = await rig["exporter"].run(dest)
	var sleeps: Array = rig["sleeps"]
	var total := 0.0
	for s: float in sleeps:
		total += s
	t.check("bounds: a throttle that never lifts ends as network", not throttled.ok and throttled.code == &"sync-export-failed" and throttled.detail["reason"] == "network", str(throttled.code))
	var cut: bool = sleeps.all(func(s: float) -> bool: return s <= 900.0) and total <= 5400.0 and total >= 4500.0
	t.check("bounds: every wait was cut to the per-wait bound and the sum stayed within the total", cut, "%s %s" % [total, sleeps.size()])
	t.check("bounds: no partial is left", not FileAccess.file_exists(dest + ".partial"))
	# A cancel ends a wait.
	var rig2 := await _rig(worker)
	var exporter2: Exporter = rig2["exporter"]
	exporter2._deps["sleep"] = func(_s: float) -> void: exporter2.cancel()
	var cancelled: PKeyResult = await exporter2.run(rig2["dir"].path_join("w.zip"))
	t.check("bounds: a cancel during a wait is cancelled", not cancelled.ok and cancelled.code == &"cancelled", str(cancelled.code))
	_free(rig2)
	_free(rig)


# ── preconditions ────────────────────────────────────────────────────────────────────────────

func _preconditions(t: PKeyTestContext) -> void:
	var worker := Worker.new()
	var rig := await _rig(worker, false)
	var res: PKeyResult = await rig["exporter"].run(rig["dir"].path_join("s.zip"))
	t.check("signed out: account_required", not res.ok and res.code == &"account_required", str(res.code))
	t.check("signed out: nothing is created and no request is sent for the pull", not FileAccess.file_exists(rig["dir"].path_join("s.zip.partial")) and worker.pulls == 0, str(worker.paths))
	var api_res: PKeyResult = await rig["sdk"].cloud_sync.export(rig["dir"].path_join("t.zip"))
	t.check("signed out: the API says the same", not api_res.ok and api_res.code == &"account_required", str(api_res.code))
	_free(rig)


# ── the pulls ────────────────────────────────────────────────────────────────────────────────

## The pull loop on its own: a 429 waits its Retry-After (through the budget) and tries again, and a tombstone
## removes the row it names.
func _pulls(t: PKeyTestContext) -> void:
	var worker := Worker.new()
	worker.settings = {"a": 1}
	worker.add("keep", 1, {"n": 1}, [])
	worker.add("gone", 2, {"n": 2}, [])
	worker.tombstones = ["gone"]
	worker.throttle_pulls = 2
	var rig := await _rig(worker, false)
	var host: Node = rig["sdk"].cloud_sync.host
	await rig["sdk"].cloud_sync.attach()
	var sleeps: Array = []
	var cancel := Exporter.Transfer.Cancel.new()
	var budget := Exporter._Budget.new(cancel, func(s: float) -> void: sleeps.append(s), func(_w: bool) -> void: pass)
	var tr := Exporter.FilesTransport.make_transport(host, false)
	var puller := Exporter._Puller.new(tr, func() -> Dictionary: return host.request_context(), cancel, budget)
	var got: Dictionary = await puller.all("c_AAAAAAAAAAAAAAAAAAAAAA")
	t.check("pulls: two throttled answers are waited out, then the rows arrive", got["ok"] and sleeps == [3.0, 3.0], str(got.get("code")) + str(sleeps))
	var ids: Array = []
	if got["ok"]:
		for c: Dictionary in got["changes"]:
			ids.append(c["setting"] if c.has("setting") else c["record"][1])
	t.check("pulls: a tombstone removes its row", ids == ["a", "keep"], str(ids))
	_free(rig)


# ── the zip writer and the core's cancel ─────────────────────────────────────────────────────

func _zip(t: PKeyTestContext) -> void:
	var check := PKeyZipStore.crc32_final(PKeyZipStore.crc32_update(0xFFFFFFFF, "123456789".to_utf8_buffer()))
	t.check("zip: CRC-32 of 123456789 is the standard check value", check == 0xCBF43926, "%x" % check)
	var whole := PKeyZipStore.crc32_update(0xFFFFFFFF, PackedByteArray([1, 2, 3, 4, 5]))
	var parts := PKeyZipStore.crc32_update(PKeyZipStore.crc32_update(0xFFFFFFFF, PackedByteArray([1, 2])), PackedByteArray([3, 4, 5]))
	t.check("zip: CRC-32 chains across pieces", whole == parts)
	# The central directory lists the entries in the order asked, not the order written.
	var sink := PKeyExportFixtures.CollectSink.new()
	var z := PKeyZipStore.new(sink)
	await z.add_bytes("b.txt", "second".to_utf8_buffer())
	await z.add_bytes("a.txt", PackedByteArray())
	z.begin("c.txt")
	await z.write("he".to_utf8_buffer())
	await z.write("llo".to_utf8_buffer())
	z.end()
	var total := z.finish(PackedStringArray(["a.txt", "c.txt", "b.txt"]))
	var archive := sink.bytes()
	t.check("zip: the writer answers the archive's size", total == archive.size() and z.error.is_empty())
	var entries: Variant = PKeyExportFixtures.read_zip(archive, "order")
	var listed: Array = []
	if entries is Array:
		for e: Dictionary in entries:
			listed.append(e["name"])
	t.check("zip: ZIPReader lists the entries in the order asked", listed == ["a.txt", "c.txt", "b.txt"], str(listed))
	if entries is Array and listed.size() == 3:
		var whole_data: bool = entries[1]["data"].get_string_from_utf8() == "hello" and entries[0]["data"].is_empty() and entries[2]["data"].get_string_from_utf8() == "second"
		t.check("zip: the data and the empty entry are whole", whole_data)
	# An order that does not name every entry once is refused.
	var bad := PKeyZipStore.new(PKeyExportFixtures.CollectSink.new())
	await bad.add_bytes("a", PackedByteArray())
	t.check("zip: an order that misses an entry is refused", bad.finish(PackedStringArray(["a", "a"])) < 0 and not bad.error.is_empty())
	# zip32: a write that would pass the limit is refused before it reaches the sink.
	var small := PKeyExportFixtures.CollectSink.new()
	var tight := PKeyZipStore.new(small, 300)
	tight.begin("x")
	var wrote: bool = await tight.write(PackedByteArray([0]))
	var writes_before := small.writes
	var over: bool = await tight.write(PKeyExportFixtures.stream("zip32", 400))
	var refused: bool = wrote and not over and tight.error["code"] == "sync-export-too-large"
	t.check("zip: a write past zip32 is sync-export-too-large and writes nothing", refused and small.writes == writes_before, str(tight.error))
	# A cancel before the first byte: nothing is written.
	var row := _tiny_row()
	var source := PKeyExportFixtures.FakeSource.new(row, PKeyExportFixtures.Transport.new())
	var cancel := PKeyCloudSyncExporter.Transfer.Cancel.new()
	cancel.cancelled = true
	var out := PKeyExportFixtures.CollectSink.new()
	var res: Dictionary = await PKeySyncExport.run(PKeyExportFixtures.input_of(row, source, {"cancel": cancel}), out)
	t.check("core: a cancel before the start writes nothing and answers cancelled", not res["ok"] and res["code"] == "cancelled" and out.writes == 0, str(res))
