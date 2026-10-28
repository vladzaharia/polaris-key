extends RefCounted
# The Cloud Sync machine's own tests, beyond the corpus scenarios: the X-1 conflict-copy cursor
# (SEC-HOST2's reproduction and its control), the principal-change, blocked, 410 and client-id
# paths. The corpus row for X-1 (`e2e-forged-plain-needs-cursor-below-since` covers the pull side;
# X-1.1 adds the push-conflict row) makes this a 20-line regression once it lands.

const Machine := preload("res://addons/polaris_key/core/sync/cloud_sync_machine.gd")
const KEY := "audio.music.volume"
const DISCOVERED := {"encryption": "e2e"}


func run(t: PKeyTestContext) -> void:
	_x1(t)
	_principal_and_blocked(t)
	_gone_and_client_ids(t)


static func _opts(encryption: String, ids: Array, extra: Dictionary = {}) -> Dictionary:
	var o := {
		"product": "diceroll",
		"catalog": {"settings": [{"key": KEY, "route": "synced", "scope": "user", "policy": "lastWrite"}]},
		"document": {"values": {KEY: 0.8}},
		"now": 1760000000000,
		"offsetMs": 0,
		"contacted": true,
		"subject": "sub_alice",
		"network": "online",
		"onSignOut": "clear",
		"encryption": encryption,
		"hasRoot": encryption == "e2e",
		"newClientId": func() -> String: return ids.pop_front(),
	}
	if encryption == "e2e":
		o["discovery"] = DISCOVERED
	o.merge(extra, true)
	return o


static func _ids() -> Array:
	return ["c_000000000000000client1", "c_000000000000000client2", "c_000000000000000client3"]


func _ok(res: Dictionary) -> Dictionary:
	return {"status": 200, "body": res}


## SEC-HOST2's reproduction: E2E, encryptionSince 1, partition cursor `cursor`, a push, then a
## conflict whose `server` copy has no `ct` (the host reports plaintext `seq` 0). Returns the read.
func _conflict_read(cursor: int) -> Dictionary:
	var m: Variant = Machine.new(_opts("e2e", _ids()))
	var body := {"encryption": "e2e", "encryptionSince": 1, "changes": [], "tombstones": []}
	if cursor > 0:
		body["cursor"] = cursor
	m.receive(_ok(body))  # the first pull answers; cursor 0 stays 0 when the body has none
	m.set_value(KEY, 0.2)
	m.advance(PKeyConstants.SYNC_DEBOUNCE_MS)
	var out: Array = m.take_requests()
	var push: Dictionary = out[out.size() - 1]
	if push.get("method") != "POST":
		return {"error": "no push"}
	m.receive(_ok({"encryption": "e2e", "results": [{"mutationId": 1, "status": "conflict", "server": {"version": 0, "value": 0.99}}]}), {"conflicts": {"1": {"seq": 0}}})
	return m.get_value(KEY)


func _x1(t: PKeyTestContext) -> void:
	var forged := _conflict_read(50)
	t.check("X-1 conflictCopyPlaintextNeedsCursorBelowSince: a plaintext conflict copy at cursor 50, since 1, is bad and never read from the cloud", forged.get("from") == "document" and not Types.json_equal(forged.get("value"), 0.99), str(forged))
	var control := _conflict_read(0)
	t.check("X-1 control: at cursor 0 (below since) the plaintext copy is legacy and reads from the cloud", control.get("from") == "cloud" and Types.json_equal(control.get("value"), 0.99), str(control))


const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")


func _machine(extra: Dictionary = {}) -> Variant:
	return Machine.new(_opts("server", _ids(), extra))


func _principal_and_blocked(t: PKeyTestContext) -> void:
	# A served `subject` that is not the partition's: a person change, handled as a sign-out.
	var m: Variant = _machine()
	m.take_requests()
	m.receive(_ok({"subject": "sub_bob", "cursor": 3, "changes": []}))
	var ev: Array = m.take_events()
	var left := false
	for e: Dictionary in ev:
		left = left or (e["type"] == "signedOut" and e["reason"] == "subjectChanged")
	t.check("subjectChanged: a served subject for another person signs out, clearing the snapshot", left and m.status()["state"] == "local" and m.journal()["sub_alice"]["cursor"] == 0)

	# 401 blocks and sends nothing; a document refresh lifts it and the pull goes out again.
	m = _machine()
	m.take_requests()
	m.receive({"status": 401, "body": {}})
	t.check("401: blocked unauthorized, nothing sent", m.status()["state"] == "blocked" and m.status()["reason"] == "unauthorized" and m.take_requests().is_empty())
	m.flush()
	t.check("401: flush while blocked sends nothing", m.take_requests().is_empty())
	m.refresh()
	t.check("401: a refresh lifts the block and the pull is sent", m.status()["state"] == "syncing" and m.take_requests().size() == 1)

	# 403: attestation_required and any other code block until a refresh; account_required leaves.
	m = _machine()
	m.take_requests()
	m.receive({"status": 403, "body": {"error": {"code": "attestation_required"}}})
	t.check("403 attestation_required: blocked attestation", m.status().get("reason") == "attestation")
	m = _machine()
	m.take_requests()
	m.receive({"status": 403, "body": {"error": {"code": "nope"}}})
	t.check("403 other: blocked forbidden", m.status().get("reason") == "forbidden")
	m = _machine()
	m.take_requests()
	m.receive({"status": 403, "body": {"error": {"code": "account_required", "signInUrl": 7}}})
	var offered := false
	for e: Dictionary in m.take_events():
		offered = offered or (e["type"] == "signInOffered" and e["signInUrl"] == null)
	t.check("403 account_required: signed out, blocked, an offer whose non-string url is null", offered and m.status().get("reason") == "account_required")

	# 503 writes_paused on a push: paused, journal kept; a body that is not an object changes nothing.
	m = _machine()
	m.receive(_ok({"cursor": 0, "changes": []}))
	m.set_value(KEY, 0.1)
	m.advance(PKeyConstants.SYNC_DEBOUNCE_MS)
	m.take_requests()
	m.receive({"status": 503, "body": {"error": {"code": "writes_paused"}}})
	t.check("writes_paused: paused with the journal kept", m.status()["state"] == "paused" and m.status()["pending"] == 1)
	m = _machine()
	var before: Dictionary = m.persist()
	m.receive({"status": 200, "body": [1, 2]})
	t.check("a 200 whose body is not an object changes nothing", Types.json_equal(m.persist(), before))

	# A result for a mutation that was not in the request is ignored.
	m = _machine()
	m.receive(_ok({"cursor": 0}))
	m.set_value(KEY, 0.3)
	m.advance(PKeyConstants.SYNC_DEBOUNCE_MS)
	m.take_requests()
	m.receive(_ok({"results": [{"mutationId": 99, "status": "ok", "version": 4}]}))
	t.check("a result for a mutationId outside the request is ignored", m.journal()["sub_alice"]["pending"].size() == 1)


func _gone_and_client_ids(t: PKeyTestContext) -> void:
	# 410: the partition cursor resets and the next pull asks for a snapshot.
	var m: Variant = _machine()
	m.receive(_ok({"cursor": 7, "changes": []}))
	m.take_requests()
	m.refresh()
	m.set_network("offline")
	m.set_network("online")
	var req: Array = m.take_requests()
	t.check("410 setup: a pull at cursor 7 is in flight", req.size() == 1 and String(req[0]["path"]).contains("cursor=7"), str(req))
	m.receive({"status": 410, "body": {}})
	var again: Array = m.take_requests()
	t.check("410: cursor reset and a snapshot pull (cursor 0) follows", m.journal()["sub_alice"]["cursor"] == 0 and again.size() == 1 and String(again[0]["path"]).contains("cursor=0"), str(again))

	# A malformed client id from the host refuses: construction, sign-in and a 409.
	var bad := func() -> String: return "not-a-client-id"
	var c: Variant = Machine.new(_opts("server", [], {"newClientId": bad}))
	t.check("bad client id at construction: signed-out machine with init_error, nothing sent", c.init_error == "bad-client-id" and c.status()["state"] == "local" and c.take_requests().is_empty())
	var s: Variant = Machine.new(_opts("server", [], {"subject": null, "newClientId": bad}))
	var snap: Dictionary = s.persist()
	var r: Dictionary = s.sign_in("sub_bob")
	t.check("bad client id at sign-in: an error result and no state change", not r["ok"] and r["error"] == "bad-client-id" and Types.json_equal(s.persist(), snap) and s.status()["state"] == "local")
	var ids: Array = ["c_000000000000000client1", "not-a-client-id"]
	var k: Variant = Machine.new(_opts("server", ids))
	var before: Dictionary = k.persist()
	var mism: Dictionary = k.receive({"status": 409, "body": {}})
	t.check("bad client id on a 409: an error result, the request stays in flight, no state change", not mism["ok"] and Types.json_equal(k.persist(), before) and k.status()["state"] == "syncing")
