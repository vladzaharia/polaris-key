extends RefCounted
# @pkey-feature connect.protocol connect.app
# `PKeyConnectSession` and `PKeyConnectChannel` (CC-14.10b; WIRE-CONTRACT-V5 sections 15.3, 15.5 and
# 15.6), ported from sdk-node's `connect.test.ts` and `connectHardening.test.ts` and the Python
# `test_connect_session`: two held identities over the pump and a memory pipe, the host's handle (send,
# receive, the message signal, close), the APP range (G9), the byte caps (G10), pushed RING and TRUST
# with their notices (G11) and the identity refresh rate (G12), and the key port (G1).

var _pair: Dictionary
var _pair2: Dictionary
var _disc := PackedByteArray()


## A key store that holds the private key; only `dh` crosses, as PKeyDeviceKeyStore's does.
class FakeKeys extends RefCounted:
	var dh_calls := 0
	var _priv: PackedByteArray


	func _init(priv: PackedByteArray) -> void:
		_priv = priv


	func dh(remote: PackedByteArray) -> PKeyResult:
		dh_calls += 1
		if PKeyCurve25519.is_low_order(remote):
			return PKeyResult.success(null)
		return PKeyResult.success(PKeyCurve25519.x25519(_priv, remote))


## A link for a session unit test: records what the session asks of it.
class FakeLink extends RefCounted:
	var sent: Array = []
	var closes: Array = []
	var pauses: Array = []
	var refuse := false


	func send_record(type: int, body: PackedByteArray) -> PKeyResult:
		if refuse:
			return PKeyResult.failure(&"too_large")
		sent.append([type, body])
		return PKeyResult.success()


	func close(code: StringName) -> void:
		closes.append(code)


	func pause(on: bool) -> void:
		pauses.append(on)


## The host calls a Docs makes, recorded.
class Host extends RefCounted:
	signal gate

	var adopted: Array = []
	var trusted: Array = []
	var refreshes := 0
	var stored := 0
	var ring_result := {"stored": true, "epoch": 2}
	var trust_result := {"applied": true}
	var refresh_ok := true
	var gate_open := true
	var mono := 0.0
	var timers: Array = []


	func adopt(jws: String) -> Dictionary:
		adopted.append(jws)
		return ring_result


	func apply_trust(jws: String) -> Dictionary:
		trusted.append(jws)
		while not gate_open:
			await gate
		return trust_result


	func refresh() -> PKeyResult:
		refreshes += 1
		return PKeyResult.success() if refresh_ok else PKeyResult.failure(&"network-error")


	func on_stored() -> void:
		stored += 1


	func clock() -> float:
		return mono


	func timer(seconds: float, fn: Callable) -> void:
		timers.append([seconds, fn])


	func docs() -> PKeyConnectChannel.Docs:
		return PKeyConnectChannel.Docs.new({
			"adopt_ring": Callable(self, "adopt"), "apply_trust": Callable(self, "apply_trust"), "refresh": Callable(self, "refresh"), "mono": Callable(self, "clock"),
		}, Callable(self, "on_stored"), Callable(self, "timer"))


class Notes extends RefCounted:
	var list: Array = []


	func on_notice(n: Dictionary) -> void:
		list.append(n)


	func reasons(kind: String) -> Array:
		return list.filter(func(n: Dictionary) -> bool: return n["type"] == kind).map(func(n: Dictionary) -> String: return str(n.get("reason", n["outcome"])))


func run(t: PKeyTestContext) -> void:
	_pair = PKeyTestPeers.pair(1)
	_pair2 = PKeyTestPeers.pair(2)
	_disc = PKeyTestPeers.random32()
	_options(t)
	await _end_to_end(t)
	await _critical_and_close(t)
	await _not_admitted(t)
	await _pushed_documents(t)
	_docs_bounds(t)
	_docs_refresh_rate(t)
	await _docs_async(t)
	await _session_caps(t)


func _source(d: Dictionary, ring_jws: String, epoch: int, prev := PackedByteArray()) -> PKeyConnectClient.PeerSource:
	var s := PKeyConnectClient.PeerSource.new()
	s.slug = PKeyTestPeers.SLUG
	s.trust = PKeyTestPeers.trust()
	s.sub = PKeyTestPeers.SUB
	s.device_id = d["id"]
	s.certificate = d["cert"]
	s.certificate_expires_at = PKeyTestPeers.NOW + 1000
	s.ring = ring_jws
	s.ring_epoch = epoch
	s.disc_current = _disc
	s.disc_previous = prev
	s.agree_public = d["pub"]
	s.keys = FakeKeys.new(d["priv"])
	return s


func _options(t: PKeyTestContext) -> void:
	var a: Dictionary = _pair["a"]
	var src := _source(a, _pair["ring"], 1, PackedByteArray([7]))
	var acct := PKeyConnectChannel.peer_account(src)
	t.check("options: the account is the held identity", acct["expected_aud"] == "djdl" and acct["own_sub"] == PKeyTestPeers.SUB and acct["own_device_id"] == a["id"] and acct["cert_jws"] == a["cert"])
	t.check("options: K_disc newest first, an unusable previous key as null", acct["disc_keys"][0] == _disc and acct["disc_keys"][1] is PackedByteArray)
	var bare := PKeyConnectChannel.peer_account(_source(a, _pair["ring"], 1))
	t.check("options: no previous key is null", bare["disc_keys"][1] == null)
	t.check("options: the held roster is the source's", acct["held_ring"].call() == {"jws": _pair["ring"], "epoch": 1})
	var pushed := {"jws": "newer", "epoch": 5}
	var over := PKeyConnectChannel.peer_account(src, func() -> Variant: return pushed)
	t.check("options: a roster a session handed up overrides it", over["held_ring"].call() == pushed)
	var o := PKeyConnectChannel.session_options(src, {"role": "initiator", "label": "Den", "rekey_messages": 9})
	t.check("options: mode a, the product slug, the hello", o["mode"] == "a" and o["role"] == "initiator" and o["slug"] == "djdl" and o["hello"]["app"] == "djdl" and o["hello"]["label"] == "Den")
	t.check("options: default capability and the passed rekey", o["caps"] == ["app/1"] and o["rekey_messages"] == 9 and not o.has("now"))
	var port: Object = o["static_key"]
	t.check("options: the static key is a port with the agreement public key", port.public_key() == a["pub"])
	var peer := PKeyCurve25519.x25519_public(PKeyTestPeers.fixed(9))
	t.check("options: its dh is the store's", port.dh(peer) == PKeyCurve25519.x25519(a["priv"], peer) and (src.keys as FakeKeys).dh_calls == 1)
	t.check("options: a low-order point is refused as null", port.dh(PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) == null)
	t.check("options: str() shows no key, certificate or roster", str(port) == "PKeyConnectChannel.KeyPort()" and not str(src).contains(a["cert"]))


## Two held identities linked over a memory pipe under `pump`: {a, b, attach_a, attach_b, docs_a, docs_b,
## link_a, link_b, host_a, host_b, holders}.
func _world(pump: PKeyPeerPump, src_a: PKeyConnectClient.PeerSource, src_b: PKeyConnectClient.PeerSource, link_options := {}) -> Dictionary:
	var ha := PKeyTestPeers.Peer.new()
	var hb := PKeyTestPeers.Peer.new()
	var host_a := Host.new()
	var host_b := Host.new()
	var pipes := PKeyPeerMemoryPipe.pair()
	var opts_a := PKeyConnectChannel.session_options(src_a, {"role": "initiator", "now": Callable(ha, "now"), "mono": Callable(ha, "mono")})
	var opts_b := PKeyConnectChannel.session_options(src_b, {"role": "responder", "now": Callable(hb, "now"), "mono": Callable(hb, "mono")})
	var lo := link_options.duplicate()
	lo["pump"] = pump
	var la := PKeyPeerLink.create(pipes[0], opts_a, lo).detail as PKeyPeerLink
	var lb := PKeyPeerLink.create(pipes[1], opts_b, lo).detail as PKeyPeerLink
	var docs_a := host_a.docs()
	var docs_b := host_b.docs()
	var att_a := PKeyConnectChannel.attach(la, docs_a, "initiator", pipes[0].remote_address())
	var att_b := PKeyConnectChannel.attach(lb, docs_b, "responder", pipes[1].remote_address())
	pump.add(la)
	pump.add(lb)
	return {
		"link_a": la, "link_b": lb, "att_a": att_a, "att_b": att_b, "docs_a": docs_a, "docs_b": docs_b, "host_a": host_a, "host_b": host_b,
		"holders": [ha, hb, pipes],
	}


func _wait_until(cond: Callable, frames := 400) -> int:
	var tree := Engine.get_main_loop() as SceneTree
	var n := 0
	while n < frames and not cond.call():
		await tree.process_frame
		n += 1
	return n


func _open_world(src_a: PKeyConnectClient.PeerSource = null, src_b: PKeyConnectClient.PeerSource = null) -> Dictionary:
	var pump := PKeyPeerPump.new(Engine.get_main_loop() as SceneTree, false)
	var w := _world(pump, src_a if src_a != null else _source(_pair["a"], _pair["ring"], 1), src_b if src_b != null else _source(_pair["b"], _pair["ring"], 1))
	w["pump"] = pump
	w["link_a"].start()
	var ra: PKeyResult = await w["att_a"].wait_opened()
	var rb: PKeyResult = await w["att_b"].wait_opened()
	w["ra"] = ra
	w["rb"] = rb
	return w


func _end_to_end(t: PKeyTestContext) -> void:
	var w := await _open_world()
	var ra: PKeyResult = w["ra"]
	var rb: PKeyResult = w["rb"]
	t.check("e2e: both links are admitted", ra.ok and rb.ok)
	if not ra.ok or not rb.ok:
		return
	var a: PKeyConnectSession = ra.detail
	var b: PKeyConnectSession = rb.detail
	var names := a.peer_device_id == PKeyTestPeers.ID_B and b.peer_device_id == PKeyTestPeers.ID_A
	t.check("e2e: the session names the admitted device, role and path", names and a.role == "initiator" and b.role == "responder" and a.path == "lan")
	t.check("e2e: the hello is the peer's, authenticated in mode a", a.hello["app"] == "djdl" and a.hello["max_message"] == 1048576 and a.caps == ["app/1"] and a.remote_address == "memory")
	t.check("e2e: str() names the peer and path, nothing else", str(a) == "PKeyConnectSession(peer=%s path=lan role=initiator)" % PKeyTestPeers.ID_B)
	# A message goes through receive().
	t.check("e2e: send ok", a.send("hello".to_utf8_buffer()).ok)
	var got: PKeyResult = await b.receive()
	t.check("e2e: receive() gets it, with the default APP type", got.ok and got.detail["type"] == 0x0100 and (got.detail["body"] as PackedByteArray).get_string_from_utf8() == "hello")
	# A waiting receive() is woken by a delivery.
	var waiting := []
	var waiter := func() -> void: waiting.append(await a.receive())
	waiter.call()
	t.check("e2e: receive() waits", waiting.is_empty())
	b.send("late".to_utf8_buffer(), 0x0200)
	await _wait_until(func() -> bool: return not waiting.is_empty())
	t.check("e2e: and is woken by the next message, type and all", waiting.size() == 1 and waiting[0].ok and waiting[0].detail["type"] == 0x0200)
	# With a listener on the signal, messages are not queued.
	var heard := []
	a.message.connect(func(type: int, body: PackedByteArray) -> void: heard.append([type, body]))
	b.send("one".to_utf8_buffer())
	await _wait_until(func() -> bool: return not heard.is_empty())
	t.check("e2e: a connected message signal takes the messages instead of the queue", heard.size() == 1 and (heard[0][1] as PackedByteArray).get_string_from_utf8() == "one")
	# The APP range.
	for bad in [0x00ff, 0x8000, 0x8001, 0xffff, -1]:
		var r := a.send(PackedByteArray(), bad)
		t.check("e2e: type 0x%04x is not an application type" % bad, not r.ok and PKeyConnectErrors.reason_of(r) == "bad_type" and r.code == &"invalid-argument")
	t.check("e2e: the ends of the range are", a.send(PackedByteArray(), 0x0100).ok and a.send(PackedByteArray(), 0x7fff).ok)
	var huge := PackedByteArray()
	huge.resize(PKeyPeerRecord.MAX_MESSAGE + 1)
	var big := a.send(huge)
	t.check("e2e: a message over the peer's cap is too_large", PKeyConnectErrors.reason_of(big) == "too_large", str(big))
	# close()
	var closes_a := []
	var closes_b := []
	a.closed.connect(func(code: StringName, by_peer: bool) -> void: closes_a.append([code, by_peer]))
	b.closed.connect(func(code: StringName, by_peer: bool) -> void: closes_b.append([code, by_peer]))
	# The two empty messages sent above are queued at b; read them, then wait for another.
	await b.receive()
	await b.receive()
	var pending := []
	var pend := func() -> void: pending.append(await b.receive())
	pend.call()
	a.close()
	await _wait_until(func() -> bool: return closes_a.size() == 1 and closes_b.size() == 1)
	t.check("e2e: close() ends the closer as peer_bye and the peer as peer_bye by the peer", closes_a == [[&"peer_bye", false]] and closes_b == [[&"peer_bye", true]], "%s %s" % [closes_a, closes_b])
	t.check("e2e: a waiting receive() fails closed", pending.size() == 1 and not pending[0].ok and PKeyConnectErrors.reason_of(pending[0]) == "closed")
	t.check("e2e: closed_info() says why", a.is_closed() and a.closed_info() == {"code": &"peer_bye", "by_peer": false})
	t.check("e2e: send after the end is closed", PKeyConnectErrors.reason_of(a.send(PackedByteArray())) == "closed" and PKeyConnectErrors.reason_of(await a.receive()) == "closed")
	t.check("e2e: and so is a second end", closes_a.size() == 1)
	_drop(w)


func _drop(w: Dictionary) -> void:
	w["link_a"].destroy()
	w["link_b"].destroy()
	w["docs_a"].close()
	w["docs_b"].close()


func _critical_and_close(t: PKeyTestContext) -> void:
	var w := await _open_world()
	var a: PKeyConnectSession = w["ra"].detail
	var b: PKeyConnectSession = w["rb"].detail
	var closes_a := []
	var closes_b := []
	a.closed.connect(func(code: StringName, by_peer: bool) -> void: closes_a.append([code, by_peer]))
	b.closed.connect(func(code: StringName, by_peer: bool) -> void: closes_b.append([code, by_peer]))
	# A record outside the APP range that is not critical never reaches the host, and closes nothing.
	t.check("critical: a non-APP record is sent", a.send_record(PKeyPeerRecord.CANDIDATES, "x".to_utf8_buffer()).ok)
	await _wait_until(func() -> bool: return false, 15)
	t.check("critical: and ignored by the peer", b.is_closed() == false and b._queue.is_empty())
	# An APP-critical type the host cannot understand closes the session (G9).
	t.check("critical: an APP-critical record is sent", a.send_record(0x8100, "x".to_utf8_buffer()).ok)
	await _wait_until(func() -> bool: return closes_a.size() == 1 and closes_b.size() == 1)
	t.check("critical: the receiver closes peer_unknown_critical", closes_b == [[&"peer_unknown_critical", false]], str(closes_b))
	t.check("critical: and the sender is told", closes_a == [[&"peer_unknown_critical", true]], str(closes_a))
	_drop(w)
	# route_record by itself.
	var link := FakeLink.new()
	var s := PKeyConnectSession.new(link, "d", ["app/1"], {}, "responder")
	PKeyConnectSession.route_record(link, s, 0x0100, "a".to_utf8_buffer())
	PKeyConnectSession.route_record(link, s, 0x7fff, "b".to_utf8_buffer())
	PKeyConnectSession.route_record(link, s, 0x0099, "c".to_utf8_buffer())
	PKeyConnectSession.route_record(link, s, 0x8000, "d".to_utf8_buffer())
	PKeyConnectSession.route_record(link, s, 0x8001, "e".to_utf8_buffer())
	PKeyConnectSession.route_record(link, s, 0xfffe, "f".to_utf8_buffer())
	PKeyConnectSession.route_record(link, null, 0x0100, "g".to_utf8_buffer())
	t.check("route: the APP range is queued, nothing else is", s._queue.size() == 2 and link.closes.is_empty())
	PKeyConnectSession.route_record(link, s, 0x8100, PackedByteArray())
	PKeyConnectSession.route_record(link, s, 0xfffd, PackedByteArray())
	t.check("route: 0x8100 to 0xFFFD close peer_unknown_critical", link.closes == [&"peer_unknown_critical", &"peer_unknown_critical"])


func _not_admitted(t: PKeyTestContext) -> void:
	# The peer's certificate is another account's: the dialler refuses it, handshake_failed.
	var stranger := PKeyTestPeers.device(PKeyTestPeers.ID_B, PKeyTestPeers.SIGN_B, 1, PKeyTestPeers.OTHER_SUB, PKeyTestPeers.NOW - 10, PKeyTestPeers.NOW + 1000, PKeyTestPeers.fixed(2))
	var w := await _open_world(_source(_pair["a"], _pair["ring"], 1), _source(stranger, _pair["ring"], 1))
	var ra: PKeyResult = w["ra"]
	t.check("refused: a certificate of another account is not admitted", not ra.ok and PKeyConnectErrors.reason_of(ra) == "handshake_failed" and ra.code == &"peer-cert-invalid", str(ra))
	t.check("refused: the failure names why", ra.detail["close_code"] == &"handshake_failed")
	t.check("refused: the other side refuses too", not (w["rb"] as PKeyResult).ok)
	_drop(w)
	# A discovery key the other side does not know: it closes without a word, the dialler sees the
	# connection go.
	var other := _source(_pair["b"], _pair["ring"], 1)
	other.disc_current = PKeyTestPeers.random32()
	var pump := PKeyPeerPump.new(Engine.get_main_loop() as SceneTree, false)
	w = _world(pump, _source(_pair["a"], _pair["ring"], 1), other, {"handshake_ms": 150})
	w["link_a"].start()
	var gone: PKeyResult = await w["att_a"].wait_opened()
	t.check("refused: a wrong discovery key is never admitted; the dialler sees the connection lost", not gone.ok and gone.detail["close_code"] == &"connection_lost", str(gone.detail))
	_drop(w)
	# A peer that never answers: the dialler's link gives up at its handshake deadline.
	w = _world(pump, _source(_pair["a"], _pair["ring"], 1), _source(_pair["b"], _pair["ring"], 1), {"handshake_ms": 150})
	pump.remove(w["link_b"])
	var started := Time.get_ticks_msec()
	w["link_a"].start()
	var late: PKeyResult = await w["att_a"].wait_opened()
	var refused: bool = not late.ok and late.detail["close_code"] == &"handshake_failed"
	t.check("refused: a silent peer is given up on at the deadline", refused and Time.get_ticks_msec() - started >= 100, "%s %d" % [late.detail, Time.get_ticks_msec() - started])
	_drop(w)


func _pushed_documents(t: PKeyTestContext) -> void:
	# A holds the roster at epoch 1, B the one at epoch 2 with a certificate for it: A wants B's
	# roster, and B pushes it.
	var src_a := _source(_pair["a"], _pair["ring"], 1)
	var src_b := _source(_pair2["b"], _pair2["ring"], 2)
	var pump := PKeyPeerPump.new(Engine.get_main_loop() as SceneTree, false)
	var w := _world(pump, src_a, src_b)
	var host_a: Host = w["host_a"]
	var notes := Notes.new()
	w["docs_a"].notice.connect(notes.on_notice)
	w["link_a"].start()
	var ra: PKeyResult = await w["att_a"].wait_opened()
	var rb: PKeyResult = await w["att_b"].wait_opened()
	await _wait_until(func() -> bool: return not host_a.adopted.is_empty(), 100)
	t.check("pushed: both are admitted across rosters", ra.ok and rb.ok)
	t.check("pushed: the pushed roster is handed to the identity client", host_a.adopted == [_pair2["ring"]])
	t.check("pushed: and reported as stored, with its epoch", notes.list.size() >= 1 and notes.list[0] == {"type": "ring", "outcome": "stored", "epoch": 2}, str(notes.list))
	t.check("pushed: the host is told, and the roster is remembered", host_a.stored >= 1 and (w["docs_a"].pushed as Dictionary)["epoch"] == 2)
	t.check("pushed: the fetch for the new certificate started once (a peer asked, the roster arrived)", host_a.refreshes == 1, str(host_a.refreshes))
	var waits: Array = host_a.timers.map(func(x: Array) -> float: return x[0])
	t.check("pushed: the minute's slot was taken, so a retry waits at the end of the gap", waits.size() == 1 and waits[0] >= 1.0 and waits[0] <= 60.0, str(waits))

	# TRUST: handed to the custodian, never trusted on arrival.
	var a: PKeyConnectSession = ra.detail
	var b: PKeyConnectSession = rb.detail
	t.check("pushed: TRUST is sent", b.send_record(PKeyPeerRecord.TRUST, "{\"trust\":\"head.body.sig\"}".to_utf8_buffer()).ok)
	await _wait_until(func() -> bool: return not host_a.trusted.is_empty(), 60)
	await _wait_until(func() -> bool: return false, 3)
	t.check("pushed: the manifest reaches apply_trust unverified", host_a.trusted == ["head.body.sig"])
	t.check("pushed: and the outcome is a notice", notes.list.back() == {"type": "trust", "outcome": "applied"}, str(notes.list.back()))
	host_a.trust_result = {"applied": false, "reason": "not_newer"}
	b.send_record(PKeyPeerRecord.TRUST, "{\"trust\":\"other.doc.sig\"}".to_utf8_buffer())
	await _wait_until(func() -> bool: return host_a.trusted.size() == 2, 60)
	await _wait_until(func() -> bool: return false, 3)
	t.check("pushed: a refusal says why", notes.list.back() == {"type": "trust", "outcome": "refused", "reason": "not_newer"}, str(notes.list.back()))
	t.check("pushed: the session stays open", not a.is_closed() and not b.is_closed())
	_drop(w)

	# Without the host calls, documents are refused as unsupported.
	var docs := PKeyConnectChannel.Docs.new({})
	var bare := Notes.new()
	docs.notice.connect(bare.on_notice)
	docs.ring("r")
	docs.trust("t")
	var unsupported := [{"type": "ring", "outcome": "refused", "reason": "unsupported"}, {"type": "trust", "outcome": "refused", "reason": "unsupported"}]
	t.check("pushed: no adopt_ring or apply_trust is unsupported", bare.list == unsupported, str(bare.list))
	t.check("pushed: and no refresh starts nothing", not docs.want_ring())


func _docs_bounds(t: PKeyTestContext) -> void:
	# A flood from an authenticated peer: eight rings wait at most, a repeat of one waiting is refused,
	# a TRUST flood leaves the last slot to a RING (G11). Rings are handled at once here, so a
	# blocked TRUST holds the queue.
	var host := Host.new()
	host.gate_open = false
	var docs := host.docs()
	var notes := Notes.new()
	docs.notice.connect(notes.on_notice)
	for i in 20:
		docs.trust("trust-%d" % i)
	t.check("bounds: seven trust documents wait, the rest are refused", host.trusted.size() == 1 and docs._active.size() == 7, str(docs._active.size()))
	t.check("bounds: refusals are `busy`, and rate-limited to one a second", notes.reasons("trust") == ["busy"], str(notes.reasons("trust")))
	docs.trust("trust-0")
	t.check("bounds: a repeat of one waiting is refused too, inside the same second", notes.reasons("trust").size() == 1)
	host.mono = 1.0
	docs.trust("trust-0")
	t.check("bounds: a second later it is noticed again", notes.reasons("trust") == ["busy", "busy"])
	docs.ring("ring-0")
	t.check("bounds: a RING still takes the slot kept for it", docs._active.size() == 8 and notes.reasons("ring").is_empty())
	docs.ring("ring-1")
	t.check("bounds: but only that one", notes.reasons("ring") == ["busy"])
	host.gate_open = true
	host.gate.emit()
	t.check("bounds: when the custodian answers, every waiting document is handled in order", host.trusted.size() == 7 and host.adopted == ["ring-0"], "%d %s" % [host.trusted.size(), host.adopted])
	t.check("bounds: and the queue empties", docs._active.is_empty() and not docs._running)
	# close() stops everything.
	docs.close()
	docs.ring("late")
	t.check("bounds: nothing is handled after close()", host.adopted == ["ring-0"])


func _docs_refresh_rate(t: PKeyTestContext) -> void:
	# G12: at most one refresh a minute on the monotonic clock; a retry waits for the end of the gap
	# and is repeated after a failure, five times at most.
	var host := Host.new()
	var docs := host.docs()
	t.check("refresh: a peer asked: this takes the minute's slot", docs.want_ring() and host.refreshes == 1)
	t.check("refresh: asked again inside the minute, nothing starts and nothing is deferred", not docs.want_ring() and host.refreshes == 1 and host.timers.is_empty())
	docs.ring("jws-1")
	t.check("refresh: a stored roster wants the new certificate but the slot is taken: a retry is deferred", host.refreshes == 1 and host.timers.size() == 1, str(host.timers.size()))
	t.check("refresh: it waits out the rest of the gap", is_equal_approx(host.timers[0][0], 60.0))
	docs.ring("jws-2")
	t.check("refresh: and one retry is enough", host.timers.size() == 1)
	host.mono = 61.0
	host.refresh_ok = false
	var fire: Callable = host.timers[0][1]
	fire.call()
	t.check("refresh: the deferred try runs", host.refreshes == 2)
	t.check("refresh: it failed, so another is deferred a minute on", host.timers.size() == 2 and is_equal_approx(host.timers[1][0], 60.0))
	for i in 5:
		host.mono += 61.0
		var f: Callable = host.timers.back()[1]
		f.call()
	t.check("refresh: failures are retried five times, then stop", host.refreshes == 7 and host.timers.size() == 6, "%d %d" % [host.refreshes, host.timers.size()])
	host.mono += 61.0
	host.refresh_ok = true
	var stored := host.stored
	docs.ring("jws-3")
	t.check("refresh: a later roster tries again and a success is reported to the host", host.refreshes == 8 and host.stored == stored + 2, "%d %d" % [host.refreshes, host.stored - stored])
	t.check("refresh: and a success ends the retries", host.timers.size() == 6)
	# close() drops a pending retry's effect.
	var host2 := Host.new()
	var docs2 := host2.docs()
	docs2.want_ring()
	docs2.ring("x")
	docs2.close()
	host2.mono = 100.0
	host2.timers[0][1].call()
	t.check("refresh: a retry that fires after close() does nothing", host2.refreshes == 1)
	t.check("refresh: str() shows nothing", str(docs2) == "PKeyConnectChannel.Docs()")


func _docs_async(t: PKeyTestContext) -> void:
	# A notice handler that is slow cannot reorder anything: documents are handled one at a time.
	var host := Host.new()
	host.gate_open = false
	var docs := host.docs()
	var notes := Notes.new()
	docs.notice.connect(notes.on_notice)
	docs.trust("a")
	docs.trust("b")
	docs.ring("r")
	t.check("async: a document in flight blocks the next", host.trusted == ["a"] and host.adopted.is_empty())
	host.gate_open = true
	host.gate.emit()
	t.check("async: then they run in arrival order, one at a time", host.trusted == ["a", "b"] and host.adopted == ["r"], "%s %s" % [host.trusted, host.adopted])
	t.check("async: and each leaves a notice", notes.list.size() == 3)


func _session_caps(t: PKeyTestContext) -> void:
	# G10 on a session with a link that records.
	var link := FakeLink.new()
	var s := PKeyConnectSession.new(link, "d", [], {}, "responder", "", "lan", PKeyConnectSession.Budget.new())
	var chunk := PackedByteArray()
	chunk.resize(1024 * 1024)
	var sent := 0
	while sent * chunk.size() <= PKeyConnectSession.QUEUE_PAUSE_BYTES:
		s.deliver(0x0100, chunk)
		sent += 1
	t.check("caps: the pipe pauses at 4 MiB queued, once, and nothing closes", link.pauses == [true] and link.closes.is_empty(), "%s %s" % [link.pauses, link.closes])
	for i in sent:
		await s.receive()
	t.check("caps: reading drains it and resumes the pipe under 1 MiB", link.pauses.back() == false)
	for i in PKeyConnectSession.QUEUE_MAX_BYTES / chunk.size() + 1:
		s.deliver(0x0100, chunk)
	t.check("caps: 8 MiB queued closes peer_busy", not link.closes.is_empty() and link.closes[0] == &"peer_busy", str(link.closes))
	# 256 messages.
	var link2 := FakeLink.new()
	var s2 := PKeyConnectSession.new(link2, "d", [], {}, "responder", "", "lan", PKeyConnectSession.Budget.new())
	for i in PKeyConnectSession.MAX_QUEUED_MESSAGES:
		s2.deliver(0x0100, PackedByteArray([1]))
	t.check("caps: 256 small messages are held", link2.closes.is_empty())
	s2.deliver(0x0100, PackedByteArray([1]))
	t.check("caps: the 257th closes peer_busy", link2.closes == [&"peer_busy"])
	# All sessions together.
	var budget := PKeyConnectSession.Budget.new(3 * 1024 * 1024)
	var la := FakeLink.new()
	var lb := FakeLink.new()
	var sa := PKeyConnectSession.new(la, "a", [], {}, "responder", "", "lan", budget)
	var sb := PKeyConnectSession.new(lb, "b", [], {}, "responder", "", "lan", budget)
	sa.deliver(0x0100, chunk)
	sa.deliver(0x0100, chunk)
	sb.deliver(0x0100, chunk)
	t.check("caps: the shared budget holds three", budget.used == 3 * 1024 * 1024 and la.closes.is_empty() and lb.closes.is_empty())
	sb.deliver(0x0100, chunk)
	t.check("caps: the fourth, from either session, is refused and closes it", lb.closes == [&"peer_busy"] and la.closes.is_empty())
	await sa.receive()
	sb.deliver(0x0100, chunk)
	t.check("caps: reading frees the budget for the others", lb.closes == [&"peer_busy"] and budget.used == 3 * 1024 * 1024)
	sa.ended(&"peer_bye", true)
	sb.ended(&"peer_bye", true)
	t.check("caps: ending a session returns every byte it held", budget.used == 0)
	# A listener bypasses the queue and the budget.
	var lc := FakeLink.new()
	var sc := PKeyConnectSession.new(lc, "c", [], {}, "responder", "", "lan", budget)
	var heard := []
	sc.message.connect(func(type: int, body: PackedByteArray) -> void: heard.append(body.size()))
	for i in 300:
		sc.deliver(0x0100, chunk)
	t.check("caps: a message listener takes everything and holds nothing", heard.size() == 300 and budget.used == 0 and lc.closes.is_empty())
	# A closed session takes nothing.
	sc.ended(&"peer_bye", false)
	sc.deliver(0x0100, chunk)
	t.check("caps: and a closed one ignores deliveries", heard.size() == 300)
	t.check("caps: a refusing link surfaces as too_large", PKeyConnectErrors.reason_of(_refusing()) == "too_large")


func _refusing() -> PKeyResult:
	var link := FakeLink.new()
	link.refuse = true
	return PKeyConnectSession.new(link, "d", [], {}, "initiator").send(PackedByteArray())
