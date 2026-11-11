extends RefCounted
# @pkey-feature connect.local
# Two devices pairing with a code (PKeyCloudLocalLinks, CC-29b.G3; WIRE-CONTRACT-V5 section 15.12) over real loopback TCP
# and real Noise, ported from sdk-node's `localLinks.e2e.test.ts`: the code, the consent, the link on both sides with
# the categories both listed, a wrong code that rotates the code, a decline that stores nothing, `renew` with the
# nameplate memory and the renewal floor, a window that expires and a gate that goes off under an open window. The
# helpers (the devices, the fake lane, the clock) are `local_links.gd`'s. No wall clock: the windows and the dial budget
# read a clock the test moves.

const Base := preload("res://tests/connect/local_links.gd")
const Pairing := preload("res://tests/connect/pairing.gd")

var _b: Base
var _host: Node


func run(t: PKeyTestContext) -> void:
	_b = Base.new()
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	_b._host = _host
	await _pairing(t)
	await _wrong_code(t)
	await _decline(t)
	await _renew(t)
	await _expiry_and_flip(t)
	await _b._frames(20)
	PKeyCloudLocalLinks.reset_budgets()
	_host.queue_free()


# -- two devices pairing ---------------------------------------------------------------------------


## Start the join of `b` in a coroutine; the answer lands in the returned Dictionary under "r".
func _start_join(b: Base.Dev, cats: Array, label: String, code: String, browse := 15) -> Dictionary:
	var holder := {"r": null}
	var run := func() -> void:
		holder["r"] = await b.links.join(
			b.join_options(cats, label, code).merged({"browse_seconds": browse})
		)
	run.call()
	return holder


func _pairing(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := Pairing.Bus.new()
	var a := _b._device(bus)
	var b := _b._device(bus)
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs", "music"], "Anna"))
	t.check("pair: the window opens with the first code", r.ok and a.codes.size() == 1)
	if not r.ok or a.codes.is_empty():
		return
	var win: PKeyCloudLocalLinks.Handle = r.detail
	var first: Dictionary = a.codes[0]
	t.check(
		"pair: the code is two groups of four, the QR is PKP1, the reason is opened",
		(
			str(first["code"]).length() == 9
			and str(first["code"])[4] == " "
			and str(first["qr"]).begins_with("PKP1:DJDL:")
			and first["reason"] == "opened"
		)
	)
	t.check(
		"pair: the window ends 300 s on and counts no failure",
		(
			first["failures"] == 0
			and int(first["expires_at"]) > 0
			and win.is_open()
			and win.code() == first
		)
	)
	var held_before := _b._held(a).size()
	var joined := _start_join(b, ["docs", "video"], "Bo", first["code"])
	var met := await _b._until(func() -> bool: return a.offers.size() == 1 and b.offers.size() == 1)
	t.check("pair: both devices reach the consent", met)
	if not met:
		win.stop()
		b.links.cancel_join()
		return
	var offer_a: PKeyConnectLocalCommon.Offer = a.offers[0]
	var offer_b: PKeyConnectLocalCommon.Offer = b.offers[0]
	t.check(
		"pair: each offer shows the other's label, platform and the categories the app asked for",
		(
			offer_a.label == "Bo"
			and offer_b.label == "Anna"
			and offer_a.platform != ""
			and offer_a.categories == ["docs", "music"]
			and offer_b.categories == ["docs", "video"]
		)
	)
	t.check(
		"pair: nothing is stored before both agree",
		_b._held(a).size() == held_before and _b._held(b).is_empty() and joined["r"] == null
	)
	offer_b.confirm()
	await _b._frames(10)
	t.check(
		"pair: one person's yes stores nothing",
		_b._held(a).size() == held_before and _b._held(b).is_empty()
	)
	offer_a.confirm()
	var done := await _b._until(func() -> bool: return joined["r"] != null and a.ended.size() == 1)
	t.check(
		"pair: the joiner is told the link and the window ends stored",
		done and joined["r"].ok and a.ended[0]["reason"] == "stored" and not win.is_open()
	)
	var link_a := _b._held(a)
	var link_b := _b._held(b)
	t.check(
		"pair: each side holds one link with the categories both listed",
		(
			link_a.size() == 1
			and link_b.size() == 1
			and link_a[0]["categories"] == ["docs"]
			and link_b[0]["categories"] == ["docs"]
		)
	)
	t.check(
		"pair: each side stored the other's label and platform",
		(
			link_a[0]["label"] == "Bo"
			and link_b[0]["label"] == "Anna"
			and link_a[0]["platform"] != null
		)
	)
	t.check(
		"pair: the answer names the link and the categories both approved",
		(
			joined["r"].detail["id"] == link_b[0]["id"]
			and joined["r"].detail["categories"] == ["docs"]
			and a.linked.size() == 1
			and a.linked[0]["id"] == link_a[0]["id"]
		)
	)
	t.check("pair: the host heard of the change", a.changes[0] >= 1 and b.changes[0] >= 1)
	var own_a: Dictionary = a.links._src.store.live(str(link_a[0]["id"])).detail
	var own_b: Dictionary = b.links._src.store.live(str(link_b[0]["id"])).detail
	t.check(
		"pair: the two devices agree on the secret and hold each other's key",
		(
			own_a["secret"] == own_b["secret"]
			and own_a["peer_key"] == own_b["own_public"]
			and own_b["peer_key"] == own_a["own_public"]
			and own_a["own_key"].size() == 32
		)
	)
	t.check(
		"pair: the key the link was made over is the one stored",
		PKeyPeerCrypto.for_platform().x25519_public(own_a["own_key"]) == own_a["own_public"]
	)
	PKeyConnectLocalState.wipe_live([own_a, own_b])
	var window_adverts := bus.adverts.filter(
		func(e: Dictionary) -> bool:
			return e["handle"].stops == 0 and (e["advert"]["txt"] as Array).has("m=q")
	)
	t.check(
		"pair: the window left no m=q advert, listener or session behind",
		a.links._shower == null and window_adverts.is_empty()
	)
	t.check(
		"pair: the dial was spent on the code's nameplate",
		b.links.dials_left(str(first["code"])) == 1
	)
	PKeyCloudLocalLinks.reset_budgets()


func _wrong_code(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := Pairing.Bus.new()
	var a := _b._device(bus)
	var b := _b._device(bus)
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	if not r.ok:
		t.check("wrong code: the window opens", false)
		return
	var first: Dictionary = a.codes[0]
	var digits := str(first["code"]).replace(" ", "")
	var wrong := digits.substr(0, 2) + ("%06d" % ((int(digits.substr(2)) + 1) % 1000000))
	var joined := _start_join(b, ["docs"], "Bo", wrong, 1)
	# The joiner waits out its browse before it says so: the test moves the clock once the shower has rotated.
	var rotated := await _b._until(func() -> bool: return a.codes.size() == 2)
	_b._clock[0] += 2.0
	var done := await _b._until(func() -> bool: return joined["r"] != null)
	t.check(
		"wrong code: the joiner is pairing-code-failed, reason wrong",
		(
			done
			and joined["r"].code == PKeyConstants.ErrorCode.PAIRING_CODE_FAILED
			and joined["r"].detail["reason"] == "wrong"
		)
	)
	t.check(
		"wrong code: the shower shows a new code with the reason wrong-code and one failure",
		(
			rotated
			and a.codes[1]["reason"] == "wrong-code"
			and a.codes[1]["failures"] == 1
			and a.codes[1]["code"] != first["code"]
			and a.codes[1]["expires_at"] == first["expires_at"]
		)
	)
	t.check(
		"wrong code: nothing was offered to either person or stored",
		(
			a.offers.is_empty()
			and b.offers.is_empty()
			and _b._held(a).is_empty()
			and _b._held(b).is_empty()
		)
	)
	# Four more guesses close the window: the fifth failed guess is too-many-tries.
	for i in 4:
		var cur: Dictionary = (r.detail as PKeyCloudLocalLinks.Handle).code()
		if cur.is_empty():
			break
		var d := str(cur["code"]).replace(" ", "")
		var bad := d.substr(0, 2) + ("%06d" % ((int(d.substr(2)) + 1) % 1000000))
		PKeyCloudLocalLinks.reset_budgets()
		var seen: int = a.codes.size()
		var h := _start_join(b, ["docs"], "Bo", bad, 1)
		await _b._until(func() -> bool: return a.codes.size() > seen or not a.ended.is_empty())
		_b._clock[0] += 2.0
		await _b._until(func() -> bool: return h["r"] != null)
	t.check(
		"wrong code: the fifth failed guess ends the window too-many-tries",
		(
			a.ended.size() == 1
			and a.ended[0]["reason"] == "too-many-tries"
			and a.failed.size() >= 1
			and a.interrupted.size() >= 0
		)
	)
	var again: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	(
		t
		. check(
			"wrong code: the renewal floor refuses a new window for 30 s (peer-closed, reason cooldown)",
			(
				not again.ok
				and again.code == PKeyConstants.ErrorCode.PEER_CLOSED
				and again.detail["reason"] == "cooldown"
			)
		)
	)
	_b._clock[0] += 31.0
	var later: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	t.check("wrong code: after the floor a window opens", later.ok)
	if later.ok:
		(later.detail as PKeyCloudLocalLinks.Handle).stop()
	PKeyCloudLocalLinks.reset_budgets()


func _decline(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := Pairing.Bus.new()
	var a := _b._device(bus)
	var b := _b._device(bus)
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	if not r.ok:
		t.check("decline: the window opens", false)
		return
	var joined := _start_join(b, ["docs"], "Bo", a.codes[0]["code"])
	await _b._until(func() -> bool: return a.offers.size() == 1 and b.offers.size() == 1)
	(b.offers[0] as PKeyConnectLocalCommon.Offer).decline()
	var done := await _b._until(func() -> bool: return joined["r"] != null)
	t.check(
		"decline: the person who declines gets peer-closed with reason declined",
		(
			done
			and joined["r"].code == PKeyConstants.ErrorCode.PEER_CLOSED
			and joined["r"].detail["reason"] == "declined"
		)
	)
	var rotated := await _b._until(
		func() -> bool: return a.codes.size() == 2 and a.failed.size() == 1
	)
	t.check(
		"decline: the other side hears it failed and shows a new code",
		rotated and a.failed[0]["reason"] == "closed" and a.codes[1]["reason"] == "closed"
	)
	t.check(
		"decline: nothing is stored on either side",
		(
			_b._held(a).is_empty()
			and _b._held(b).is_empty()
			and (r.detail as PKeyCloudLocalLinks.Handle).is_open()
		)
	)
	# The shower's person says no: the shower hears declined, the joiner hears the other device declined.
	PKeyCloudLocalLinks.reset_budgets()
	a.offers.clear()
	b.offers.clear()
	var joined2 := _start_join(b, ["docs"], "Bo", a.codes[1]["code"])
	await _b._until(func() -> bool: return a.offers.size() == 1 and b.offers.size() == 1)
	(a.offers[0] as PKeyConnectLocalCommon.Offer).decline()
	await _b._until(func() -> bool: return joined2["r"] != null)
	t.check(
		"decline: the joiner hears the other device declined",
		(
			joined2["r"].code == PKeyConstants.ErrorCode.PEER_CLOSED
			and joined2["r"].detail["reason"] == "declined"
		)
	)
	await _b._until(func() -> bool: return a.failed.size() == 2 and a.codes.size() == 3)
	t.check(
		"decline: the shower shows the reason declined",
		a.failed[1]["reason"] == "declined" and a.codes[2]["reason"] == "declined"
	)
	(r.detail as PKeyCloudLocalLinks.Handle).stop()
	t.check(
		"decline: stop ends the window person",
		a.ended.size() == 1 and a.ended[0]["reason"] == "person"
	)
	PKeyCloudLocalLinks.reset_budgets()


func _renew(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := Pairing.Bus.new()
	var a := _b._device(bus)
	var r: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	if not r.ok:
		t.check("renew: the window opens", false)
		return
	var win: PKeyCloudLocalLinks.Handle = r.detail
	var second: PKeyResult = await a.links.pair(a.pair_options(["docs"], "Anna"))
	t.check(
		"renew: a second window while one is open is invalid-options",
		second.code == PKeyConstants.ErrorCode.INVALID_OPTIONS
	)
	var first_np := str(a.codes[0]["nameplate"])
	var renewed: PKeyResult = await win.renew()
	t.check(
		"renew: it answers the first code of a new window",
		renewed.ok and a.codes.size() == 2 and renewed.detail["reason"] == "opened"
	)
	t.check(
		"renew: the nameplate is not one this app closed with in the last 300 s",
		(
			renewed.ok
			and renewed.detail["nameplate"] != first_np
			and renewed.detail["code"] != a.codes[0]["code"]
		)
	)
	t.check("renew: the old window ended with no on_end", a.ended.is_empty() and win.is_open())
	# A renewal works on a closed handle, and two calls at once share one window.
	win.stop()
	t.check(
		"renew: stop ends the window person",
		a.ended.size() == 1 and a.ended[0]["reason"] == "person" and not win.is_open()
	)
	var shared := {"a": null, "b": null}
	var run_a := func() -> void: shared["a"] = await win.renew()
	var run_b := func() -> void: shared["b"] = await win.renew()
	run_a.call()
	run_b.call()
	await _b._until(func() -> bool: return shared["a"] != null and shared["b"] != null)
	t.check(
		"renew: it works on a closed handle and two calls at once share one window",
		(
			shared["a"].ok
			and shared["b"].ok
			and shared["a"].detail["code"] == shared["b"].detail["code"]
			and a.codes.size() == 3
			and win.is_open()
		)
	)
	# stop() while a renewal is opening leaves no window and no code.
	var pending := {"r": null}
	var run_c := func() -> void: pending["r"] = await win.renew()
	run_c.call()
	win.stop()
	await _b._until(func() -> bool: return pending["r"] != null)
	t.check(
		"renew: stop during a renewal answers peer-closed and leaves no window",
		(
			pending["r"].code == PKeyConstants.ErrorCode.PEER_CLOSED
			and not win.is_open()
			and win.code().is_empty()
			and a.links._shower == null
		)
	)
	# The second wrong-code end within 600 s trips the floor.
	var floor := a.links._floor()
	floor.ended("wrong-code", _b._mono())
	t.check(
		"renew: one wrong-code end alone does not", a.links._floor().check(_b._mono())["allowed"]
	)
	floor.ended("wrong-code", _b._mono())
	var cooled: PKeyResult = await win.renew()
	t.check(
		"renew: the second wrong-code end within 600 s refuses a new window (cooldown)",
		(
			not cooled.ok
			and cooled.code == PKeyConstants.ErrorCode.PEER_CLOSED
			and cooled.detail["reason"] == "cooldown"
		)
	)
	PKeyCloudLocalLinks.reset_budgets()


func _expiry_and_flip(t: PKeyTestContext) -> void:
	PKeyCloudLocalLinks.reset_budgets()
	var bus := Pairing.Bus.new()
	var a := _b._device(bus)
	var opts := a.pair_options(["docs"], "Anna")
	opts["seconds"] = 20
	var r: PKeyResult = await a.links.pair(opts)
	if not r.ok:
		t.check("expiry: the window opens", false)
		return
	t.check(
		"expiry: the window is open and its advert is up",
		(
			(r.detail as PKeyCloudLocalLinks.Handle).is_open()
			and bus.adverts.size() == 1
			and bus.adverts[0]["advert"]["txt"].has("m=q")
		)
	)
	_b._clock[0] += 21.0
	await _b._until(func() -> bool: return not a.ended.is_empty())
	t.check(
		"expiry: after its seconds the window ends expired and withdraws the advert",
		(
			a.ended.size() == 1
			and a.ended[0]["reason"] == "expired"
			and bus.adverts[0]["handle"].stops == 1
		)
	)
	# A discovery read that clears the answer closes the window and every join.
	var b := _b._device(bus)
	var win_r: PKeyResult = await b.links.pair(b.pair_options(["docs"], "Bo"))
	var joined := _start_join(a, ["docs"], "Anna", "1234 5678")
	await _b._frames(3)
	var before: int = b.changes[0]
	_b._manifest(b.core, false)
	b.core.discovery_changed.emit()
	_b._manifest(a.core, false)
	a.core.discovery_changed.emit()
	await _b._until(func() -> bool: return joined["r"] != null)
	t.check(
		"flip: the gate going off closes the window with the reason off",
		(
			win_r.ok
			and b.ended.size() == 1
			and b.ended[0]["reason"] == "off"
			and not (win_r.detail as PKeyCloudLocalLinks.Handle).is_open()
		)
	)
	t.check(
		"flip: it closes the join in flight",
		(
			joined["r"].code == PKeyConstants.ErrorCode.PEER_CLOSED
			and joined["r"].detail["reason"] == "closed"
		)
	)
	t.check("flip: the host hears of the flip", b.changes[0] > before)
	PKeyCloudLocalLinks.reset_budgets()
