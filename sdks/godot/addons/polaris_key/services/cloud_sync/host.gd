extends Node
## The Godot Cloud Sync host: the first production host of the machine. A port of Python
## `cloud_sync/host.py` (itself of sdk-node `cloudSync/host.ts`) with every SEC-SYNC-HOST fix. The
## machine does no I/O; this node is everything around it:
##
##   * one machine per client, built from app code (`encryption`, default "e2e"), the discovery
##     `services.sync` member, the codec port and the product catalog;
##   * the catalog comes from `/config/schema`, cached beside the journal, with the app's compiled
##     mirror before the first fetch; fetched again when a pull's `catalogVersion` differs, at most
##     every five minutes (H-1, H-2);
##   * every request the machine queues goes through `transport.gd` (bearer, `X-PKey-*`), and in E2E
##     mode through the codec port on the way out and in;
##   * the journal is written, sealed, to `<state_dir>/cloud-sync` (H-6);
##   * a `Timer` child drives `advance` while the machine holds work.
##
## Single-threaded: `await` re-enters, so one pump runs at a time (`_pumping`, `_again`). A machine
## that is rebuilt or purged while a request is out has its answer dropped (`_gen`).
##
## Rules this host keeps: S1 the opened result is the codec's own; S2 the mode is app code's and
## the served catalog's encryption member is dropped; S3 a locked codec sends and reads nothing and
## the host adds no GET of its own; S7 no value, root or key in a log or event (static strings only);
## S10 an answer that cannot be opened is dropped without advancing the cursor; HOST-BIND a request
## whose bound person is known and differs from the session's is dropped, an unknown session is
## allowed. Nothing on the licence path imports this script.
##
## Not yet (U-21.7): the bounded `flush` rules and tests (H-8, H-9), the purge generation and
## ordering tests (H-7), and the lifecycle notifications. U-21.9 adds the API layer over this node.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Machine := preload("res://addons/polaris_key/core/sync/cloud_sync_machine.gd")
const Routes := preload("res://addons/polaris_key/core/sync/sync_routes.gd")
const Transport := preload("res://addons/polaris_key/services/cloud_sync/transport.gd")
const State := preload("res://addons/polaris_key/services/cloud_sync/state.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")

## The machine's events, in batches, in order. A listener may call `touch` or `flush`: the pump
## runs again after it, never a second pump.
signal events(batch: Array)

## How often the timer wakes the machine while it holds work (ms).
const TICK_MS := 250
## The most exchanges one pump makes, whatever the machine keeps asking for.
const MAX_EXCHANGES := 64
const MAX_CATALOG_ENTRIES := 1024
const MAX_CATALOG_BYTES := 1024 * 1024
## A served catalog is fetched again at most this often (the first fetch is free).
const CATALOG_REFETCH_MS := 5 * 60_000

var _deps: Dictionary
var _opts: Dictionary
var _file: State
var _codec: CodecPort
var _transport: PKeyTransport
var _machine: Machine = null
var _detach: Callable = Callable()
## The catalog compiled into the app: authoritative for every key it names.
var _mirror: Variant = null
## The last catalog the Worker served: it may only add keys the mirror lacks.
var _served: Variant = null
var _catalog: Dictionary = {"schemaVersion": 0, "entries": []}
var _last_fetch_at: Variant = null
var _used := 0
var _routes: Array = []
var _open_keys: Dictionary = {}
var _document_json := ""
var _tried_catalog_version: Variant = null
var _rebuild_wanted := false
var _again := false
var _pumping := false
var _started := false
var _closed := false
## After a purge the journal stays unsaved until a principal signs in again.
var _purged := false
var _root_pending: Variant = null
## Bumped on every (re)build: an answer for an older machine is dropped.
var _gen := 0
var _timer: Timer
var _sync_key_re: RegEx


## `deps` (every value a Callable so the host holds no stale copy):
##   product: String
##   state_dir: String                      where `cloud-sync` lives
##   enabled: Callable() -> bool            the sync service is on (default true)
##   token: Callable() -> String            the device bearer
##   session_subject: Callable() -> Variant the person the session's token belongs to, null if unknown
##   headers: Callable(extra) -> Dictionary, url: Callable(path) -> String   (the Core's)
##   discovery: Callable() -> Variant       the discovery manifest or null
##   fetch_schema: Callable() -> Variant    coroutine; the `/config/schema` body or null
##   document: Callable() -> Dictionary     {values, locked?}
##   codec: CodecPort (default: locked), sealer: PKeyRecordSealer (default: none)
##   transport: PKeyTransport (default: Transport.make(self)), clock: Callable() -> int (ms),
##   new_client_id: Callable() -> String (default: random)
## `opts` (app code only): {encryption: "e2e"|"server", catalog: Dictionary, aliases: Dictionary}.
func configure(deps: Dictionary, opts: Dictionary = {}) -> void:
	_deps = deps
	_opts = opts
	_codec = deps.get("codec", CodecPort.new())
	_file = State.new(deps["state_dir"], deps["product"], deps.get("sealer"))
	_sync_key_re = RegEx.create_from_string(PKeyConstants.SYNC_KEY_PATTERN)


func is_started() -> bool:
	return _started and not _closed


## The machine; null before `start`.
func machine() -> Machine:
	return _machine


func _now() -> int:
	var clock: Variant = _deps.get("clock")
	if clock is Callable and (clock as Callable).is_valid():
		return clock.call()
	return int(Time.get_unix_time_from_system() * 1000.0)


# ── start ─────────────────────────────────────────────────────────────────────────────────────


## Load the saved journal and catalog, build the machine and attach it to the codec. Idempotent.
## Makes no request unless a catalog has to be fetched (none cached and none compiled in). The
## result is `{ok: true}` or `{ok: false, error}`: a machine that refuses to build (a malformed
## client id from the host) leaves the host stopped.
func start() -> Dictionary:
	if _started or _closed:
		return Types.ok()
	_started = true
	_transport = _deps.get("transport") if _deps.get("transport") != null else Transport.make(self)
	_timer = Timer.new()
	_timer.one_shot = true
	_timer.timeout.connect(_on_timer)
	add_child(_timer)
	var saved := _file.load_file()
	_open_keys = {}
	for k in saved["openKeys"]:
		_open_keys[k] = true
	_mirror = _vetted(_opts.get("catalog"))
	_served = _vetted(saved["catalog"])
	var built := _build(saved["persisted"])
	if not built["ok"]:
		_started = false
		return built
	if saved["catalog"] == null and _opts.get("catalog") == null:
		await _refetch_catalog(null)
	touch()
	return Types.ok()


func _enabled() -> bool:
	var e: Variant = _deps.get("enabled")
	return not (e is Callable) or bool((e as Callable).call())


## The routes' catalog: the mirror as it is, plus served entries only for keys the mirror does not
## name and the person's own open settings do not use. The Worker's catalog never changes a route
## the app compiled in, and never turns an open setting into a declared one (H-1).
func _effective() -> Dictionary:
	var taken := {}
	var mirror_entries: Array = _mirror["entries"] if _mirror != null else []
	for e: Dictionary in mirror_entries:
		taken[e["key"]] = true
	var extra: Array = []
	if _served != null:
		for e: Dictionary in _served["entries"]:
			if not taken.has(e["key"]) and not _open_keys.has(e["key"]):
				extra.append(e)
	var base: Dictionary = _mirror if _mirror != null else (_served if _served != null else {"schemaVersion": 0, "entries": []})
	var src: Variant = _served if _served != null else _mirror
	var version: Variant = src["schemaVersion"] if src != null else 0
	var out := base.duplicate()
	out["schemaVersion"] = version
	out["entries"] = mirror_entries + extra
	return out


## The routes of a catalog, without any mode the catalog states (the app decides the mode).
static func _routes_of(catalog: Dictionary) -> Array:
	var out: Array = []
	for r: Dictionary in Routes.synced_settings(catalog):
		var c := r.duplicate()
		c.erase("encryption")
		out.append(c)
	return out


## A catalog fit to route by: the right shape and size, every entry key a valid sync key, and one
## entry per key. null when it is not (H-1).
func _vetted(c: Variant) -> Variant:
	if not State.is_catalog_shape(c) or (c["entries"] as Array).size() > MAX_CATALOG_ENTRIES:
		return null
	if JSON.stringify(c, "", false).to_utf8_buffer().size() > MAX_CATALOG_BYTES:
		return null
	var seen := {}
	var entries: Array = []
	for e in c["entries"]:
		var k: Variant = e.get("key") if e is Dictionary else null
		if not (k is String) or _sync_key_re.search(k) == null or seen.has(k):
			continue
		seen[k] = true
		entries.append(e)
	var out: Dictionary = (c as Dictionary).duplicate()
	out["entries"] = entries
	return out


## (Re)build the machine from the journal, the catalog and the document.
func _build(persisted: Variant) -> Dictionary:
	if _detach.is_valid():
		_detach.call()
		_detach = Callable()
	var catalog := _effective()
	var routes := _routes_of(catalog)
	var document: Dictionary = _deps["document"].call()
	var make_id: Callable = _deps.get("new_client_id", _random_client_id)
	var m := Machine.new({
		"product": _deps["product"],
		"catalog": {"settings": routes},
		"document": document,
		"now": _now(),
		"encryption": _opts.get("encryption", "e2e"),
		"hasRoot": not _codec.locked(),
		"newClientId": make_id,
	}, persisted)
	if m.init_error != "":
		push_error("Cloud Sync host: the machine could not be built")
		return Types.fail(m.init_error)
	_catalog = catalog
	_routes = routes
	_document_json = JSON.stringify(document, "", false)
	_machine = m
	_gen += 1
	_apply_discovery(m)
	_detach = _codec.attach(_on_root_changed)
	_root_pending = null
	return Types.ok()


static func _random_client_id() -> String:
	return "c_" + PKeyB64Url.encode(Crypto.new().generate_random_bytes(16))


func _apply_discovery(m: Machine) -> void:
	var doc: Variant = _deps["discovery"].call() if _deps.get("discovery") is Callable else null
	if not (doc is Dictionary):
		return
	var services: Variant = doc.get("services")
	var sync: Variant = services.get("sync") if services is Dictionary else null
	if not (sync is Dictionary) or sync.get("enabled") != true:
		return
	var e: Variant = sync.get("encryption")
	m.set_discovery({"encryption": e} if e == "e2e" or e == "server" else {})


## Discovery just loaded: tell the machine what `services.sync` says.
func note_discovery() -> void:
	if _machine == null:
		return
	_apply_discovery(_machine)
	touch()


## The signed config document refreshed: lift a block, and rebuild if the document changed.
func note_document_refreshed() -> void:
	if _machine == null:
		return
	_machine.refresh()
	if JSON.stringify(_deps["document"].call(), "", false) != _document_json:
		_rebuild_wanted = true
	touch()


## Bring the machine's clock to the real one, so an edit made now is stamped and debounced from now.
func catch_up() -> void:
	if _machine == null:
		return
	var dt := _now() - _machine.now()
	if dt > 0:
		_machine.advance(dt)


func _on_root_changed(present: bool) -> void:
	# Recorded; applied at the next pump (the codec calls this from its own code path).
	_root_pending = present
	if _started and not _closed:
		touch()


## A principal signs in: the machine's answer (an error result when the host's client id was
## refused) is returned as it is, and the pump runs.
func sign_in(subject: String) -> Dictionary:
	if _machine == null:
		return Types.fail("not-started")
	var r: Dictionary = _machine.sign_in(subject)
	if r["ok"]:
		_purged = false
		touch()
	return r


# ── the pump ──────────────────────────────────────────────────────────────────────────────────


## Run the machine now: advance its clock, exchange every queued request, save. Never errors into
## the caller. A call while a pump runs (a listener reacting to an event, a wake) asks the running
## pump to go round once more and returns.
func touch() -> void:
	if not is_started() or not _enabled():
		return
	if _pumping:
		_again = true
		return
	_pumping = true
	await _pump()
	_pumping = false
	_arm()


## Wait (frame by frame) until no pump is running, or `max_ms` has passed. True when idle. The
## bounded wait `flush` builds on (U-21.7 adds the rules around it).
func idle(max_ms := 15000) -> bool:
	var deadline := Time.get_ticks_msec() + max_ms
	var tree := get_tree()
	while _pumping and Time.get_ticks_msec() < deadline:
		await tree.process_frame
	return not _pumping


func _pump() -> void:
	_used = 0
	while true:
		_again = false
		if _rebuild_wanted:
			_rebuild()
		var m := _machine
		if m == null:
			return
		var pending: Variant = _root_pending
		_root_pending = null
		if pending != null:
			m.set_root(bool(pending))
		var dt := _now() - m.now()
		if dt > 0:
			m.advance(dt)
		while _used < MAX_EXCHANGES and m == _machine:
			var reqs: Array = m.take_requests()
			if reqs.is_empty():
				break
			var bound: Variant = m.subject()
			for req: Dictionary in reqs:
				_used += 1
				await _exchange(m, req, bound)
		if m == _machine:
			_emit(m)
		if not (_again and _used < MAX_EXCHANGES):
			break
	# Saving commits the debounced edits (`persist()`), so a pump that exchanged nothing leaves the
	# file alone and an edit keeps its debounce window.
	if _used > 0:
		_save()


func _receive(m: Machine, res: Dictionary, opened: Variant = null) -> void:
	if m == _machine:
		m.receive(res, opened)


## One request: seal it (E2E), send it, open the answer, hand both to the machine.
func _exchange(m: Machine, req: Dictionary, bound: Variant) -> void:
	var e2e: bool = m.encryption_mode() == "e2e"
	# S3 / H-10: a locked codec sends nothing, a pull included.
	if e2e and _codec.locked():
		return _receive(m, Transport.TRANSPORT_ERROR)
	var wire := req
	var mutations: Variant = null
	if req.get("method") == "POST":
		var body: Variant = req.get("body")
		mutations = body.get("mutations") if body is Dictionary else null
		_note_open_keys(mutations)
		if e2e:
			var sealed: Dictionary = _codec.seal_push(body, _routes)
			if not sealed.get("ok", false):
				# Locked, or a mutation that cannot be sealed: nothing is sent (HC-6).
				return _receive(m, Transport.TRANSPORT_ERROR)
			wire = {"method": "POST", "path": req["path"], "body": sealed["body"]}
	# HOST-BIND: a request bound to one person never goes out under another's session. An unknown
	# session subject (discovery not loaded, an offline boot) is allowed.
	var who: Variant = _deps["session_subject"].call() if _deps.get("session_subject") is Callable else null
	if who != null and bound != null and who != bound:
		return _receive(m, Transport.TRANSPORT_ERROR)
	var ctx := {
		"product": _deps["product"],
		"token": _deps["token"].call(),
		"headers": _deps["headers"],
		"url": _deps["url"],
	}
	var res: Dictionary = await Transport.send_sync(_transport, ctx, wire)
	if m != _machine:
		return  # rebuilt or purged while the request was out: the answer is dropped
	var ok: bool = res.get("status") == 200 and res.get("body") is Dictionary
	if not e2e or not ok:
		# Server mode, an error answer, or no answer: the machine reads it as it is.
		if e2e and res.get("status") == 200:
			return _receive(m, Transport.TRANSPORT_ERROR)  # H-10: a 200 that is not an object
		_receive(m, res)
		# Python refetches only after an E2E pull; a server-mode app needs its catalog as much.
		if ok:
			await _maybe_refetch(res["body"])
		return
	var opened_res: Dictionary = _codec.open_pull(res["body"], mutations, _opts.get("aliases"), _open_keys.keys())
	if not opened_res.get("ok", false):
		# Locked since the request left, or a repeated mutationId: the answer is dropped, the cursor stays.
		return _receive(m, Transport.TRANSPORT_ERROR)
	var body_out: Dictionary = opened_res["body"]
	var opened: Dictionary = opened_res.get("opened", {})
	_note_opened_keys(body_out, opened)
	_receive(m, {"status": 200, "body": body_out}, opened)
	await _maybe_refetch(body_out)


# ── the catalog ───────────────────────────────────────────────────────────────────────────────


## A pull that names another `catalogVersion` than the catalog held: fetch it again, once.
func _maybe_refetch(body: Variant) -> void:
	if not (body is Dictionary):
		return
	var v: Variant = body.get("catalogVersion")
	if not Types.is_number(v):
		return
	if Types.json_equal(v, _catalog.get("schemaVersion")) or Types.json_equal(v, _tried_catalog_version):
		return
	await _refetch_catalog(int(v))


func _refetch_catalog(version: Variant) -> void:
	var now := _now()
	# Rate-limited, and counted in the pump's budget like any other request (H-2).
	if _used >= MAX_EXCHANGES or (_last_fetch_at != null and now - int(_last_fetch_at) < CATALOG_REFETCH_MS):
		return
	_last_fetch_at = now
	_tried_catalog_version = version
	_used += 1
	var raw: Variant = await _deps["fetch_schema"].call()
	var fetched: Variant = _vetted(raw)
	if fetched == null:
		return
	if Types.json_equal(fetched, _served):
		return
	var before := JSON.stringify(_routes_of(_catalog), "", false)
	_served = fetched
	# Rebuild only when the routes the machine uses would change.
	var effective := _effective()
	if JSON.stringify(_routes_of(effective), "", false) == before:
		_catalog = effective
		return
	_rebuild_wanted = true
	_again = true


## New catalog or document: the machine is rebuilt from its own journal (never mid-request: an
## answer for the old machine is dropped).
func _rebuild() -> void:
	_rebuild_wanted = false
	var old := _machine
	var persisted: Dictionary = old.persist()
	_emit(old)
	if _build(persisted)["ok"]:
		_save(persisted)
	else:
		_machine = old


# ── open keys ─────────────────────────────────────────────────────────────────────────────────


func _declared() -> Dictionary:
	var d := {}
	for r: Dictionary in _routes:
		d[r["key"]] = true
	return d


## An undeclared key this client wrote (H-5: its own mutations).
func _note_open_keys(mutations: Variant) -> void:
	if not (mutations is Array):
		return
	var declared := _declared()
	for mu in mutations:
		var target: Variant = mu.get("target") if mu is Dictionary else null
		if target is Dictionary and target.get("setting") is String and not declared.has(target["setting"]):
			_add_open_key(target["setting"])


## Names from rows this host opened (`sealed`): a served name, an unopened row or a plaintext row
## never enters the set, so a Worker cannot fill it to push real names out (H-5).
func _note_opened_keys(body: Variant, opened: Dictionary) -> void:
	if not (body is Dictionary) or not (body.get("changes") is Array):
		return
	var declared := _declared()
	var rows: Array = opened["changes"] if opened.get("changes") is Array else []
	var changes: Array = body["changes"]
	for i in changes.size():
		var row: Variant = rows[i] if i < rows.size() else null
		var c: Variant = changes[i]
		if row is Dictionary and row.get("sealed") == true and c is Dictionary and c.get("setting") is String and not declared.has(c["setting"]):
			_add_open_key(c["setting"])


func _add_open_key(name: String) -> void:
	_open_keys.erase(name)
	_open_keys[name] = true
	while _open_keys.size() > State.OPEN_KEYS_MAX:
		_open_keys.erase(_open_keys.keys()[0])


# ── events and state ──────────────────────────────────────────────────────────────────────────


func _emit(m: Machine) -> void:
	var batch: Array = m.take_events()
	if not batch.is_empty():
		events.emit(batch)


## Persist the journal. Committing the debounced edits is what `persist()` does by contract. The
## file never holds the root. A failure to persist never fails the call that produced it.
func _save(persisted: Variant = null) -> void:
	if _purged or _machine == null:
		return
	var snapshot: Variant = persisted if persisted != null else _machine.persist()
	var ok := _file.save({
		"v": 1,
		"product": _deps["product"],
		"persisted": snapshot,
		"catalog": _served,
		"openKeys": _open_keys.keys(),
	})
	if not ok:
		push_warning("Cloud Sync host: the journal could not be saved")


# ── the timer ─────────────────────────────────────────────────────────────────────────────────


## Wake while the machine holds work (an edit waiting out its debounce, a request to retry, a
## sign-out flush).
func _arm() -> void:
	if _closed or _machine == null or _timer == null or not _timer.is_stopped():
		return
	var s: Dictionary = _machine.status()
	if s["pending"] > 0 and ["pending", "syncing", "paused"].has(s["state"]):
		_timer.start(TICK_MS / 1000.0)


func _on_timer() -> void:
	touch()


# ── calls the API layer makes ─────────────────────────────────────────────────────────────────


## Forget the person's synced data (S6): the file, which holds the opened snapshot, is deleted first;
## the machine is rebuilt empty; nothing is saved again until `sign_in`. A request still out has its
## answer dropped (`_gen`). U-21.7 adds the waits and tests of H-7.
func purge() -> bool:
	_purged = true
	var removed := _file.remove()
	_open_keys = {}
	if _timer != null:
		_timer.stop()
	if is_started() and _machine != null:
		_emit(_machine)
		_build(null)
		if _machine != null:
			_machine.import_local({})
	_file.remove()
	return removed


## Stop the timer and detach from the codec; save the journal. Safe to call more than once.
func close() -> void:
	if _closed:
		return
	var was := is_started()
	_closed = true
	if _timer != null:
		_timer.stop()
	if _detach.is_valid():
		_detach.call()
		_detach = Callable()
	if was and _machine != null:
		_save()
