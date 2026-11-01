extends RefCounted
# @pkey-feature sync.files sync.files.delta
# The bulk-body channel of Cloud Sync file transfers (U-41.G), against a fake channel: the file transport
# routes only the body calls through it (the bearer in the head, never a header; a 3xx refused; an answer
# over the cap is bad_response; a lost reply is cancelled and answers status 0), and the engine enqueues a
# phase's bodies together (parts, chunks), takes completions in any order, and stops for good on a cancel.

const FilesTransport := preload("res://addons/polaris_key/services/cloud_sync/files_transport.gd")
const BulkChannel := preload("res://addons/polaris_key/services/cloud_sync/bulk_channel.gd")
const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")
const Codec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const TransferSuite := preload("res://tests/suite_cloud_sync_transfer.gd")

const CloudSync := preload("res://addons/polaris_key/services/cloud_sync.gd")

const PRODUCT := "diceroll"
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
	func get_chunk(a, b, c = ""): return s.get_chunk(a, b)

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
