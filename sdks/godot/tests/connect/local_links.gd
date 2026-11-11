extends RefCounted
# @pkey-feature connect.local
# Local links with no account (PKeyCloudLocalLinks, `PolarisKey.cloud_connect.local_links`, CC-29b.G3; WIRE-CONTRACT-V5
# section 15.12), ported from sdk-node's `localLinks.test.ts`: the store (`pkey.connect.local.v1`: the cap, the strict
# parse, an unreadable record never replaced, the last link clearing it, the reachable cap), the gate (`pair` and `join`
# answer `local-pairing-off`, managing links never does, a flip closes the window), `dials_left`, the failures of `join`
# and `cancel_join`, and two devices pairing over real loopback TCP and real Noise: the code, the consent, the link on
# both sides with the categories both listed, a wrong code that rotates the code, a decline that stores nothing, a
# window that expires, and `renew` with the nameplate memory and the renewal floor. No wall clock: the windows and the
# dial budget read a clock the test moves.

const Pairing := preload("res://tests/connect/pairing.gd")

var _host: Node
var _clock := [1000.0]


## A browse that ends when it is stopped, as a real lane's does (the shared fake keeps a stopped browser's callback).
class BrowseHandle:
	extends Pairing.FakeHandle
	var bus: Pairing.Bus
	var entry: Dictionary

	func stop() -> void:
		super()
		bus.browsers.erase(entry)


class LiveLane:
	extends Pairing.Lane

	func browse(
		on_up: Callable, _down := Callable(), _accept := Callable(), tags := {}
	) -> PKeyResult:
		var made := super(on_up, _down, _accept, tags)
		var h := BrowseHandle.new()
		h.bus = bus
		h.entry = bus.browsers[bus.browsers.size() - 1]
		return PKeyResult.success(h)


## One device: its core, client, store and facade, and what it was told.
class Dev:
	extends RefCounted
	var core: PKeyCore
	var state: PKeyConnectState
	var client: PKeyConnectClient
	var links: PKeyCloudLocalLinks
	var codes: Array = []
	var offers: Array = []
	var ended: Array = []
	var linked: Array = []
	var failed: Array = []
	var changes := [0]
	var interrupted: Array = []

	func on_code(c: Dictionary) -> void:
		codes.append(c)

	func on_confirm(o: PKeyConnectLocalCommon.Offer) -> void:
		offers.append(o)

	func on_end(e: Dictionary) -> void:
		ended.append(e)

	func on_linked(l: Dictionary) -> void:
		linked.append(l)

	func on_failed(f: Dictionary) -> void:
		failed.append(f)

	func on_interrupted(n: int) -> void:
		interrupted.append(n)

	func changed() -> void:
		changes[0] += 1

	## The options of `pair` for this device.
	func pair_options(cats: Array, label: String) -> Dictionary:
		return {
			"categories": cats,
			"label": label,
			"on_confirm": Callable(self, "on_confirm"),
			"on_code": Callable(self, "on_code"),
			"on_end": Callable(self, "on_end"),
			"on_linked": Callable(self, "on_linked"),
			"on_failed": Callable(self, "on_failed"),
			"on_interrupted": Callable(self, "on_interrupted"),
			"allow_loopback": true,
		}

	func join_options(cats: Array, label: String, code: String) -> Dictionary:
		return {
			"categories": cats,
			"label": label,
			"on_confirm": Callable(self, "on_confirm"),
			"code": code,
			"allow_loopback": true
		}


func run(t: PKeyTestContext) -> void:
	_host = Node.new()
	_tree().root.add_child(_host)
	await _store(t)
	await _gate(t)
	await _manage(t)
	await _dials(t)
	await _join_failures(t)
	await _frames(20)
	PKeyCloudLocalLinks.reset_budgets()
	_host.queue_free()


# -- helpers --------------------------------------------------------------------------------------


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _frames(n: int) -> void:
	for i in n:
		await _tree().process_frame


func _until(cond: Callable, frames := 1500) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


func _mono() -> float:
	return _clock[0]


func _device(bus: Pairing.Bus, gate: Variant = true, web := false) -> Dev:
	var d := Dev.new()
	var clock := [PKeyTestPeers.NOW]
	var opts := PKeyTestFixtures.options(
		"https://key.plrs.im",
		PKeyMemoryStore.new(PKeyTestPeers.ID_A, "pkeyt_x"),
		clock,
		"djdl",
		PKeyTestPeers.trust()
	)
	d.core = PKeyCore.create(opts, _host, "0.0.0").detail
	_manifest(d.core, gate)
	d.state = PKeyConnectState.for_tests("djdl", "user://pkey", true)
	d.client = PKeyConnectClient.new(d.core, d.state, null)
	var lane := LiveLane.new(bus)
	d.links = PKeyCloudLocalLinks.new(
		d.core,
		d.client,
		{
			"tree": _tree(),
			"web": func() -> bool: return web,
			"lane": func() -> Object: return lane,
			"mono": Callable(self, "_mono"),
			"timer": func(_s: float, _f: Callable) -> void: pass,
		}
	)
	d.links.on_change(Callable(d, "changed"))
	return d


func _manifest(core: PKeyCore, gate: Variant) -> void:
	var f := {"enabled": true, "lan": true, "relay": true}
	if gate != null:
		f["localPairing"] = gate
	core.discovery_manifest = {"services": {"connect": f}}


## A row for `store.add`, with a peer key made of `n`.
func _row(n: int, label: Variant = "peer", now := 100) -> Dictionary:
	return {
		"own_key": PKeyTestPeers.fixed(n + 1),
		"own_public": PKeyTestPeers.fixed(n + 2),
		"peer_key": PKeyTestPeers.fixed(n),
		"secret": PKeyTestPeers.fixed(n + 3),
		"label": label,
		"platform": "linux",
		"cats": ["docs"],
		"now": now,
	}


func _held(d: Dev) -> Array:
	var r := d.links.list()
	return r.detail if r.ok else []


# -- the store -------------------------------------------------------------------------------------


func _store(t: PKeyTestContext) -> void:
	var d := _device(Pairing.Bus.new())
	var store := d.links._src.store
	t.check(
		"store: a device with no record holds no links",
		_held(d).is_empty() and store.count().detail == 0
	)
	t.check("store: the record is not the Connect record's", store.persistence() == "memory")
	var added := store.add(_row(10, "Anna"))
	t.check(
		"store: a link is stored",
		added.ok and added.detail["stored"] and str(added.detail["id"]).length() == 16
	)
	var again := store.add(_row(10, "Anna 2"))
	t.check(
		"store: the same peer replaces its link, not a second one",
		again.ok and store.count().detail == 1
	)
	var listed: Dictionary = _held(d)[0]
	t.check(
		"store: list carries label, categories, platform and reachable",
		(
			listed["label"] == "Anna 2"
			and listed["categories"] == ["docs"]
			and listed["platform"] == "linux"
			and listed["reachable"] == true
		)
	)
	var text := str(listed)
	var secret_text := PKeyB64Url.encode(PKeyTestPeers.fixed(13))
	t.check(
		"store: no key or secret is in a listing or a str()",
		(
			not text.contains(secret_text)
			and not str(store).contains(secret_text)
			and not str(d.links).contains(secret_text)
		)
	)
	# A platform that is not a spelling is not kept.
	store.add(_row(20, null, 100).merged({"platform": "amiga"}, true))
	t.check(
		"store: a platform that is not an X-PKey-Platform spelling is dropped",
		(
			store.live(PKeyConnectLocalCommon.link_id(PKeyTestPeers.fixed(20))).ok
			and (
				_held(d).filter(func(r: Dictionary) -> bool: return r["platform"] == null).size()
				== 1
			)
		)
	)
	# Reachable by default up to eight; the ninth is stored off and cannot be turned on.
	for n in range(30, 30 + 7):
		store.add(_row(n))
	var ninth := store.add(_row(100))
	var ninth_id := str(ninth.detail["id"])
	var reach := _held(d).filter(func(r: Dictionary) -> bool: return r["reachable"]).size()
	t.check(
		"store: eight links are reachable and the ninth is stored off",
		(
			reach == 8
			and (
				_held(d).filter(func(r: Dictionary) -> bool: return r["id"] == ninth_id)[0]["reachable"]
				== false
			)
		)
	)
	var refused := d.links.set_reachable(ninth_id, true)
	t.check(
		"store: a ninth reachable link is local-links-full with cap reachable",
		(
			not refused.ok
			and refused.code == PKeyConstants.ErrorCode.LOCAL_LINKS_FULL
			and refused.detail["cap"] == "reachable"
		)
	)
	# The cap of 32 is judged in the write.
	var n := 200
	while int(store.count().detail) < PKeyPeerLocal.MAX_LOCAL_LINKS:
		store.add(_row(n))
		n += 4
	var over := store.add(_row(n + 1))
	t.check(
		"store: a 33rd link is not stored",
		(
			over.ok
			and over.detail["stored"] == false
			and store.count().detail == PKeyPeerLocal.MAX_LOCAL_LINKS
		)
	)
	var held := store.add(_row(10, "Anna 3"))
	t.check(
		"store: at the cap even a peer already held is not stored again",
		held.ok and held.detail["stored"] == false
	)
	var off := store.add(_row(n + 5).merged({"allowed": func() -> bool: return false}, true))
	t.check(
		"store: a pairing that finishes after the gate went off writes nothing",
		(
			off.ok
			and off.detail.get("off", false)
			and store.count().detail == PKeyPeerLocal.MAX_LOCAL_LINKS
		)
	)
	# A record that is not this schema is unreadable and never replaced.
	var garbage := _device(Pairing.Bus.new())
	var gs := garbage.links._src.store
	gs._state.write_bytes(
		'{"schema":"pkey.connect.local.v1","product":"djdl","links":[{"id":1}]}'.to_utf8_buffer()
	)
	var rows := gs.rows()
	t.check(
		"store: a record that breaks a rule is device-keys-unreadable",
		not rows.ok and rows.code == PKeyDeviceKeyStore.KEYS_UNREADABLE
	)
	var refused_add := gs.add(_row(10))
	var kept: Variant = gs._state.read_bytes().detail
	t.check(
		"store: an unreadable record is never replaced",
		(
			not refused_add.ok
			and kept is PackedByteArray
			and (kept as PackedByteArray).get_string_from_utf8().contains('"id":1')
		)
	)
	var list_bad := garbage.links.list()
	t.check("store: list says so", not list_bad.ok)
	# Strictness: an unknown member, a duplicate id and an empty list are unusable.
	var strict := _device(Pairing.Bus.new())
	var ss := strict.links._src.store
	var good := ss.add(_row(10))
	var rec: Dictionary = JSON.parse_string(ss._state.read_bytes().detail.get_string_from_utf8())
	var row: Dictionary = (rec["links"] as Array)[0].duplicate()
	var variants := {
		"an unknown member":
		{"schema": rec["schema"], "product": "djdl", "links": [row.merged({"extra": 1})]},
		"a duplicate id": {"schema": rec["schema"], "product": "djdl", "links": [row, row]},
		"no links": {"schema": rec["schema"], "product": "djdl", "links": []},
		"another product": {"schema": rec["schema"], "product": "other", "links": [row]},
		"a key that is not canonical":
		{"schema": rec["schema"], "product": "djdl", "links": [row.merged({"secret": "AAAA"})]},
	}
	for what: String in variants:
		ss._state.write_bytes(JSON.stringify(variants[what]).to_utf8_buffer())
		t.check("store: %s is unreadable" % what, not ss.rows().ok)
	t.check("store: the first add worked", good.ok)
	# Removing the last link clears the store: the record goes, it is never rewritten empty.
	var last := _device(Pairing.Bus.new())
	var ls := last.links._src.store
	var id := str(ls.add(_row(10)).detail["id"])
	ls.add(_row(14))
	var gone := last.links.remove(id)
	t.check(
		"store: remove answers ok and the peer's key reaches the purge hook",
		gone.ok and ls.count().detail == 1
	)
	var id2 := str(_held(last)[0]["id"])
	t.check(
		"store: forgetting the last link clears the record",
		(
			last.links.remove(id2).ok
			and ls._state.read_bytes().detail == null
			and _held(last).is_empty()
		)
	)
	t.check(
		"store: an unknown id is link-unknown",
		last.links.remove(id2).code == PKeyConstants.ErrorCode.LINK_UNKNOWN
	)


# -- the gate and managing links ------------------------------------------------------------------


func _gate(t: PKeyTestContext) -> void:
	var off := _device(Pairing.Bus.new(), false)
	var p: PKeyResult = await off.links.pair(off.pair_options(["docs"], "A"))
	t.check(
		"gate: pair is local-pairing-off while the answer is false",
		(
			not p.ok
			and p.code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF
			and p.detail["feature"] == PKeyConstants.Feature.CONNECT_LOCAL
		)
	)
	var j: PKeyResult = await off.links.join(off.join_options(["docs"], "A", "1234 5678"))
	t.check(
		"gate: join is local-pairing-off while the answer is false",
		not j.ok and j.code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF
	)
	var none := _device(Pairing.Bus.new(), null)
	var n: PKeyResult = await none.links.pair(none.pair_options(["docs"], "A"))
	t.check(
		"gate: a manifest with no localPairing member is off",
		not n.ok and n.code == PKeyConstants.ErrorCode.LOCAL_PAIRING_OFF
	)
	t.check(
		"gate: local_pairing reads the cached answer",
		not off.links.local_pairing() and _device(Pairing.Bus.new()).links.local_pairing()
	)
	var web := _device(Pairing.Bus.new(), true, true)
	var w: PKeyResult = await web.links.pair(web.pair_options(["docs"], "A"))
	t.check(
		"gate: web is connect-unavailable with reason runtime",
		(
			not w.ok
			and w.code == PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE
			and w.detail["reason"] == PKeyConstants.UnsupportedReason.RUNTIME
		)
	)
	t.check(
		"gate: list on web is empty",
		web.links.list().ok and (web.links.list().detail as Array).is_empty()
	)
	# Managing links is never gated.
	off.links._src.store.add(_row(10, "Anna"))
	var id := str(_held(off)[0]["id"])
	t.check(
		"gate: list, rename, set_reachable and remove work with the gate off",
		(
			off.links.rename(id, "Bo").ok
			and off.links.set_reachable(id, false).ok
			and _held(off)[0]["label"] == "Bo"
			and _held(off)[0]["reachable"] == false
			and off.links.remove(id).ok
		)
	)
	# A bad option is a typed failure.
	var on := _device(Pairing.Bus.new())
	var bad_cats: PKeyResult = await on.links.pair(on.pair_options(["Docs"], "A"))
	var no_code: PKeyResult = await on.links.pair(
		{"categories": ["docs"], "on_confirm": Callable(on, "on_confirm")}
	)
	var both: PKeyResult = await on.links.join(
		on.join_options(["docs"], "A", "12345678").merged({"qr": "x"})
	)
	t.check(
		"gate: bad categories, no on_code and code with qr are invalid-options",
		(
			bad_cats.code == PKeyConstants.ErrorCode.INVALID_OPTIONS
			and no_code.code == PKeyConstants.ErrorCode.INVALID_OPTIONS
			and both.code == PKeyConstants.ErrorCode.INVALID_OPTIONS
		)
	)
	# A device that holds 32 links answers local-links-full before anything is advertised or dialled.
	for k in PKeyPeerLocal.MAX_LOCAL_LINKS:
		on.links._src.store.add(_row(10 + k * 4))
	var full: PKeyResult = await on.links.pair(on.pair_options(["docs"], "A"))
	var full_join: PKeyResult = await on.links.join(on.join_options(["docs"], "A", "1234 5678"))
	t.check(
		"gate: pair and join at the cap are local-links-full with cap stored",
		(
			full.code == PKeyConstants.ErrorCode.LOCAL_LINKS_FULL
			and full.detail["cap"] == "stored"
			and full_join.code == PKeyConstants.ErrorCode.LOCAL_LINKS_FULL
		)
	)


func _manage(t: PKeyTestContext) -> void:
	var d := _device(Pairing.Bus.new())
	d.links._src.store.add(_row(10, "Anna"))
	var id := str(_held(d)[0]["id"])
	var before: int = d.changes[0]
	t.check(
		"manage: rename changes the label on this device",
		d.links.rename(id, "  Bo  ").ok and _held(d)[0]["label"] == "Bo"
	)
	t.check(
		"manage: an empty label is invalid-options",
		(
			d.links.rename(id, "").code == PKeyConstants.ErrorCode.INVALID_OPTIONS
			and d.links.rename(id, "x".repeat(65)).code == PKeyConstants.ErrorCode.INVALID_OPTIONS
		)
	)
	t.check(
		"manage: rename of an unknown id is link-unknown",
		d.links.rename("0".repeat(16), "Bo").code == PKeyConstants.ErrorCode.LINK_UNKNOWN
	)
	t.check(
		"manage: set_reachable of an unknown id is link-unknown",
		d.links.set_reachable("0".repeat(16), true).code == PKeyConstants.ErrorCode.LINK_UNKNOWN
	)
	t.check(
		"manage: on_change fired after a store, a rename and a re-mark",
		(
			d.changes[0] == before + 1
			and d.links.set_reachable(id, false).ok
			and d.changes[0] == before + 2
		)
	)
	var removed: Array = []
	d.links.removed = func(keys: Array) -> void: removed.append_array(keys)
	var peer := PKeyTestPeers.fixed(10)
	t.check(
		"manage: remove tells the purge hook the peer's key",
		d.links.remove(id).ok and removed.size() == 1 and removed[0] == peer
	)
	var seen := [0]
	var unsub := d.links.on_change(func() -> void: seen[0] += 1)
	d.links._src.store.add(_row(50))
	var next_id := str(_held(d)[0]["id"])
	d.links.set_reachable(next_id, false)
	unsub.call()
	d.links.set_reachable(next_id, true)
	t.check("manage: the Callable on_change returns unsubscribes", seen[0] == 1)


# -- dials and the join failures ----------------------------------------------------------------


func _dials(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var d := _device(Pairing.Bus.new())
	t.check(
		"dials_left: null until the text starts with two digits",
		(
			d.links.dials_left("") == null
			and d.links.dials_left("4") == null
			and d.links.dials_left("4x") == null
			and d.links.dials_left("-") == null
		)
	)
	t.check(
		"dials_left: two for a nameplate not dialled",
		(
			d.links.dials_left("48") == 2
			and d.links.dials_left("48 12") == 2
			and d.links.dials_left("4-8") == 2
		)
	)
	d.links._budget().spend("48", _mono(), 1)
	t.check(
		"dials_left: one after a dial",
		d.links.dials_left("4812 3456") == 1 and d.links.dials_left("49") == 2
	)
	d.links._budget().spend("48", _mono(), 1)
	t.check("dials_left: zero when both are spent", d.links.dials_left("48") == 0)
	_clock[0] += 301.0
	t.check("dials_left: two again after 300 s", d.links.dials_left("48") == 2)
	PKeyCloudLocalLinks.reset_budgets()


func _join_failures(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var d := _device(Pairing.Bus.new())
	var bad: PKeyResult = await d.links.join(d.join_options(["docs"], "A", "12ab"))
	t.check(
		"join: a code that does not parse is pairing-code-failed, reason invalid",
		(
			bad.code == PKeyConstants.ErrorCode.PAIRING_CODE_FAILED
			and bad.detail["reason"] == "invalid"
		)
	)
	var other: PKeyResult = await d.links.join(
		{
			"categories": ["docs"],
			"on_confirm": Callable(d, "on_confirm"),
			"qr": "PKP1:OTHER:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAA",
			"allow_loopback": true
		}
	)
	t.check(
		"join: a QR of another app is reason other-app",
		(
			other.code == PKeyConstants.ErrorCode.PAIRING_CODE_FAILED
			and other.detail["reason"] == "other-app"
		)
	)
	d.links._budget().spend("12", _mono(), 2)
	var spent: PKeyResult = await d.links.join(d.join_options(["docs"], "A", "1234 5678"))
	t.check(
		"join: a code whose dials are spent is reason spent and browses nothing",
		(
			spent.code == PKeyConstants.ErrorCode.PAIRING_CODE_FAILED
			and spent.detail["reason"] == "spent"
		)
	)
	# No advert: pairing-not-found once the browse ran out.
	var found := {"r": null}
	var run := func() -> void:
		found["r"] = await d.links.join(
			d.join_options(["docs"], "A", "9912 3456").merged({"browse_seconds": 5})
		)
	run.call()
	await _frames(5)
	t.check("join: it waits while the browse runs", found["r"] == null)
	_clock[0] += 6.0
	await _until(func() -> bool: return found["r"] != null)
	t.check(
		"join: no matching advert is pairing-not-found",
		found["r"] is PKeyResult and found["r"].code == PKeyConstants.ErrorCode.PAIRING_NOT_FOUND
	)
	# cancel_join: the answer is peer-closed with reason cancelled, and no dial is refunded.
	var cancelled := {"r": null}
	var run2 := func() -> void:
		cancelled["r"] = await d.links.join(d.join_options(["docs"], "A", "7712 3456"))
	run2.call()
	await _frames(3)
	d.links.cancel_join()
	await _until(func() -> bool: return cancelled["r"] != null)
	t.check(
		"join: cancel_join answers peer-closed with reason cancelled",
		(
			cancelled["r"] is PKeyResult
			and cancelled["r"].code == PKeyConstants.ErrorCode.PEER_CLOSED
			and cancelled["r"].detail["reason"] == "cancelled"
		)
	)
	t.check("join: a cancelled join left the dial budget alone", d.links.dials_left("77") == 2)
	PKeyCloudLocalLinks.reset_budgets()
