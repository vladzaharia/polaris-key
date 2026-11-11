extends RefCounted
# @pkey-feature connect.lan
# The Android discovery lane (CC-14b.9): PKeyAndroidMdns over a fake plugin that records the nsd_* ops
# and plays back events through `poll`. The Kotlin side is tested by NsdCommandsTest and PeerNsdTest;
# the real NsdManager runs only on a device (OS-6).

const A := "p1-aaaaaaaaaaaaaaaa"
const B := "p1-bbbbbbbbbbbbbbbb"
const C := "p1-cccccccccccccccc"


class FakePlugin:
	extends RefCounted
	var calls: Array = []
	var queued: Array = []
	var reply := {}
	## Whether the plugin reports `slots` (false: an older plugin).
	var slots := true
	## Whether the plugin reports `local` (the q and l slots and the q tag kind).
	var local := false

	func cmd(json: String) -> String:
		var q: Dictionary = JSON.parse_string(json)
		calls.append(q)
		var op := str(q.get("op"))
		if op == "poll":
			var out := {"ok": true, "events": queued, "dropped": 0}
			queued = []
			return JSON.stringify(out)
		if reply.has(op):
			return JSON.stringify(reply[op])
		var out := {"ok": true, "supported": true, "permission": "not_required"}
		if slots:
			out["slots"] = true
			if local:
				out["local"] = true
		return JSON.stringify(out)

	func event(body: Dictionary) -> void:
		queued.append(body)

	func ops() -> Array:
		return calls.map(func(c): return c["op"])

	func last(op: String) -> Dictionary:
		for i in range(calls.size() - 1, -1, -1):
			if calls[i]["op"] == op:
				return calls[i]
		return {}


class Seen:
	extends RefCounted
	var up: Array = []
	var down: Array = []

	func on_up(p: Dictionary) -> void:
		up.append(p)

	func on_down(n: String) -> void:
		down.append(n)


class Asked:
	extends RefCounted
	var permissions: Array = []

	func ask(p: String) -> void:
		permissions.append(p)


var _androids: Array[PKeyAndroid] = []


func run(t: PKeyTestContext) -> void:
	_create(t)
	_browse(t)
	_permission(t)
	_advertise(t)
	_bounds(t)
	_slots(t)
	_tags(t)
	_local(t)
	_consumers(t)
	_older(t)
	_export(t)
	for a in _androids:
		a.free()


func _lane(fake: FakePlugin, asked: Asked = null) -> PKeyAndroidMdns:
	var android := PKeyAndroid.new()
	android.platform = "android"
	android.native = fake
	_androids.append(android)
	return PKeyAndroidMdns.create(android, Callable(asked, "ask") if asked != null else Callable(Asked.new(), "ask"))


func _create(t: PKeyTestContext) -> void:
	var a := PKeyAndroid.new()
	a.platform = "ios"
	a.native = null
	t.check("create: off Android there is no lane", PKeyAndroidMdns.create(a, Callable()) == null)
	a.free()
	var unsupported := FakePlugin.new()
	unsupported.reply["nsd_status"] = {"ok": true, "supported": false, "permission": "not_required"}
	t.check("create: a plugin below API 34 gives no lane", _lane(unsupported) == null)
	var older := FakePlugin.new()
	older.reply["nsd_status"] = {"ok": false, "error": "unknown_op"}
	t.check("create: an older plugin without the nsd ops gives no lane", _lane(older) == null)
	var lane := _lane(FakePlugin.new())
	t.check("create: a plugin with the nsd ops gives a lane", lane != null and str(lane) == "PKeyAndroidMdns()")


func _browse(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	var lane := _lane(fake)
	var seen := Seen.new()
	var b := lane.browse(seen.on_up, seen.on_down, func(n: String) -> bool: return n != C)
	t.check("browse: starts", b.ok and fake.ops().has("nsd_browse_start"))
	var extra := lane.browse(Seen.new().on_up)
	t.check("browse: a second browse shares the native one", extra.ok and fake.ops().count("nsd_browse_start") == 1)
	extra.detail.stop()
	t.check("browse: the accepted names go native as a list", lane.set_accepted([A, B]) and fake.last("nsd_accept")["names"] == [A, B])
	var row := {"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.9", "fd00::2", "fe80::1%12"], "port": 4100, "txt": ["v=1", "m=a"]}
	fake.event(row)
	fake.event(row)
	fake.event({"ev": "nsd_found", "instance": C, "hosts": ["192.168.1.9"], "port": 4100, "txt": []})
	fake.event({"ev": "nsd_found", "instance": "p1-short", "hosts": ["192.168.1.9"], "port": 4100, "txt": []})
	fake.event({"ev": "nsd_found", "instance": B, "hosts": ["192.168.1.7"], "port": 0, "txt": []})
	fake.event({"ev": "nsd_found", "instance": B, "hosts": [], "port": 4100, "txt": []})
	fake.event({"ev": "nsd_found", "instance": B, "hosts": [5, "10.0.0.2", "10.0.0.2"], "port": 4101, "txt": ["a", "b", "c", "d", "e", "f", "g", "h", "i", 5]})
	lane.poll()
	var want := {"instance": A, "txt": ["v=1", "m=a"], "hosts": ["192.168.1.9", "fd00::2", "fe80::1%12"], "host": "192.168.1.9", "port": 4100}
	t.check("browse: a hit carries every address, once", seen.up.size() == 2 and seen.up[0] == want)
	var refused := seen.up.any(func(p): return p["instance"] == C or p["instance"] == "p1-short")
	t.check("browse: a second check drops refused names, bad ports and empty hosts", not refused and seen.up[1]["hosts"] == ["10.0.0.2"] and seen.up[1]["port"] == 4101)
	t.check("browse: TXT is cut to 8 text entries", (seen.up[1]["txt"] as Array).size() == 8)
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.10"], "port": 4100, "txt": []})
	lane.poll()
	t.check("browse: a changed address is reported again", seen.up.size() == 3 and seen.up[2]["host"] == "192.168.1.10")
	fake.event({"ev": "nsd_found", "instance": A, "hosts": [], "port": 4100, "txt": []})
	lane.poll()
	t.check("browse: an update with no address retracts the name", seen.down == [A])
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.10"], "port": 4100, "txt": []})
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.10"], "port": 0, "txt": []})
	lane.poll()
	t.check("browse: …and so does a bad port", seen.down == [A, A])
	seen.down = []
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.10"], "port": 4100, "txt": []})
	fake.event({"ev": "nsd_lost", "instance": A})
	fake.event({"ev": "nsd_lost", "instance": A})
	fake.event({"ev": "nsd_lost", "instance": C})
	lane.poll()
	t.check("browse: a loss is reported once and only for what was up", seen.down == [A])
	fake.event(row)
	lane.poll()
	t.check("browse: a peer that returned is found again", seen.up.size() >= 5)
	b.detail.stop()
	t.check("browse: stop ends the browse", fake.ops().has("nsd_browse_stop") and not lane.status()["active"])
	var after := seen.up.size()
	lane.stop()
	t.check("stop: ends everything natively", fake.ops().has("nsd_stop_all"))
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.9"], "port": 4100, "txt": []})
	lane.poll()
	t.check("stop: events after a stop are not routed", seen.up.size() == after)
	var bad := _lane(FakePlugin.new())
	t.check("set_accepted: a bad name clears the set natively and fails", not bad.set_accepted([A, "nope"]) and bad._android.native.last("nsd_accept")["names"] == [])


func _permission(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	fake.reply["nsd_browse_start"] = {"ok": false, "error": "permission_denied", "message": null}
	fake.reply["nsd_advertise"] = {"ok": false, "error": "permission_denied", "message": null}
	var asked := Asked.new()
	var lane := _lane(fake, asked)
	var r := lane.browse(Seen.new().on_up)
	t.check("permission: a denied browse is nearby-permission-denied", not r.ok and r.code == PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED and PKeyConnectErrors.reason_of(r) == "permission_denied")
	t.check("permission: …and the user is asked for ACCESS_LOCAL_NETWORK", asked.permissions == ["android.permission.ACCESS_LOCAL_NETWORK"])
	t.check("permission: …and the lane is not browsing, so a retry after the grant works", not lane.status()["active"] and lane.last_error() == "permission_denied")
	fake.reply.erase("nsd_browse_start")
	t.check("permission: after the grant the same lane browses", lane.browse(Seen.new().on_up).ok)
	var a := lane.advertise({"instance": A, "port": 4100})
	t.check("permission: a denied advert is nearby-permission-denied and is not advertising", not a.ok and a.code == PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED and asked.permissions.size() == 2)
	var down := FakePlugin.new()
	down.reply["nsd_advertise"] = {"ok": false, "error": "unsupported", "message": "sdk"}
	var l2 := _lane(down)
	var u := l2.advertise({"instance": A, "port": 4100})
	t.check("permission: an unsupported OS is not a permission error", not u.ok and u.code != PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED)


func _advertise(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	var lane := _lane(fake)
	var r := lane.advertise({"instance": A, "port": 4100, "txt": ["v=1", "m=a", 5]})
	var sent := fake.last("nsd_advertise")
	t.check("advertise: names the listener's port and passes only text TXT", r.ok and sent["instance"] == A and int(sent["port"]) == 4100 and sent["txt"] == ["v=1", "m=a"])
	t.check("advertise: a bad name is refused before the plugin", not lane.advertise({"instance": "x", "port": 4100}).ok)
	t.check("advertise: a missing or out-of-range port is refused", not lane.advertise({"instance": A}).ok and not lane.advertise({"instance": A, "port": 70000}).ok)
	var old: Object = r.detail
	var moved := lane.advertise({"instance": B, "port": 4100})
	old.stop()
	t.check("advertise: a replaced handle does nothing", not fake.ops().has("nsd_advertise_stop"))
	t.check("advertise: the new handle stops the advert", moved.ok and (moved.detail.stop() or fake.ops().has("nsd_advertise_stop")))
	lane.advertise({"instance": A, "port": 4100})
	fake.event({"ev": "nsd_advert", "ok": false, "reason": "renamed"})
	lane.poll()
	t.check("advertise: a refused advert shows in the status", not lane.status()["active"] and lane.last_error() == "renamed")


func _bounds(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	var lane := _lane(fake)
	var seen := Seen.new()
	lane.browse(seen.on_up)
	for i in PKeyAndroidMdns.MAX_ROWS + 50:
		var name := "p1-" + _name16(i)
		fake.event({"ev": "nsd_found", "instance": name, "hosts": ["192.168.1.9"], "port": 4100, "txt": []})
	lane.poll()
	t.check("browse: the reported table is bounded", seen.up.size() == PKeyAndroidMdns.MAX_ROWS)
	var many: Array = []
	for i in PKeyAndroidMdns.MAX_ACCEPTED + 1:
		many.append("p1-" + _name16(i))
	t.check("set_accepted: an oversized set is cleared, not sent", not lane.set_accepted(many) and fake.last("nsd_accept")["names"] == [])
	var other := FakePlugin.new()
	var l2 := _lane(other)
	var s2 := Seen.new()
	l2.browse(s2.on_up)
	other.event({"ev": "other", "x": 1})
	other.event({"ev": "result", "req": 7})
	other.event({"ev": "resumed"})
	l2.poll()
	t.check("poll: events that are not discovery are not routed here and break nothing", s2.up.is_empty())


func _calls_of(fake: FakePlugin, op: String) -> Array:
	return fake.calls.filter(func(c): return c["op"] == op)


func _slots(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	var lane := _lane(fake)
	t.check("slots: the plugin's status makes capabilities", lane.capabilities() == {"slots": true, "tags": true, "local": false})
	var a := lane.advertise({"instance": A, "port": 4100, "txt": ["v=1", "m=a"]})
	var v := lane.advertise({"instance": B, "port": 4101, "txt": ["v=1", "m=v"], "slot": "v"})
	var p := lane.advertise({"instance": C, "port": 4102, "txt": ["v=1", "m=p"], "slot": "p"})
	var sent := _calls_of(fake, "nsd_advertise")
	t.check("slots: each slot is its own registration on the caller's port", a.ok and v.ok and p.ok and sent.map(func(c): return c["slot"]) == ["a", "v", "p"] and
		sent.map(func(c): return int(c["port"])) == [4100, 4101, 4102])
	t.check("slots: the lane reports each one", lane.advertising("a") and lane.advertising("v") and lane.advertising("p") and lane.port_of("v") == 4101 and lane.port_of("p") == 4102)
	var cs: Array = []
	for i in 8:
		var c := lane.advertise({"instance": "p1-" + _name16(100 + i), "port": 4100, "txt": [], "slot": "c"})
		cs.append(c)
	var c_slots: Array = _calls_of(fake, "nsd_advertise").slice(3).map(func(c): return c["slot"])
	t.check("slots: contact adverts take c0 to c7", cs.all(func(c): return c.ok) and c_slots == ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"])
	var ninth := lane.advertise({"instance": "p1-" + _name16(200), "port": 4100, "txt": [], "slot": "c"})
	t.check("slots: a ninth contact advert is refused before the plugin", not ninth.ok and _calls_of(fake, "nsd_advertise").size() == 11)
	var dup := lane.advertise({"instance": "p1-" + _name16(100), "port": 4100, "txt": [], "slot": "c"})
	t.check("slots: a contact name that runs is refused", not dup.ok)
	t.check("slots: an unknown slot is refused", not lane.advertise({"instance": A, "port": 4100, "slot": "c0"}).ok and not lane.advertise({"instance": A, "port": 4100, "slot": "x"}).ok)
	# A second advert on a slot replaces it; the old handle then does nothing.
	var old: Object = v.detail
	var v2 := lane.advertise({"instance": C, "port": 4101, "txt": [], "slot": "v"})
	old.stop()
	t.check("slots: a replaced handle does nothing", v2.ok and _calls_of(fake, "nsd_advertise_stop").is_empty())
	var did: bool = v2.detail.update(B, ["v=1", "m=v"])
	var moved := fake.last("nsd_advertise")
	t.check("slots: update moves the advert on the same port and slot", did and moved["instance"] == B and moved["slot"] == "v" and int(moved["port"]) == 4101)
	t.check("slots: update with a bad name is false and sends nothing", not v2.detail.update("x", []) and fake.last("nsd_advertise")["instance"] == B)
	v2.detail.stop()
	t.check("slots: stop names the slot", fake.last("nsd_advertise_stop")["slot"] == "v" and not lane.advertising("v") and lane.port_of("v") == 0)
	t.check("slots: …and update after that is false", not v2.detail.update(A, []))
	(cs[3].detail as Object).stop()
	t.check("slots: a stopped contact frees its place", fake.last("nsd_advertise_stop")["slot"] == "c3" and lane.advertise({"instance": "p1-" + _name16(300), "port": 4100, "slot": "c"}).ok and
		fake.last("nsd_advertise")["slot"] == "c3")
	fake.event({"ev": "nsd_advert", "slot": "p", "ok": false, "reason": "renamed"})
	lane.poll()
	t.check("slots: a refusal ends that slot only", not lane.advertising("p") and lane.advertising("a") and lane.last_error() == "renamed")
	lane.stop()
	t.check("slots: stop ends them all", not lane.advertising("a") and not lane.status()["active"] and fake.ops().has("nsd_stop_all"))


func _tags(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	var lane := _lane(fake)
	var seen := Seen.new()
	var h1 := "0123456789abcdef"
	var h2 := "fedcba9876543210"
	var b := lane.browse(seen.on_up, seen.on_down, func(n: String) -> bool: return n == A, {"v": [h1, h2, "extra"], "p": [h2], "z": [h1]})
	var acc := fake.last("nsd_accept")
	t.check("tags: a browse pushes at most 2 per kind and only v, p and q", b.ok and acc["tags"] == {"v": [h1, h2], "p": [h2]} and acc["names"] == [])
	t.check("tags: the names keep the tags in force", lane.set_accepted([A]) and fake.last("nsd_accept")["tags"] == {"v": [h1, h2], "p": [h2]} and fake.last("nsd_accept")["names"] == [A])
	t.check("tags: new tags keep the names", lane.set_tags({"v": [h2]}) and fake.last("nsd_accept")["names"] == [A] and fake.last("nsd_accept")["tags"] == {"v": [h2]})
	fake.event({"ev": "nsd_found", "instance": B, "hosts": ["192.168.1.8"], "port": 4100, "txt": ["v=1", "m=v", "h=" + h2]})
	fake.event({"ev": "nsd_found", "instance": C, "hosts": ["192.168.1.7"], "port": 4100, "txt": ["v=1", "m=v", "h=" + h1]})
	fake.event({"ev": "nsd_found", "instance": "p1-" + _name16(5), "hosts": ["192.168.1.6"], "port": 4100, "txt": ["v=1", "m=p", "h=" + h2]})
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.9"], "port": 4100, "txt": ["v=1", "m=a"]})
	lane.poll()
	t.check("tags: a name the roster refuses enters on a matching kind and tag only", seen.up.map(func(p): return p["instance"]) == [B, A], str(seen.up.map(func(p): return p["instance"])))
	b.detail.stop()
	t.check("tags: ending the browse clears the tags natively", not fake.last("nsd_accept").has("tags") and fake.ops().has("nsd_browse_stop"))
	var l2 := _lane(FakePlugin.new())
	t.check("tags: set_tags with none and none held is nothing", l2.set_tags({}) and _calls_of(l2._android.native, "nsd_accept").is_empty())
	var no_tags := FakePlugin.new()
	var l3 := _lane(no_tags)
	t.check("tags: a browse without tags sends no tags", l3.browse(Seen.new().on_up).ok and _calls_of(no_tags, "nsd_accept").is_empty())
	var deny := FakePlugin.new()
	deny.reply["nsd_accept"] = {"ok": false, "error": "bad_input"}
	var l4 := _lane(deny)
	l4.browse(Seen.new().on_up)
	t.check("tags: a refused push is false and holds nothing", not l4.set_tags({"v": [h1]}) and l4._tags.is_empty())


func _older(t: PKeyTestContext) -> void:
	var fake := FakePlugin.new()
	fake.slots = false
	var lane := _lane(fake)
	t.check("older: no slots, no tags", lane != null and lane.capabilities() == {"slots": false, "tags": false, "local": false})
	t.check("older: slot a works as it always did, without a slot field", lane.advertise({"instance": A, "port": 4100}).ok and not fake.last("nsd_advertise").has("slot"))
	for slot in ["v", "p", "c"]:
		var r := lane.advertise({"instance": B, "port": 4100, "slot": slot})
		t.check("older: slot %s is nearby-unsupported and sends nothing" % slot, not r.ok and r.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED and _calls_of(fake, "nsd_advertise").size() == 1)
	var br := lane.browse(Seen.new().on_up, Callable(), Callable(), {"v": ["0123456789abcdef"]})
	t.check("older: a browse with tags is nearby-unsupported and starts nothing", not br.ok and br.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED and not fake.ops().has("nsd_browse_start"))
	t.check("older: a plain browse works", lane.browse(Seen.new().on_up).ok)
	t.check("older: set_tags with none is true, with some is false", lane.set_tags({}) and not lane.set_tags({"v": ["0123456789abcdef"]}))
	var again := lane.advertise({"instance": B, "port": 4100})
	again.detail.stop()
	t.check("older: a stop sends no slot", again.ok and not fake.last("nsd_advertise_stop").has("slot") and not lane.advertising("a"))


func _export(t: PKeyTestContext) -> void:
	t.check("export: the permission constant is the OS name", PKeyAndroidExport.LOCAL_NETWORK_PERMISSION == "android.permission.ACCESS_LOCAL_NETWORK")
	# Local pairing (CC-29b.G4) advertises and browses through the same NsdManager registrations: the manifest of the
	# account lane is all it needs, and the camera belongs to the kit's scanner, not to this export.
	for flavor in ["play", "direct"]:
		var manifest := PKeyAndroidExport.manifest_elements(flavor)
		t.check("export: %s carries the local-network and network-state permissions local pairing shares with the account lane" % flavor,
				manifest.contains(PKeyAndroidExport.LOCAL_NETWORK_PERMISSION) and manifest.contains(PKeyAndroidExport.NETWORK_STATE_PERMISSION) and not manifest.contains("CAMERA"))


static func _name16(i: int) -> String:
	const ALPHA := "abcdefghijklmnopqrstuvwxyz234567"
	var s := ""
	var n := i
	for k in 16:
		s += ALPHA[n % 32]
		n /= 32
	return s


func _local_lane() -> Array:
	var fake := FakePlugin.new()
	fake.local = true
	return [fake, _lane(fake)]


# Local pairing (CC-29b.G4): slots q and l0 to l7, the q tag kind.
func _local(t: PKeyTestContext) -> void:
	var older := FakePlugin.new()
	var old := _lane(older)
	t.check("local: a plugin without the local ops refuses q and l", not old.advertise({"instance": A, "port": 4100, "txt": [], "slot": "q"}).ok
			and not old.advertise({"instance": A, "port": 4100, "txt": [], "slot": "l"}).ok and _calls_of(older, "nsd_advertise").is_empty()
			and not old.browse(Callable(), Callable(), Callable(), {"q": ["0123456789abcdef"]}).ok)
	var pair := _local_lane()
	var fake: FakePlugin = pair[0]
	var lane: PKeyAndroidMdns = pair[1]
	t.check("local: capabilities say so", lane.capabilities() == {"slots": true, "tags": true, "local": true})
	var q := lane.advertise({"instance": A, "port": 4200, "txt": ["v=1", "m=q", "n=12"], "slot": "q"})
	t.check("local: slot q is its own registration on the window's port", q.ok and fake.last("nsd_advertise")["slot"] == "q" and int(fake.last("nsd_advertise")["port"]) == 4200 and lane.advertising("q"))
	var ls: Array = []
	for i in 8:
		ls.append(lane.advertise({"instance": "p1-" + _name16(500 + i), "port": 4300, "txt": ["v=1", "m=l"], "slot": "l"}))
	var slots: Array = _calls_of(fake, "nsd_advertise").slice(1).map(func(c): return c["slot"])
	t.check("local: the m=l adverts take l0 to l7 on the service's port", ls.all(func(r): return r.ok) and slots == ["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]
			and _calls_of(fake, "nsd_advertise").slice(1).all(func(c): return int(c["port"]) == 4300))
	var ninth := lane.advertise({"instance": "p1-" + _name16(600), "port": 4300, "txt": [], "slot": "l"})
	t.check("local: a ninth is refused before the plugin", not ninth.ok and _calls_of(fake, "nsd_advertise").size() == 9)
	t.check("local: a name that runs is refused", not lane.advertise({"instance": "p1-" + _name16(500), "port": 4300, "txt": [], "slot": "l"}).ok)
	(ls[2].detail as Object).stop()
	t.check("local: a stopped name frees its place", fake.last("nsd_advertise_stop")["slot"] == "l2"
			and lane.advertise({"instance": "p1-" + _name16(700), "port": 4300, "txt": [], "slot": "l"}).ok and fake.last("nsd_advertise")["slot"] == "l2")
	t.check("local: a name moves by update", (ls[0].detail as Object).update(B, ["v=1", "m=l"]) and fake.last("nsd_advertise")["slot"] == "l0" and fake.last("nsd_advertise")["instance"] == B)
	lane.stop()
	t.check("local: stop ends them all", not lane.advertising("q") and not lane.status()["active"])


# Several browses share the plugin's one: each gets what its own filter admits.
func _consumers(t: PKeyTestContext) -> void:
	var pair := _local_lane()
	var fake: FakePlugin = pair[0]
	var lane: PKeyAndroidMdns = pair[1]
	var tag := "0123456789abcdef"
	var account := Seen.new()
	var locals := Seen.new()
	var a := lane.browse(account.on_up, account.on_down, func(n: String) -> bool: return n == A)
	t.check("share: the first browse sets the names", a.ok and a.detail.set_accepted([A]) and fake.last("nsd_accept")["names"] == [A])
	var l := lane.browse(locals.on_up, locals.on_down, func(n: String) -> bool: return n == B)
	t.check("share: a second browse starts nothing natively", l.ok and fake.ops().count("nsd_browse_start") == 1)
	t.check("share: names are the union of both browses", l.detail.set_accepted([B]) and fake.last("nsd_accept")["names"] == [A, B])
	fake.event({"ev": "nsd_found", "instance": A, "hosts": ["192.168.1.9"], "port": 4100, "txt": ["v=1", "m=a"]})
	fake.event({"ev": "nsd_found", "instance": B, "hosts": ["192.168.1.8"], "port": 4300, "txt": ["v=1", "m=l"]})
	lane.poll()
	t.check("share: a row goes to the browse that accepts it", account.up.map(func(p): return p["instance"]) == [A] and locals.up.map(func(p): return p["instance"]) == [B])
	var late := Seen.new()
	var third := lane.browse(late.on_up, late.on_down, func(n: String) -> bool: return n == B)
	t.check("share: a browse that opens later is told what is up", late.up.map(func(p): return p["instance"]) == [B])
	third.detail.stop()
	var pairing := Seen.new()
	var p := lane.browse(pairing.on_up, pairing.on_down, func(_n: String) -> bool: return false, {"q": [tag]})
	t.check("share: tags are sent with everyone's names", p.ok and fake.last("nsd_accept")["tags"] == {"q": [tag]} and fake.last("nsd_accept")["names"] == [A, B])
	fake.event({"ev": "nsd_found", "instance": C, "hosts": ["192.168.1.7"], "port": 4400, "txt": ["v=1", "m=q", "h=" + tag, "n=12"]})
	lane.poll()
	t.check("share: a tagged row goes to the browse that holds the tag only", pairing.up.map(func(x): return x["instance"]) == [C] and locals.up.size() == 1 and account.up.size() == 1)
	fake.event({"ev": "nsd_lost", "instance": A})
	lane.poll()
	t.check("share: a loss reaches the browse that had the name", account.down == [A] and locals.down.is_empty())
	p.detail.stop()
	t.check("share: ending the pairing browse takes its tags back", not fake.last("nsd_accept").has("tags") and fake.last("nsd_accept")["names"] == [A, B] and not fake.ops().has("nsd_browse_stop"))
	a.detail.stop()
	t.check("share: and its names", fake.last("nsd_accept")["names"] == [B])
	l.detail.stop()
	t.check("share: the last one stops the browse", fake.ops().count("nsd_browse_stop") == 1)
