extends RefCounted
# @pkey-feature connect.lan
# The Apple discovery lane (CC-14b.4): PKeyAppleMdns over a fake binary entry that records the
# bj_* ops and plays back events. The Swift side is tested by BonjourHostTests; the real glue
# runs in the live test (PKEY_LIVE_BONJOUR=1 swift test) and in the suite_native_apple real group.

const A := "p1-aaaaaaaaaaaaaaaa"
const B := "p1-bbbbbbbbbbbbbbbb"
const C := "p1-cccccccccccccccc"


class FakeBin:
	extends RefCounted
	var calls: Array = []
	var queued: Array = []
	var reply := {}

	func cmd_bin(op: String, data: PackedByteArray) -> PackedByteArray:
		calls.append([op, data])
		return PackedByteArray([int(reply.get(op, 1))])

	func poll_bin() -> Array:
		var out := queued
		queued = []
		return out

	func event(kind: String, body: Dictionary) -> void:
		queued.append([kind, JSON.stringify(body).to_utf8_buffer()])

	func ops() -> Array:
		return calls.map(func(c): return c[0])

	func json_of(op: String) -> Dictionary:
		for c in calls:
			if c[0] == op:
				return JSON.parse_string((c[1] as PackedByteArray).get_string_from_utf8())
		return {}


class Seen:
	extends RefCounted
	var up: Array = []
	var down: Array = []

	func on_up(p: Dictionary) -> void:
		up.append(p)

	func on_down(n: String) -> void:
		down.append(n)


var _apples: Array[PKeyApple] = []


func run(t: PKeyTestContext) -> void:
	_create(t)
	_browse(t)
	_errors(t)
	_advertise(t)
	_export(t)
	for a in _apples:
		a.free()


func _lane(fake: FakeBin) -> PKeyAppleMdns:
	var apple := PKeyApple.new()
	apple.platform = "ios"
	apple.native = fake
	_apples.append(apple)
	return PKeyAppleMdns.create(apple, null)


func _create(t: PKeyTestContext) -> void:
	var a := PKeyApple.new()
	a.platform = "ios"
	a.native = RefCounted.new()
	t.check("create: no binary entry, no lane", PKeyAppleMdns.create(a, null) == null)
	a.free()
	var lane := _lane(FakeBin.new())
	t.check("create: a native with the binary entry gives a lane", lane != null and str(lane) == "PKeyAppleMdns()")


func _browse(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	var seen := Seen.new()
	var b := lane.browse(seen.on_up, seen.on_down, func(n: String) -> bool: return n != C)
	t.check("browse: starts", b.ok and fake.ops() == ["bj_browse_start"] and fake.json_of("bj_browse_start") == {"p2p": false})
	t.check("browse: a second browse is refused", not lane.browse(seen.on_up).ok)
	t.check("browse: nothing is accepted until the names are pushed (the bytes are the concatenated names)", lane.set_accepted([A, B])
			and fake.calls[-1][0] == "bj_accept" and (fake.calls[-1][1] as PackedByteArray).get_string_from_ascii() == A + B)
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": C, "txt": []})
	fake.event("bj_found", {"instance": "p1-short", "txt": []})
	fake.event("bj_found", {"instance": B, "txt": ["a", "b", "c", "d", "e", "f", "g", "h", "i", 5]})
	fake.queued.append(["selftest", PackedByteArray([1])])
	fake.queued.append(["bj_found", PackedByteArray([0xFF, 0xFE])])
	lane.poll()
	t.check("browse: a hit is reported once, in the lan shape", seen.up.size() == 2 and seen.up[0] == {"instance": A, "txt": ["v=1", "m=a"], "hosts": [], "host": "", "port": 0, "native": true})
	t.check("browse: the accept callback is a second check, a bad name and bad payloads are dropped", not seen.up.any(func(p): return p["instance"] == C or p["instance"] == "p1-short"))
	t.check("browse: TXT is cut to 8 text entries", (seen.up[1]["txt"] as Array).size() == 8)
	fake.event("bj_lost", {"instance": A})
	fake.event("bj_lost", {"instance": A})
	fake.event("bj_lost", {"instance": C})
	lane.poll()
	t.check("browse: a loss is reported once and only for what was up", seen.down == [A])
	fake.event("bj_found", {"instance": A, "txt": []})
	lane.poll()
	t.check("browse: a peer that returned is found again", seen.up.size() == 3)
	var rows := Seen.new()
	var big := _lane(FakeBin.new())
	big.browse(rows.on_up)
	var many := FakeBin.new()
	many.queued = []
	var lane2 := _lane(many)
	lane2.browse(rows.on_up)
	for i in PKeyAppleMdns.MAX_ROWS + 50:
		many.event("bj_found", {"instance": "p1-%s" % _name16(i), "txt": []})
	lane2.poll()
	t.check("browse: the reported table is bounded", rows.up.size() == PKeyAppleMdns.MAX_ROWS)
	b.detail.stop()
	t.check("browse: stop ends the browse", fake.ops().has("bj_browse_stop"))
	lane.stop()
	t.check("browse: stop() ends everything natively", fake.ops().has("bj_stop_all"))


func _name16(i: int) -> String:
	var alphabet := "abcdefghijklmnopqrstuvwxyz234567"
	var s := ""
	var n := i
	for k in 16:
		s += alphabet[n % 32]
		n /= 32
	return s


func _errors(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	fake.reply = {"bj_browse_start": 4}
	var lane := _lane(fake)
	var denied := lane.browse(Callable())
	t.check("errors: a refused permission is nearby-permission-denied", not denied.ok and denied.code == PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED and lane.last_error() == "permission_denied")
	fake.reply = {"bj_browse_start": 5, "bj_advertise_start": 5}
	var plist := lane.browse(Callable())
	t.check("errors: a missing plist is not-configured", not plist.ok and plist.code == PKeyConstants.ErrorCode.NOT_CONFIGURED and lane.last_error() == "not_configured")
	var ad := lane.advertise({"instance": A, "txt": ["v=1", "m=a"]})
	t.check("errors: the same for an advert", not ad.ok and ad.code == PKeyConstants.ErrorCode.NOT_CONFIGURED)
	fake.reply = {"bj_browse_start": 6}
	t.check("errors: any other failure is a registered code", not lane.browse(Callable()).ok)
	t.check("errors: a failed start leaves the lane idle", not lane.status()["active"])
	var live := _lane(FakeBin.new())
	var f2: FakeBin = live._apple.native
	live.browse(Callable())
	f2.event("bj_error", {"scope": "browse", "error": "permission_denied"})
	live.poll()
	t.check("errors: a late refusal is kept", live.last_error() == "permission_denied")
	t.check("errors: a bad instance name never reaches the native side", not live.advertise({"instance": "x", "txt": []}).ok and not f2.ops().has("bj_advertise_start"))


func _advertise(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	var first := lane.advertise({"instance": A, "port": 1234, "txt": ["v=1", "m=a"]})
	t.check("advertise: starts with the instance and TXT, and no port (the OS listener has its own)", first.ok and fake.json_of("bj_advertise_start") == {"instance": A, "txt": ["v=1", "m=a"]})
	var second := lane.advertise({"instance": B, "port": 1234, "txt": ["v=1", "m=a"]})
	t.check("advertise: the next name updates the same advert", second.ok and fake.ops().count("bj_advertise_start") == 1 and fake.json_of("bj_advertise_update")["instance"] == B)
	first.detail.stop()
	t.check("advertise: the replaced handle's stop() does not stop the new name (lan rotates this way)", not fake.ops().has("bj_advertise_stop") and lane.status()["active"])
	fake.event("bj_advertise", {"ok": true, "port": 5555})
	lane.poll()
	t.check("advertise: the started port is kept", lane._port == 5555)
	second.detail.stop()
	t.check("advertise: the current handle stops it", fake.ops().has("bj_advertise_stop") and not lane.status()["active"])
	lane.advertise({"instance": A, "txt": []})
	fake.event("bj_advertise", {"ok": false, "error": "permission_denied"})
	lane.poll()
	t.check("advertise: a failed start is reported and the advert is not running", lane.last_error() == "permission_denied" and not lane._advertising)


func _export(t: PKeyTestContext) -> void:
	var apple_export := PKeyAppleExport
	var p := apple_export.local_network_plist("")
	t.check("export: Bonjour keys name the peer service and carry a usage sentence", p.contains("<key>NSBonjourServices</key>") and p.contains("<string>_pkeypeer._tcp</string>")
			and p.contains("<key>NSLocalNetworkUsageDescription</key>") and p.contains(apple_export.DEFAULT_LOCAL_NETWORK_USAGE))
	t.check("export: a key the preset already has is not doubled", not apple_export.local_network_plist("<key>NSBonjourServices</key>").contains("NSBonjourServices")
			and not apple_export.local_network_plist("<key>NSLocalNetworkUsageDescription</key>").contains("NSLocalNetworkUsageDescription")
			and apple_export.local_network_plist("<key>NSBonjourServices</key><key>NSLocalNetworkUsageDescription</key>") == "")
	var escaped := apple_export.local_network_plist("", "A & B")
	var blank := apple_export.local_network_plist("", "  ")
	t.check("export: a custom sentence is XML-escaped, an empty one falls back", escaped.contains("A &amp; B") and blank.contains(apple_export.DEFAULT_LOCAL_NETWORK_USAGE))
	var other := apple_export.bonjour_warning("<key>NSBonjourServices</key><string>_x._tcp</string>")
	var ours := apple_export.bonjour_warning("<key>NSBonjourServices</key><string>_pkeypeer._tcp</string>")
	t.check("export: a preset list without the peer service warns", other != "" and ours == "" and apple_export.bonjour_warning("") == "")
