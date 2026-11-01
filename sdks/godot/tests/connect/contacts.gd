extends RefCounted
# @pkey-feature connect.links
# `PKeyConnectContacts` and the `contacts` rows of the `pkey.connect.v1` record (CC-19b.G2; WIRE-CONTRACT-V5
# section 15.10), ported from sdk-node's `contacts.ts` and `connectState.test.ts`: the 12 `contact.store`
# rows of `peer-matrix.json` through the store (the record is read and written between every operation), the
# record's bounds (64 + 8 rows, the category charset, a malformed row makes the record unusable and is never
# replaced), the 24 h lapse of a pending contact on every read, remove and set_reachable, redaction, and the
# size cap with a 128-device roster and 72 contacts. Reads res://tests/corpus/v2/peer-matrix.json
# (generator-owned; never edit it).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const PRODUCT := "demo"


class Clock extends RefCounted:
	var now := 1000


	func read() -> int:
		return now


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	_store_rows(t, (j.data as Dictionary)["contact"]["store"])
	_no_record(t)
	_reads(t)
	_changes(t)
	_lapse(t)
	_bounds(t)
	_malformed(t)
	_size_cap(t)
	_redaction(t)


# -- helpers --------------------------------------------------------------------------------------

static func _fill(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(32)
	b.fill(n)
	return b


static func _key(n: int) -> String:
	return PKeyB64Url.encode(_fill(n))


static func _raw(key_n: int, secret_n: int, cats: Array = [], reachable := true, pending := -1, label := "") -> Dictionary:
	var d := {"agreeKey": _key(key_n), "secret": _key(secret_n), "cats": cats.duplicate(), "createdAt": 1, "reachable": reachable}
	if label != "":
		d["label"] = label
	if pending >= 0:
		d["pendingSince"] = pending
	return d


static func _record(rows: Array) -> PKeyConnectState.Record:
	var r := PKeyConnectState.Record.new()
	r.product = PRODUCT
	r.device_id = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
	r.ring = "ring"
	r.certificate = "cert"
	r.disc_keys.append(_key(200))
	r.contacts = rows
	return r


## A store in memory holding a record with `rows`, and the contacts over it at the clock's time.
static func _contacts(rows: Array, clock: Clock) -> Array:
	var state := PKeyConnectState.for_tests(PRODUCT, "user://pkey", true)
	state.write(_record(rows))
	return [state, PKeyConnectContacts.new(state, Callable(clock, "read"))]


## [active secrets, pending secrets] (each its first byte) in the record, read raw.
static func _held(state: PKeyConnectState) -> Array:
	var rec: PKeyConnectState.Record = state.read().detail
	var active: Array = []
	var pending: Array = []
	for r: Dictionary in rec.contacts:
		var first := int((PKeyB64Url.decode_strict(r["secret"]) as PackedByteArray)[0])
		if r.has("pendingSince"):
			pending.append(first)
		else:
			active.append(first)
	return [active, pending]


static func _ints(a: Array) -> Array:
	return a.map(func(x: Variant) -> int: return int(x))


# -- the corpus's store rows ----------------------------------------------------------------------

func _store_rows(t: PKeyTestContext, rows: Array) -> void:
	var good := 0
	for r: Dictionary in rows:
		var seed_rows: Array = []
		for p: Array in r["start"]:
			seed_rows.append(_raw(int(p[0]), int(p[1])))
		var clock := Clock.new()
		var made := _contacts(seed_rows, clock)
		var state: PKeyConnectState = made[0]
		var contacts: PKeyConnectContacts = made[1]
		var ok := (r["ops"] as Array).size() == (r["want"] as Array).size()
		var bad := ""
		for i in (r["ops"] as Array).size():
			var op: Dictionary = r["ops"][i]
			var w: Dictionary = r["want"][i]
			match op["op"]:
				"pair":
					clock.now = int(op["now"])
					var v := contacts.store({"agree_key": _key(int(op["key"])), "secret": _fill(int(op["secret"])), "label": op.get("label", ""), "cats": []})
					if v.ok:
						ok = ok and w["result"] == ("pending" if v.detail["pending"] else "active")
					else:
						ok = ok and w["result"] == "full" and v.code == &"full"
				"promote":
					ok = ok and contacts.promote(_key(int(op["key"]))).ok
				"drop":
					clock.now = int(op["now"])
					ok = ok and contacts.list().ok
			var held := _held(state)
			ok = ok and held[0] == _ints(w["active"]) and held[1] == _ints(w["pending"])
			var order: Array = []
			var live := contacts.trial_order()
			if live.ok:
				for c: Dictionary in live.detail:
					order.append(int((c["secret"] as PackedByteArray)[0]))
				PKeyConnectContacts.wipe_live(live.detail)
			ok = ok and live.ok and order == _ints(w["order"])
			if not ok and bad == "":
				bad = "op %d: %s %s" % [i, held, order]
		good += int(t.check("store through the record: %s" % r["id"], ok, bad))
	t.check("every store row ran through the record", good == 12, "%d/12" % good)


# -- reads and changes ----------------------------------------------------------------------------

func _no_record(t: PKeyTestContext) -> void:
	var state := PKeyConnectState.for_tests(PRODUCT, "user://pkey", true)
	var c := PKeyConnectContacts.new(state)
	var r := c.list()
	t.check("no record: a device with no connect record has no links", not r.ok and r.code == PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE)
	t.check("no record: a pairing cannot be stored", not c.store({"agree_key": _key(5), "secret": _fill(5), "cats": []}).ok)


func _reads(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var made := _contacts([_raw(1, 11, ["docs", "a-b"], true, -1, "Ana"), _raw(2, 22, [], false)], clock)
	var c: PKeyConnectContacts = made[1]
	var listed := c.list()
	t.check("list: the held links, in order, with no key of any kind", listed.ok and (listed.detail as Array).size() == 2)
	var first: Dictionary = listed.detail[0]
	t.check("list: id, label, categories, time and reachability", first["id"] == PKeyConnectContacts.id_of(_key(1)) and first["label"] == "Ana" and first["categories"] == ["docs", "a-b"] \
			and first["created_at"] == 1 and first["reachable"] == true and first["re_pair_pending"] == false and listed.detail[1]["label"] == null and listed.detail[1]["reachable"] == false)
	t.check("list: a row's members name no key", not str(first).contains(_key(1)) and not str(first).contains(_key(11)) and first.size() == 6)
	t.check("id: 16 characters of the peer's key, a public value", first["id"].length() == 16 and PKeyConnectContacts.id_of("short") == "" \
			and PKeyConnectContacts.id_of(_key(1)) != PKeyConnectContacts.id_of(_key(2)))
	var live := c.live(first["id"])
	t.check("live: the secret and key for one link, decoded", live.ok and live.detail["secret"] == _fill(11) and live.detail["agree_key"] == _key(1) and live.detail["pending"] == false)
	PKeyConnectContacts.wipe_live([live.detail])
	t.check("live: wipe zeroes the copy", live.detail["secret"] == _fill(0))
	t.check("live: an unknown link is link-unknown", c.live("nope").code == PKeyConstants.ErrorCode.LINK_UNKNOWN)
	var keys := c.held_keys()
	t.check("held keys: the active contacts' agreeKeys", keys.ok and keys.detail == [_key(1), _key(2)])


func _changes(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var made := _contacts([_raw(1, 11, ["docs"], false, -1, "Old"), _raw(2, 22)], clock)
	var state: PKeyConnectState = made[0]
	var c: PKeyConnectContacts = made[1]
	var id1 := PKeyConnectContacts.id_of(_key(1))
	t.check("set_reachable: the choice rests in the record", c.set_reachable(id1, true).ok and c.list().detail[0]["reachable"] == true)
	t.check("set_reachable: an unknown link is link-unknown", c.set_reachable("nope", true).code == PKeyConstants.ErrorCode.LINK_UNKNOWN)
	# A re-pair of a held peer waits as a pending contact, the held one untouched.
	clock.now = 2000
	var v := c.store({"agree_key": _key(1), "secret": _fill(33), "label": "New", "cats": ["music"]})
	t.check("store: a peer already held is pending", v.ok and v.detail["pending"] == true and _held(state) == [[11, 22], [33]])
	var info: Dictionary = c.list().detail[0]
	t.check("store: the held link shows a re-pair waiting, with its own label and categories", info["re_pair_pending"] == true and info["label"] == "Old" and info["categories"] == ["docs"])
	var order: Array = []
	for x: Dictionary in c.trial_order().detail:
		order.append(int((x["secret"] as PackedByteArray)[0]))
	t.check("trial order: the held contacts, then the pending one", order == [11, 22, 33])
	t.check("promote: the pending contact takes the held one's place, keeping its reachability", c.promote(_key(1)).ok and _held(state) == [[33, 22], []] and c.list().detail[0]["reachable"] == true \
			and c.list().detail[0]["label"] == "New" and c.list().detail[0]["categories"] == ["music"])
	# A new peer is stored active and reachable, and the secret handed in is left alone.
	var secret := _fill(44)
	var added := c.store({"agree_key": _key(4), "secret": secret, "cats": []})
	t.check("store: a new peer is active", added.ok and added.detail["pending"] == false and _held(state)[0] == [33, 22, 44] and secret == _fill(44))
	t.check("store: and reachable, stamped with the time", c.list().detail[2]["reachable"] == true and c.list().detail[2]["created_at"] == 2000)
	# Remove: the secret is out of the record before it answers, a pending re-pair with it.
	c.store({"agree_key": _key(4), "secret": _fill(55), "cats": []})
	var id4 := PKeyConnectContacts.id_of(_key(4))
	t.check("remove: the link and its pending re-pair are gone from the record", c.remove(id4).ok and _held(state) == [[33, 22], []])
	var raw_after: String = (state.read().detail as PKeyConnectState.Record).encode().get_string_from_utf8()
	t.check("remove: no trace of the secret in the record's bytes", not raw_after.contains(_key(44)) and not raw_after.contains(_key(55)))
	t.check("remove: an unknown link is link-unknown", c.remove(id4).code == PKeyConstants.ErrorCode.LINK_UNKNOWN)


func _lapse(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	clock.now = 100000
	var made := _contacts([_raw(1, 11), _raw(1, 33, [], true, 100000 - 86400 + 1), _raw(2, 22), _raw(2, 44, [], true, 100000 - 86400)], clock)
	var state: PKeyConnectState = made[0]
	var c: PKeyConnectContacts = made[1]
	var listed := c.list()
	t.check("lapse: a pending contact of 24 h is dropped on a read, one a second younger is kept", listed.ok and _held(state) == [[11, 22], [33]])
	t.check("lapse: and it stays dropped in the record", (state.read().detail as PKeyConnectState.Record).contacts.size() == 3)


func _bounds(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var rows: Array = []
	for n in 64:
		rows.append(_raw(n + 1, n + 1))
	var made := _contacts(rows, clock)
	var c: PKeyConnectContacts = made[1]
	var full := c.store({"agree_key": _key(100), "secret": _fill(100), "cats": []})
	t.check("bounds: the 65th contact is refused full", not full.ok and full.code == &"full" and _held(made[0])[0].size() == 64)
	t.check("bounds: but a re-pair of a held peer is stored pending", c.store({"agree_key": _key(5), "secret": _fill(105), "cats": []}).detail["pending"] == true)
	var parse_ok := PKeyConnectState.Record.parse(_record(rows).encode())
	t.check("bounds: 64 rows parse", parse_ok != null and parse_ok.contacts.size() == 64)
	var too_many: Array = []
	for n in 73:
		too_many.append(_raw(n + 1, n + 1))
	t.check("bounds: 73 rows make the record unusable", PKeyConnectState.Record.parse(_record(too_many).encode()) == null)
	var seventy_two: Array = []
	for n in 72:
		seventy_two.append(_raw(n + 1, n + 1))
	t.check("bounds: 72 rows parse (64 held and 8 pending)", PKeyConnectState.Record.parse(_record(seventy_two).encode()) != null)


func _malformed(t: PKeyTestContext) -> void:
	var bad_rows := {
		"a category outside the charset": _raw(1, 1, ["a_b"]),
		"an upper-case category": _raw(1, 1, ["Docs"]),
		"a 33-character category": _raw(1, 1, ["a".repeat(33)]),
		"a repeated category": _raw(1, 1, ["a", "a"]),
		"nine categories": _raw(1, 1, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
		"an empty category": _raw(1, 1, [""]),
		"a short key": {"agreeKey": "short", "secret": _key(1), "cats": [], "createdAt": 1, "reachable": true},
		"a secret that is not canonical": {"agreeKey": _key(1), "secret": _key(1).substr(0, 42) + "B", "cats": [], "createdAt": 1, "reachable": true},
		"no reachable flag": {"agreeKey": _key(1), "secret": _key(1), "cats": [], "createdAt": 1},
		"a negative createdAt": {"agreeKey": _key(1), "secret": _key(1), "cats": [], "createdAt": -1, "reachable": true},
		"a label that is not text": {"agreeKey": _key(1), "secret": _key(1), "cats": [], "createdAt": 1, "reachable": true, "label": 5},
	}
	for what: String in bad_rows:
		var rec := _record([_raw(9, 9), bad_rows[what]])
		t.check("record: %s makes it unusable" % what, PKeyConnectState.Record.parse(rec.encode()) == null)
	# An unusable record is an error to the contacts store, never reset: the bytes stay what they were.
	var clock := Clock.new()
	var made := _contacts([_raw(9, 9)], clock)
	var state: PKeyConnectState = made[0]
	var c: PKeyConnectContacts = made[1]
	state.write(_record([_raw(9, 9), _raw(1, 1, ["Docs"])]))
	var before := state._mem.duplicate()
	var l := c.list()
	t.check("record: list answers keys-unreadable", not l.ok and l.code == PKeyDeviceKeyStore.KEYS_UNREADABLE)
	t.check("record: a store is refused and writes nothing", not c.store({"agree_key": _key(5), "secret": _fill(5), "cats": []}).ok and not c.remove("x").ok and not c.set_reachable("x", true).ok)
	t.check("record: the bytes are unchanged, not reset", state._mem == before)
	# A record with no contacts member parses as before.
	var plain := _record([])
	t.check("record: without contacts it is the same record as before", not plain.encode().get_string_from_utf8().contains("contacts") \
			and PKeyConnectState.Record.parse(plain.encode()).contacts.is_empty())


func _size_cap(t: PKeyTestContext) -> void:
	# A 128-device roster with its certificate is tens of KiB; 72 contacts with the longest labels and
	# eight categories each must still fit the state cap (the file reads at most 256 KiB).
	var rows: Array = []
	var cats: Array = []
	for n in 8:
		cats.append("c".repeat(31) + str(n))
	for n in 72:
		rows.append(_raw(n + 1, n + 1, cats, true, 5 if n >= 64 else -1, "L".repeat(64)))
	var rec := _record(rows)
	rec.ring = "r".repeat(128 * 400)
	rec.certificate = "c".repeat(4096)
	var bytes := rec.encode()
	t.check("size: a 128-device roster plus 72 full contacts fit the 256 KiB cap", bytes.size() < 262144, str(bytes.size()))
	var root := "user://pkey_contacts_%s" % Crypto.new().generate_random_bytes(4).hex_encode()
	var state := PKeyConnectState.for_tests(PRODUCT, root)
	var wrote := state.write(rec)
	var back := state.read()
	t.check("size: and round-trip through the file", wrote.ok and back.ok and (back.detail as PKeyConnectState.Record).contacts.size() == 72, str(wrote.code) + str(back.code))
	state.clear()
	DirAccess.remove_absolute(root.path_join(PRODUCT))
	DirAccess.remove_absolute(root)


func _redaction(t: PKeyTestContext) -> void:
	var clock := Clock.new()
	var made := _contacts([_raw(1, 171)], clock)
	var c: PKeyConnectContacts = made[1]
	t.check("redaction: the store prints nothing", str(c) == "PKeyConnectContacts()")
	t.check("redaction: a record with contacts prints nothing", str(_record([_raw(1, 171)])) == "PKeyConnectState.Record(redacted)")
	var row := PKeyConnectContacts.Row.new(_key(1), _fill(171), "Ana", [], 1, true, -1)
	t.check("redaction: a row prints nothing", str(row) == "PKeyConnectContacts.Row()")
	row.wipe()
	t.check("redaction: and wipes its own copy of the secret", row.stored.secret == _fill(0))
