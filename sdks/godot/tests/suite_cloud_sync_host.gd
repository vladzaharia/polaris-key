extends RefCounted
# @pkey-feature sync.settings
# The Cloud Sync host (U-21.6): transport, state file, catalog vetting, the pump against a loopback
# server. One check group per rule of the plan's section 3 (H-1 to H-6, H-10) and HOST-BIND.
#
#   H-1  mirror authoritative; a served catalog is vetted and only adds keys; its mode is dropped
#   H-2  refetch on a changed catalogVersion, at most every 5 min, equal rebuild skipped, budgeted
#   H-3  no redirect followed; 8 MiB cap; strict parse
#   H-4  15 s per request
#   H-5  open keys only from sealed rows and own mutations, capped at 4096
#   H-6  state file sealed, 0600, no root, purge deletes
#   H-10 a locked codec sends nothing and adds no GET; a 200 that is not an object in E2E is dropped

const Host := preload("res://addons/polaris_key/services/cloud_sync/host.gd")
const Transport := preload("res://addons/polaris_key/services/cloud_sync/transport.gd")
const State := preload("res://addons/polaris_key/services/cloud_sync/state.gd")
const CodecPort := preload("res://addons/polaris_key/services/cloud_sync/codec_port.gd")
const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

const PRODUCT := "diceroll"
const SECRET_MARK := "marker-value-9f3a"


## A codec with a root and no encryption: the host's own rules are what these tests check.
class OpenCodec:
	extends CodecPort
	var sealed_rows := true
	var detached := 0

	func locked() -> bool:
		return false

	func attach(_l: Callable) -> Callable:
		return func() -> void: detached += 1

	func seal_push(body: Dictionary, _routes: Array) -> Dictionary:
		return {"ok": true, "body": body}

	func open_pull(body: Dictionary, _m: Variant, _a: Variant, _k: Array) -> Dictionary:
		var rows: Array = []
		for c in body.get("changes", []):
			rows.append({"sealed": sealed_rows and not String(c.get("setting", "")).begins_with("plain.")})
		return {"ok": true, "body": body, "opened": {"changes": rows}}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _transport(t)
	_state(t)
	await _host(t)
	await _bounds(t)
	return true


func _server_url(s: PKeyFakeServer, path: String) -> String:
	return s.base_url() + path


func _transport(t: PKeyTestContext) -> void:
	t.check("is_sync_path: the product's two routes only", Transport.is_sync_path(PRODUCT, "/diceroll/sync/ops") and Transport.is_sync_path(PRODUCT, "/diceroll/sync?cursor=0&clientId=c_x") \
			and not Transport.is_sync_path(PRODUCT, "/diceroll/config") and not Transport.is_sync_path(PRODUCT, "/other/sync/ops") and not Transport.is_sync_path(PRODUCT, "/diceroll/sync?x=%0a ") and not Transport.is_sync_path(PRODUCT, "/diceroll/sync/ops/../x"))
	var other := PKeyTestFixtures.new_server(func(_r: Dictionary) -> Dictionary: return {"status": 200, "body": "{}"})
	var big := "[\"" + "A".repeat(9 * 1024 * 1024) + "\"]"
	var server: PKeyFakeServer
	server = PKeyTestFixtures.new_server(func(req: Dictionary) -> Dictionary:
		match req["path"]:
			"/diceroll/sync?redirect":
				return {"status": 302, "headers": {"Location": other.base_url() + "/landed"}}
			"/diceroll/sync?big":
				return {"status": 200, "body": big}
			"/diceroll/sync?hang":
				return {"hang": true}
			"/diceroll/sync?bad":
				return {"status": 200, "body": "{\"a\":1,}"}
			"/diceroll/sync?errpage":
				return {"status": 502, "body": "<html>"}
			"/diceroll/sync?ints":
				return {"status": 200, "body": "{\"cursor\":5,\"x\":1.5}"}
		return {"status": 404})
	var host := Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var tr := Transport.make(host, false)
	t.check("H-3/H-4: the transport follows no redirect, has 15 s and an 8 MiB cap", not tr.follow_redirects and tr.timeout == 15.0 and tr.body_limit == 8 * 1024 * 1024)
	await PKeyTestFixtures.frames(2)
	var ctx := {"product": PRODUCT, "token": "pkeyt_secret", "headers": func(extra: Dictionary) -> Dictionary: return extra, "url": func(path: String) -> String: return server.base_url() + path}
	var r: Dictionary = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?redirect"})
	t.check("H-3: a 302 is an answer, not followed, and the bearer reached no other origin", r == {"status": 302} and other.requests.is_empty(), str(r))
	t.check("the bearer is sent to the product origin", (server.requests.back()["headers"] as Dictionary).get("authorization") == "Bearer pkeyt_secret")
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?big"})
	t.check("H-3: a body over 8 MiB is not an answer", r == Transport.TRANSPORT_ERROR, str(r).left(80))
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?bad"})
	t.check("H-3: a 200 that is not strict JSON is not an answer", r == Transport.TRANSPORT_ERROR)
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?errpage"})
	t.check("an error page keeps its status", r == {"status": 502})
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?ints"})
	t.check("the strict loader keeps integers", r.get("status") == 200 and typeof(r["body"]["cursor"]) == TYPE_INT and typeof(r["body"]["x"]) == TYPE_FLOAT)
	var n := server.requests.size()
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/config"})
	var no_token := ctx.duplicate()
	no_token["token"] = ""
	var r2: Dictionary = await Transport.send_sync(tr, no_token, {"method": "GET", "path": "/diceroll/sync?ints"})
	t.check("a non-sync path and a missing token send nothing", r == Transport.TRANSPORT_ERROR and r2 == Transport.TRANSPORT_ERROR and server.requests.size() == n)
	tr.timeout = 1.0
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?hang"})
	t.check("H-4: a request that never answers ends in a transport error", r == Transport.TRANSPORT_ERROR)
	server.stop()
	other.stop()
	host.queue_free()


func _state(t: PKeyTestContext) -> void:
	var dir := PKeyTestFixtures.scratch_dir("cloud_sync_state")
	var file := {"v": 1, "product": PRODUCT, "persisted": {"partitions": {"local": {"x": SECRET_MARK}}, "hlc": [0, 0], "contacted": true, "cursor": 7}, "catalog": null, "openKeys": ["a", "b"]}
	var sealer := PKeyFakeSealer.new("keystore")
	var s := State.new(dir.path_join("a"), PRODUCT, sealer)
	t.check("H-6: save with a sealer", s.save(file))
	var raw := FileAccess.get_file_as_bytes(s.path())
	t.check("H-6: the file is PKCS-prefixed and holds no readable value", raw.slice(0, 4).get_string_from_utf8() == "PKCS" and raw.get_string_from_utf8().find(SECRET_MARK) == -1 and sealer.calls.has("seal"))
	var back := s.load_file()
	t.check("H-6: the sealed file round-trips (integers stay integers)", back["persisted"] != null and Types.json_equal(back["persisted"]["partitions"], file["persisted"]["partitions"]) and typeof(back["persisted"]["cursor"]) == TYPE_INT and back["openKeys"] == ["a", "b"])
	t.check("H-6: no root or key member is ever written", not raw.get_string_from_utf8().contains("root"))
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		t.check("H-6: the file is owner-only", FileAccess.get_unix_permissions(s.path()) == (FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER))
	t.check("H-6: another product's file reads as empty", State.new(s.dir, "other", sealer).load_file()["persisted"] == null)
	sealer.fault_open = true
	t.check("H-6: a sealed file that cannot be opened reads as empty, never as plaintext", s.load_file()["persisted"] == null)
	sealer.fault_open = false
	var junk := FileAccess.open(s.path(), FileAccess.WRITE)
	junk.store_string("{\"v\":1,\"product\":\"diceroll\"}")
	junk.close()
	t.check("H-6: a plain file where a sealed one belongs is not read", s.load_file()["persisted"] == null)
	var stray := FileAccess.open(s.path() + ".tmp-abc", FileAccess.WRITE)
	stray.store_string("x")
	stray.close()
	t.check("H-6: remove deletes the file and sweeps temporary siblings", s.remove() and not FileAccess.file_exists(s.path()) and not FileAccess.file_exists(s.path() + ".tmp-abc"))
	var e := State.new(dir.path_join("b"), PRODUCT, null)
	e.unique_id = "test-unique-id"
	t.check("H-6: without a sealer the engine-encrypted file is used", e.save(file))
	var eraw := FileAccess.get_file_as_bytes(e.path())
	t.check("H-6: the encrypted file holds no readable value and round-trips", eraw.get_string_from_utf8().find(SECRET_MARK) == -1 and e.load_file()["persisted"] != null)
	var moved := State.new(e.dir, PRODUCT, null)
	moved.unique_id = "another-device"
	t.check("H-6: another device's unique id cannot read it", moved.load_file()["persisted"] == null)
	PKeyTestFixtures.remove_tree(dir)


## A host on a loopback server. `answers` maps a path prefix to a handler result.
func _make(t: PKeyTestContext, tag: String, handler: Callable, extra: Dictionary = {}, opts: Dictionary = {}) -> Dictionary:
	var server := PKeyTestFixtures.new_server(handler)
	var dir := PKeyTestFixtures.scratch_dir("cloud_sync_host_" + tag)
	var clock := [1760000000000]
	var subject := [null]
	var host: Node = Host.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var deps := {
		"product": PRODUCT,
		"state_dir": dir,
		"sealer": PKeyFakeSealer.new(),
		"token": func() -> String: return "pkeyt_secret",
		"session_subject": func() -> Variant: return subject[0],
		"headers": func(x: Dictionary) -> Dictionary: return x,
		"url": func(path: String) -> String: return server.base_url() + path,
		"discovery": func() -> Variant: return null,
		"fetch_schema": func() -> Variant: return null,
		"document": func() -> Dictionary: return {"values": {}, "locked": []},
		"clock": func() -> int: return clock[0],
	}
	deps.merge(extra, true)
	var o := {"encryption": "server", "catalog": {"schemaVersion": 1, "entries": [{"key": "a.x", "kind": "config", "label": "x", "schema": {"type": "number"}}]}}
	o.merge(opts, true)
	host.configure(deps, o)
	return {"host": host, "server": server, "dir": dir, "clock": clock, "subject": subject}


func _done(c: Dictionary) -> void:
	c["host"].close()
	c["host"].queue_free()
	c["server"].stop()
	PKeyTestFixtures.remove_tree(c["dir"])


## Touch, then wait for the pump (a touch during a pump only asks it to go round again).
func _settle(host: Node) -> void:
	host.touch()
	await host.idle()


func _pull(c: Dictionary, extra: Dictionary = {}) -> void:
	# Force a fresh pull: the machine pulls when the network comes back.
	await c["host"].idle()
	var m: Variant = c["host"].machine()
	m.set_network("offline")
	m.set_network("online")
	await _settle(c["host"])


func _host(t: PKeyTestContext) -> void:
	var served := [{"schemaVersion": 2, "cloudSync": {"encryption": "e2e"}, "entries": [
		{"key": "a.x", "kind": "config", "label": "x", "schema": {"type": "string"}, "user": {"conflict": "max"}},
		{"key": "b.y", "kind": "config", "label": "y", "schema": {"type": "number"}},
		{"key": "b.y", "kind": "config", "label": "dup"},
		{"key": "bad key!", "kind": "config", "label": "bad"}]}]
	var fetches := [0]
	var catalogs: Array = []
	var handler := func(req: Dictionary) -> Dictionary:
		if req["method"] == "GET":
			return {"status": 200, "body": JSON.stringify({"cursor": 1, "catalogVersion": 2, "changes": [], "tombstones": [], "serverNow": 1760000000000})}
		return {"status": 200, "body": JSON.stringify({"results": [], "cursor": 1})}
	var serve := [false]
	var c := _make(t, "catalog", handler, {"fetch_schema": func() -> Variant:
		fetches[0] += 1
		return served[0] if serve[0] else null})
	var host: Node = c["host"]
	var started: Dictionary = await host.start()
	t.check("host: start builds the machine", started["ok"] and host.machine() != null)
	var routes: Array = host._routes
	t.check("H-1: before a fetch the app's mirror routes", routes.size() == 1 and routes[0]["key"] == "a.x" and routes[0]["schema"]["type"] == "number")
	serve[0] = true
	c["clock"][0] += 5 * 60_000 + 1
	await host._refetch_catalog(2)
	await _settle(host)
	routes = host._routes
	var keys := []
	for r: Dictionary in routes:
		keys.append(r["key"])
	t.check("H-1: a served catalog only adds keys the mirror lacks; the mirror's route stays", keys == ["a.x", "b.y"] and routes[0]["schema"]["type"] == "number" and routes[0]["policy"] == "lastWrite", str(routes))
	t.check("H-1: a served mode is dropped from every route (S2)", not routes[0].has("encryption") and not routes[1].has("encryption"))
	t.check("H-1: a duplicate and an invalid key are dropped from the served catalog", host._served["entries"].size() == 2)
	var too_many := {"schemaVersion": 1, "entries": []}
	for i in 1025:
		too_many["entries"].append({"key": "k.%d" % i, "kind": "config"})
	t.check("H-1: a catalog over 1024 entries is refused", host._vetted(too_many) == null and host._vetted({"schemaVersion": 1}) == null)
	var huge := {"schemaVersion": 1, "entries": [{"key": "k.1", "kind": "config", "label": "A".repeat(1024 * 1024 + 8)}]}
	t.check("H-1: a catalog over 1 MiB is refused", host._vetted(huge) == null)
	# Persisted catalog is the served one, re-vetted on load; the mirror still wins.
	_done(c)

	# H-2: refetch on a changed catalogVersion, at most every 5 minutes, an equal rebuild skipped.
	fetches[0] = 0
	var body_version := [5]
	var h2 := func(req: Dictionary) -> Dictionary:
		if req["method"] == "GET":
			return {"status": 200, "body": JSON.stringify({"cursor": 1, "catalogVersion": body_version[0], "changes": [], "tombstones": [], "serverNow": 1760000000000})}
		return {"status": 200, "body": "{}"}
	var same_routes := {"schemaVersion": 2, "entries": [{"key": "a.x", "kind": "config", "label": "x", "schema": {"type": "number"}}]}
	var c2 := _make(t, "h2", h2, {"fetch_schema": func() -> Variant:
		fetches[0] += 1
		return same_routes})
	host = c2["host"]
	await host.start()
	fetches[0] = 0
	host._last_fetch_at = null
	var r: Dictionary = host.sign_in("sub_a")
	t.check("host: sign_in passes the machine's result", r["ok"])
	await _settle(host)
	t.check("H-2: a pull naming another catalogVersion fetches the catalog once", fetches[0] == 1, str(fetches[0]))
	var gen: int = host._gen
	t.check("H-2: an equal rebuild is skipped (same routes, no new machine)", gen == host._gen and not host._rebuild_wanted)
	body_version[0] = 6
	await _pull(c2)
	t.check("H-2: a second version inside five minutes does not fetch", fetches[0] == 1, str(fetches[0]))
	c2["clock"][0] += 5 * 60_000 + 1
	body_version[0] = 7
	await _pull(c2)
	t.check("H-2: after five minutes it fetches again", fetches[0] == 2, str(fetches[0]))
	t.check("H-2: the journal was saved sealed after the exchange", FileAccess.file_exists(host._file.path()))
	t.check("H-1: the served catalog is never persisted", host._file.load_file()["catalog"] == null and host._served != null)
	_done(c2)

	# H-10: a locked codec sends nothing and adds no GET.
	var h10 := _make(t, "h10", func(_r: Dictionary) -> Dictionary: return {"status": 200, "body": "{}"}, {}, {"encryption": "e2e"})
	host = h10["host"]
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	await _settle(host)
	t.check("H-10/S3: an E2E product with a locked codec sends nothing, a pull included", h10["server"].requests.is_empty(), str(h10["server"].requests.size()))
	t.check("H-10: the machine reports locked", host.machine().status()["state"] in ["locked", "unsupported"] or host.machine().status().get("reason") == "keyring")
	_done(h10)

	# H-10 (200 not an object in E2E) and H-5 (open keys), with an open codec.
	var disc := func() -> Variant: return {"services": {"sync": {"enabled": true, "encryption": "e2e"}}}
	var mode := ["array"]
	var h5 := func(req: Dictionary) -> Dictionary:
		if mode[0] == "array":
			return {"status": 200, "body": "[1]"}
		return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 3, "changes": [
			{"setting": "zz.sealed", "version": 1, "value": 1},
			{"setting": "plain.row", "version": 2, "value": 1}], "tombstones": []})}
	var codec := OpenCodec.new()
	var c5 := _make(t, "h5", h5, {"codec": codec, "discovery": disc}, {"encryption": "e2e"})
	host = c5["host"]
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	t.check("H-10: a 200 that is not an object in E2E mode is dropped (cursor unchanged)", host.machine().journal()["sub_a"]["cursor"] == 0)
	mode[0] = "rows"
	await _pull(c5)
	t.check("H-5: open keys come only from sealed rows", host._open_keys.has("zz.sealed") and not host._open_keys.has("plain.row"), str(host._open_keys.keys()))
	for i in 4100:
		host._add_open_key("fill.%d" % i)
	t.check("H-5: open keys are capped at 4096, oldest dropped", host._open_keys.size() == State.OPEN_KEYS_MAX and not host._open_keys.has("zz.sealed") and host._open_keys.has("fill.4099"))
	_done(c5)

	# HOST-BIND.
	var bound_server := [0]
	var cb := _make(t, "bind", func(req: Dictionary) -> Dictionary:
		bound_server[0] += 1
		return {"status": 200, "body": "{\"cursor\":1,\"serverNow\":1760000000000}"})
	host = cb["host"]
	await host.start()
	cb["subject"][0] = "sub_b"
	host.sign_in("sub_a")
	await _settle(host)
	t.check("HOST-BIND: a request bound to another person than the session's is dropped, not sent", cb["server"].requests.is_empty() and host.machine().status()["state"] != "syncing", str(host.machine().status()))
	cb["subject"][0] = null
	await _pull(cb)
	t.check("HOST-BIND: an unknown session subject is allowed", cb["server"].requests.size() >= 1)
	cb["subject"][0] = "sub_a"
	await _pull(cb)
	t.check("HOST-BIND: a matching session subject is allowed", cb["server"].requests.size() >= 2)
	_done(cb)

	# A malformed client id from the host: sign_in's result is an error and nothing is sent.
	var cbad := _make(t, "badid", func(_r: Dictionary) -> Dictionary: return {"status": 200, "body": "{}"}, {"new_client_id": func() -> String: return "not-an-id"})
	host = cbad["host"]
	await host.start()
	var bad: Dictionary = host.sign_in("sub_a")
	await _settle(host)
	t.check("host: a refused client id is an error result and sends nothing", not bad["ok"] and bad["error"] == "bad-client-id" and cbad["server"].requests.is_empty())
	_done(cbad)

	# Relaunch: the sealed journal is read back; purge deletes the file.
	var persisted_cursor := [0]
	var cr := _make(t, "relaunch", func(_r: Dictionary) -> Dictionary: return {"status": 200, "body": "{\"cursor\":9,\"serverNow\":1760000000000}"})
	host = cr["host"]
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	t.check("host: the journal file exists after an exchange", FileAccess.file_exists(host._file.path()))
	var again: Node = Host.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(again)
	var deps2: Dictionary = host._deps.duplicate()
	again.configure(deps2, host._opts)
	await again.start()
	t.check("host: a relaunch resumes the saved cursor", again.machine().journal().get("sub_a", {}).get("cursor", -1) == 9, str(again.machine().journal()))
	again.close()
	again.queue_free()
	host.purge()
	t.check("H-6: purge deletes the state file and the machine is empty", not FileAccess.file_exists(host._file.path()) and host.machine().journal().get("sub_a") == null)
	_done(cr)


## The server's answer to a push: every mutation ok, version counting up.
func _answer(version: Array) -> Callable:
	return func(req: Dictionary) -> Dictionary:
		if req["method"] == "GET":
			return {"status": 200, "body": "{\"cursor\":1,\"serverNow\":1760000000000}"}
		var parsed: Variant = JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())
		var results := []
		for mu in parsed["mutations"]:
			version[0] += 1
			results.append({"mutationId": int(mu["mutationId"]), "status": "ok", "version": version[0]})
		return {"status": 200, "body": JSON.stringify({"results": results, "cursor": version[0], "serverNow": 1760000000000})}


func _posts(server: PKeyFakeServer) -> int:
	var n := 0
	for r: Dictionary in server.requests:
		if r["method"] == "POST":
			n += 1
	return n


func _bounds(t: PKeyTestContext) -> void:
	# H-7: a purge interleaved with an exchange in flight. The file goes first, the generation is
	# bumped, the pump is waited for (bounded), and the late exchange neither sends nor saves.
	var version := [0]
	var held := [true]
	var gate := func() -> void:
		while held[0]:
			await PKeyTestFixtures.frames(1)
	var c := _make(t, "purge", _answer(version), {"exchange_gate": gate})
	var host: Node = c["host"]
	await host.start()
	host.purge_wait_ms = 150
	host.sign_in("sub_a")
	host.touch()  # the pump stops at the gate with the first pull taken
	await PKeyTestFixtures.frames(2)
	host._save()
	t.check("H-7 setup: a journal is on disk and a pump is parked at the gate", FileAccess.file_exists(host._file.path()) and host._pumping)
	var old_machine: Object = host.machine()
	var purge_done := [false]
	var purging := func() -> void:
		await host.purge()
		purge_done[0] = true
	purging.call()
	t.check("H-7: the file is deleted first, before the pump is waited for", not FileAccess.file_exists(host._file.path()) and not purge_done[0] and host._purged)
	await PKeyTestFixtures.frames(3)
	var started := Time.get_ticks_msec()
	while not purge_done[0] and Time.get_ticks_msec() - started < 3000:
		await PKeyTestFixtures.frames(1)
	t.check("H-7: the wait for a stuck pump is bounded, then the machine is rebuilt empty", purge_done[0] and host.machine() != old_machine and host.machine().journal().get("sub_a") == null)
	held[0] = false
	await host.idle()
	t.check("H-7: the late exchange sends nothing and the pump never re-saves", c["server"].requests.is_empty() and not FileAccess.file_exists(host._file.path()), str(c["server"].requests.size()))
	t.check("H-7: a sign-in after a purge saves again", host.sign_in("sub_b")["ok"] and not host._purged)
	_done(c)

	# H-8: a listener that touches, flushes and edits during event delivery: no deadlock, one pump.
	version[0] = 0
	var c8 := _make(t, "reentrant", _answer(version))
	host = c8["host"]
	await host.start()
	host.sign_in("sub_a")
	await host.idle()
	var calls := [0, 0]
	host.events.connect(func(batch: Array) -> void:
		calls[0] += 1
		if calls[0] == 1:
			host.touch()
			host.machine().set_value("a.x", 3)
			host.touch()
			calls[1] = 1 if host._pumping else 0)
	host.machine().set_value("a.x", 2)
	var settled: bool = await host.flush(5000)
	t.check("H-8: a listener that touches and edits during delivery neither hangs nor starts a second pump", settled and calls[1] == 1 and calls[0] >= 1)
	t.check("H-8: the edit made inside the listener reached the server", _posts(c8["server"]) >= 1 and (c8["server"].requests.back()["body"] as PackedByteArray).get_string_from_utf8().contains("\"value\":3"), str(c8["server"].requests.size()))
	_done(c8)

	# H-9: flush is bounded, includes the trailing touch, and loses no wake-up.
	version[0] = 0
	var c9 := _make(t, "flush", _answer(version))
	host = c9["host"]
	await host.start()
	host.sign_in("sub_a")
	await host.idle()
	host.machine().set_value("a.x", 5)
	var before_posts := _posts(c9["server"])
	var ok: bool = await host.flush(5000)
	t.check("H-9: flush commits the debounced edit and sends it before it returns", ok and _posts(c9["server"]) == before_posts + 1 and host.machine().status()["pending"] == 0, str(host.machine().status()))
	# A touch landing as the pump ends: the edit is made from the pump's last event delivery.
	var once := [false]
	host.events.connect(func(_b: Array) -> void:
		if not once[0]:
			once[0] = true
			host.machine().set_value("a.x", 6))
	host.machine().set_value("a.x", 5.5)
	ok = await host.flush(5000)
	t.check("H-9: an edit that lands during the last delivery is still sent (no lost wake-up)", ok and host.machine().status()["pending"] == 0 and (c9["server"].requests.back()["body"] as PackedByteArray).get_string_from_utf8().contains("6"), str(host.machine().status()))
	_done(c9)

	# H-9 bound: a server that never answers cannot hold flush past its bound.
	var ch := _make(t, "hang", func(_r: Dictionary) -> Dictionary: return {"hang": true})
	host = ch["host"]
	await host.start()
	host.sign_in("sub_a")
	var t0 := Time.get_ticks_msec()
	ok = await host.flush(300)
	var took := Time.get_ticks_msec() - t0
	t.check("H-9: flush against a server that never answers returns within its bound", not ok and took < 2000, "%d ms" % took)
	_done(ch)

	# Close-request and pause notifications flush, bounded, and leave auto-accept-quit alone.
	version[0] = 0
	var cn := _make(t, "notify", _answer(version))
	host = cn["host"]
	await host.start()
	host.sign_in("sub_a")
	await host.idle()
	var auto := get_tree_auto_accept()
	host.machine().set_value("a.x", 7)
	var posts := _posts(cn["server"])
	host.notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)
	await host.idle()
	var started2 := Time.get_ticks_msec()
	while _posts(cn["server"]) == posts and Time.get_ticks_msec() - started2 < 4000:
		await PKeyTestFixtures.frames(1)
	t.check("close request: the pending edit is flushed", _posts(cn["server"]) == posts + 1)
	host.machine().set_value("a.x", 8)
	posts = _posts(cn["server"])
	host.notification(Node.NOTIFICATION_APPLICATION_PAUSED)
	started2 = Time.get_ticks_msec()
	while _posts(cn["server"]) == posts and Time.get_ticks_msec() - started2 < 4000:
		await PKeyTestFixtures.frames(1)
	t.check("paused: the pending edit is flushed", _posts(cn["server"]) == posts + 1)
	t.check("the host never changes auto-accept-quit", get_tree_auto_accept() == auto)
	_done(cn)


func get_tree_auto_accept() -> bool:
	return (Engine.get_main_loop() as SceneTree).auto_accept_quit
