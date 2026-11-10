extends RefCounted
# @pkey-feature sync.settings config.sync
# The Cloud Sync settings API (U-21.9) on a real autoload over a loopback server. One group per rule
# of the plan's section 3: A-1 to A-7, and the sign-out chain (flush, machine sign-out, ring forget,
# purge) in that order.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")
const BulkChannel := preload("res://addons/polaris_key/services/cloud_sync/bulk_channel.gd")

const PRODUCT := "diceroll"
const KEY := "a.x"


## A key ring that logs and answers like the real one's `forget()`.
class FakeRing:
	extends RefCounted
	var log: Array
	var file_path: String
	var fail := false
	var file_seen_at_forget := false

	func _init(p_log: Array, p_file: String) -> void:
		log = p_log
		file_path = p_file

	func forget() -> PKeyResult:
		await Engine.get_main_loop().process_frame
		file_seen_at_forget = FileAccess.file_exists(file_path)
		log.append("ring.forget")
		return PKeyResult.failure(&"store-failed", "x") if fail else PKeyResult.success()


## A state file whose delete fails (a purge that cannot finish).
class FailingState:
	extends "res://addons/polaris_key/services/cloud_sync/state.gd"

	func remove() -> bool:
		return false


## A ring that also logs `lock()`, the moment the root leaves memory.
class LoggingRing:
	extends FakeRing

	func lock() -> void:
		log.append("ring.lock")


## A bulk channel that logs `close()`, the moment the native lanes are cancelled.
class LoggingChannel:
	extends BulkChannel
	var log: Array

	func _init(p_log: Array) -> void:
		log = p_log

	func available() -> bool:
		return true

	func close() -> void:
		log.append("channel.close")


## A state file whose rewrite fails (the blocked state cannot be saved).
class FailingSave:
	extends "res://addons/polaris_key/services/cloud_sync/state.gd"

	func save(_file: Dictionary) -> bool:
		return false


class OpenCodec:
	extends CodecPort

	func locked() -> bool:
		return false


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_urls_and_options(t)
	await _settings_and_machine(t)
	await _person_change_and_offline(t)
	await _sign_out_chain(t)
	await _elsewhere_and_offers(t)
	await _account_required_persisted(t)
	await _account_required_routes(t)
	await _account_required_hardening(t)
	await _import_and_document(t)
	await _quit_durability(t)
	_licence_free(t)
	await PKeyTestFixtures.frames(3)  # queued frees run before the next suite and the exit
	return true


## Every request path the handler saw, "METHOD /path".
var _paths: Array = []


func _handler(log: Array, version: Array, extra: Callable = Callable()) -> Callable:
	return func(req: Dictionary) -> Dictionary:
		_paths.append("%s %s" % [req["method"], req["path"]])
		if extra.is_valid():
			var r: Variant = extra.call(req)
			if r != null:
				return r
		if req["method"] == "GET":
			return {"status": 200, "body": "{\"cursor\":1,\"serverNow\":1760000000000}"}
		log.append("push")
		var parsed: Variant = JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())
		var results := []
		for mu in parsed["mutations"]:
			version[0] += 1
			results.append({"mutationId": int(mu["mutationId"]), "status": "ok", "version": version[0]})
		return {"status": 200, "body": JSON.stringify({"results": results, "cursor": version[0], "serverNow": 1760000000000})}


## A started SDK on a loopback server with the sync service and one declared setting.
func _make(handler: Callable, services := PackedStringArray(["license", "config", "sync"]), codec: Object = null, encryption := "server") -> Dictionary:
	var server := PKeyTestFixtures.new_server(handler)
	var dir := PKeyTestFixtures.scratch_dir("cloud_sync_settings")
	var o := PKeyOptions.new()
	o.product_slug = PRODUCT
	o.version = "1.0.0"
	o.base_url = server.base_url()
	o.store = PKeyMemoryStore.new("", "pkeyt_cached")
	o.expected_services = services
	o.build_stamp_path = ""
	o.persist_settings = false
	o.store_root = dir
	o.cloud_sync_encryption = encryption
	o.cloud_sync_codec = codec
	var sdk := PKeyTestFixtures.new_sdk()
	var events: Array = []
	sdk.event.connect(func(kind: String, data: Dictionary) -> void:
		if kind == "cloudSync":
			events.append(data))
	var cfg: PKeyResult = sdk.configure(o)
	sdk.config.set_compiled_catalog({"CATALOG_VERSION": 1, "DEFAULTS": {}, "ENTRIES": [{"key": KEY, "kind": "config", "label": "x", "schema": {"type": "number"}}]})
	await sdk.start()
	sdk.config.env = PKeyConfigEnv.for_process(PKeyOptions.CONFIG_ENV_ALWAYS, "PKEY_CONFIG_", true, "linux", PackedStringArray())
	return {"sdk": sdk, "server": server, "dir": dir, "events": events, "configured": cfg}


func _done(c: Dictionary) -> void:
	if c["sdk"].cloud_sync != null:
		c["sdk"].cloud_sync.close()
	c["sdk"].queue_free()
	c["server"].stop()
	PKeyTestFixtures.remove_tree(c["dir"])


## Sign in `subject` as the identity client would (the session's stored subject, then the event).
func _sign_in(c: Dictionary, subject: String) -> void:
	var sdk: Node = c["sdk"]
	sdk.core.cache.set_subject(subject)
	sdk.cloud_sync.on_identity("signedIn", subject, "")
	await sdk.cloud_sync._drain()
	await sdk.cloud_sync.host.idle()


func _urls_and_options(t: PKeyTestContext) -> void:
	var base := "https://key.plrs.im"
	var Sync := PKeyCloudSync
	t.check("A-5: a path is resolved against the Worker origin", Sync.safe_sign_in_url("/signin?x=1", base) == "https://key.plrs.im/signin?x=1")
	t.check("A-5: an https URL on the origin is kept", Sync.safe_sign_in_url("https://key.plrs.im/a", base) == "https://key.plrs.im/a")
	t.check("A-5: another origin, http, a scheme-relative or backslash URL is refused", Sync.safe_sign_in_url("https://evil.example/a", base) == null and Sync.safe_sign_in_url("http://key.plrs.im/a", base) == null \
			and Sync.safe_sign_in_url("//evil.example/a", base) == null and Sync.safe_sign_in_url("/\\evil.example", base) == null and Sync.safe_sign_in_url("javascript:alert(1)", base) == null)
	t.check("A-5: control characters and whitespace are refused", Sync.safe_sign_in_url("/a b", base) == null and Sync.safe_sign_in_url("/a\n", base) == null and Sync.safe_sign_in_url("\thttps://key.plrs.im/", base) == null)
	t.check("A-5: the default port is normalised, the path is not restricted", \
			Sync.safe_sign_in_url("https://key.plrs.im:443/a/b?c=d#e", base) == "https://key.plrs.im:443/a/b?c=d#e" \
			and Sync.safe_sign_in_url("https://key.plrs.im/", base) == "https://key.plrs.im/")
	t.check("A-5: userinfo, any backslash, a trailing dot, a punycode lookalike and another port are refused", \
			Sync.safe_sign_in_url("https://user@key.plrs.im/a", base) == null \
			and Sync.safe_sign_in_url("https://key.plrs.im\\@evil.example/", base) == null \
			and Sync.safe_sign_in_url("https://key.plrs.im/a\\b", base) == null and Sync.safe_sign_in_url("https://key.plrs.im./a", \
					base) == null and Sync.safe_sign_in_url("https://xn--key-plrs.im/a", base) == null \
			and Sync.safe_sign_in_url("https://key.plrs.im:8443/a", base) == null and Sync.safe_sign_in_url("https://key.plrs.im:443@evil.example/", base) == null)
	t.check("A-5: null and non-strings stay null", Sync.safe_sign_in_url(null, base) == null and Sync.safe_sign_in_url(5, base) == null and Sync.safe_sign_in_url("", base) == null)
	var o := PKeyOptions.new()
	o.product_slug = PRODUCT
	o.cloud_sync_encryption = "plain"
	var r := PKeyCore.create(o, null, "0.1.0")
	t.check("A-7: the mode is app code's and must be e2e or server", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS)


func _settings_and_machine(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	# No Sync service: the typed product N/A, and config writes stay local.
	var c0 := await _make(_handler(log, version), PackedStringArray(["license", "config"]))
	var st: PKeyResult = c0["sdk"].cloud_sync.status()
	t.check("status: a product without the Sync service gets the typed N/A", not st.ok and st.code == PKeyErrors.SERVICE_UNAVAILABLE and st.detail.get("reason") == "product")
	var fl: PKeyResult = await c0["sdk"].cloud_sync.flush()
	t.check("flush: the same N/A", not fl.ok and fl.code == PKeyErrors.SERVICE_UNAVAILABLE)
	t.check("config: without Cloud Sync a setting is local", c0["sdk"].config.setting(KEY).sync() == "local" and c0["sdk"].config.set_value(KEY, 1.5).ok)
	_done(c0)

	var c := await _make(_handler(log, version))
	var sdk: Node = c["sdk"]
	t.check("configure: the cloud_sync API exists", c["configured"].ok and sdk.cloud_sync != null and sdk.cloud_sync.status().ok)
	t.check("status: local before a person signs in", sdk.cloud_sync.status().detail["state"] == "local")
	await _sign_in(c, "ps_a")
	var changed := []
	sdk.config.config_changed.connect(func(keys: PackedStringArray) -> void: changed.append(Array(keys)))
	var set_r: PKeyResult = sdk.config.set_value(KEY, 2)
	t.check("config: a write goes through the machine and reads back", set_r.ok and sdk.config.get_value(KEY) == 2 and sdk.config.get_config_source(KEY) == &"local", str(set_r))
	t.check("config: the change is reported once, synchronously", changed == [[KEY]], str(changed))
	t.check("setting.sync(): pending while the edit waits", sdk.config.setting(KEY).sync() == "pending")
	var bad: PKeyResult = sdk.config.set_value(KEY, "text")
	t.check("config: a value the schema refuses is invalid-options (the machine's bad_request)", not bad.ok and bad.code == PKeyErrors.INVALID_OPTIONS)
	var posts := log.size()
	var fr: PKeyResult = await sdk.cloud_sync.flush()
	t.check("flush: sends the edit and answers the status", fr.ok and log.size() == posts + 1 and fr.detail["pending"] == 0, str(fr))
	t.check("setting.sync(): synced after the push", sdk.config.setting(KEY).sync() == "synced")
	var sync_paths := _paths.filter(func(p: String) -> bool: return p.contains("/sync"))
	t.check("wiring: the host's requests carry the product prefix exactly once", not sync_paths.is_empty() and sync_paths.all(func(p: String) -> bool: return p.begins_with("GET /%s/sync?" % PRODUCT) or p == "POST /%s/sync/ops" % PRODUCT), str(sync_paths))
	var cleared: PKeyResult = sdk.config.clear(KEY)
	t.check("config: clear goes through the machine too", cleared.ok and sdk.config.get_config_source(KEY) != &"local")
	t.check("events: the stream carries no value", c["events"].all(func(e: Dictionary) -> bool: return not e.has("value")))
	_done(c)


func _person_change_and_offline(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var c := await _make(_handler(log, version))
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	sdk.config.set_value(KEY, 3)
	var ring := FakeRing.new(log, sdk.cloud_sync.host._file.path())
	sdk.cloud_sync._keyring = ring
	var pushes_before := log.count("push")
	# A-1: the person changes. The credential is already the new person's: nothing is sent for the old one.
	sdk.core.cache.set_subject("ps_b")
	sdk.cloud_sync.on_identity("subjectChanged", "ps_b", "ps_a")
	await sdk.cloud_sync._drain()
	await sdk.cloud_sync.host.idle()
	var left: Array = c["events"].filter(func(e: Dictionary) -> bool: return e.get("type") == "signedOut")
	t.check("A-1: the old person's unsent edit is discarded, never pushed", log.count("push") == pushes_before and left.size() >= 1 and sdk.cloud_sync.host.machine().subject() == "ps_b")
	t.check("A-1: the old person's value left memory before the new one's", sdk.config.get_value(KEY) != 3)
	t.check("A-1: the ring was forgotten for the person who left", log.has("ring.forget"))
	_done(c)

	# A-2: an offline boot is not a sign-out. The journal keeps its person; an empty stored subject changes nothing.
	log.clear()
	var c2 := await _make(_handler(log, version))
	await _sign_in(c2, "ps_a")
	c2["sdk"].config.set_value(KEY, 4)
	await c2["sdk"].cloud_sync.flush()
	var dir: String = c2["dir"]
	c2["sdk"].cloud_sync.close()
	c2["sdk"].queue_free()
	var o: PKeyOptions = c2["sdk"].core.options
	var sdk2 := PKeyTestFixtures.new_sdk()
	sdk2.configure(o)
	await sdk2.start()
	var evs := []
	sdk2.event.connect(func(k: String, d: Dictionary) -> void: evs.append(d))
	sdk2.core.cache.set_subject("")
	await sdk2.cloud_sync.attach()
	await sdk2.cloud_sync.host.idle()
	var ok_boot: bool = sdk2.cloud_sync.host.machine() != null and sdk2.cloud_sync.host.machine().subject() == "ps_a"
	t.check("A-2: an unknown stored subject at boot changes nothing (no sign-out, no forget)", ok_boot and evs.filter(func(e: Dictionary) -> bool: return e.get("type") == "signedOut").is_empty())
	sdk2.cloud_sync.on_identity("signedOut", "", "ps_a")
	await sdk2.cloud_sync._drain()
	await sdk2.cloud_sync.host.idle()
	t.check("A-2/A-4: only a readable signedOut leaves", sdk2.cloud_sync.host.machine().subject() == null)
	sdk2.cloud_sync.close()
	sdk2.queue_free()
	c2["server"].stop()
	PKeyTestFixtures.remove_tree(dir)


func _sign_out_chain(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var c := await _make(_handler(log, version))
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	var state_path: String = sdk.cloud_sync.host._file.path()
	var ring := FakeRing.new(log, state_path)
	sdk.cloud_sync._keyring = ring
	sdk.config.set_value(KEY, 7)
	log.clear()
	# The identity client's hook list holds the chain (it replaced the ring's standalone forget).
	var hooks: Array = sdk.identity._before_sign_out
	var chain := hooks.filter(func(h: Callable) -> bool: return h.get_method() == "_forget_ring")
	t.check("chain: the identity client runs one pre-sign-out hook that is Cloud Sync's", chain.size() == 1)
	await chain[0].call()
	t.check("chain: flush first (the edit is pushed), then the ring forgets", log == ["push", "ring.forget"], str(log))
	t.check("chain: the state file still existed when the ring forgot, and is gone after the purge", ring.file_seen_at_forget and not FileAccess.file_exists(state_path))
	t.check("chain: the machine is signed out and empty", sdk.cloud_sync.host.machine().subject() == null and sdk.cloud_sync.status().detail["state"] == "local")
	var types: Array = c["events"].map(func(e: Dictionary) -> Variant: return e.get("type"))
	t.check("chain: the app hears signedOut, and no offer for a voluntary sign-out", types.has("signedOut") and not types.has("signInOffered"), str(types))
	_done(c)

	# D-13: a ring that cannot forget its root stops the sign-out: the error is returned, nothing is
	# purged, the identity session stays; a retry (the ring healthy again) completes it.
	log.clear()
	var c2 := await _make(_handler(log, version))
	await _sign_in(c2, "ps_a")
	var state2: String = c2["sdk"].cloud_sync.host._file.path()
	var ring2 := FakeRing.new(log, state2)
	ring2.fail = true
	c2["sdk"].cloud_sync._keyring = ring2
	c2["sdk"].config.set_value(KEY, 8)
	var stopped: Variant = await c2["sdk"]._forget_ring()
	t.check("D-13: a failing ring.forget returns its error to the sign-out", stopped is PKeyResult and not stopped.ok and stopped.code == &"store-failed", str(stopped))
	t.check("D-13: nothing is purged and the session's subject is kept", ring2.file_seen_at_forget and FileAccess.file_exists(state2) and c2["sdk"].core.cache.subject == "ps_a")
	ring2.fail = false
	var retried: Variant = await c2["sdk"]._forget_ring()
	t.check("D-13: a retry with a healthy ring completes the chain", retried is PKeyResult and retried.ok and not FileAccess.file_exists(state2))
	_done(c2)

	# A-3: a purge that fails is reported as purgeFailed and does not change the sign-out's result.
	log.clear()
	var c4 := await _make(_handler(log, version))
	await _sign_in(c4, "ps_a")
	var h4: Node = c4["sdk"].cloud_sync.host
	h4._file = FailingState.new(h4._file.dir, PRODUCT, null)
	c4["sdk"].cloud_sync._keyring = FakeRing.new(log, h4._file.path())
	var res4: Variant = await c4["sdk"]._forget_ring()
	var failed_evt: bool = c4["events"].any(func(e: Dictionary) -> bool: return e.get("type") == "purgeFailed")
	t.check("A-3: a purge failure emits purgeFailed and the sign-out's own result is unchanged", failed_evt and res4 is PKeyResult and res4.ok, str(res4))
	_done(c4)

	# Purge also runs when Sync is off, and the ring is still forgotten.
	log.clear()
	var c3 := await _make(_handler(log, version), PackedStringArray(["license", "config"]))
	var state3: String = c3["sdk"].cloud_sync.host._file.path()
	DirAccess.make_dir_recursive_absolute(c3["sdk"].cloud_sync.host._file.dir)
	var f := FileAccess.open(state3, FileAccess.WRITE)
	f.store_string("stale")
	f.close()
	var ring3 := FakeRing.new(log, state3)
	c3["sdk"].cloud_sync._keyring = ring3
	await c3["sdk"].cloud_sync.before_sign_out()
	t.check("A-3: with Sync off a sign-out still forgets the ring and deletes the file", log == ["ring.forget"] and not FileAccess.file_exists(state3))
	_done(c3)


func _elsewhere_and_offers(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var mode := ["ok"]
	var handler := _handler(log, version, func(req: Dictionary) -> Variant:
		if req["method"] == "POST" and mode[0] == "account_required":
			return {"status": 403, "body": "{\"error\":{\"code\":\"account_required\",\"signInUrl\":\"https://evil.example/x\"}}"}
		if req["method"] == "GET" and mode[0] == "other_person":
			return {"status": 200, "body": "{\"subject\":\"ps_zzz\",\"cursor\":1}"}
		return null)
	var c := await _make(handler)
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	var ring := FakeRing.new(log, sdk.cloud_sync.host._file.path())
	sdk.cloud_sync._keyring = ring
	sdk.config.set_value(KEY, 9)
	mode[0] = "account_required"
	log.clear()
	await sdk.cloud_sync.flush()
	await sdk.cloud_sync._join_chain()
	await PKeyTestFixtures.frames(3)
	var order: Array = c["events"].map(func(e: Dictionary) -> Variant: return e.get("type"))
	var offer: Dictionary = {}
	for e: Dictionary in c["events"]:
		if e.get("type") == "signInOffered":
			offer = e
	t.check("A-4: a sign-out that happens elsewhere (account_required) reaches Cloud Sync as signedOut and forgets", order.has("signedOut") and log.has("ring.forget"), str(order))
	t.check("A-5: the offer comes after the forget, and a foreign URL is dropped to null", not offer.is_empty() and offer.get("sign_in_url") == null and order.find("signInOffered") > order.find("signedOut"), str(offer))
	# A-4: a stale subject is dropped when the machine holds none.
	sdk.cloud_sync._subject = "ps_stale"
	await sdk.cloud_sync._leave()
	t.check("A-4: a stale subject is dropped when the machine holds none", sdk.cloud_sync._subject == null)
	_done(c)

	# subjectChanged: an offer with no URL, after the forget.
	mode[0] = "other_person"
	log.clear()
	var c2 := await _make(handler)
	c2["sdk"].core.cache.set_subject("ps_a")
	c2["sdk"].cloud_sync.on_identity("signedIn", "ps_a", "")
	await c2["sdk"].cloud_sync._drain()
	await c2["sdk"].cloud_sync.host.idle()
	await PKeyTestFixtures.frames(5)
	var kinds: Array = c2["events"].map(func(e: Dictionary) -> Variant: return e.get("type"))
	var has_null_offer := false
	for e: Dictionary in c2["events"]:
		has_null_offer = has_null_offer or (e.get("type") == "signInOffered" and e.get("sign_in_url") == null)
	t.check("A-5: a person change by the Worker's own word is an involuntary leave with a null offer", kinds.has("signedOut") and has_null_offer, str(kinds))
	_done(c2)


## U-52: `account_required` keeps the machine as it stands (blocked, no partition) and the refused subject
## with it. A relaunch stays blocked and sends nothing for that subject; another subject lifts it.
func _account_required_persisted(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var mode := ["ok"]
	var handler := _handler(log, version, func(req: Dictionary) -> Variant:
		if mode[0] == "account_required" and req["path"].contains("/sync"):
			return {"status": 403, "body": "{\"error\":{\"code\":\"account_required\",\"signInUrl\":\"https://evil.example/x\"}}"}
		return null)
	var c := await _make(handler)
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	var ring := FakeRing.new(log, sdk.cloud_sync.host._file.path())
	sdk.cloud_sync._keyring = ring
	sdk.config.set_value(KEY, 9)
	mode[0] = "account_required"
	await sdk.cloud_sync.flush()
	await sdk.cloud_sync._join_chain()
	await PKeyTestFixtures.frames(3)
	var host: Node = sdk.cloud_sync.host
	var types: Array = c["events"].map(func(e: Dictionary) -> Variant: return e.get("type"))
	var left: Array = c["events"].filter(func(e: Dictionary) -> bool: return e.get("type") == "signedOut")
	t.check("U-52: the app hears signedOut(accountRequired) with the edit counted, and no unsyncedData", left.size() == 1 \
			and left[0]["reason"] == "accountRequired" and left[0]["unsynced"] >= 1 and not types.has("unsyncedData"), str(c["events"]))
	t.check("U-52: the ring forgot, and the status reads blocked (not local)", log.has("ring.forget") \
			and sdk.cloud_sync.status().detail["state"] == "blocked" and sdk.cloud_sync.status().detail["reason"] == "account_required")
	var saved: Dictionary = host._file.load_file()
	t.check("U-52: the machine is saved as it stands: blocked, no partition for the subject, the refused subject named", \
			FileAccess.file_exists(host._file.path()) and saved["refused"] == "ps_a" and saved["persisted"]["blocked"] == "account_required" \
			and not saved["persisted"]["partitions"].has("ps_a"), str(saved.get("refused")))
	var offer: Dictionary = {}
	for e: Dictionary in c["events"]:
		if e.get("type") == "signInOffered":
			offer = e
	t.check("U-52: the offer's foreign sign-in URL is vetted to null", not offer.is_empty() and offer.get("sign_in_url") == null)
	# While blocked an edit stays local and nothing is sent.
	var sync_before := _paths.filter(func(p: String) -> bool: return p.contains("/sync")).size()
	sdk.config.set_value(KEY, 10)
	await sdk.cloud_sync.flush()
	t.check("U-52: blocked, an edit goes nowhere", _paths.filter(func(p: String) -> bool: return p.contains("/sync")).size() == sync_before)
	# Relaunch: same options, same store, the same subject still signed in at the identity client.
	var o: PKeyOptions = sdk.core.options
	sdk.cloud_sync.close()
	sdk.queue_free()
	mode[0] = "ok"
	var sdk2 := PKeyTestFixtures.new_sdk()
	sdk2.configure(o)
	await sdk2.start()
	# The identity client's cached subject is replayed at launch through attach(), not as a sign-in.
	sdk2.core.cache.set_subject("ps_a")
	await sdk2.cloud_sync.attach()
	await sdk2.cloud_sync._drain()
	await sdk2.cloud_sync.host.idle()
	var h2: Node = sdk2.cloud_sync.host
	var sync_after := _paths.filter(func(p: String) -> bool: return p.contains("/sync")).size()
	t.check("U-52: a relaunch with the same subject stays blocked, signed out, and sends nothing", h2.machine().subject() == null \
			and sdk2.cloud_sync.status().detail["state"] == "blocked" and h2.refused() == "ps_a" and sync_after == sync_before, \
			"%d %d" % [sync_before, sync_after])
	t.check("U-52: the relaunch holds no root", h2.machine().has_root() == false)
	sdk2.cloud_sync.on_identity("signedIn", "ps_b", "")
	await sdk2.cloud_sync._drain()
	await h2.idle()
	t.check("U-52: a different subject lifts the block", h2.machine().subject() == "ps_b" and sdk2.cloud_sync.status().detail["state"] != "blocked" and h2.refused() == null)
	sdk2.cloud_sync.close()
	sdk2.queue_free()
	c["server"].stop()
	PKeyTestFixtures.remove_tree(c["dir"])

	# A sign-out clears the refusal: the same subject may sign in again.
	log.clear()
	var c2 := await _make(handler)
	var sdk3: Node = c2["sdk"]
	await _sign_in(c2, "ps_a")
	mode[0] = "account_required"
	sdk3.config.set_value(KEY, 1)
	await sdk3.cloud_sync.flush()
	await sdk3.cloud_sync._join_chain()
	mode[0] = "ok"
	t.check("U-52: refused, blocked", sdk3.cloud_sync.host.refused() == "ps_a")
	await sdk3.cloud_sync.before_sign_out()
	t.check("U-52: a sign-out purges the blocked state and the refusal", sdk3.cloud_sync.host.refused() == null \
			and sdk3.cloud_sync.status().detail["state"] == "local" and not FileAccess.file_exists(sdk3.cloud_sync.host._file.path()))
	await _sign_in(c2, "ps_a")
	t.check("U-52: the same subject signs in again after a sign-out", sdk3.cloud_sync.host.machine().subject() == "ps_a")
	# F2: a sign-in the person completes in this run lifts the refusal of that same subject.
	mode[0] = "account_required"
	sdk3.config.set_value(KEY, 2)
	await sdk3.cloud_sync.flush()
	await sdk3.cloud_sync._join_chain()
	mode[0] = "ok"
	t.check("U-52: refused again", sdk3.cloud_sync.host.refused() == "ps_a" and sdk3.cloud_sync.host.machine().subject() == null)
	sdk3.cloud_sync.on_identity("signedIn", "ps_a", "")
	await sdk3.cloud_sync._drain()
	await sdk3.cloud_sync.host.idle()
	t.check("U-52: the person signing in again as the same subject lifts the refusal", sdk3.cloud_sync.host.machine().subject() == "ps_a" \
			and sdk3.cloud_sync.host.refused() == null and sdk3.cloud_sync.status().detail["state"] != "blocked")
	_done(c2)


## U-52: the key-ring route and a request in flight. A 403 account_required on a key-ring call is the same
## signal as the `/sync` one; a `/sync` request on the wire is cancelled and its answer dropped.
func _account_required_routes(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var ring_403 := [false]
	var hang_sync := [false]
	var handler := _handler(log, version, func(req: Dictionary) -> Variant:
		if ring_403[0] and req["path"].contains("devices/keyring"):
			return {"status": 403, "body": "{\"error\":{\"code\":\"account_required\",\"signInUrl\":\"/signin?product=diceroll\"}}"}
		if hang_sync[0] and req["path"].contains("/sync"):
			return {"hang": true}
		return null)
	var c := await _make(handler)
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	sdk.config.set_value(KEY, 3)
	ring_403[0] = true
	var read: PKeyResult = await sdk.keyring.read()
	await sdk.cloud_sync._join_chain()
	await PKeyTestFixtures.frames(3)
	t.check("U-52: the key-ring call's own answer is unchanged", not read.ok and String(read.code) == "account_required")
	t.check("U-52: a key-ring 403 account_required blocks Cloud Sync and forgets the root", sdk.cloud_sync.status().detail["state"] == "blocked" \
			and sdk.cloud_sync.host.refused() == "ps_a" and not sdk.keyring.unlocked())
	var offer: Dictionary = {}
	for e: Dictionary in c["events"]:
		if e.get("type") == "signInOffered":
			offer = e
	# The loopback Worker is http, so the vetting (https on the Worker's origin only) drops the path to null.
	t.check("U-52: the key-ring answer's sign-in URL is offered through the same vetting", not offer.is_empty() and offer.has("sign_in_url") and offer["sign_in_url"] == null, str(offer))
	var events_before: int = c["events"].size()
	await sdk.keyring.read()
	await PKeyTestFixtures.frames(3)
	t.check("U-52: a second 403 while blocked changes nothing", c["events"].size() == events_before)
	_done(c)

	# A /sync request on the wire when the signal arrives: cancelled, its answer dropped, nothing left armed.
	log.clear()
	var c2 := await _make(handler)
	var sdk2: Node = c2["sdk"]
	await _sign_in(c2, "ps_a")
	sdk2.config.set_value(KEY, 4)
	hang_sync[0] = true
	sdk2.cloud_sync.flush()  # not awaited: the push is out and never answered
	var waited := 0
	while c2["server"].requests.filter(func(r: Dictionary) -> bool: return r["method"] == "POST").is_empty() and waited < 200:
		await PKeyTestFixtures.frames(1)
		waited += 1
	t.check("U-52: the push is on the wire", not c2["server"].requests.filter(func(r: Dictionary) -> bool: return r["method"] == "POST").is_empty())
	var started := Time.get_ticks_msec()
	sdk2.cloud_sync.account_required(null)
	var h: Node = sdk2.cloud_sync.host
	var idle: bool = await h.idle(5000)
	t.check("U-52: the request in flight is cancelled at once, not after its 15 s timeout", idle and Time.get_ticks_msec() - started < 5000, str(Time.get_ticks_msec() - started))
	t.check("U-52: the machine is blocked with no request waiting and no timer armed", sdk2.cloud_sync.status().detail["state"] == "blocked" \
			and h._machine.take_requests().is_empty() and h._timer.is_stopped())
	_done(c2)


## U-52 hardening: a failed forget is saved, retried and holds sign-in; a late answer for someone who left,
## and one from a redirect, are ordinary; the native lanes close before the root drops; a failed rewrite of the
## blocked state deletes the file.
func _account_required_hardening(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var mode := ["ok"]
	var handler := _handler(log, version, func(req: Dictionary) -> Variant:
		if mode[0] == "account_required" and req["path"].contains("/sync"):
			return {"status": 403, "body": "{\"error\":{\"code\":\"account_required\"}}"}
		if mode[0] == "redirect" and req["path"].contains("devices/keyring"):
			return {"status": 302, "headers": {"location": "/diceroll/elsewhere"}}
		if req["path"].contains("/elsewhere"):
			return {"status": 403, "body": "{\"error\":{\"code\":\"account_required\"}}"}
		return null)

	# F3: the ring cannot forget. Saved as pending, sign-in waits, the retry at start and before sign-in clears it.
	var c := await _make(handler)
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	var ring := FakeRing.new(log, sdk.cloud_sync.host._file.path())
	ring.fail = true
	sdk.cloud_sync._keyring = ring
	sdk.config.set_value(KEY, 5)
	mode[0] = "account_required"
	await sdk.cloud_sync.flush()
	await sdk.cloud_sync._join_chain()
	var host: Node = sdk.cloud_sync.host
	t.check("U-52 forget: a failing ring.forget is kept as pending, in memory and in the saved state", host.forget_pending() and host._file.load_file()["forgetPending"] == true)
	mode[0] = "ok"
	sdk.cloud_sync.on_identity("signedIn", "ps_b", "")
	await sdk.cloud_sync._drain()
	await host.idle()
	t.check("U-52 forget: sign-in waits while the root cannot be removed", host.machine().subject() == null and host.forget_pending())
	# Relaunch with the failure still pending in the file: the start retries it with a healthy ring.
	var o: PKeyOptions = sdk.core.options
	sdk.cloud_sync.close()
	sdk.queue_free()
	log.clear()
	var sdk2 := PKeyTestFixtures.new_sdk()
	sdk2.configure(o)
	var ring2 := FakeRing.new(log, "")
	sdk2.cloud_sync._keyring = ring2
	await sdk2.start()
	await sdk2.cloud_sync.attach()
	var h2: Node = sdk2.cloud_sync.host
	t.check("U-52 forget: a relaunch retries the forget at start and clears it", log.has("ring.forget") and not h2.forget_pending() and h2._file.load_file()["forgetPending"] == false, str(log))
	sdk2.cloud_sync.on_identity("signedIn", "ps_b", "")
	await sdk2.cloud_sync._drain()
	await h2.idle()
	t.check("U-52 forget: sign-in then goes through", h2.machine().subject() == "ps_b")
	sdk2.cloud_sync.close()
	sdk2.queue_free()
	c["server"].stop()
	PKeyTestFixtures.remove_tree(c["dir"])

	# F5: an answer for someone who has since left is ignored; for the person signed in it counts.
	log.clear()
	var c2 := await _make(handler)
	var sdk3: Node = c2["sdk"]
	await _sign_in(c2, "ps_a")
	sdk3.cloud_sync.account_required_for(null, "ps_other")
	t.check("U-52 subject: an account_required for another person changes nothing", sdk3.cloud_sync.host.machine().subject() == "ps_a" and sdk3.cloud_sync.status().detail["state"] != "blocked")
	sdk3.cloud_sync.account_required_for(null, null)
	t.check("U-52 subject: one noted while nobody was signed in changes nothing either", sdk3.cloud_sync.host.machine().subject() == "ps_a")
	sdk3.cloud_sync.account_required_for(null, "ps_a")
	t.check("U-52 subject: one for the person signed in counts", sdk3.cloud_sync.host.machine().subject() == null and sdk3.cloud_sync.status().detail["state"] == "blocked")

	# F8: the blocked state cannot be rewritten: the old file (the plaintext snapshot) is deleted, the refusal stays in memory.
	_done(c2)
	log.clear()
	var c3 := await _make(handler)
	var sdk4: Node = c3["sdk"]
	await _sign_in(c3, "ps_a")
	sdk4.config.set_value(KEY, 6)
	await sdk4.cloud_sync.flush()
	var h4: Node = sdk4.cloud_sync.host
	t.check("U-52 save: the state file exists while signed in", FileAccess.file_exists(h4._file.path()))
	h4._file = FailingSave.new(h4._file.dir, PRODUCT, null)
	sdk4.cloud_sync.account_required(null)
	await sdk4.cloud_sync._join_chain()
	t.check("U-52 save: a failed rewrite of the blocked state deletes the file and keeps the refusal in memory", not FileAccess.file_exists(h4._file.path()) and h4.refused() == "ps_a")
	_done(c3)

	# The native lanes are cancelled before the root drops.
	log.clear()
	var c4 := await _make(handler)
	var sdk5: Node = c4["sdk"]
	await _sign_in(c4, "ps_a")
	sdk5.cloud_sync._files.set_channel(LoggingChannel.new(log))
	sdk5.cloud_sync._keyring = LoggingRing.new(log, sdk5.cloud_sync.host._file.path())
	log.clear()
	sdk5.cloud_sync.account_required(null)
	await sdk5.cloud_sync._join_chain()
	t.check("U-52 lanes: the bulk channel closes, then the root is locked, then the ring forgets", log.slice(0, 3) == ["channel.close", "ring.lock", "ring.forget"], str(log))
	_done(c4)

	# F6: an account_required that came through a redirect is an ordinary 403.
	mode[0] = "redirect"
	var c5 := await _make(handler)
	var sdk6: Node = c5["sdk"]
	await _sign_in(c5, "ps_a")
	var red: PKeyResult = await sdk6.keyring.read()
	await sdk6.cloud_sync._join_chain()
	await PKeyTestFixtures.frames(3)
	t.check("U-52 origin: an account_required reached through a redirect changes nothing", not red.ok \
			and sdk6.cloud_sync.host.machine().subject() == "ps_a" and sdk6.cloud_sync.status().detail["state"] != "blocked", str(red))
	_done(c5)


func _import_and_document(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var c := await _make(_handler(log, version))
	var sdk: Node = c["sdk"]
	sdk.config.set_override_store(PKeyOverrideStore.new({KEY: 5}))
	sdk.cloud_sync.attach()
	await sdk.cloud_sync.host.idle()
	var host: Node = sdk.cloud_sync.host
	t.check("A-6: the import marker is not written before a person signed in", not host._file.imported())
	await _sign_in(c, "ps_a")
	t.check("A-6: the marker is set after the sign-in, apart from the state file", host._file.imported() and FileAccess.file_exists(host._file.dir.path_join("cloud-sync-imported.json")) and host._file.path() != host._file.dir.path_join("cloud-sync-imported.json"))
	t.check("A-6: the legacy local value entered the machine", sdk.config.get_value(KEY) == 5 or host.machine().get_value(KEY)["value"] == 5)
	# A document refresh asks for a rebuild; the next write rebuilds first.
	host._rebuild_wanted = true
	var before: Object = host.machine()
	var r: PKeyResult = sdk.config.set_value(KEY, 6)
	t.check("A-6: the machine is rebuilt (locked list current) before a set after a document refresh", r.ok and not host._rebuild_wanted and host.machine() != before)
	_done(c)


func _pending_values(host: Node) -> Array:
	var out: Array = []
	var persisted: Variant = host._file.load_file()["persisted"]
	if persisted is Dictionary:
		for name in persisted["partitions"]:
			for op: Dictionary in persisted["partitions"][name]["pending"]:
				out.append(op.get("value"))
	return out


## S-1: an edit inside the debounce window survives quit: the close and pause notifications, and
## leaving the tree, save before they await anything.
func _quit_durability(t: PKeyTestContext) -> void:
	var log := []
	var version := [0]
	var c := await _make(_handler(log, version))
	var sdk: Node = c["sdk"]
	await _sign_in(c, "ps_a")
	var host: Node = sdk.cloud_sync.host
	sdk.config.set_value(KEY, 11)
	t.check("S-1 setup: the edit is only a draft, nothing saved holds it", not _pending_values(host).has(11))
	host.notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)
	t.check("S-1: a close request saves the debounced edit before any await", _pending_values(host).has(11), str(_pending_values(host)))
	sdk.config.set_value(KEY, 12)
	host.notification(Node.NOTIFICATION_APPLICATION_PAUSED)
	t.check("S-1: a pause saves the debounced edit before any await", _pending_values(host).has(12))
	sdk.config.set_value(KEY, 13)
	host.get_parent().remove_child(host)
	t.check("S-1: leaving the tree saves the debounced edit", _pending_values(host).has(13))
	host.queue_free()
	sdk.cloud_sync.host = null
	_done(c)


func _licence_free(t: PKeyTestContext) -> void:
	var clean := true
	var why := ""
	for p in ["services/cloud_sync.gd", "services/cloud_sync/host.gd", "services/cloud_sync/state.gd", "services/cloud_sync/transport.gd", "core/sync/cloud_sync_machine.gd"]:
		for line in FileAccess.get_file_as_string("res://addons/polaris_key/" + p).split("\n"):
			var code := line.strip_edges()
			if code.begins_with("#") or code.begins_with("##"):
				continue
			for word in ["core.license", "entitlements", "license.", "cache.license", ".license_state"]:
				if code.contains(word):
					clean = false
					why = "%s: %s" % [p, code]
	t.check("A-7: licence state is never read or written from the sync path", clean, why)
