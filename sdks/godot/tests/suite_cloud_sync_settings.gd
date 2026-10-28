extends RefCounted
# @pkey-feature sync.settings config.sync
# The Cloud Sync settings API (U-21.9) on a real autoload over a loopback server. One group per rule
# of the plan's section 3: A-1 to A-7, and the sign-out chain (flush, machine sign-out, ring forget,
# purge) in that order.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")

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
	await _import_and_document(t)
	await _quit_durability(t)
	_licence_free(t)
	await PKeyTestFixtures.frames(3)  # queued frees run before the next suite and the exit
	return true


func _handler(log: Array, version: Array, extra: Callable = Callable()) -> Callable:
	return func(req: Dictionary) -> Dictionary:
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
	t.check("chain: the identity client runs one pre-sign-out hook and it is Cloud Sync's", hooks.size() == 1)
	await hooks[0].call()
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
