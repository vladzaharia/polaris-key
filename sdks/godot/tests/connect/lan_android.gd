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
		return JSON.stringify({"ok": true, "supported": true, "permission": "not_required"})

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
	t.check("browse: a second browse is refused", not lane.browse(seen.on_up).ok)
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


func _export(t: PKeyTestContext) -> void:
	t.check("export: the permission constant is the OS name", PKeyAndroidExport.LOCAL_NETWORK_PERMISSION == "android.permission.ACCESS_LOCAL_NETWORK")


static func _name16(i: int) -> String:
	const ALPHA := "abcdefghijklmnopqrstuvwxyz234567"
	var s := ""
	var n := i
	for k in 16:
		s += ALPHA[n % 32]
		n /= 32
	return s
