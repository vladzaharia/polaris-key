extends RefCounted
# @pkey-feature sync.records
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
	_collections(t)


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
	t.check("403 account_required: the partition is gone, no root, and a relaunch stays blocked", not m.persist()["partitions"].has("sub_alice") \
			and not m.has_root() and m.status().get("reason") == "account_required" and m.status().get("state") == "blocked")
	# The host's call (a key-ring or file route): the same transition; idempotent; a no-op with no subject.
	m = _machine()
	m.take_requests()
	m.account_required("https://key.plrs.im/signin")
	var offer: Dictionary = {}
	var kinds: Array = []
	for e: Dictionary in m.take_events():
		kinds.append(e["type"])
		if e["type"] == "signInOffered":
			offer = e
	t.check("account_required(): signedOut, the offer with the url, no unsyncedData, blocked", kinds.has("signedOut") \
			and not kinds.has("unsyncedData") and offer.get("signInUrl") == "https://key.plrs.im/signin" \
			and m.status().get("reason") == "account_required")
	m.account_required("https://key.plrs.im/again")
	t.check("account_required(): already blocked, nothing more", m.take_events().is_empty())
	var again: Variant = Machine.relaunch(m, _opts("server", _ids(), {"hasRoot": true}))
	t.check("account_required(): a relaunch stays blocked and signed out, and the root flag is the machine's, not the option's", \
			again.status().get("reason") == "account_required" and again.subject() == null and not again.has_root() \
			and again.take_requests().is_empty())

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


# ── collections (C26.7, U-46): the handle's calls on the machine ──────────────────────────────

func _coll_machine(extra: Dictionary = {}) -> Variant:
	var o := _opts("server", _ids(), extra)
	o["catalog"]["collections"] = [
		{"name": "cards", "policy": "merge"},
		{"name": "tags", "policy": "union"},
		{"name": "scores", "policy": "max", "field": "points"},
		{"name": "saves", "policy": "revision"},
		{"name": "log.*", "policy": "lastWrite"},
		{"name": "log.audit.*", "policy": "union"},
		{"name": "log.audit.fixed", "policy": "merge"},
	]
	return Machine.new(o)


func _pending(m: Variant) -> Array:
	return m.journal()["sub_alice"]["pending"]


func _collections(t: PKeyTestContext) -> void:
	var m: Variant = _coll_machine()
	# A name is governed by itself, else by the longest `prefix.*` with something after the prefix.
	t.check("collection_decl: an exact name", m.collection_decl("cards")["policy"] == "merge" and m.collection_decl("scores")["field"] == "points")
	t.check("collection_decl: a pattern governs a name under it", m.collection_decl("log.app")["policy"] == "lastWrite" and m.collection_decl("log.app.deep")["policy"] == "lastWrite")
	t.check(
			"collection_decl: the longest pattern wins, an exact name beats a pattern",
			m.collection_decl("log.audit.x")["policy"] == "union"
			and m.collection_decl("log.audit.fixed")["policy"] == "merge"
	)
	t.check(
			"collection_decl: a pattern needs something after its prefix, and an undeclared name is null",
			m.collection_decl("log.") == null
			and m.collection_decl("log") == null
			and m.collection_decl("nope") == null
	)

	# update: one clock stamp over the named fields; the others stay.
	var u: Dictionary = m.update("cards", "c1", {"set": {"title": "Dragon", "hp": 10}, "remove": ["old"]})
	var ops := _pending(m)
	var stamps := {}
	var names := []
	for o: Dictionary in ops:
		stamps[o["editedHlc"]] = true
		names.append("%s:%s" % [o["op"], o["field"]])
	t.check("update: setField then removeField, in field order, under one stamp", u["ok"] and names == ["setField:hp", "setField:title", "removeField:old"] and stamps.size() == 1, str(names))
	t.check("update: the record reads with the fields applied", Types.json_equal(m.record("cards", "c1")["value"], {"hp": 10, "title": "Dragon"}) and m.record("cards", "c1")["from"] == "pending")
	m.update("cards", "c1", {"set": {"hp": 11}})
	t.check("update: a field not named stays as it was", Types.json_equal(m.record("cards", "c1")["value"], {"hp": 11, "title": "Dragon"}))
	var before := _pending(m).size()
	t.check(
			"update: refused for a policy that is not merge, an empty change and a field named twice",
			m.update("tags", "t", {"set": {"a": 1}}).get("error") == "collection-unknown"
			and m.update("cards", "c1", {}).get("error") == "bad_request"
			and m.update("cards", "c1", {"set": {"a": 1}, "remove": ["a"]}).get("error") == "bad_request"
			and _pending(m).size() == before
	)

	# put on a merge record sends fields, not members.
	m.put("cards", "c2", {"a": 1, "b": 2})
	var kinds := {}
	for o: Dictionary in _pending(m):
		if o["target"]["record"][1] == "c2":
			kinds[o["op"]] = true
	t.check("put on a merge record sends setField operations", kinds.keys() == ["setField"])

	# delete: a stamp for every policy but union; revision is a compare-and-set on the snapshot's version.
	m.add("tags", "t1", "x")
	m.delete("tags", "t1")
	m.delete("cards", "c1")
	var dels := _pending(m).filter(func(o: Dictionary) -> bool: return o["op"] == "delete")
	t.check("delete: a union delete carries no stamp, a merge delete does", dels.size() == 2 and not dels[0].has("editedHlc") and dels[1].has("editedHlc"))
	var sd: Dictionary = m.delete("saves", "s")
	var revision_dels := _pending(m).filter(func(o: Dictionary) -> bool: return o["op"] == "delete" and o["target"]["record"][0] == "saves")
	t.check(
			"delete: a revision delete is the collection's default delete, on the snapshot's version (U-08), and an undeclared name is refused",
			sd.get("ok") == true and revision_dels.size() == 1 and revision_dels[0]["baseVersion"] == "*" and not revision_dels[0].has("editedHlc")
				and m.delete("nope", "s").get("error") == "collection-unknown"
	)
	t.check(
			"collection verbs: signed-out while nobody is signed in",
			_coll_machine({"subject": null}).update("cards", "c", {"set": {"a": 1}}).get("error") == "signed-out"
			and _coll_machine({"subject": null}).delete("cards", "c").get("error") == "signed-out"
	)

	# Record events: local from this device's calls, remote from a pull; nothing computed until watched.
	var w: Variant = _coll_machine()
	w.put("cards", "pre", {"a": 1})
	w.take_events()
	w.watch_records("cards", true)
	t.check("watch: a record that exists when the watch starts is not reported", w.take_events().filter(func(e: Dictionary) -> bool: return e["type"] == "records").is_empty())
	w.update("cards", "c1", {"set": {"a": 1}})
	var ev: Array = w.take_events().filter(func(e: Dictionary) -> bool: return e["type"] == "records")
	t.check("watch: a local write is reported once with its ids, in byte order", ev.size() == 1 and ev[0]["collection"] == "cards" and ev[0]["ids"] == ["c1"] and ev[0]["origin"] == "local", str(ev))
	w.update("cards", "c0", {"set": {"a": 1}})
	w.update("cards", "c2", {"set": {"a": 1}})
	t.check("record_ids: the effective ids in byte order, pending creates included", w.record_ids("cards") == ["c0", "c1", "c2", "pre"])
	w.watch_records("cards", false)
	w.take_events()
	w.update("cards", "c3", {"set": {"a": 1}})
	t.check("watch: after the watch is off nothing is reported", w.take_events().filter(func(e: Dictionary) -> bool: return e["type"] == "records").is_empty())

	# Observers: a tap hears every outcome beside on_outcome, and a rebuilt machine adopts both.
	var heard := []
	var main_heard := []
	var a: Variant = _coll_machine()
	a.on_outcome(func(o: Dictionary) -> void: main_heard.append(o["mutationId"]))
	var off: Callable = a.tap_outcomes(func(o: Dictionary) -> void: heard.append(o["mutationId"]))
	a.watch_records("cards", true)
	a.receive(_ok({"cursor": 0, "changes": [], "tombstones": []}))
	var put: Dictionary = a.put_at("saves", "s1", {"x": 1}, "*")
	a.advance(PKeyConstants.SYNC_DEBOUNCE_MS)
	var req: Array = a.take_requests()
	a.receive({"status": 200, "body": {"cursor": 1, "results": [{"mutationId": 1, "status": "ok", "version": 1}], "changes": [], "tombstones": []}})
	t.check(
			"tap_outcomes: a tap hears the outcome of an exact write, and on_outcome still does",
			put["ok"]
			and heard == [put["mutationId"]]
			and main_heard == heard,
			"%s %s %s" % [heard, main_heard, req.size()]
	)
	off.call()
	a.put_at("saves", "s2", {"x": 1}, "*")
	a.advance(PKeyConstants.SYNC_DEBOUNCE_MS)
	a.take_requests()
	a.receive({"status": 200, "body": {"cursor": 2, "results": [{"mutationId": 2, "status": "ok", "version": 1}], "changes": [], "tombstones": []}})
	t.check("tap_outcomes: the remover stops the tap", heard.size() == 1)
	var b: Variant = _coll_machine()
	var heard_b := []
	a.tap_outcomes(func(o: Dictionary) -> void: heard_b.append(o["mutationId"]))
	b.adopt_observers(a)
	b.update("cards", "z", {"set": {"a": 1}})
	t.check(
			"adopt_observers: the watches and taps carry over to the machine that replaces this one",
			b._watched.has("cards")
			and b._outcome_taps.size() == 1
			and not b.take_events().filter(func(e: Dictionary) -> bool: return e["type"] == "records").is_empty()
	)
