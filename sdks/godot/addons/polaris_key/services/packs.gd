class_name PKeyPacks
extends RefCounted
## `PolarisKey.update.packs` — the Godot pack facet (plans/P4-01.md §2.6–§2.10; CONTENT §10, §13;
## README §5.7; P4-08). It is the GDScript port of client-core's PackEngine (PKeyPackEngine) with
## the Godot ports:
##
##   transport  PKeyPackCdnTransport (`pkey-cdn`, `web`): the pinned record from discovery's
##              `release.endpoints.record`, objects from `distribution.endpoints.blobs` with
##              Range/If-Range, gzip off, redirects followed by hand, the bearer only to the
##              control plane's origin; PKeyPackEmbeddedTransport: the baselines in
##              `res://pkey_packs/` (each with its marker), verified once per process and then
##              installed state and delta bases
##   storage    PKeyPackStorage under `user://pkey` (staging, `store/<sha256>.pck`,
##              `trees/<sha256>/`, `content/state.json`)
##   zstd       PackedByteArray.decompress for plain frames; the engine's own GDDL delta decoder
##              for `--patch-from` frames, advertised (`zstd-patch-from`) only on the pinned engine
##              versions whose probe passes; never `chunk` in v1
##
## The running build's pins come from its content stamp, `res://pkey_packs/pkey-content.json`
## (P4-03 writes it; a build without one has no packs). `godot.pck` packs activate at a boot: they
## are mounted by `mount()` (PKeyBoot's MOUNT stage) after the first frame is drawn, in
## `mountOrder`, one per frame, after the header and directory checks, with `replace_files=true`,
## from their content-addressed paths, never twice in a process. A restart pack committed before
## its id was mounted in this process (the boot's FETCH) mounts at this boot; later ones at the
## next. `files.tree` packs are hot: `path(id)` names the running tree.
##
## Signals: `pack_progress(id, bytes, total)` while a pack downloads, `set_changed(activation)`
## when a commit or rollback changes the active set (`hot`: now; `restart`: at the next boot or
## this boot's mount), `pack_ready(id)` when a pack is usable in this process (a hot commit, or a
## mount), `pack_failed(id, err)` with the failure's code.
##
## Every call that can wait is a coroutine returning a PKeyResult (`estimate` and `mount` return
## Dictionaries). Usable before configure(): every call then answers `not-configured`.

signal pack_progress(id: String, bytes: int, total: int)
signal pack_ready(id: String)
signal pack_failed(id: String, err: String)
signal set_changed(activation: String)

const DEFAULT_STAMP_PATH := "res://pkey_packs/pkey-content.json"
## The total mounted pack bytes on web until device numbers exist (S-05 §4.3): 150 MB on mobile
## browsers, 300 MB on desktop ones.
const WEB_CAP_MOBILE := 150 * 1000 * 1000
const WEB_CAP_DESKTOP := 300 * 1000 * 1000

## The content stamp (`pkey-content/1`) among the app's own read-only resources.
var stamp_path := DEFAULT_STAMP_PATH
## Where embedded baselines live (`res://pkey_packs/`).
var embedded_dir := PKeyPackTransport.EMBEDDED_DIR
## Where staging, the store and the state live (`user://pkey`; on web a MEMFS path such as
## `/pkey` keeps large packs out of the IndexedDB mirror, A6 §2.6).
var root := "user://pkey"
## Variant preferences per axis, in preference order. Empty: detected (texture families from
## OS.has_feature, the locale from TranslationServer).
var axes := {}
## The most memory one delta frame may take (`memBytes`).
var mem_budget := 256 * 1024 * 1024
## The most one buffered `full` decode may hold (-1: no bound; decompress cannot stream).
var one_shot_budget := -1
## One wall-clock deadline per object request, seconds (a timeout resumes at the next ensure).
var object_timeout := 600.0
## The web mount cap in bytes (0: the default for this browser class, -1: none).
var web_cap := 0
## Replace the transport (tests, a platform transport).
var transport: PKeyPackTransport = null
## Extra handlers registered before start.
var _pending_handlers: Array = []

## The engine, once started (null before).
var engine: PKeyPackEngine = null
## The embedded baselines start() refused, by marker step.
var refused_embedded: Array = []
## Pack ids mounted in this process, and their install.
var mounted := {}
## The content stamp's `content` ({contentApi, pins, expects}), or null.
var content: Variant = null

var _core_ref: WeakRef = null
var _starting := false
signal _started


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## Whether the build ships a content stamp (and so may have packs).
func configured() -> bool:
	return FileAccess.file_exists(stamp_path) or ResourceLoader.exists(stamp_path)


## The variant preferences this host sends to selectVariant: the engine (`godot-<maj>.<min>`) and
## per-axis lists (the game's, else the texture families this GPU decodes and the locale).
func prefs() -> Dictionary:
	var v := Engine.get_version_info()
	var a := axes.duplicate(true)
	if not a.has("texture"):
		var tex: Array = []
		for f in ["astc", "bptc", "s3tc", "etc2", "etc"]:
			if OS.has_feature(f):
				tex.append(f)
		a["texture"] = tex
	if not a.has("locale"):
		var loc := TranslationServer.get_locale()
		var list: Array = [loc]
		var lang := loc.get_slice("_", 0)
		if lang != loc:
			list.append(lang)
		if not list.has("en"):
			list.append("en")
		a["locale"] = list
	return {"engine": "godot-%d.%d" % [v["major"], v["minor"]], "axes": a}


## Read the content stamp: {ok, content} or {ok: false, error: content-stamp-invalid}; null
## content when there is no stamp at all.
func read_stamp() -> Dictionary:
	if not FileAccess.file_exists(stamp_path):
		return {"ok": true, "content": null}
	var r := PKeyPackStorage.read_bytes(stamp_path)
	if not r["ok"] or r.has("missing"):
		return {"ok": false, "error": PKeyConstants.ErrorCode.CONTENT_STAMP_INVALID}
	return PKeyPackClaims.parse_content_stamp(r["bytes"])


## Add a handler for a pack type (CONTENT §4.1).
func register_handler(handler: Object) -> bool:
	if engine != null:
		return engine.register_handler(handler)
	if not PKeyPackHandler.valid(handler):
		return false
	_pending_handlers.append(handler)
	return true


## Start packs: read the stamp, build the engine, register the embedded baselines and load the
## state (every entry re-verified). Runs once; later calls join it. A coroutine.
func start() -> PKeyResult:
	if engine != null and engine.doc != null:
		return PKeyResult.success()
	if _starting:
		await _started
		return PKeyResult.success() if engine != null and engine.doc != null else PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Packs did not start.")
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	_starting = true
	var s := read_stamp()
	if not s["ok"]:
		_starting = false
		_started.emit()
		return PKeyResult.failure(StringName(s["error"]), "The content stamp is not a valid pkey-content/1 document.")
	content = s["content"]
	var e := PKeyPackEngine.new(PKeyPackStorage.new(root))
	e.product = core.product
	e.release_keys = core.options.pinned_release_keys
	e.product_trust = func() -> Dictionary: return core.trust.effective()
	e.stamp = content
	e.prefs = prefs()
	e.patch_methods = [PKeyConstants.PatchMethod.ZSTD_PATCH_FROM] if e.zstd.patch_from_available() else []
	e.mem_budget = mem_budget
	e.one_shot_budget = one_shot_budget
	var cdn := PKeyPackCdnTransport.new(core)
	cdn.object_timeout = object_timeout
	e.transport = transport if transport != null else cdn
	e.transports = [e.transport.id()] if e.transport.id() != "" else ["pkey-cdn"]
	e.entitlements = func() -> Variant: return _granted(core)
	for h in _pending_handlers:
		e.register_handler(h)
	e.progress.connect(_on_progress)
	var emb := PKeyPackEmbeddedTransport.new(embedded_dir)
	var baselines: Array = await PKeyPackJob.run(emb.embedded, "PolarisKey embedded packs")
	var loaded: Dictionary = await e.load_state(baselines)
	refused_embedded = loaded["refused"]
	engine = e
	_starting = false
	_started.emit()
	return PKeyResult.success()


## The licence's granted boolean flags, or null when the product runs no License service.
static func _granted(core: PKeyCore) -> Variant:
	if not core.enabled("license"):
		return null
	var out := {}
	var doc = core.cache.license["doc"] if core.cache != null and core.cache.license != null else null
	var ents = doc.get("entitlements") if doc is Dictionary else null
	if ents is Dictionary:
		for k in ents:
			if ents[k] is Dictionary and PKeyClaims.is_true(ents[k].get("value")):
				out[k] = true
	return out


func _on_progress(e: Dictionary) -> void:
	if e.get("phase") == "download" or e.get("phase") == "apply":
		pack_progress.emit(String(e["packId"]), int(e["done"]), int(e["total"]))


func _ready_engine() -> PKeyResult:
	var r := await start()
	if not r.ok:
		return r
	return PKeyResult.success()


## Install the pinned release of each pack (CONTENT §10): already-current packs resolve at once;
## others are fetched, verified, checked, committed and activated. A coroutine: ok with detail =
## the installs, or the first failure (also `pack_failed(id, code)`).
func ensure(pack_ids: Array) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off = core.require_service("release", PKeyConstants.Feature.PACKS_STATE)
	if off != null:
		return off
	var ready := await _ready_engine()
	if not ready.ok:
		return ready
	var before := engine.state()
	var r := await engine.ensure(pack_ids)
	_announce(before)
	if not r.ok:
		var id: String = r.detail.get("packId", "") if r.detail is Dictionary else ""
		pack_failed.emit(id, String(r.code))
		_report_failure(id, String(r.code))
	return r


## P6-03 telemetry: a `pack_failed` update event on the device report's `updates` (the updater's
## queue, while the updater is active), with the pack id as the deliverable, the pinned version as
## the release, the code and the running set's packSetId. A transient `network-error` is not one
## (the next ensure resumes).
func _report_failure(pack_id: String, code: String) -> void:
	var core := _core()
	if core == null or pack_id == "" or code == String(PKeyErrors.NETWORK):
		return
	var u = core.update_events
	if not (u is PKeyUpdater) or not u.active() or u.slots == null:
		return
	var version := ""
	if content is Dictionary:
		for p in content["pins"]:
			if p["pack"] == pack_id:
				version = String(p["release"]["version"])
	if version == "":
		return
	var e: Dictionary = u.event(PKeyConstants.UpdateEvent.PACK_FAILED, {"version": version}, null, code)
	e["deliverable"] = pack_id
	e.erase("fromRelease")
	var set_id = pack_set_id()
	if set_id is String:
		e["packSetId"] = set_id
	var st: Dictionary = u.slots.load_state()
	PKeySlots.add_event(st, e)
	u.slots.save_state(st)


## Emit set_changed and pack_ready for what changed since `before` (an engine snapshot).
func _announce(before: Dictionary) -> void:
	var after := engine.state()
	var changed := ""
	for id in after["active"]:
		var was = before.get("active", {}).get(id)
		var now_i: Dictionary = after["active"][id]
		if not (was is Dictionary) or was["recordSha256"] != now_i["recordSha256"]:
			if now_i["activation"] == "hot":
				changed = "hot"
			elif changed == "":
				changed = "restart"
	if changed != "":
		set_changed.emit(changed)
	for id in after["running"]:
		var was = before.get("running", {}).get(id)
		var now_i: Dictionary = after["running"][id]
		if now_i["activation"] == "hot" and (not (was is Dictionary) or was["recordSha256"] != now_i["recordSha256"]):
			pack_ready.emit(id)


## Preflight without downloading: {bytes, packs, refused} (the consent dialog's size).
func estimate(pack_ids: Array) -> Dictionary:
	var ready := await _ready_engine()
	if not ready.ok:
		var refused: Array = []
		for id in pack_ids:
			refused.append({"packId": String(id), "code": String(ready.code)})
		return {"bytes": 0, "packs": [], "refused": refused}
	return await engine.estimate(pack_ids)


## The install state and this process's running set (PKeyPackEngine.state()); {} before start.
func state() -> Dictionary:
	return engine.state() if engine != null else {}


## Where a running pack's payload is: a tree's directory, or a pack's `.pck` path; "" otherwise.
func path(pack_id: String) -> String:
	if engine == null or not engine.running.has(pack_id):
		return ""
	return String(engine.running[pack_id]["location"])


## `packSetId` of the running set (plans/P4-01.md §2.9), for `devices/report`'s `content`; null
## before start or without a stamp.
func pack_set_id() -> Variant:
	if engine == null or content == null:
		return null
	return engine.pack_set_id()


## Mark this boot healthy: the running set becomes the confirmed one (the shared boot guard).
func confirm() -> PKeyResult:
	if engine == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Packs have not started.")
	return await engine.confirm()


## Re-point a pack at the install it replaced. A coroutine (ok, detail: whether it rolled back).
func rollback(pack_id: String) -> PKeyResult:
	var ready := await _ready_engine()
	if not ready.ok:
		return ready
	var before := engine.state()
	var r := await engine.rollback(pack_id)
	if r.ok and r.detail == true:
		_announce(before)
	return r


## Operator recovery after a torn `state.json` (see PKeyPackEngine).
func recover_state() -> PKeyResult:
	var ready := await _ready_engine()
	if not ready.ok:
		return ready
	return await engine.recover_state()


## The packs the shared boot guard counts (an active install that is not the confirmed release).
## Starts packs when needed; empty without a stamp. A coroutine.
func pending_for_guard() -> PackedStringArray:
	if not configured() or _core() == null:
		return PackedStringArray()
	var r := await start()
	if not r.ok:
		return PackedStringArray()
	return engine.pending()


## Roll the given packs back for the guard: {packId: {from, to}}. A coroutine.
func roll_back_for_guard(ids: PackedStringArray) -> Dictionary:
	if engine == null:
		return {}
	var before := engine.state()
	var out: Dictionary = await engine.rollback_many(ids)
	if not out.is_empty():
		_announce(before)
	return out


# ── The boot's pack stages ──────────────────────────────────────────────────────────────────

## The boot's pack options from the stamp (§2.10): `requiredPacks` are the `required: true`
## expects; `essentialPacks` the `delivery: "essential"` ones that are not required.
func boot_options() -> Dictionary:
	var c = content
	if c == null:
		var s := read_stamp()
		c = s.get("content") if s["ok"] else null
	var required: Array = []
	var essential: Array = []
	if c is Dictionary:
		for e in c["expects"]:
			if e["required"] == true:
				required.append(e["pack"])
			elif PKeyPackClaims.same(e["delivery"], "essential"):
				essential.append(e["pack"])
	return {"requiredPacks": required, "essentialPacks": essential}


## The prefetch packs (`delivery: "prefetch"`, not required): BACKGROUND's work.
func prefetch_packs() -> Array:
	var out: Array = []
	if content is Dictionary:
		for e in content["expects"]:
			if e["required"] != true and PKeyPackClaims.same(e["delivery"], "prefetch"):
				out.append(e["pack"])
	return out


func _installed_now(wanted: Array) -> Array:
	var out: Array = []
	if engine == null or not (content is Dictionary):
		return out
	var pins := {}
	for p in content["pins"]:
		pins[p["pack"]] = p["release"]["sha256"]
	for id in wanted:
		var i = engine.running.get(id)
		if i is Dictionary and pins.get(id) == i["recordSha256"]:
			out.append(id)
	return out


## The boot's FETCH stage (client-core `runBootFetch`): estimate the required and essential packs
## that are not current, ask when the policy says so (`fetch.consent {bytes, metered}` through
## `send`, then `answer(bytes, metered)`), download them with `fetch.progress {done, total}`, and
## return `fetch.done {result, installed}` (the caller sends it). `opts`: consent (`always`,
## `metered` (default) or `never`), metered (bool), answer (Callable -> bool, may await). A
## coroutine.
func boot_fetch(send: Callable, opts: Dictionary = {}) -> Dictionary:
	var bo := boot_options()
	var wanted: Array = []
	for id in bo["requiredPacks"] + bo["essentialPacks"]:
		if not wanted.has(id):
			wanted.append(id)
	var done := func(result: String) -> Dictionary:
		return {"type": "fetch.done", "result": result, "installed": _installed_now(wanted)}
	if wanted.is_empty():
		return done.call("ok")
	var ready := await _ready_engine()
	if not ready.ok:
		return done.call("offline" if ready.code == PKeyErrors.NETWORK else "failed")
	var metered: bool = opts.get("metered", false) == true
	var est := await engine.estimate(wanted)
	var policy := String(opts.get("consent", "metered"))
	var ask: bool = int(est["bytes"]) > 0 and (policy == "always" or (policy == "metered" and metered))
	if ask:
		send.call({"type": "fetch.consent", "bytes": int(est["bytes"]), "metered": metered})
		var answer: Callable = opts.get("answer", Callable())
		var yes := false
		if answer.is_valid():
			yes = await answer.call(int(est["bytes"]), metered) == true
		if not yes:
			return done.call("declined")
	var total := int(est["bytes"])
	send.call({"type": "fetch.progress", "done": 0, "total": total})
	var track := {"base": 0, "last": 0}
	var listener := func(e: Dictionary) -> void:
		if e.get("phase") != "download":
			return
		var now_n := mini(total, int(track["base"]) + int(e["done"]))
		if now_n > int(track["last"]):
			track["last"] = now_n
			send.call({"type": "fetch.progress", "done": now_n, "total": total})
	engine.progress.connect(listener)
	var result := "ok"
	for id in est["packs"]:
		var r := await ensure([id])
		if not r.ok:
			result = "offline" if r.code == PKeyErrors.NETWORK else "failed"
		track["base"] = track["last"]
	if not est["refused"].is_empty() and result == "ok":
		result = "failed"
		for x in est["refused"]:
			if x["code"] == String(PKeyErrors.NETWORK):
				result = "offline"
		for x in est["refused"]:
			pack_failed.emit(String(x["packId"]), String(x["code"]))
	engine.progress.disconnect(listener)
	if result == "ok" and int(track["last"]) < total:
		send.call({"type": "fetch.progress", "done": total, "total": total})
	return done.call(result)


## Wait until the first frame has been drawn (`RenderingServer.frame_post_draw`, the strict
## signal; a headless run has no renderer and waits one process frame).
static func after_first_frame() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	if DisplayServer.get_name() == "headless":
		await tree.process_frame
	else:
		await RenderingServer.frame_post_draw


func _web_cap() -> int:
	if web_cap != 0:
		return web_cap
	if not OS.has_feature("web"):
		return -1
	return WEB_CAP_MOBILE if OS.has_feature("web_android") or OS.has_feature("web_ios") else WEB_CAP_DESKTOP


## Mount this boot's restart packs (README §5.7; S-05 §4.1, §4.6): after the first frame is drawn,
## in `mountOrder` (then pack id), one per frame, only the running set's content-addressed paths,
## each after the header and directory checks (on a worker thread), with `replace_files=true`,
## never twice in a process. Over the web cap a pack is not mounted. A coroutine returning
## {mounted: [ids], refused: [{packId, code, detail}]}; `pack_ready(id)` per mounted pack.
func mount() -> Dictionary:
	var out := {"mounted": [], "refused": []}
	if engine == null:
		return out
	var handler = engine.handlers.get("godot.pck")
	if handler == null:
		return out
	var queue: Array = []
	for id in handler.to_mount:
		if not mounted.has(id):
			queue.append(handler.to_mount[id])
	if queue.is_empty():
		return out
	queue.sort_custom(func(a, b):
		var oa := _mount_order(a)
		var ob := _mount_order(b)
		if oa != ob:
			return oa < ob
		return PKeyPackClaims.compare_bytes(a["packId"], b["packId"]) < 0)
	await after_first_frame()
	var cap := _web_cap()
	var used := 0
	for i in mounted.values():
		used += int(i["payloadSize"])
	var tree := Engine.get_main_loop() as SceneTree
	for i in queue:
		var id: String = i["packId"]
		var rec = engine.records.get(i["recordSha256"])
		var variant = _variant_of(rec, i)
		if rec == null or variant == null:
			out["refused"].append({"packId": id, "code": PKeyConstants.ErrorCode.RECORD_REJECTED, "detail": "no verified record"})
			pack_failed.emit(id, PKeyConstants.ErrorCode.RECORD_REJECTED)
			continue
		var src := PKeyByteSource.file(String(i["location"]), int(i["payloadSize"]))
		var chk: Dictionary = await PKeyPackJob.run(PKeyGodotPckHandler.check.bind(src, rec, variant), "PolarisKey pack check")
		if not chk["ok"]:
			out["refused"].append({"packId": id, "code": chk["code"], "detail": chk.get("detail", "")})
			pack_failed.emit(id, String(chk["code"]))
			continue
		if cap >= 0 and used + int(i["payloadSize"]) > cap:
			out["refused"].append({"packId": id, "code": String(PKeyErrors.UNSUPPORTED), "detail": "over the web mount cap (%d bytes)" % cap})
			pack_failed.emit(id, String(PKeyErrors.UNSUPPORTED))
			continue
		var started := Time.get_ticks_usec()
		if not PKeyPck.mount(String(i["location"]), true):
			out["refused"].append({"packId": id, "code": PKeyPck.DIRECTORY_REFUSED, "detail": "the engine refused to mount it"})
			pack_failed.emit(id, PKeyPck.DIRECTORY_REFUSED)
			continue
		var ms := (Time.get_ticks_usec() - started) / 1000.0
		if ms > 100.0:
			push_warning("PolarisKey: mounting %s took %.0f ms (%d entries); a larger pack belongs under a loading screen (S-05 §4.1)." % [id, ms, int(chk.get("count", 0))])
		mounted[id] = i
		handler.mounted[id] = true
		used += int(i["payloadSize"])
		out["mounted"].append(id)
		pack_ready.emit(id)
		if tree != null:
			await tree.process_frame
	return out


func _mount_order(install: Dictionary) -> int:
	var rec = engine.records.get(install["recordSha256"]) if engine != null else null
	if rec is Dictionary and rec.get("handler") is Dictionary and PKeyClaims.is_number(rec["handler"].get("mountOrder")):
		return int(rec["handler"]["mountOrder"])
	return 0


static func _variant_of(rec: Variant, install: Dictionary) -> Variant:
	if not (rec is Dictionary):
		return null
	for v in rec.get("variants", []):
		if PKeyPackClaims.variant_key(v.get("variant")) == install["variant"]:
			return v
	return null


## BACKGROUND's work: install the prefetch packs not yet current, one by one. A coroutine
## returning {installed: [ids], failed: [{packId, code}]}.
func background(pack_ids: Array = []) -> Dictionary:
	var ids := pack_ids if not pack_ids.is_empty() else prefetch_packs()
	var out := {"installed": [], "failed": []}
	for id in ids:
		var r := await ensure([id])
		if r.ok:
			out["installed"].append(id)
		else:
			out["failed"].append({"packId": id, "code": String(r.code)})
	return out
