class_name PKeyCloudSync
extends RefCounted
## Cloud Sync's settings API (U-21.9): what app code sees on top of the host. A port of Python
## `cloud_sync/api.py` (`CloudSyncApi` and `CloudSyncClient`).
##
##   PolarisKey.cloud_sync.status()    ok, detail = the machine's status (`state`, `pending`, ...)
##   PolarisKey.cloud_sync.flush()     send what is waiting (bounded), save, answer the status; a coroutine
##   PolarisKey.event("cloudSync", d)  the machine's events, in order; `d.type` is the machine's name
##                                     (`signedOut`, `unsyncedData`, `signInOffered`, `change`,
##                                     `rejected`, `purgeFailed`), other keys snake_case, keys only
##   PolarisKey.cloud_sync.saves       the synced saves (U-23; PKeySaves, services/cloud_sync/saves.gd): list, read,
##                                     write, resolve, delete, revisions
##   PolarisKey.cloud_sync.transfers() the saves being written now (PKeyTransfer handles)
##                                     and, on the same stream, `transferProgress`, `transferDone` and
##                                     `transferFailed` (a cancelled write is `transferDone` with state "cancelled")
##   PolarisKey.config.set_value / clear / setting(k).sync()   routed through the machine while a
##                                     person is signed in
##
## A product without the Sync service gets the typed `product` N/A from `status()` and `flush()`.
## The identity session's subject drives the machine; identity events are handled one at a time and
## in order. Rules kept here (plans U-07-U-21 section 3):
##   A-1  a person change never talks to the server: the subject and the synced projection are cleared
##        synchronously, then `sign_out(discard)`; each queued request is bound to its person (the host
##        drops it when the session is another person's)
##   A-2  an offline boot is not a sign-out: an unknown stored subject changes nothing; only a
##        `signedOut` identity event, or a deactivation, leaves
##   A-3  before sign-out (the old token is still current): flush (bounded), the machine signs out,
##        the ring forgets, the data is purged. The flush comes before the forget (an E2E flush needs
##        the root). Forget and purge are each tried whatever the other did; a failure is logged and never
##        replaces the sign-out's own error. Purge also runs when Sync is off
##   A-4  a sign-out that happens elsewhere reaches Cloud Sync as `signedOut`; a stale subject is dropped
##   A-5  `signInUrl`: control characters and whitespace refuse it; it is resolved against the Worker
##        origin and kept only as an https URL on that origin. The offer comes only for
##        `accountRequired`/`subjectChanged`, after the forget
##   A-6  the locked list is rebuilt before `set`/`clear` after a document refresh; the import marker is
##        written after the sign-in succeeded and apart from the state file
##   A-7  the mode comes from app code only (`PKeyOptions.cloud_sync_encryption`); licence state is never
##        read or written from here
## No event, log line or error carries a value or the root (H-11).
##
## "Connect leave" (the first link of the sign-out chain once Cloud Connect exists in Godot) plugs in as
## `before_leave`: a Callable awaited before the flush. None today.

const Host := preload("res://addons/polaris_key/services/cloud_sync/host.gd")
const Transport := preload("res://addons/polaris_key/services/cloud_sync/transport.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")
const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const TransferCodec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const FilesTransport := preload("res://addons/polaris_key/services/cloud_sync/files_transport.gd")
const SavesRecords := preload("res://addons/polaris_key/services/cloud_sync/saves_records.gd")
const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")

## The reasons the machine leaves a principal, each of which drops the key ring.
const FORGETTING := ["signOut", "accountRequired", "subjectChanged"]
const CHAIN_WAIT_MS := 10000

## Awaited first in the sign-out chain (Cloud Connect leave). Empty callable: none.
var before_leave: Callable = Callable()
## The host node (a child of the autoload), or null before `bind`.
var host: Node = null
## The synced saves (PKeySaves), or null before `bind`.
var saves: PKeySaves = null

var _core: PKeyCore
var _config: PKeyConfig
var _keyring: Object
var _emit: Callable
var _attached := false
var _attaching := false
var _listening := false
var _subject: Variant = null
var _forgot := false
## True while the sign-out chain runs: a ring that cannot forget then skips the purge and stops the sign-out (D-13).
var _in_sign_out := false
var _forget_error: PKeyResult = null
var _forgets := 0
var _queue: Array = []
var _running := false
var _closed := false
var _port := _Port.new()
var _journal: Object = null
## The saves' file transport (U-41.G): it owns the bulk channel's requests in flight.
var _files: Object = null
var _bulk_open := false
## Held here: a Callable on a RefCounted does not keep it alive.
var _saves_port: _SavesPort = null
var _cache: Object = null
var _cache_for: Variant = null
## While one person replaces another, the incoming person: their chunk folder is the one that stays.
var _keep_subject: Variant = null
## The records handles handed out, by collection name (one per name, so its signals persist).
var _collections := {}


## Build the host over this Core. `emit` is `func(data: Dictionary)`: one cloudSync event.
func bind(p_core: PKeyCore, sdk: Node, p_config: PKeyConfig, p_keyring: Object, opts: PKeyOptions, p_emit: Callable) -> void:
	close()
	_closed = false
	_core = p_core
	_config = p_config
	_keyring = p_keyring
	_emit = p_emit
	_attached = false
	_attaching = false
	_subject = null
	host = Host.new()
	sdk.add_child(host)
	var sealer: PKeyRecordSealer = null
	if not PKeyRecordSealer.switched_off():
		sealer = PKeyRecordSealer.for_platform(p_core.product)
	# The real codec (U-21.8) over the key ring; a test or an app may pass its own; without a ring, the
	# locked base codec, so an E2E product stays locked and sends nothing.
	var codec: Object = opts.cloud_sync_codec
	if codec == null:
		codec = PKeySyncHostCodec.new(p_keyring) if p_keyring is PKeySyncRing else CodecPort.new()
	host.configure({
		"product": p_core.product,
		"state_dir": PKeyBackupExclusion.root(opts.store_root).path_join(p_core.storage_namespace),
		"sealer": sealer,
		"codec": codec,
		"enabled": func() -> bool: return p_core.enabled("sync"),
		"token": func() -> String: return p_core.tokens.current(),
		"session_subject": func() -> Variant: return p_core.cache.subject if p_core.cache.subject != "" else null,
		"headers": func(extra: Dictionary) -> Dictionary: return p_core.headers(extra),
		"url": func(path: String) -> String: return p_core.base_url + path,
		"discovery": func() -> Variant: return p_core.discovery_manifest,
		"fetch_schema": func() -> Variant: return await p_config.fetch_schema(),
		"document": func() -> Dictionary: return p_config._sync_document(),
		"transport": Transport.make(host, p_core.local_only),
	}, {
		"encryption": opts.cloud_sync_encryption,
		"catalog": null,
		"aliases": opts.cloud_sync_aliases,
		"saves": {
			"delta": opts.cloud_sync_saves_delta,
			"max_bytes": opts.cloud_sync_saves_max_bytes if opts.cloud_sync_saves_max_bytes > 0 else null,
			"save_format_version": opts.cloud_sync_save_format_version,
		},
	})
	_port.set_api(self)
	_build_saves()


# ── What app code calls ───────────────────────────────────────────────────────────────────────


## The saves being written now (PKeyTransfer handles), oldest first.
func transfers() -> Array:
	return saves.transfers() if saves != null else []


## The machine's status. `local` before Cloud Sync has started. The typed `product` N/A when the
## product does not run the Sync service.
func status() -> PKeyResult:
	var refused: Variant = _core.require_service("sync", PKeyConstants.Feature.SYNC_SETTINGS) if _core != null else PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if refused != null:
		return refused
	if host == null or not host.is_started():
		return PKeyResult.success({"state": "local", "pending": 0, "protection": host.state_protection() if host != null else "none"})
	var out: Dictionary = host.machine().status()
	out["protection"] = host.state_protection()
	return PKeyResult.success(out)


## The records handle of a collection the product's catalog declares (U-46, `sync.records`): a
## `PKeyCollection`, the same one for the same name, in `detail`. Starts the host first. An undeclared
## name answers `collection_unknown` from each call of the handle, never an error here. The typed
## `product` N/A when the product does not run the Sync service. A coroutine.
func collection(name: String) -> PKeyResult:
	var refused: Variant = _core.require_service("sync", PKeyConstants.Feature.SYNC_RECORDS) if _core != null else PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if refused != null:
		return refused
	await attach()
	if host == null or not host.is_started():
		return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_FAILED, "Cloud Sync could not start.", {"reason": "sync-not-started"})
	if not _collections.has(name):
		_collections[name] = PKeyCollection.new(name, host)
	return PKeyResult.success(_collections[name])


## Send what is waiting now (bounded by the sign-out flush window), save the journal and answer the
## status. A coroutine.
func flush() -> PKeyResult:
	var refused: Variant = _core.require_service("sync", PKeyConstants.Feature.SYNC_SETTINGS) if _core != null else PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if refused != null:
		return refused
	await attach()
	await _drain()
	if host != null and host.is_started():
		await host.flush()
	return status()


# ── The saves ─────────────────────────────────────────────────────────────────────────────────


func _device_label() -> String:
	return PKeyDeviceLabel.resolve("", _core.options) if _core != null else ""


func _build_saves() -> void:
	var port := _SavesPort.new()
	port.set_api(self)
	_saves_port = port
	var tr := FilesTransport.make_transport(host, _core.local_only)
	var transport := FilesTransport.new(tr, port.request_context)
	_files = transport
	# D-10: the bulk channel is used only when the app opted in and the platform supplied one.
	var opts: PKeyOptions = _core.options
	var channel: Object = PKeyAppleBulk.pick(opts, _core.product, _core.base_url, host.state_dir())
	if channel == null and opts != null and opts.cloud_sync_background_transfers and OS.get_name() == "Android":
		# U-41.6b: the Android plugin's channel, when the export carries the plugin (null: foreground as before).
		channel = PKeyAndroidBulk.create(_bulk_context)
	if channel != null:
		transport.set_channel(channel)
	_journal = Journal.Files.new(host.state_dir(), host.sealer())
	var engine := Transfer.new(transport, _journal)
	# A save may wait out a long throttle.
	engine.max_retry_after = float(FilesTransport.RETRY_AFTER_CAP)
	var records := SavesRecords.new(host, port.blind_record)
	var o: Dictionary = host.saves_options()
	saves = PKeySaves.new({
		"records": records,
		"engine": engine,
		"file_codec": port.file_codec,
		"cache": port.chunk_cache,
		"gate": port.gate,
		"delta": o["delta"],
		"max_bytes": o["max_bytes"],
		"format_version": o["save_format_version"],
		"emit": port.emit_transfer,
		"purge_files": port.purge_files,
		"device_label": Callable(self, "_device_label"),
	})


## The file codec of the saves now: the plain-hash codec in server mode, the key ring's in end-to-end
## mode, null while the ring is locked. The root lives in the returned object for one operation only, and
## the object asks the ring again before every use.
func _file_codec() -> Variant:
	if host == null or not host.is_started():
		return null
	if host.machine().encryption_mode() != "e2e":
		return TransferCodec.Server.new()
	return TransferCodec.e2e_for(host.codec(), PKeySaves.COLLECTION)


## The chunk cache of the person signed in (D-9): held as stored, so ciphertext in end-to-end mode.
func _chunk_cache() -> Variant:
	if host == null or _subject == null or not host.saves_options()["delta"]:
		return null
	if _cache_for != _subject:
		_cache_for = _subject
		var largest: int = host.saves_options()["max_bytes"] if host.saves_options()["max_bytes"] != null else PKeySyncFileStream.LANE_MAX_BYTES
		_cache = PKeyChunkCache.Files.new(PKeyChunkCache.dir_for(host.state_dir(), _subject, PKeySaves.COLLECTION), PKeyChunkCache.budget(largest))
	return _cache


func _saves_gate() -> Variant:
	var refused: Variant = _core.require_service("sync", PKeyConstants.Feature.SYNC_SAVES) if _core != null else PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if refused != null:
		return refused
	await attach()
	if host == null or not host.is_started():
		return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_FAILED, "Cloud Sync is not started.", {"reason": "sync-not-started"})
	return null


func _emit_transfer(event: Dictionary) -> void:
	if _emit.is_valid():
		_emit.call(event)


## The journal of the transfers and the chunk cache go with the person (D-9). Each is tried whatever the other did.
## Person-scoped: every person's chunk folder goes (the leaving one and any orphan of an earlier person)
## except the incoming person's, who replaces the leaving one. The leaving subject need not be known.
func _purge_save_files() -> void:
	if _journal != null:
		_journal.clear()
	if host != null and is_instance_valid(host):
		var root: String = host.state_dir().path_join(PKeyChunkCache.DIR_NAME)
		var keep := (_keep_subject as String).sha256_text() if _keep_subject is String and _keep_subject != "" else ""
		var d := DirAccess.open(root)
		if d != null:
			for name in d.get_directories():
				if name != keep:
					_remove_tree(root.path_join(name))
			for name in d.get_files():
				DirAccess.remove_absolute(root.path_join(name))
			if keep == "":
				DirAccess.remove_absolute(root)
	_cache = null
	_cache_for = null


static func _remove_tree(path: String) -> void:
	var d := DirAccess.open(path)
	if d == null:
		return
	for name in d.get_files():
		DirAccess.remove_absolute(path.path_join(name))
	for name in d.get_directories():
		_remove_tree(path.path_join(name))
	DirAccess.remove_absolute(path)


# ── What the SDK calls ────────────────────────────────────────────────────────────────────────


## Start the host and sign the machine in as the stored subject. Idempotent; a no-op while the
## product does not run the Sync service.
func attach() -> void:
	if _closed or host == null or _attached or not _core.enabled("sync"):
		return
	while _attaching:
		await host.get_tree().process_frame
	if _attached:
		return
	_attaching = true
	# The compiled mirror is read now, so a mirror set after configure() counts.
	var mirror := _config._compiled_catalog()
	host._opts["catalog"] = mirror if not mirror.is_empty() else null
	var started: Dictionary = await host.start()
	if not started["ok"]:
		push_warning("Cloud Sync: the host could not start")
		_attaching = false
		return
	if not _listening:
		_listening = true
		host.events.connect(_on_events)
	_config._use_sync(_port)
	# A journal saved while signed in still names its subject.
	_subject = host.machine().subject()
	# A-2: an empty stored subject is unknown (offline boot, discovery not loaded): nothing changes.
	var stored: String = _core.cache.subject
	if stored != "":
		await _sign_in(stored)
	await _open_bulk()
	_surface_interrupted()
	_attached = true
	_attaching = false


## An identity change (`signedIn`, `signedOut`, `subjectChanged`): queued, handled in order.
func on_identity(kind: String, subject: String, _previous: String = "") -> void:
	if kind != "signedOut":
		_allow_ring_holds()
	_enqueue(func() -> void: await _on_identity(kind, subject))


## Discovery just loaded: tell the machine, and start the host if it has not started.
func note_discovery() -> void:
	if host != null and host.is_started():
		host.note_discovery()
	attach()


## The signed config document refreshed: lift a block, rebuild if the document changed.
func note_document_refreshed() -> void:
	if host != null and host.is_started():
		host.note_document_refreshed()


## The licence was deactivated: the principal is gone with the device, and the synced data with it
## (also when no principal was held).
func on_deactivated() -> void:
	await _drain()
	if host != null and host.is_started():
		await _leave()
	await _join_chain()
	await _forget()
	_subject = null


## The identity client's pre-sign-out hook (A-3): [Connect leave], flush (bounded), the machine signs
## out, the ring forgets, the data is purged. The flush comes first, while the root is held. A ring
## that cannot forget its root stops the sign-out (D-13): the failing result is returned, nothing is
## purged and the identity session stays; a retry forgets again. A purge failure is reported as
## `purgeFailed` and never changes the result.
func before_sign_out() -> PKeyResult:
	if before_leave.is_valid():
		await before_leave.call()
	await _drain()
	_forgot = false
	_forget_error = null
	_in_sign_out = true
	if _keyring != null and _keyring.has_method("begin_sign_out"):
		_keyring.begin_sign_out()
	if host != null and host.is_started() and _subject != null:
		var m: Object = host.machine()
		if m.subject() != null:
			m.sign_out(false)
			host.deliver_events()
			await host.flush(PKeyConstants.SYNC_SIGNOUT_FLUSH_MS)
	# The machine's own `signedOut` event forgets; if it never came (nothing held, or a failure above),
	# forget now. Purge runs also when Sync is off.
	await _join_chain()
	if not _forgot:
		await _forget()
	_in_sign_out = false
	if _forget_error != null:
		_allow_ring_holds()
		return _forget_error
	_subject = null
	return PKeyResult.success()


func _allow_ring_holds() -> void:
	if _keyring != null and _keyring.has_method("allow_holds"):
		_keyring.allow_holds()


func close() -> void:
	_closed = true
	for handle: PKeyCollection in _collections.values():
		handle.close()
	_collections = {}
	if host != null and is_instance_valid(host):
		host.close()
		host.queue_free()
	host = null


# ── Identity events, one at a time ────────────────────────────────────────────────────────────


func _enqueue(fn: Callable) -> void:
	if _closed:
		return
	_queue.append(fn)
	if not _running:
		_run_queue()


func _run_queue() -> void:
	_running = true
	while not _queue.is_empty():
		var fn: Callable = _queue.pop_front()
		await fn.call()
	_running = false


## Wait for every identity event queued so far (bounded).
func _drain() -> void:
	if host == null:
		return
	var deadline := Time.get_ticks_msec() + 30000
	while (_running or not _queue.is_empty()) and Time.get_ticks_msec() < deadline:
		await host.get_tree().process_frame


func _on_identity(kind: String, subject: String) -> void:
	await attach()
	if host == null or not host.is_started():
		return
	# A key return with no subject leaves the account the device held, as a sign-out does.
	if kind == "signedOut" or (kind == "activated" and subject == ""):
		await _leave()
		return
	if subject == "":
		return  # unknown (A-2)
	if subject != _subject:
		await _sign_in(subject)


func _sign_in(subject: String) -> void:
	if host == null or not host.is_started():
		return
	# Another person: the first one leaves (unsent edits dropped, then forgotten) before this one starts.
	# The device credential is already the new person's, so nothing is sent for the old one (A-1).
	if _subject != null and _subject != subject:
		_keep_subject = subject
		await _sign_out_now()
		_keep_subject = null
	# Once per install, before the first principal arrives so the values enter at the floor and a newer
	# cloud value wins. The marker is written after the sign-in succeeded (A-6).
	var mark: bool = host.import_pending(_config._importable())
	_subject = subject
	var r: Dictionary = host.sign_in(subject)
	if not r["ok"]:
		_subject = null
		push_warning("Cloud Sync: the sign-in was refused")
		return
	if mark:
		host.mark_imported()
	host.deliver_events()
	host.touch()
	await _open_bulk()
	await _join_chain()


## What a native bulk channel pins at open: the product, the origin of the sync routes and the signed-in subject.
func _bulk_context() -> Dictionary:
	if host == null or not (_subject is String):
		return {}
	var ctx: Dictionary = host.request_context()
	var parts := PKeyAndroidBulk.split_url((ctx["url"] as Callable).call("/"))
	return {"product": ctx["product"], "origin": parts.get("origin", ""), "subject": _subject}


## D-11: tell the journaled saves uploads no live write holds, once, as `transferFailed` (code `transfer-failed`).
func _surface_interrupted() -> void:
	if saves != null and _journal != null and _subject is String:
		saves.surface_interrupted(_journal.list())


## Open the bulk channel once per session, naming the journaled transfers to keep (D-7: the journal and the
## server are the truth; the channel keeps no ledger). A transfer the channel lost is sent again by the
## journal's own resume.
func _open_bulk() -> void:
	if _files == null or _bulk_open or _journal == null or not (_subject is String) or not _files.batching():
		return
	_bulk_open = true
	await _files.open_channel(_journal.list())


## The person changed (A-1): never talks to the server. Unsynced edits are discarded and the old
## synced values leave memory before anything waits.
func _sign_out_now() -> void:
	_subject = null
	host.machine().sign_out(true)
	host.deliver_events()
	host.touch()
	await _join_chain()


## The device was deactivated, or the identity is gone: leave the principal.
func _leave() -> void:
	if host == null or not host.is_started():
		return
	var m: Object = host.machine()
	if m.subject() == null:
		_subject = null  # A-4: a stale subject is dropped when the machine holds none
		return
	m.sign_out(false)
	host.deliver_events()
	host.touch()
	await _join_chain()


# ── The machine's events ──────────────────────────────────────────────────────────────────────


func _on_events(events: Array) -> void:
	var left := false
	var involuntary := false
	for e: Dictionary in events:
		if e.get("type") == "signedOut" and FORGETTING.has(e.get("reason")):
			left = true
			involuntary = involuntary or e["reason"] == "accountRequired" or e["reason"] == "subjectChanged"
	# The root leaves memory before anything else runs.
	if left:
		_forgot = true
		_forgets += 1
		_forget_task()
	var offers: Array = []
	for e: Dictionary in events:
		if e.get("type") == "signInOffered":
			offers.append(e)
	for e: Dictionary in events:
		if e.get("type") == "signedOut":
			_subject = null
		if e.get("type") == "change":
			_config._note_sync_change(e["keys"], e["origin"])
		if left and e.get("type") == "signInOffered":
			continue  # the offer follows the forget (A-5)
		_deliver(e)
	if left:
		_after_forget(offers, involuntary)


func _deliver(e: Dictionary) -> void:
	var out := e.duplicate()
	if e.get("type") == "signInOffered":
		out["signInUrl"] = safe_sign_in_url(e.get("signInUrl"), _core.base_url)
	if _emit.is_valid():
		_emit.call(out)


## The offer follows the forget, so a person never sees it before their data is gone. Only the
## involuntary reasons make one; a plain sign-out does not.
func _after_forget(offers: Array, involuntary: bool) -> void:
	await _join_chain()
	if offers.is_empty() and involuntary:
		_deliver({"type": "signInOffered", "signInUrl": null})
	for o: Dictionary in offers:
		_deliver(o)


func _forget_task() -> void:
	await _forget()
	_forgets -= 1


## Drop the ring (the root first), then the synced data. Each step is tried whatever the other did; a
## failure is logged, never raised, and never replaces the sign-out's own error.
func _forget() -> void:
	_forgot = true
	# The bulk channel closes first: its requests carry the person's sealed bodies and bearer, and nothing may
	# be queued once the journal goes or the ring locks.
	if _files != null:
		_bulk_open = false
		_files.close()
	# Lock the ring first, synchronously: from here nothing is sealed for the saves, and a transfer in
	# flight fails sync-locked. Then the saves' transfers, journal and chunk cache go, and only then the
	# pin is removed.
	if _keyring != null and _keyring.has_method("lock"):
		_keyring.lock()
	if saves != null:
		await saves.purge()
	if _keyring != null:
		var r: Variant = await _keyring.forget()
		if r is PKeyResult and not r.ok:
			push_warning("Cloud Sync: the key ring pin could not be removed")
			if _in_sign_out:
				# D-13: a root that cannot be deleted must not be left behind under a signed-out device.
				_forget_error = r
				return
	if host != null and is_instance_valid(host):
		var removed: bool = await host.purge()
		if not removed:
			push_warning("Cloud Sync: the synced data could not be deleted")
			if _emit.is_valid():
				_emit.call({"type": "purgeFailed"})


## Wait for the forgets started so far (bounded).
func _join_chain() -> void:
	if host == null:
		return
	var deadline := Time.get_ticks_msec() + CHAIN_WAIT_MS
	while _forgets > 0 and Time.get_ticks_msec() < deadline:
		await host.get_tree().process_frame
	if _forgets > 0:
		push_warning("Cloud Sync: a forget is still waiting")


## A sign-in URL fit to hand to the app (A-5): no control character or whitespace; a path is resolved
## against the Worker origin; only an https URL on that origin is kept. Else null.
static func safe_sign_in_url(url: Variant, base_url: String) -> Variant:
	if not (url is String) or url == "":
		return null
	var s: String = url
	for i in s.length():
		var c := s.unicode_at(i)
		if c <= 0x20 or c == 0x7f or (c >= 0x80 and c <= 0x9f):
			return null
	var base := PKeyTransport.parse_url(base_url)
	if base.is_empty():
		return null
	var resolved := s
	if s.begins_with("/"):
		if s.begins_with("//") or s.contains("\\"):
			return null
		resolved = PKeyTransport.resolve(base_url, s)
	var u := PKeyTransport.parse_url(resolved)
	if u.is_empty() or u["scheme"] != "https" or u["origin"] != base["origin"]:
		return null
	return resolved


## The saves' port onto this API: every dependency PKeySaves holds is a method here, which reaches the API
## through a weak reference, so the saves and the API form no cycle.
class _SavesPort:
	extends RefCounted
	var _api: WeakRef = null

	func set_api(a: Object) -> void:
		_api = weakref(a)

	func _owner() -> Object:
		return _api.get_ref() if _api != null else null

	func request_context() -> Dictionary:
		var a: Object = _owner()
		return a.host.request_context() if a != null and a.host != null else {"product": "", "token": "", "headers": func(x: Dictionary) -> Dictionary: return x, "url": func(p: String) -> String: return p}

	func blind_record(collection: String, id: String) -> String:
		var a: Object = _owner()
		if a == null or a.host == null:
			return ""
		var codec: Object = a.host.codec()
		return codec.blind_record(collection, id) if codec.has_method("blind_record") else ""

	func file_codec() -> Variant:
		var a: Object = _owner()
		return a._file_codec() if a != null else null

	func chunk_cache() -> Variant:
		var a: Object = _owner()
		return a._chunk_cache() if a != null else null

	func gate() -> Variant:
		var a: Object = _owner()
		if a == null:
			return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_FAILED, "Cloud Sync is gone.", {"reason": "sync-not-started"})
		return await a._saves_gate()

	func emit_transfer(event: Dictionary) -> void:
		var a: Object = _owner()
		if a != null:
			a._emit_transfer(event)

	func purge_files() -> void:
		var a: Object = _owner()
		if a != null:
			a._purge_save_files()


## The config client's port onto the machine.
class _Port:
	extends RefCounted
	var _api: WeakRef = null
	var api: Object:
		get:
			return _api.get_ref() if _api != null else null

	func set_api(a: Object) -> void:
		_api = weakref(a)

	func active() -> bool:
		var a: Object = api
		return a != null and a.host != null and a.host.is_started() and a._subject != null

	func _after() -> void:
		# The machine queued the edit; deliver its events now (nothing is due before the debounce,
		# so this does not wait on the network), and let the pump run.
		api.host.deliver_events()
		api.host.touch()

	func set_value(key: String, value: Variant) -> Dictionary:
		api.host.ensure_current()
		api.host.catch_up()
		var r: Dictionary = api.host.machine().set_value(key, value)
		_after()
		return r

	func clear_value(key: String) -> Dictionary:
		api.host.ensure_current()
		api.host.catch_up()
		var r: Dictionary = api.host.machine().clear_value(key)
		_after()
		return r

	func get_value(key: String) -> Dictionary:
		return api.host.machine().get_value(key)

	func state(key: String) -> String:
		return String(api.host.machine().setting_state(key)["sync"])
