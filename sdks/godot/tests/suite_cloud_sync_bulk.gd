extends RefCounted
# @pkey-feature sync.files sync.files.delta sync.transfer.background
# The bulk-body channel of Cloud Sync file transfers (U-41.G), against a fake channel: the file transport
# routes only the body calls through it (the bearer in the head, never a header; a 3xx refused; an answer
# over the cap is bad_response; a lost reply is cancelled and answers status 0), and the engine enqueues a
# phase's bodies together (parts, chunks), takes completions in any order, and stops for good on a cancel.

const FilesTransport := preload("res://addons/polaris_key/services/cloud_sync/files_transport.gd")
const BulkChannel := preload("res://addons/polaris_key/services/cloud_sync/bulk_channel.gd")
const ORIGIN := "https://sync.example"
const TOKEN := "pkeyt_secret_bearer"
const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")
const Codec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const TransferSuite := preload("res://tests/suite_cloud_sync_transfer.gd")

const CloudSync := preload("res://addons/polaris_key/services/cloud_sync.gd")

const PRODUCT := "diceroll"
const PRODUCT_URL := "https://key.example.test/diceroll/sync/files/saves/slot1/upload/u1"
const BEARER := "tok-3f9a-secret-bearer"
const TARGET := {"collection": "saves", "record": "slot1", "transfer": "saves:slot1"}


## A channel whose answers the test gives: `auto(head, body)` answers at once (null: no answer), else the
## request waits until `answer(req, reply)`.
class FakeChannel:
	extends BulkChannel

	class Hold:
		extends RefCounted
		signal released
		var reply := {}

	var is_available := true
	var auto := Callable()
	var heads: Array = []
	var bodies: Array = []
	var holds := {}
	var cancelled_reqs: Array = []
	var cancelled_transfers: Array = []
	var opened_with: Array = []
	var close_calls := 0
	var in_flight := 0
	var max_in_flight := 0

	func available() -> bool:
		return is_available

	func open(keep_ids: Array) -> Dictionary:
		opened_with.append(keep_ids)
		return {"resume": [], "cancelled": 0, "swept": 0}

	func put(head: Dictionary, body: PackedByteArray) -> Dictionary:
		bodies.append(body)
		return await _serve(head)

	func fetch(head: Dictionary) -> Dictionary:
		return await _serve(head)

	func _serve(head: Dictionary) -> Dictionary:
		heads.append(head)
		in_flight += 1
		max_in_flight = maxi(max_in_flight, in_flight)
		var out: Variant = null
		if auto.is_valid():
			out = await auto.call(head)
		if out == null:
			var h := Hold.new()
			holds[head["req"]] = h
			await h.released
			out = h.reply
		in_flight -= 1
		return out

	func answer(req: int, reply: Dictionary) -> void:
		var h: Hold = holds[req]
		h.reply = reply
		h.released.emit()

	func cancel(what: Variant) -> void:
		if what is String:
			cancelled_transfers.append(what)
		else:
			cancelled_reqs.append(what)

	func close() -> void:
		close_calls += 1


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _transport(t)
	await _engine(t)
	await _engine_cancel(t)
	await _sign_out(t)
	await _late_reply(t)
	await _android(t)
	await _apple(t)
	await PKeyTestFixtures.frames(10)
	return true


static func _headers(extra: Dictionary) -> Dictionary:
	var h := {"x-pkey-device": "dev1"}
	h.merge(extra, true)
	return h


func _sha(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


func _rig(ch: BulkChannel) -> Dictionary:
	var host := Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	# local-only: the PKeyTransport dials nothing, so a JSON call that wrongly stayed on it is visible.
	var tr := FilesTransport.make_transport(host, true)
	var ctx := func() -> Dictionary:
		return {"product": PRODUCT, "token": "pkeyt_secret", "headers": _headers, "url": func(path: String) -> String: return "https://sync.example" + path}
	var ft := FilesTransport.new(tr, ctx)
	ft.set_channel(ch)
	return {"ft": ft, "host": host}


func _ok(status := 204, body := PackedByteArray(), headers := {}) -> Dictionary:
	return {"status": status, "headers": headers, "body": body}


func _transport(t: PKeyTestContext) -> void:
	var ch := FakeChannel.new()
	var rig := _rig(ch)
	var ft: FilesTransport = rig["ft"]
	var body := Crypto.new().generate_random_bytes(300)
	ch.auto = func(_h: Dictionary) -> Variant: return _ok()
	t.check("the transport batches while the channel is available", ft.batching())

	var put: Dictionary = await ft.put_part(TARGET, "up_1", 2, body, _sha(body))
	var head: Dictionary = ch.heads[0]
	t.check("put_part: the body goes through the channel and 204 is ok", put["ok"] and ch.bodies[0] == body, str(put))
	t.check("put_part: the head names the route, the transfer and the part", head["url"] == "https://sync.example/diceroll/sync/files/saves/slot1/upload/up_1/parts/2"
			and head["transfer"] == "saves:slot1" and head["part"] == 2 and head["req"] is int and head["req"] > 0, str(head))
	t.check("put_part: the bearer is in the head and in no header", head["bearer"] == "pkeyt_secret" and not (head["headers"] as Dictionary).has("authorization")
			and (head["headers"] as Dictionary)["content-digest"] == "sha-256=:%s:" % Marshalls.raw_to_base64(PKeySyncHkdf.sha256(body)), str(head["headers"].keys()))
	var bearer_elsewhere := false
	for k in head:
		if k != "bearer" and str(head[k]).contains("pkeyt_secret"):
			bearer_elsewhere = true
	t.check("put_part: the bearer is in no other field", not bearer_elsewhere)

	var json_call: Dictionary = await ft.begin(TARGET, {"size": 1})
	t.check("JSON calls stay on the PKeyTransport", not json_call["ok"] and json_call["code"] == "local_only" and ch.heads.size() == 1, str(json_call))

	var bad: Dictionary = await ft.put_part(TARGET, "up_1", 0, body, _sha(body))
	t.check("the route check runs before the channel", not bad["ok"] and bad["code"] == "bad_path" and ch.heads.size() == 1)

	# get_chunk and get_file
	var obj := Crypto.new().generate_random_bytes(5000)
	ch.auto = func(_h: Dictionary) -> Variant: return _ok(200, obj, {"ETag": "\"e1\"", "Content-Range": "bytes 0-4999/5000"})
	var got: Dictionary = await ft.get_chunk("saves", "c".repeat(64), "saves:slot1")
	t.check("get_chunk: the object comes back through the channel", got["ok"] and got["value"] == obj and ch.heads[ch.heads.size() - 1]["transfer"] == "saves:slot1", str(got.get("code")))
	var file: Dictionary = await ft.get_file(TARGET, {"version": 3, "range": [0, 5000], "if_match": "\"e1\""})
	var fh: Dictionary = ch.heads[ch.heads.size() - 1]
	t.check("get_file: ranged GET with If-Match, the answer's headers read case-insensitively", file["ok"] and file["value"]["etag"] == "\"e1\"" and file["value"]["content_range"] == [0, 5000, 5000]
			and fh["headers"]["range"] == "bytes=0-4999" and fh["headers"]["if-match"] == "\"e1\"" and fh["url"].ends_with("/saves/slot1?version=3"), str(file))

	# a 3xx is refused
	ch.auto = func(_h: Dictionary) -> Variant: return _ok(302)
	var red: Dictionary = await ft.put_single(TARGET, "up_1", body, _sha(body))
	t.check("a 3xx is refused", not red["ok"] and red["code"] == "redirect_refused" and red["status"] == 302)

	# an oversize answer is bad_response, whichever side noticed
	ch.auto = func(_h: Dictionary) -> Variant: return {"fail": "oversize"}
	var over: Dictionary = await ft.get_chunk("saves", "c".repeat(64))
	t.check("an oversize failure from the channel is bad_response", not over["ok"] and over["code"] == PKeyConstants.ErrorCode.BAD_RESPONSE)
	ch.auto = func(_h: Dictionary) -> Variant: return _ok(200, PackedByteArray([1, 2, 3]).duplicate())
	var cap_ok: Dictionary = await ft.get_file(TARGET, {"version": null, "range": [0, 2], "if_match": null})
	t.check("a body longer than the range asked is bad_response", not cap_ok["ok"] and cap_ok["code"] == PKeyConstants.ErrorCode.BAD_RESPONSE, str(cap_ok))
	ch.auto = func(_h: Dictionary) -> Variant: return {"fail": "network"}
	var net: Dictionary = await ft.put_single(TARGET, "up_1", body, _sha(body))
	t.check("a network failure answers status 0 (a retry)", not net["ok"] and net["status"] == 0)

	# an error answer is read as the server's refusal
	ch.auto = func(_h: Dictionary) -> Variant: return _ok(503, JSON.stringify({"error": {"code": "busy"}}).to_utf8_buffer(), {"Retry-After": "7"})
	var busy: Dictionary = await ft.put_single(TARGET, "up_1", body, _sha(body))
	t.check("an error answer keeps its code and Retry-After", not busy["ok"] and busy["status"] == 503 and busy["code"] == "busy" and busy["retry_after"] == 7.0, str(busy))

	# a lost reply: cancelled natively at the deadline, status 0
	ft.bulk_timeout = 0.05
	ch.auto = Callable()
	var before := ch.heads.size()
	var lost: Dictionary = await ft.put_single(TARGET, "up_1", body, _sha(body))
	t.check("a lost reply answers status 0", not lost["ok"] and lost["status"] == 0)
	t.check("a lost reply is cancelled natively by its req", ch.cancelled_reqs == [ch.heads[before]["req"]], str(ch.cancelled_reqs))
	ft.bulk_timeout = -1.0
	# a late answer for it is dropped and harms nothing
	ch.answer(ch.heads[before]["req"], _ok())

	# cancel_transfer is final for what is in flight
	var tree := Engine.get_main_loop() as SceneTree
	var waits := [null]
	var runner := func() -> void: waits[0] = await ft.put_part(TARGET, "up_1", 1, body, _sha(body))
	runner.call()
	await tree.process_frame
	t.check("cancel: the request is waiting", waits[0] == null and ch.holds.size() > 0)
	ft.cancel_transfer("saves:slot1")
	await tree.process_frame
	t.check("cancel: the waiting request ends with no answer and the channel is told", waits[0] != null and waits[0]["status"] == 0 and waits[0]["code"] == "cancelled"
			and ch.cancelled_transfers == ["saves:slot1"], str(waits[0]))

	# an unscoped request (no journal id) is dropped by cancel_transfer("")
	var tgt := {"collection": "saves", "record": "slot1"}
	waits[0] = null
	var unscoped := func() -> void: waits[0] = await ft.put_part(tgt, "up_1", 1, body, _sha(body))
	unscoped.call()
	await tree.process_frame
	ch.cancelled_transfers.clear()
	ft.cancel_transfer("")
	await tree.process_frame
	t.check("cancel: an unscoped request is dropped, here and natively", waits[0] != null and waits[0]["code"] == "cancelled" and ch.cancelled_transfers == ["unscoped"], str(waits[0]))

	# close(): in flight ends, new requests are refused, open_channel reopens
	waits[0] = null
	runner.call()
	await tree.process_frame
	ft.close()
	await tree.process_frame
	t.check("close: the channel is closed and the request in flight ends", ch.close_calls == 1 and waits[0] != null and waits[0]["status"] == 0)
	ch.auto = func(_h: Dictionary) -> Variant: return _ok()
	var sent_before := ch.heads.size()
	var closed: Dictionary = await ft.put_part(TARGET, "up_1", 1, body, _sha(body))
	t.check("close: a request after it is refused and sends nothing", not closed["ok"] and closed["status"] == 400 and ch.heads.size() == sent_before)
	var reopened: Dictionary = await ft.open_channel(["saves:slot1"])
	var again: Dictionary = await ft.put_part(TARGET, "up_1", 1, body, _sha(body))
	t.check("open_channel: reopens with the kept ids and requests flow again", reopened["resume"] == [] and ch.opened_with == [["saves:slot1"]] and again["ok"])

	# no channel: nothing is routed, and an unavailable one is not used
	ch.is_available = false
	t.check("an unavailable channel is not batching", not ft.batching())
	rig["host"].queue_free()


# ── The engine ──────────────────────────────────────────────────────────────────────────────────

## The sequential engine's fake server behind a transport that reports itself batching: every body call
## waits `delay(n)` frames, so completions arrive out of order, and the number in flight is counted.
class BatchTransport:
	extends RefCounted
	var s: Object
	var in_flight := 0
	var max_in_flight := 0
	var order: Array = []
	var transfers: Array = []
	var cancelled: Array = []
	var delay := Callable()
	var is_batching := true

	func _init(p_s: Object) -> void:
		s = p_s

	func batching() -> bool:
		return is_batching

	func cancel_transfer(id: String) -> void:
		cancelled.append(id)

	func _wait(n: int) -> void:
		in_flight += 1
		max_in_flight = maxi(max_in_flight, in_flight)
		var frames: int = delay.call(n) if delay.is_valid() else 1
		for i in frames:
			await (Engine.get_main_loop() as SceneTree).process_frame
		in_flight -= 1

	func begin(a, b): return s.begin(a, b)
	func status(a, b): return s.status(a, b)
	func abort(a, b): return s.abort(a, b)
	func finalize(a, b): return s.finalize(a, b)
	func plan_chunks(a, b, c): return s.plan_chunks(a, b, c)
	func get_file(a, b): return s.get_file(a, b)
	func get_chunk(a, b, _c = ""): return s.get_chunk(a, b)

	func put_single(a, b, c, d):
		transfers.append(a.get("transfer"))
		await _wait(0)
		return s.put_single(a, b, c, d)

	func put_part(a, b, n, d, e):
		transfers.append(a.get("transfer"))
		await _wait(n)
		order.append(n)
		return s.put_part(a, b, n, d, e)

	func put_chunk(a, b, c, d, e):
		transfers.append(a.get("transfer"))
		await _wait(order.size())
		order.append(c)
		return s.put_chunk(a, b, c, d, e)


func _engine(t: PKeyTestContext) -> void:
	var suite := TransferSuite.new()
	var srv := TransferSuite.FakeServer.new()
	var multi := TransferSuite.FakeMulti.new(srv)
	var bt := BatchTransport.new(multi)
	# part 4 finishes first, part 1 last
	bt.delay = func(n: int) -> int: return 8 - n * 2
	var j := Journal.Memory.new()
	var big := suite._noise(350000)
	var e := suite._engine(bt, j)
	var r: PKeyResult = await e.upload(suite._upload_req("b1", big))
	t.check("batch: a multipart upload finalizes", r.ok, str(r))
	t.check("batch: all four parts were in flight together", bt.max_in_flight == 4, str(bt.max_in_flight))
	t.check("batch: replies arrived in any order (4 before 1)", bt.order == [4, 3, 2, 1], str(bt.order))
	t.check("batch: the stored file is the source", srv.files.size() == 1 and srv.files[0] == big)
	t.check("batch: every request names its transfer", bt.transfers.size() == 4 and bt.transfers.all(func(x: Variant) -> bool: return x == "b1"), str(bt.transfers))

	# `done` is written as replies arrive: the journal at the first reply holds exactly that part
	srv = TransferSuite.FakeServer.new()
	bt = BatchTransport.new(TransferSuite.FakeMulti.new(srv))
	bt.delay = func(n: int) -> int: return 8 - n * 2
	j = Journal.Memory.new()
	var snapshots: Array = []
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_part":
			snapshots.append((j.get_record("b2")["done"] as Array).duplicate())
		return null
	r = await suite._engine(bt, j).upload(suite._upload_req("b2", big))
	t.check("batch: the journal gains each part as its reply arrives", r.ok and snapshots == [[], [4], [3, 4], [2, 3, 4]], str(snapshots))

	# a lost reply (status 0) is retried on its own; the rest of the batch is not resent
	srv = TransferSuite.FakeServer.new()
	bt = BatchTransport.new(TransferSuite.FakeMulti.new(srv))
	var lost := [false]
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_part" and not lost[0]:
			lost[0] = true
			return Transfer.reply_fail(0, "network")
		return null
	r = await suite._engine(bt, Journal.Memory.new()).upload(suite._upload_req("b3", big))
	t.check("batch: a part with no reply is retried alone", r.ok and srv.part_puts.size() == 4 and srv.files[0] == big, str(srv.part_puts))

	# chunks: the missing chunks are enqueued together
	srv = TransferSuite.FakeServer.new()
	bt = BatchTransport.new(srv)
	bt.delay = func(n: int) -> int: return 1 + (n % 3)
	var data := suite._noise(3 * 1048576 + 999)
	r = await suite._engine(bt, Journal.Memory.new()).upload_chunked(suite._chunked_req("b4", data, Codec.Server.new()))
	t.check("batch chunks: the upload finalizes", r.ok, str(r))
	t.check("batch chunks: several chunks were in flight together, within the batch bound", bt.max_in_flight > 1 and bt.max_in_flight <= Transfer.BATCH_CHUNKS, str(bt.max_in_flight))
	t.check("batch chunks: every missing chunk was sent once", srv.chunk_puts.size() == bt.order.size() and srv.chunk_puts.size() >= 3, "%d/%d" % [srv.chunk_puts.size(), bt.order.size()])

	# without a channel nothing is batched
	srv = TransferSuite.FakeServer.new()
	bt = BatchTransport.new(TransferSuite.FakeMulti.new(srv))
	bt.is_batching = false
	r = await suite._engine(bt, Journal.Memory.new()).upload(suite._upload_req("b5", big))
	t.check("no channel: parts go one at a time", r.ok and bt.max_in_flight == 1, str(bt.max_in_flight))

	# downloads pass the transfer id to a batching transport and nothing else changes
	t.check("the batch bounds are the plan's", Transfer.BATCH_CHUNKS == 256 and Transfer.BATCH_CHUNKS < PKeyConstants.SYNC_CHUNK_REQUESTS_PER_MINUTE)


func _engine_cancel(t: PKeyTestContext) -> void:
	var suite := TransferSuite.new()
	var big := suite._noise(350000)
	var srv := TransferSuite.FakeServer.new()
	var bt := BatchTransport.new(TransferSuite.FakeMulti.new(srv))
	bt.delay = func(_n: int) -> int: return 6
	var cancel := Transfer.Cancel.new()
	var j := Journal.Memory.new()
	var tree := Engine.get_main_loop() as SceneTree
	# cancel while the batch is in flight
	var go := func() -> void:
		for i in 2:
			await tree.process_frame
		cancel.cancelled = true
	go.call()
	var r: PKeyResult = await suite._engine(bt, j).upload(suite._upload_req("c1", big, {"cancel": cancel}))
	t.check("cancel during a batch: the transport is told to drop the transfer", bt.cancelled == ["c1"], str(bt.cancelled))
	t.check("cancel during a batch: the result is cancelled and nothing more is sent after it", not r.ok and r.code == &"cancelled", str(r))
	var sent := srv.part_puts.size()
	await PKeyTestFixtures.frames(12)
	t.check("cancel is final: no request was started afterwards", srv.part_puts.size() == sent and bt.in_flight == 0)


# ── Sign-out ────────────────────────────────────────────────────────────────────────────────────

class LogChannel:
	extends BulkChannel
	var log: Array

	func _init(p_log: Array) -> void:
		log = p_log

	func available() -> bool:
		return true

	func close() -> void:
		log.append("channel-close")


class LogRing:
	extends RefCounted
	var log: Array

	func _init(p_log: Array) -> void:
		log = p_log

	func lock() -> void:
		log.append("lock")

	func forget() -> PKeyResult:
		log.append("forget")
		return PKeyResult.success()


class StateHost:
	extends Node
	var dir := ""

	func state_dir() -> String:
		return dir


class LogJournal:
	extends RefCounted
	var log: Array

	func _init(p_log: Array) -> void:
		log = p_log

	func clear() -> void:
		log.append("journal-clear")


func _sign_out(t: PKeyTestContext) -> void:
	var log: Array = []
	var api := CloudSync.new()
	var rig := _rig(LogChannel.new(log))
	api._files = rig["ft"]
	api._keyring = LogRing.new(log)
	api._journal = LogJournal.new(log)
	var dir := PKeyTestFixtures.scratch_dir("bulk_signout")
	var state := StateHost.new()
	state.dir = dir
	api.host = state
	var chunks := dir.path_join(PKeyChunkCache.DIR_NAME)
	for who in ["person-a", "person-b", "orphan"]:
		var d := chunks.path_join(who.sha256_text()).path_join("c")
		DirAccess.make_dir_recursive_absolute(d)
		var f := FileAccess.open(d.path_join("x"), FileAccess.WRITE)
		f.store_string("x")
		f.close()
	# A restart with no save since: no cache owner, no current subject, and the credential is already B's.
	api._cache_for = null
	api._subject = null
	api._keep_subject = "person-b"
	api._purge_save_files()
	t.check("purge: the leaving person's folder goes though nothing names them", not DirAccess.dir_exists_absolute(chunks.path_join("person-a".sha256_text())))
	t.check("purge: an orphan of an earlier person is swept", not DirAccess.dir_exists_absolute(chunks.path_join("orphan".sha256_text())))
	t.check("purge: the incoming person's folder stays", DirAccess.dir_exists_absolute(chunks.path_join("person-b".sha256_text())))
	t.check("purge: the journal is cleared", log == ["journal-clear"], str(log))
	api._keep_subject = null
	api._purge_save_files()
	t.check("purge: a plain sign-out leaves no chunk folder", not DirAccess.dir_exists_absolute(chunks))
	log.clear()
	api.host = null
	api.saves = null
	await api._forget()
	t.check("sign-out: the channel closes before the ring locks and before the pin goes", log == ["channel-close", "lock", "forget"], str(log))
	state.free()
	rig["host"].queue_free()
	PKeyTestFixtures.remove_tree(dir)


class MixTransport:
	extends RefCounted
	var s: Object
	var ft: Object

	func _init(p_s: Object, p_ft: Object) -> void:
		s = p_s
		ft = p_ft

	func batching() -> bool:
		return ft.batching()

	func cancel_transfer(id: String) -> void:
		ft.cancel_transfer(id)

	func begin(a, b): return s.begin(a, b)
	func status(a, b): return s.status(a, b)
	func abort(a, b): return s.abort(a, b)
	func finalize(a, b): return s.finalize(a, b)
	func plan_chunks(a, b, c): return s.plan_chunks(a, b, c)
	func get_file(a, b): return s.get_file(a, b)
	func get_chunk(a, b, _c = ""): return s.get_chunk(a, b)
	func put_single(a, b, c, d): return s.put_single(a, b, c, d)
	func put_chunk(a, b, c, d, e): return s.put_chunk(a, b, c, d, e)

	func put_part(a, b, n, d, e):
		return await ft.put_part(a, b, n, d, e)


func _late_reply(t: PKeyTestContext) -> void:
	var suite := TransferSuite.new()
	var ch := FakeChannel.new()
	var rig := _rig(ch)
	var ft: FilesTransport = rig["ft"]
	var srv := TransferSuite.FakeServer.new()
	var j := Journal.Memory.new()
	var big := suite._noise(350000)
	var tree := Engine.get_main_loop() as SceneTree
	var result := [null]
	var go := func() -> void: result[0] = await suite._engine(MixTransport.new(TransferSuite.FakeMulti.new(srv), ft), j).upload(suite._upload_req("l1", big))
	go.call()
	var spins := 0
	while ch.holds.size() < 4 and spins < 600:
		await tree.process_frame
		spins += 1
	t.check("late reply: the whole batch is held by the channel", ch.holds.size() == 4, str(ch.holds.size()))
	ft.close()
	for req in ch.holds.keys():
		ch.answer(req, _ok())
	spins = 0
	while result[0] == null and spins < 600:
		await tree.process_frame
		spins += 1
	var rec: Variant = j.get_record("l1")
	t.check("late reply: after close, an acknowledged reply marks nothing done", result[0] != null and not result[0].ok and (rec == null or (rec["done"] as Array).is_empty()), str(rec))
	rig["host"].queue_free()


# ── The Android lane (U-41.6b): PKeyAndroidBulk over the plugin's byte[] ops, events through the facade ─────────

func _a_head(req: int, transfer := "saves:slot1", path := "/diceroll/sync/files/saves/slot1/upload/u1/parts/1") -> Dictionary:
	return {"req": req, "transfer": transfer, "url": ORIGIN + path, "headers": {"Content-Type": "application/octet-stream", "X-PKey-Device": "dev1"},
			"bearer": TOKEN, "max_body": 4096, "part": 1}


func _ctx() -> Dictionary:
	return {"product": PRODUCT, "origin": ORIGIN, "subject": "user:1"}


## The facade, the plugin fake and a channel that is open.
func _a_rig() -> Dictionary:
	var f := PKeyFakeAndroidNative.new()
	var a := PKeyAndroid.new()
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
	t.check("android bulk: no channel with a plugin whose probe is not refused", PKeyAndroidBulk.create(_ctx, Partial.new(), PKeyAndroid.new()) == null)
	t.check("android bulk: a plugin with all seven ops makes a channel", PKeyAndroidBulk.create(_ctx, f0, PKeyAndroid.new()) != null)
	t.check(
			"android bulk: urls split into origin and path, userinfo and fragments refused",
			PKeyAndroidBulk.split_url("https://h:8443/a/b?version=2") == {"origin": "https://h:8443", "path": "/a/b?version=2"}
				and PKeyAndroidBulk.split_url("https://u@h/a").is_empty()
				and PKeyAndroidBulk.split_url("https://h/a#f").is_empty()
				and PKeyAndroidBulk.split_url("https://h").is_empty()
	)

	# Before open, and after a refused open, nothing is sent.
	var cold := PKeyAndroidBulk.create(_ctx, f0, PKeyAndroid.new())
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


func _bulk_rig() -> Dictionary:
	var fake := PKeyFakeAppleNative.Bulk.new()
	var apple := PKeyApple.new()
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
	var bare := PKeyApple.new()
	bare.platform = "ios"
	bare.native = PKeyFakeAppleNative.new()
	t.check("apple bulk: a native without the binary entry gives no channel", PKeyAppleBulk.create(PRODUCT, "https://k.test", "/s", bare) == null)
	var other := PKeyApple.new()
	other.platform = "android"
	other.native = PKeyFakeAppleNative.Bulk.new()
	t.check("apple bulk: off iOS there is no channel", PKeyAppleBulk.create(PRODUCT, "https://k.test", "/s", other) == null)
	t.check("apple bulk: the origin leaves out the default port", PKeyAppleBulk.origin_of("https://key.example.test/") == "https://key.example.test" and
		PKeyAppleBulk.origin_of("http://127.0.0.1:8787") == "http://127.0.0.1:8787" and PKeyAppleBulk.origin_of("nope") == "")

	# The pick (D-10): the option decides, and a channel the app set wins.
	var apple := PKeyApple.new()
	apple.native = PKeyFakeAppleNative.Bulk.new()
	apple.platform = "ios"
	var opts := PKeyOptions.new()
	t.check("apple bulk: option off, no channel", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", apple) == null)
	opts.cloud_sync_background_transfers = true
	t.check("apple bulk: option on, on iOS, the Apple channel", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", apple) is PKeyAppleBulk)
	t.check("apple bulk: option on, the host with no plugin, none", PKeyAppleBulk.pick(opts, PRODUCT, "https://key.example.test", "user://x", bare) == null)
	var mine := FakeChannel.new()
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


static func _contains(hay: PackedByteArray, needle: PackedByteArray) -> bool:
	if needle.is_empty() or hay.size() < needle.size():
		return false
	for i in hay.size() - needle.size() + 1:
		if hay[i] == needle[0] and hay.slice(i, i + needle.size()) == needle:
			return true
	return false
