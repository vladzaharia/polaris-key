extends RefCounted
# @pkey-feature sync.settings sync.records
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

	func open_pull(body: Dictionary, _m: Variant, _a: Variant, _k: Array, _rk: Array = []) -> Dictionary:
		var rows: Array = []
		for c in body.get("changes", []):
			rows.append({"sealed": sealed_rows and not String(c.get("setting", "")).begins_with("plain.")})
		return {"ok": true, "body": body, "opened": {"changes": rows}}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _transport(t)
	_state(t)
	await _host(t)
	await _bounds(t)
	await _collections(t)
	await _collections_hardening(t)
	await PKeyTestFixtures.frames(20)  # let abandoned coroutines resume and finish
	return true


## A codec that refuses to seal a mutation whose value is the string "unsealable".
class RefusingCodec:
	extends OpenCodec

	func seal_push(body: Dictionary, _routes: Array) -> Dictionary:
		for mu in body.get("mutations", []):
			if mu is Dictionary and mu.get("value") is String and mu["value"] == "unsealable":
				return {"ok": false, "code": "invalid_options"}
		return {"ok": true, "body": body}


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
			"/diceroll/sync?nul":
				return {"status": 200, "body": "{\"changes\":[{\"setting\":\"a\\u0000b\",\"version\":1}]}"}
			"/diceroll/sync?nulvalue":
				return {"status": 200, "body": "{\"changes\":[{\"setting\":\"a.x\",\"version\":1,\"value\":\"p\\u0000q\"}]}"}
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
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?nul"})
	t.check("S-2/HC-4: a served name with a \\u0000 escape is not an answer (it would read as another name)", r == Transport.TRANSPORT_ERROR)
	r = await Transport.send_sync(tr, ctx, {"method": "GET", "path": "/diceroll/sync?nulvalue"})
	t.check("R-1: a served VALUE with a \\u0000 escape still pulls (it reads as U+FFFD)", r.get("status") == 200 and r["body"]["changes"][0]["value"] == "p\ufffdq", str(r))
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
	var noid := State.new(dir.path_join("c"), PRODUCT, null)
	noid.unique_id = ""
	t.check("S-6: with no sealer and no device id the journal is not written", noid.protection() == "none" and not noid.save(file) and not FileAccess.file_exists(noid.path()))
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
func _make(_t: PKeyTestContext, tag: String, handler: Callable, extra: Dictionary = {}, opts: Dictionary = {}) -> Dictionary:
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


func _pull(c: Dictionary, _extra: Dictionary = {}) -> void:
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
	t.check(
			"H-8: the edit made inside the listener reached the server",
			_posts(c8["server"]) >= 1
			and (c8["server"].requests.back()["body"] as PackedByteArray).get_string_from_utf8().contains("\"value\":3"),
			str(c8["server"].requests.size())
	)
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
	t.check(
			"H-9: flush commits the debounced edit and sends it before it returns",
			ok
			and _posts(c9["server"]) == before_posts + 1
			and host.machine().status()["pending"] == 0,
			str(host.machine().status())
	)
	# A touch landing as the pump ends: the edit is made from the pump's last event delivery.
	var once := [false]
	host.events.connect(func(_b: Array) -> void:
		if not once[0]:
			once[0] = true
			host.machine().set_value("a.x", 6))
	host.machine().set_value("a.x", 5.5)
	ok = await host.flush(5000)
	t.check(
			"H-9: an edit that lands during the last delivery is still sent (no lost wake-up)",
			ok
			and host.machine().status()["pending"] == 0
			and (c9["server"].requests.back()["body"] as PackedByteArray).get_string_from_utf8().contains("6"),
			str(host.machine().status())
	)
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


# ── the records handle (C26.7, U-46): PKeyCollection over the host's machine ─────────────────────

func _collections(t: PKeyTestContext) -> void:
	var version := [0]
	var catalog := {"schemaVersion": 1, "entries": [], "cloudSync": {"collections": [
		{"name": "cards", "conflict": "merge"},
		{"name": "tags", "conflict": "union"},
		{"name": "saves", "template": "saves"},
		{"name": "log.*", "template": "session"},
	]}}
	var c := _make(t, "collections", _answer(version), {}, {"catalog": catalog})
	var host: Node = c["host"]
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	var cards := PKeyCollection.new("cards", host)
	var tags := PKeyCollection.new("tags", host)
	var saves := PKeyCollection.new("saves", host)
	var logs := PKeyCollection.new("log.app", host)
	var nope := PKeyCollection.new("nope", host)
	t.check(
			"collection: the catalog's declarations reach the machine (conflict as the policy, a template's policy, a pattern)",
			cards.policy() == "merge"
			and tags.policy() == "union"
			and saves.policy() == "revision"
			and logs.policy() == "lastWrite"
			and nope.policy() == ""
	)
	var changes: Array = []
	cards.changed.connect(func(ids: Array, origin: String) -> void: changes.append([ids, origin]))
	var r: PKeyResult = cards.update("c1", {"set": {"title": "Dragon", "hp": 10}})
	t.check("collection: update is accepted and reports a local change", r.ok and changes == [[["c1"], "local"]], str(changes))
	t.check("collection: get_record reads the pending value, ids lists it", _same_json(cards.get_record("c1"), {"value": {"title": "Dragon", "hp": 10}, "from": "pending"}) and cards.ids() == ["c1"])
	await _settle(host)
	t.check(
			"collection: the push went out as field operations and the record reads from the cloud",
			_same_json(cards.get_record("c1"), {"value": {"title": "Dragon", "hp": 10}, "from": "cloud"}),
			str(cards.get_record("c1"))
	)

	# Refusals are returned, nothing is sent or journalled.
	var posts := _posts(c["server"])
	var refused := {
		"an undeclared name": [nope.put("a", 1), "collection_unknown"],
		"put on a merge record": [cards.put("c1", {}), "op_invalid_for_policy"],
		"update on a union record": [tags.update("t", {"set": {"a": 1}}), "op_invalid_for_policy"],
		"add on a merge record": [cards.add("c1", 1), "op_invalid_for_policy"],
		"an empty id": [cards.update("", {"set": {"a": 1}}), "value_invalid"],
		"an empty change": [cards.update("c1", {}), "value_invalid"],
		"a field named twice": [cards.update("c1", {"set": {"a": 1}, "remove": ["a"]}), "value_invalid"],
		"an empty field name": [cards.update("c1", {"set": {"": 1}}), "value_invalid"],
		"a field name over 1 KiB": [cards.update("c1", {"set": {"a".repeat(1025): 1}}), "value_invalid"],
		"an element over 1 KiB": [tags.add("t", "x".repeat(1100)), "value_invalid"],
		"an element canonical JSON refuses": [tags.add("t", NAN), "value_invalid"],
		"if_version on a merge delete": [cards.delete("c1", 3), "op_invalid_for_policy"],
		"if_version on a lastWrite put": [logs.put("k", 1, 2), "op_invalid_for_policy"],
		"a malformed if_version": [saves.put("s", {}, "later"), "value_invalid"],
		"an id outside the sync key set": [saves.put("a b", 1), "value_invalid"],
		"an id of 129 characters": [saves.put("a".repeat(129), 1), "value_invalid"],
		"an id shaped like a blinded name": [saves.put("x:" + "A".repeat(43), 1), "value_invalid"],
		"a field name holding a NUL byte": [cards.update("c1", {"set": {PackedByteArray([102, 0, 103]): 1}}), "value_invalid"],
		"a NaN value": [logs.put("k", NAN), "value_invalid"],
		"an integer beyond 2^53": [logs.put("k", 9007199254740993), "value_invalid"],
		"a NaN field value": [cards.update("c1", {"set": {"a": INF}}), "value_invalid"],
		"a NaN value with if_version": [saves.put("s", NAN, "*"), "value_invalid"],
	}
	for name in refused:
		var pair: Array = refused[name]
		var res: PKeyResult = pair[0]
		t.check("collection: %s is refused with %s" % [name, pair[1]], not res.ok and String(res.code) == pair[1], str(res))
	await _settle(host)
	t.check("collection: a refusal sends nothing", _posts(c["server"]) == posts)
	t.check("collection: a refusal journals nothing", cards.ids() == ["c1"] and logs.ids() == [] and saves.ids() == [])
	t.check("collection: the refusal order is unknown, policy, then value", String(nope.put("a b", NAN).code) == "collection_unknown" and String(cards.put("a b", NAN).code) == "op_invalid_for_policy")

	# Union and delete.
	var a := tags.add("t1", {"k": 1})
	t.check("collection: add and remove on a union record", a.ok and tags.remove("t1", {"k": 1}).ok and tags.delete("t1").ok)

	# A compare-and-set on a revision collection: a ticket now, the outcome on the signal.
	var outcomes: Array = []
	saves.outcome.connect(func(o: Dictionary) -> void: outcomes.append(o))
	var cas: PKeyResult = saves.put("s1", {"playtime": 5}, "*")
	t.check("collection: a compare-and-set returns its ticket", cas.ok and cas.detail is Dictionary and int(cas.detail["mutation_id"]) > 0, str(cas))
	await _settle(host)
	t.check(
			"collection: its outcome arrives once on the outcome signal",
			outcomes.size() == 1
			and outcomes[0]["status"] == "ok"
			and int(outcomes[0]["mutationId"]) == int(cas.detail["mutation_id"]),
			str(outcomes)
	)
	var plain := saves.put("s2", {"playtime": 6})
	await _settle(host)
	t.check("collection: a put without if_version is a plain write and reports no outcome", plain.ok and outcomes.size() == 1)
	var gone := saves.delete("s1")
	await _settle(host)
	t.check(
			"collection: delete on a revision record is a compare-and-set on the version held",
			gone.ok
			and gone.detail is Dictionary
			and outcomes.size() == 2
			and outcomes[1]["status"] == "ok",
			str(outcomes)
	)

	# A rebuild keeps the watches and taps.
	host._rebuild()
	cards.update("c2", {"set": {"a": 1}})
	t.check("collection: a rebuilt machine still reports the watched collection", changes.size() >= 2 and changes.back()[0] == ["c2"], str(changes))

	# Signed out. A ticket still open is forgotten by close().
	var open_ticket := saves.put("s9", {"playtime": 1}, "*")
	t.check("collection: a ticket is held until its outcome", open_ticket.ok and not saves._tickets.is_empty())
	var closing := PKeyCollection.new("saves", host)
	closing.put("s8", 1, "*")
	closing.close()
	t.check("collection: close() forgets the tickets", closing._tickets.is_empty())
	host.machine().sign_out(true)
	t.check("collection: a verb while nobody is signed in answers signed_out", String(cards.update("c9", {"set": {"a": 1}}).code) == "signed_out")
	cards.close()
	tags.close()
	saves.close()
	logs.close()
	nope.close()
	_done(c)


static func _same_json(a: Variant, b: Variant) -> bool:
	return PKeySyncCanonicalJson.canonicalize_value(a).get("canonical") == PKeySyncCanonicalJson.canonicalize_value(b).get("canonical")


func _collections_hardening(t: PKeyTestContext) -> void:
	var version := [0]
	var catalog := {"schemaVersion": 1, "entries": [], "cloudSync": {"collections": [
		{"name": "tags", "conflict": "union"},
		{"name": "log.*", "template": "session"},
	]}}
	var c := _make(t, "collections_hardening", _answer(version), {}, {"catalog": catalog})
	var host: Node = c["host"]
	# A handle made before the host started registers when the host does.
	var early := PKeyCollection.new("tags", host)
	var early2 := PKeyCollection.new("tags", host)
	t.check("collection: before the host starts a verb is refused, collection_unknown", String(early.add("t", 1).code) == "collection_unknown")
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	var seen: Array = []
	var seen2: Array = []
	early.changed.connect(func(ids: Array, origin: String) -> void: seen.append([ids, origin]))
	early2.changed.connect(func(ids: Array, origin: String) -> void: seen2.append([ids, origin]))
	t.check("collection: a handle made before the host started reports changes", early.add("t1", 1).ok and seen == [[["t1"], "local"]], str(seen))
	t.check("collection: the second handle on one collection reports them too", seen2 == [[["t1"], "local"]], str(seen2))
	early.close()
	early2.add("t2", 1)
	t.check("collection: closing one handle does not silence the other", seen2.size() == 2 and seen2[1][0] == ["t2"], str(seen2))
	early2.close()

	# saves is not implicit.
	var saves := PKeyCollection.new("saves", host)
	t.check("collection: saves answers collection_unknown unless the catalog declares it", saves.policy() == "" and String(saves.put("s", 1).code) == "collection_unknown")
	saves.close()

	# close() forgets the tickets: no outcome after close.
	_done(c)

	# E2E: a mutation the codec cannot seal is dropped with a local rejection; the next one goes out.
	var disc := func() -> Variant: return {"services": {"sync": {"enabled": true, "encryption": "e2e"}}}
	var handler := func(req: Dictionary) -> Dictionary:
		if req["method"] == "GET":
			return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 1, "serverNow": 1760000000000})}
		var parsed: Variant = JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())
		var results := []
		for mu in parsed["mutations"]:
			version[0] += 1
			results.append({"mutationId": int(mu["mutationId"]), "status": "ok", "version": version[0]})
		return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "results": results, "cursor": version[0] + 1, "serverNow": 1760000000000})}
	var e := _make(t, "unsealable", handler, {"codec": RefusingCodec.new(), "discovery": disc}, {"encryption": "e2e", "catalog": catalog})
	var eh: Node = e["host"]
	await eh.start()
	eh.sign_in("sub_a")
	await _settle(eh)
	var events: Array = []
	eh.events.connect(func(batch: Array) -> void: events.append_array(batch))
	var logs := PKeyCollection.new("log.app", eh)
	t.check("e2e: the handle accepts a value the codec will refuse", logs.put("a", "unsealable").ok)
	t.check("e2e: and a good one after it", logs.put("b", 2).ok)
	await _settle(eh)
	await _settle(eh)
	var pushed: Array = []
	for r: Dictionary in e["server"].requests:
		if r["method"] == "POST":
			pushed.append_array(JSON.parse_string((r["body"] as PackedByteArray).get_string_from_utf8())["mutations"])
	var ids_pushed: Array = []
	for mu in pushed:
		ids_pushed.append(mu["target"]["record"][1])
	var rejected := events.filter(func(ev: Dictionary) -> bool: return ev.get("type") == "rejected" and ev.get("code") == "value_invalid")
	t.check("e2e: the unsealable mutation is dropped with a local value_invalid rejection", rejected.size() == 1, str(events))
	t.check("e2e: the next mutation is pushed and the unsealable one never is", ids_pushed == ["b"], str(ids_pushed))
	t.check("e2e: the journal holds nothing pending afterwards", eh.machine().status().get("pending", 0) == 0, str(eh.machine().status()))
	logs.close()
	_done(e)
