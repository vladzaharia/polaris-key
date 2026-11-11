extends RefCounted
# @pkey-feature sync.files sync.files.delta sync.transfer.background
# The native lanes of the bulk-body channel (U-41.6): PKeyAppleBulk (the binary entry's sb_* ops) and
# PKeyAndroidBulk (the plugin's sb* methods) against their fakes, plus each lane's guards. The fake channel
# and the transport tests live in suite_cloud_sync_bulk.gd.

const Base := preload("res://tests/suite_cloud_sync_bulk.gd")
const ORIGIN := "https://sync.example"
const TOKEN := "pkeyt_secret_bearer"
const PRODUCT := "diceroll"
const PRODUCT_URL := "https://key.example.test/diceroll/sync/files/saves/slot1/upload/u1"
const BEARER := "tok-3f9a-secret-bearer"

## The facade nodes the tests made: a Node is not reference counted, so the suite frees them at its end.
static var _owned: Array[Node] = []


static func _own(n: Node) -> Node:
	_owned.append(n)
	return n


static func _free_owned() -> void:
	for n in _owned:
		if is_instance_valid(n):
			n.free()
	_owned.clear()


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _apple(t)
	await _android(t)
	await _apple_guards(t)
	await _android_guards(t)
	await PKeyTestFixtures.frames(10)
	_free_owned()
	return true


# ── The Android lane (U-41.6b): PKeyAndroidBulk over the plugin's byte[] ops, events through the facade ─────────

func _a_head(req: int, transfer := "saves:slot1", path := "/diceroll/sync/files/saves/slot1/upload/u1/parts/1") -> Dictionary:
	return {"req": req, "transfer": transfer, "url": ORIGIN + path, "headers": {"Content-Type": "application/octet-stream", "X-PKey-Device": "dev1"},
			"bearer": TOKEN, "max_body": 4096, "part": 1}


func _ctx() -> Dictionary:
	return {"product": PRODUCT, "origin": ORIGIN, "subject": "user:1"}


## The facade, the plugin fake and a channel that is open.
func _a_rig() -> Dictionary:
	var f := PKeyFakeAndroidNative.new()
	var a := _own(PKeyAndroid.new())
	a.platform = "android"
	a.native = f
	var ch := PKeyAndroidBulk.create(_ctx, f, a)
	await ch.open(["saves:slot1"])
	return {"f": f, "a": a, "ch": ch}


static func _done(f: PKeyFakeAndroidNative, req: int, transfer: String, status := 204, body_len := 0) -> void:
	f.push_event(
			{"ev": "sb_done", "transfer": PKeyAndroidBulk.transfer_key(transfer), "req": float(req), "status": float(status), "headers": {"ETag": "\"e1\"", "Content-Type": "x"}, "body_len": float(body_len)}
	)


func _android(t: PKeyTestContext) -> void:
	var f0 := PKeyFakeAndroidNative.new()
	t.check("android bulk: no channel with a plugin whose probe is not refused", PKeyAndroidBulk.create(_ctx, Partial.new(), _own(PKeyAndroid.new())) == null)
	t.check("android bulk: a plugin with all seven ops makes a channel", PKeyAndroidBulk.create(_ctx, f0, _own(PKeyAndroid.new())) != null)
	t.check(
			"android bulk: urls split into origin and path, userinfo and fragments refused",
			PKeyAndroidBulk.split_url("https://h:8443/a/b?version=2") == {"origin": "https://h:8443", "path": "/a/b?version=2"}
				and PKeyAndroidBulk.split_url("https://u@h/a").is_empty()
				and PKeyAndroidBulk.split_url("https://h/a#f").is_empty()
				and PKeyAndroidBulk.split_url("https://h").is_empty()
	)

	# Before open, and after a refused open, nothing is sent.
	var cold := PKeyAndroidBulk.create(_ctx, f0, _own(PKeyAndroid.new()))
	var r0: Dictionary = await cold.put(_a_head(1), PackedByteArray([1]))
	t.check("android bulk: a request before open fails and touches nothing", r0 == {"fail": "network"} and f0.sb_ops.is_empty())
	f0.bulk_open_ok = false
	await cold.open([])
	t.check("android bulk: a refused open leaves the channel closed", (await cold.put(_a_head(1), PackedByteArray([1]))) == {"fail": "network"} and f0.sb_calls("sbPut").is_empty())

	# open: the product, the origin, the subject, and the journal ids as hashes.
	var rig: Dictionary = await _a_rig()
	var f: PKeyFakeAndroidNative = rig["f"]
	var a: PKeyAndroid = rig["a"]
	var ch: PKeyAndroidBulk = rig["ch"]
	var opened: Dictionary = f.sb_calls("sbOpen")[0]
	t.check(
			"android bulk: open pins product, origin and subject and sends the keep ids hashed",
			opened == {"product": PRODUCT, "origin": ORIGIN, "subject": "user:1", "keep": [PKeyAndroidBulk.transfer_key("saves:slot1")]}
	)
	t.check("android bulk: the channel is available", ch.available())

	# put: staged in pieces of at most 8 MiB, queued by file name, resolved by the event.
	var body := PackedByteArray()
	body.resize(8 * 1048576 + 10)
	body.fill(7)
	var out := [null]
	(func() -> void: out[0] = await ch.put(_a_head(5), body)).call()
	await PKeyTestFixtures.frames(4)
	var stages: Array = f.sb_ops.filter(func(o: Array) -> bool: return o[0] == "sbStage")
	t.check(
			"android bulk: a body over 8 MiB is staged in two pieces, the second names the file",
			stages.size() == 2 and stages[0][2] == 8 * 1048576 and stages[1][2] == 10 and not (stages[0][1] as Dictionary).has("file") and (stages[1][1] as Dictionary).has("file")
	)
	var puts := f.sb_calls("sbPut")
	t.check(
			"android bulk: one sbPut with the path (no origin), the staged file, the lower-cased headers and the cap",
			puts.size() == 1
				and puts[0]["path"] == "/diceroll/sync/files/saves/slot1/upload/u1/parts/1"
				and puts[0]["file"] == (stages[0][1] as Dictionary).get("file", (stages[1][1] as Dictionary)["file"])
				and puts[0]["max_body"] == 4096
				and puts[0]["headers"]["content-type"] == "application/octet-stream"
				and puts[0]["headers"]["x-pkey-device"] == "dev1"
	)
	t.check("android bulk: the transfer id is the SHA-256 of the journal id", puts[0]["transfer"] == PKeyAndroidBulk.transfer_key("saves:slot1") and (puts[0]["transfer"] as String).length() == 64)
	t.check(
			"android bulk: the bearer rides only in the request's own header, nowhere else",
			puts[0]["headers"]["authorization"] == "Bearer " + TOKEN
				and f.sb_ops.all(func(o: Array) -> bool: return o[0] == "sbPut" or not JSON.stringify(o[1]).contains(TOKEN))
				and not JSON.stringify(puts[0]).replace("Bearer " + TOKEN, "").contains(TOKEN)
	)
	t.check("android bulk: the staged bytes are the sealed body, whole", f.sb_files[puts[0]["file"]] == body)
	t.check("android bulk: the request waits for the event", out[0] == null)
	# Forged or replayed events change nothing.
	_done(f, 5, "saves:other", 200)
	_done(f, 99, "saves:slot1", 200)
	f.push_event({"ev": "sb_done", "transfer": 5, "req": "x", "status": 200})
	a.poll()
	t.check("android bulk: an event for another transfer, an unknown req or a malformed req is dropped", out[0] == null)
	_done(f, 5, "saves:slot1", 204)
	a.poll()
	t.check("android bulk: the matching event answers", out[0] is Dictionary and out[0]["status"] == 204)
	var again := [null]
	(func() -> void: again[0] = await ch.put(_a_head(6), PackedByteArray([1, 2, 3]))).call()
	await PKeyTestFixtures.frames(1)
	_done(f, 6, "saves:slot1", 200)
	_done(f, 6, "saves:slot1", 500)
	a.poll()
	t.check(
			"android bulk: the answer carries status, lower-case headers and an empty body; a replay changes nothing",
			again[0] is Dictionary and again[0]["status"] == 200 and again[0]["headers"] == {"etag": "\"e1\"", "content-type": "x"} and (again[0]["body"] as PackedByteArray).is_empty()
	)

	# fetch: the body comes with sbTake; a body over the cap is oversize.
	var got := [null]
	(func() -> void: got[0] = await ch.fetch(_a_head(7, "saves:slot1", "/diceroll/sync/files/saves/slot1"))).call()
	await PKeyTestFixtures.frames(1)
	t.check(
			"android bulk: a fetch is one sbGet with no file",
			f.sb_calls("sbGet").size() == 1 and not (f.sb_calls("sbGet")[0] as Dictionary).has("file") and f.sb_calls("sbGet")[0]["path"] == "/diceroll/sync/files/saves/slot1"
	)
	f.sb_answers[7] = PackedByteArray([9, 8, 7])
	_done(f, 7, "saves:slot1", 200, 3)
	a.poll()
	t.check("android bulk: the answer body is taken with sbTake", got[0] is Dictionary and got[0]["status"] == 200 and got[0]["body"] == PackedByteArray([9, 8, 7]))
	var big := [null]
	(func() -> void: big[0] = await ch.fetch(_a_head(8, "saves:slot1", "/diceroll/sync/files/saves/slot1"))).call()
	await PKeyTestFixtures.frames(1)
	_done(f, 8, "saves:slot1", 200, 5000)
	a.poll()
	t.check("android bulk: an answer longer than max_body is oversize and is never taken", big[0] == {"fail": "oversize"} and f.sb_calls("sbTake").size() == 1)

	# sb_fail reasons.
	for case in [["redirect", 9], ["oversize", 10], ["network", 11], ["timeout", 12]]:
		var res := [null]
		var req: int = case[1]
		(func() -> void: res[0] = await ch.fetch(_a_head(req, "saves:slot1", "/diceroll/sync/files/saves/slot1"))).call()
		await PKeyTestFixtures.frames(1)
		f.push_event({"ev": "sb_fail", "transfer": PKeyAndroidBulk.transfer_key("saves:slot1"), "req": float(req), "reason": case[0]})
		a.poll()
		var want: Dictionary = {"fail": case[0]} if case[0] == "oversize" else ({"fail": "network"} if case[0] != "redirect" else {})
		var ok: bool = res[0] is Dictionary and (res[0].get("status") == 302 if case[0] == "redirect" else res[0] == want)
		t.check("android bulk: sb_fail %s" % case[0], ok)

	# Refusals before anything is staged or queued.
	var n_ops := f.sb_ops.size()
	var bad_heads := [
		_a_head(20).merged({"url": "https://other.example/diceroll/sync/files/saves/slot1/upload/u1/parts/1"}, true),
		_a_head(21).merged({"url": "https://u@sync.example/diceroll/sync/files/saves/slot1"}, true),
		_a_head(22).merged({"headers": {"Authorization": "Bearer x"}}, true),
		_a_head(23).merged({"headers": {"Cookie": "a=b"}}, true),
		_a_head(24).merged({"bearer": ""}, true),
		_a_head(0),
		_a_head(25).merged({"max_body": 17 * 1048576}, true),
		_a_head(26).merged({"transfer": ""}, true),
	]
	var refused := true
	for h in bad_heads:
		refused = refused and (await ch.put(h, PackedByteArray([1]))) == {"fail": "network"}
	t.check("android bulk: a foreign origin, userinfo, an authorization or unlisted header, no bearer, a bad req or cap or no transfer is refused before native", refused and f.sb_ops.size() == n_ops)

	# A refused sbPut answers a failure at once and leaves nothing waiting.
	f.bulk_put_ok = false
	t.check("android bulk: a refused sbPut is a network failure", (await ch.put(_a_head(30), PackedByteArray([1]))) == {"fail": "network"})
	f.bulk_put_ok = true

	# cancel: by req and by transfer; a late event is dropped.
	var c1 := [null]
	(func() -> void: c1[0] = await ch.put(_a_head(40), PackedByteArray([1]))).call()
	await PKeyTestFixtures.frames(1)
	ch.cancel(40)
	var cancels := f.sb_calls("sbCancel")
	t.check(
			"android bulk: cancel(req) sends the hashed transfer and the req and ends the wait",
			cancels[-1]["transfer"] == PKeyAndroidBulk.transfer_key("saves:slot1") and int(cancels[-1]["req"]) == 40 and cancels[-1].size() == 2 and c1[0] == {"fail": "network"}
	)
	_done(f, 40, "saves:slot1", 200)
	a.poll()
	var c2 := [null]
	(func() -> void: c2[0] = await ch.put(_a_head(41), PackedByteArray([1]))).call()
	await PKeyTestFixtures.frames(1)
	ch.cancel("saves:slot1")
	t.check(
			"android bulk: cancel(transfer id) cancels natively and ends its waits",
			f.sb_calls("sbCancel")[-1] == {"transfer": PKeyAndroidBulk.transfer_key("saves:slot1")} and c2[0] == {"fail": "network"}
	)
	ch.cancel("")
	t.check("android bulk: an empty id is the unscoped tag", f.sb_calls("sbCancel")[-1] == {"transfer": PKeyAndroidBulk.transfer_key("unscoped")})

	# close: pending waits end, native closes, and later requests fail until open.
	var c3 := [null]
	(func() -> void: c3[0] = await ch.put(_a_head(50), PackedByteArray([1]))).call()
	await PKeyTestFixtures.frames(1)
	ch.close()
	t.check("android bulk: close ends every wait and closes natively", c3[0] == {"fail": "network"} and f.sb_ops[-1][0] == "sbClose")
	var after: int = f.sb_calls("sbPut").size()
	t.check("android bulk: a request after close fails without native", (await ch.put(_a_head(51), PackedByteArray([1]))) == {"fail": "network"} and f.sb_calls("sbPut").size() == after)
	await ch.open([])
	t.check("android bulk: open again after close", f.sb_calls("sbOpen").size() == 2)

# ── The iOS channel (U-41.5c): PKeyAppleBulk over a fake of the binary entry ────────────────────────


## A plugin whose first method does not answer a bad input with a refusal: the probe stops there.
class Partial:
	extends RefCounted

	# gdlint:ignore=function-name
	func sbOpen(_header: PackedByteArray) -> PackedByteArray:
		return PackedByteArray()


## A plugin whose every bulk method answers a fixed status byte.
class StatusPlugin:
	extends RefCounted
	var status := 0

	# gdlint:ignore=function-name
	func sbOpen(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbStage(_h: PackedByteArray, _p: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbPut(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbGet(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbTake(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbCancel(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])

	# gdlint:ignore=function-name
	func sbEnd(_h: PackedByteArray) -> PackedByteArray:
		return PackedByteArray([status])


func _bulk_rig() -> Dictionary:
	var fake := PKeyFakeAppleNative.Bulk.new()
	var apple := _own(PKeyApple.new())
	apple.native = fake
	apple.platform = "ios"
	var ch := PKeyAppleBulk.create(PRODUCT, "https://key.example.test", "/var/state/ns", apple)
	return {"fake": fake, "apple": apple, "ch": ch}


static func _head(req: int, transfer := "saves:slot1", url := PRODUCT_URL) -> Dictionary:
	return {"req": req, "transfer": transfer, "url": url, "headers": {"content-type": "application/octet-stream"},
			"bearer": BEARER, "max_body": 4096, "part": 2}


## Spin frames until `f` is true (or 600 frames).
func _until(f: Callable) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var n := 0
	while not f.call() and n < 600:
		await tree.process_frame
		n += 1


func _apple(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# Where there is none.
	var bare := _own(PKeyApple.new())
	bare.platform = "ios"
	bare.native = PKeyFakeAppleNative.new()
	t.check("apple bulk: a native without the binary entry gives no channel", PKeyAppleBulk.create(PRODUCT, "https://k.test", "/s", bare) == null)
	var other := _own(PKeyApple.new())
	other.platform = "android"
	other.native = PKeyFakeAppleNative.Bulk.new()
	t.check("apple bulk: off iOS there is no channel", PKeyAppleBulk.create(PRODUCT, "https://k.test", "/s", other) == null)
	t.check("apple bulk: the origin leaves out the default port", PKeyAppleBulk.origin_of("https://key.example.test/") == "https://key.example.test" and
		PKeyAppleBulk.origin_of("http://127.0.0.1:8787") == "http://127.0.0.1:8787" and PKeyAppleBulk.origin_of("nope") == "")

	# The pick (D-10): the option decides, and a channel the app set wins.
	var apple := _own(PKeyApple.new())
	apple.native = PKeyFakeAppleNative.Bulk.new()
	apple.platform = "ios"
	var opts := PKeyOptions.new()
	t.check("apple bulk: option off, no channel", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", apple) == null)
	opts.cloud_sync_background_transfers = true
	t.check("apple bulk: option on, on iOS, the Apple channel", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", apple) is PKeyAppleBulk)
	t.check("apple bulk: option on, the host with no plugin, none", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", bare) == null)
	var mine := Base.FakeChannel.new()
	opts.cloud_sync_bulk_channel = mine
	t.check("apple bulk: a channel the app set wins", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", apple) == mine)

	# Open: the report, then a lost one.
	var rig := _bulk_rig()
	var fake: PKeyFakeAppleNative.Bulk = rig["fake"]
	var ch: PKeyAppleBulk = rig["ch"]
	fake.report = {"resume": ["saves:b"], "cancelled": 2, "swept": 1}
	var got: Dictionary = await ch.open(["saves:a", "saves:b"])
	t.check("apple bulk: open sends the product, origin, an absolute state dir and the kept ids", fake.open_args.get("product") == PRODUCT and
		fake.open_args.get("origin") == "https://key.example.test" and str(fake.open_args.get("state_dir")).begins_with("/") and
		fake.open_args.get("keep") == ["saves:a", "saves:b"], str(fake.open_args))
	t.check("apple bulk: open answers the reconcile report", got == {"resume": ["saves:b"], "cancelled": 2, "swept": 1}, str(got))
	ch.close()
	var rig2 := _bulk_rig()
	rig2["fake"].report = null
	rig2["ch"].open_timeout_s = 0.05
	var lost: Dictionary = await rig2["ch"].open(["saves:a"])
	t.check("apple bulk: no report in time takes every kept transfer as lost", lost["resume"] == ["saves:a"], str(lost))
	var rig3 := _bulk_rig()
	rig3["fake"].refuse_open = true
	var refused: Dictionary = await rig3["ch"].open(["x"])
	t.check("apple bulk: a refused open leaves the channel unavailable", refused["resume"].is_empty() and not rig3["ch"].available())

	# A put: staged in pieces, one header, the answer from the event.
	rig = _bulk_rig()
	fake = rig["fake"]
	ch = rig["ch"]
	await ch.open([])
	var body := PackedByteArray()
	body.resize(9 * 1048576 + 5)
	for i in 64:
		body[i * 1000] = i + 1
	var res := [null]
	var go := func() -> void: res[0] = await ch.put(_head(7), body)
	go.call()
	await _until(func() -> bool: return fake.puts.size() == 1)
	t.check("apple bulk: the body is staged in two pieces of at most 8 MiB", fake.ops.count("sb_stage") == 2 and fake.puts.size() == 1 and (fake.puts[0]["body"] as PackedByteArray) == body)
	var rec: Dictionary = fake.puts[0]
	t.check("apple bulk: the header names the request, the spool and the bearer", rec["req"] == 7 and rec["transfer"] == "saves:slot1" and
		rec["bearer"] == BEARER and rec["spool"].length() == 36 and rec["max_body"] == 4096 and rec["part"] == 2 and
		rec["url"] == PRODUCT_URL, str(rec.keys()))
	t.check("apple bulk: the request waits for its event", res[0] == null)
	fake.finish(7, 204, {"ETag": "\"x\"", "x-junk": 3}, PackedByteArray([1, 2, 3]))
	await _until(func() -> bool: return res[0] != null)
	t.check("apple bulk: the event answers status, lower-case headers and body", res[0] is Dictionary and res[0]["status"] == 204 and
		res[0]["headers"] == {"etag": "\"x\""} and res[0]["body"] == PackedByteArray([1, 2, 3]), str(res[0]))
	# D-9: the bearer crossed once, in the one request header.
	var seen := 0
	var pieces := 0
	for p in fake.payloads:
		if p[0] == "sb_stage":
			pieces += (p[1] as PackedByteArray).size() - (1 if p[1][0] == 0 else 37)
		elif _contains(p[1], BEARER.to_utf8_buffer()):
			seen += 1
			t.check("apple bulk: the bearer is only in the put header", p[0] == "sb_put")
	t.check("apple bulk: the bearer appears in exactly one payload", seen == 1, str(seen))
	t.check("apple bulk: the staged pieces hold the body and nothing else", pieces == body.size(), str(pieces))

	# A get, a failure, an oversize.
	var g := [null, null, null]
	var g1 := func() -> void: g[0] = await ch.fetch(_head(8, "saves:slot1", "https://key.example.test/diceroll/sync/files/saves/slot1"))
	var g2 := func() -> void: g[1] = await ch.fetch(_head(9))
	var g3 := func() -> void: g[2] = await ch.fetch(_head(10))
	g1.call()
	g2.call()
	g3.call()
	await _until(func() -> bool: return fake.gets.size() == 3)
	t.check("apple bulk: a get carries no spool", fake.gets.size() == 3 and not fake.gets[0].has("spool") and fake.ops.count("sb_stage") == 2)
	fake.finish(10, 200, {}, PackedByteArray([9]))
	fake.fail(9, "network")
	fake.fail(8, "oversize")
	await _until(func() -> bool: return g[0] != null and g[1] != null and g[2] != null)
	t.check("apple bulk: events are routed by request, in any order", g[2]["status"] == 200 and g[1] == {"fail": "network"} and g[0] == {"fail": "oversize"}, str(g))

	# A refusal from the platform frees the staged file.
	fake.refuse_requests = true
	var refused_put: Dictionary = await ch.put(_head(11), PackedByteArray([1, 2, 3]))
	t.check("apple bulk: a refused put answers a failure and cancels its spool", refused_put == {"fail": "network"} and
		fake.cancels.any(func(c: Dictionary) -> bool: return c.has("spool")) and fake.staged.is_empty())
	fake.refuse_requests = false

	# Cancel is final.
	var c1 := [null]
	var cgo := func() -> void: c1[0] = await ch.fetch(_head(20))
	cgo.call()
	await _until(func() -> bool: return fake.tasks.has(20))
	ch.cancel(20)
	await _until(func() -> bool: return c1[0] != null)
	var asked := fake.cancels.any(func(c: Dictionary) -> bool: return int(c.get("req", 0)) == 20)
	t.check("apple bulk: cancel by request cancels natively and returns", asked and c1[0] == {"fail": "network"}, str(fake.cancels) + str(c1[0]))
	fake.finish(20, 200)
	await PKeyTestFixtures.frames(3)
	var t1 := [null, null]
	var tgo := func(r: int, tr: String) -> void: t1[r - 21] = await ch.fetch(_head(r, tr))
	tgo.call(21, "saves:a")
	tgo.call(22, "")
	await _until(func() -> bool: return fake.tasks.has(21) and fake.tasks.has(22))
	ch.cancel("saves:a")
	ch.cancel("")
	await _until(func() -> bool: return t1[0] != null and t1[1] != null)
	t.check("apple bulk: cancel by transfer, and the empty id is the unscoped one", fake.cancels.has({"transfer": "saves:a"}) and
		fake.cancels.has({"transfer": "unscoped"}) and t1[0] == {"fail": "network"} and t1[1] == {"fail": "network"}, str(fake.cancels))

	# The platform's task bound: the rest wait for a place.
	fake.tasks.clear()
	var many := []
	many.resize(305)
	var peak := [0]
	var mgo := func(i: int) -> void:
		many[i] = await ch.fetch(_head(100 + i, "saves:many"))
	for i in 305:
		mgo.call(i)
	await _until(func() -> bool: return fake.tasks.size() == 300)
	await PKeyTestFixtures.frames(3)
	t.check("apple bulk: no more than 300 requests are queued at once", fake.tasks.size() == 300 and fake.gets.size() >= 300, str(fake.tasks.size()))
	for i in 5:
		fake.finish(100 + i, 200)
	await _until(func() -> bool: return fake.tasks.size() == 300 and fake.gets.size() == 305 + 3 + 0)
	t.check("apple bulk: places freed let the waiting ones go", many[0] is Dictionary and many[0]["status"] == 200 and fake.tasks.size() <= 300)
	for r in fake.tasks.keys().duplicate():
		fake.finish(r, 200)
	await _until(func() -> bool: return many.all(func(m: Variant) -> bool: return m != null))
	t.check("apple bulk: every request is answered in the end", many.all(func(m: Variant) -> bool: return m is Dictionary and m.get("status") == 200))

	# Close: what is in flight fails; late events are dropped; nothing goes after.
	var k := [null]
	var kgo := func() -> void: k[0] = await ch.fetch(_head(300))
	kgo.call()
	await _until(func() -> bool: return fake.tasks.has(300))
	var closes := fake.closed
	ch.close()
	await _until(func() -> bool: return k[0] != null)
	t.check("apple bulk: close tells the platform and fails what was in flight", fake.closed == closes + 1 and k[0] == {"fail": "network"})
	fake.finish(300, 200)
	var after: Dictionary = await ch.fetch(_head(301))
	t.check("apple bulk: after close a request is refused without reaching the platform", after == {"fail": "network"} and not fake.tasks.has(301))
	await tree.process_frame
	apple.free()
	(rig["apple"] as PKeyApple).free()
	(rig2["apple"] as PKeyApple).free()
	(rig3["apple"] as PKeyApple).free()
	bare.free()
	other.free()


func _android_guards(t: PKeyTestContext) -> void:
	var plugin := StatusPlugin.new()
	for status in [0, 1]:
		plugin.status = status
		t.check("android bulk: a plugin whose probe answers other than bad input gives no channel (status %d)" % status, PKeyAndroidBulk.create(_ctx, plugin, _own(PKeyAndroid.new())) == null)
	plugin.status = PKeyAndroidBulk.BAD_INPUT
	t.check("android bulk: a plugin whose probe answers bad input gives a channel", PKeyAndroidBulk.create(_ctx, plugin, _own(PKeyAndroid.new())) != null)

	var rig: Dictionary = await _a_rig()
	var f: PKeyFakeAndroidNative = rig["f"]
	var ch: PKeyAndroidBulk = rig["ch"]
	var head := _a_head(60)
	(head["headers"] as Dictionary)["authorization"] = "Bearer other"
	var got: Dictionary = await ch.put(head, PackedByteArray([1]))
	t.check("android bulk: an authorization among the request headers is refused and nothing is queued",
			got == {"fail": "network"} and f.sb_calls("sbStage").is_empty() and f.sb_calls("sbPut").is_empty() and f.sb_calls("sbGet").is_empty())
	ch.close()
	(rig["a"] as PKeyAndroid).free()


func _apple_guards(t: PKeyTestContext) -> void:
	# An event for a request that waits for a place is not its answer.
	var rig := _bulk_rig()
	var fake: PKeyFakeAppleNative.Bulk = rig["fake"]
	var ch: PKeyAppleBulk = rig["ch"]
	await ch.open([])
	var tree := Engine.get_main_loop() as SceneTree
	var go := func(i: int) -> void: await ch.fetch(_head(i))
	for i in range(1, 301):
		go.call(i)
	await _until(func() -> bool: return fake.tasks.size() == 300)
	go.call(400)
	await PKeyTestFixtures.frames(2)
	t.check("apple bulk: the 301st request waits for a place", ch._pending.has(400) and not ch._slots.has(400) and not fake.tasks.has(400))
	fake.finish(400, 200)
	await PKeyTestFixtures.frames(3)
	t.check("apple bulk: an event for a request waiting for a place is dropped", ch._pending.has(400) and not (ch._pending[400].done as bool))
	ch.close()
	await tree.process_frame
	(rig["apple"] as PKeyApple).free()

	# What an earlier session left in the native queue is not this one's.
	var rig2 := _bulk_rig()
	var fake2: PKeyFakeAppleNative.Bulk = rig2["fake"]
	var ch2: PKeyAppleBulk = rig2["ch"]
	fake2.report = null
	ch2.open_timeout_s = 0.05
	fake2.queue_event("sb_reconciled", JSON.stringify({"resume": ["stale"], "cancelled": 9, "swept": 9}).to_utf8_buffer())
	var opened: Dictionary = await ch2.open(["saves:a"])
	t.check("apple bulk: events queued before open are dropped", opened == {"resume": ["saves:a"], "cancelled": 0, "swept": 0}, str(opened))
	ch2.close()
	(rig2["apple"] as PKeyApple).free()

	# The header buffer is cleared once the call is made.
	var rig3 := _bulk_rig()
	var fake3: PKeyFakeAppleNative.Bulk = rig3["fake"]
	var ch3: PKeyAppleBulk = rig3["ch"]
	await ch3.open([])
	var done := [0]
	var one := func() -> void:
		await ch3.put(_head(1), PackedByteArray([1, 2, 3]))
		done[0] += 1
	var two := func() -> void:
		await ch3.fetch(_head(2))
		done[0] += 1
	one.call()
	two.call()
	await _until(func() -> bool: return fake3.puts.size() == 1 and fake3.gets.size() == 1)
	var seen := 0
	var zeroed := true
	for h in fake3.held:
		if h[0] == "sb_put" or h[0] == "sb_get":
			seen += 1
			zeroed = zeroed and (h[1] as PackedByteArray).size() > 4 and (h[1] as PackedByteArray).count(0) == (h[1] as PackedByteArray).size()
	t.check("apple bulk: the request header buffer is zeroed after the call", seen == 2 and zeroed, str(seen))
	ch3.close()
	await tree.process_frame
	(rig3["apple"] as PKeyApple).free()


## The engine's request numbers never restart within a process: an answer left from before a sign-out cannot
## match a request of the next session, on either channel.


static func _contains(hay: PackedByteArray, needle: PackedByteArray) -> bool:
	if needle.is_empty() or hay.size() < needle.size():
		return false
	for i in hay.size() - needle.size() + 1:
		if hay[i] == needle[0] and hay.slice(i, i + needle.size()) == needle:
			return true
	return false
