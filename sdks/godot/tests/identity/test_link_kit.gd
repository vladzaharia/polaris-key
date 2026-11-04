extends RefCounted
# @pkey-feature identity.link identity.redirect.native ui.gate
# The kit's rung 6 and link steps (I-48.14): the sign-in dialog starts the native redirect on a desktop and
# falls back to the device code where the SDK answers redirect-unavailable; the gate asks for the link offer
# after a sign-in this device started and draws link-offer, link-done and link-conflict over
# PolarisKey.identity.link. The SDK's own link and redirect rules are test_link.gd's and test_native_redirect.gd's.

const B := preload("res://tests/identity/support.gd")
const GA := preload("res://tests/identity/test_gate_auto.gd")

const RURI := "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
const RQ := "rq_A1xUxaz50yGeWfx8JDSnAw"
const HANDLE := "lh_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const TOKEN_NEW := "pkeyt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW"
const TOKEN_OK := {
	"access_token": TOKEN_NEW, "token_type": "Bearer", "scope": "profile email", "schemaVersion": 1,
	"device": {"id": "D"}, "license": {"id": "lic_1"}, "subject": "ps_abc",
}
const OFFER := {"offer": [{"kind": "google", "reach": "global"}]}


func run(t: PKeyTestContext) -> void:
	_controller(t)
	await _dialog_native(t)
	await _dialog_fallbacks(t)
	await _gate_offer(t)
	await _gate_hold(t)
	await _gate_failures(t)
	await _gate_conflict_and_decline(t)
	await _no_offer(t)


## A started SDK with the native redirect and link routes, device keys and a desktop platform.
func _bed(native := true) -> B:
	var bed := B.new()
	bed.device_keys = PKeyDeviceKeyStore.for_tests("djdl", "user://pkey_test_link_kit_%d" % Time.get_ticks_usec())
	var sdk := await bed.make_sdk()
	sdk.identity.redirect_acquisition_sync = false
	sdk.identity.link.store = PKeyLinkDeclinedStore.for_tests("djdl", "user://pkey_test_link_kit_rec_%d" % Time.get_ticks_usec(), true)
	var root := _root(bed)
	var fragment := {
		"enabled": true, "configured": true, "issuer": root,
		"endpoints": {
			"authorize": root + "/authorize", "token": root + "/token", "request": root + "/request", "link": root + "/link",
			"nonce": root + "/nonce", "signinReturn": bed.server.base_url() + "/signin/return",
		},
	}
	if native:
		fragment["nativeRedirect"] = {"loopback": true, "schemes": [], "claimedHttps": []}
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": fragment}}
	bed.pushes = [B.json(201, {"request_uri": RURI, "expires_in": 600})]
	bed.tokens = [B.json(200, TOKEN_OK)]
	bed.links = [B.json(200, OFFER)]
	sdk.identity.native_platform = "desktop"
	return bed


func _root(bed: B) -> String:
	return "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]


func _stage_gate(bed: B) -> PKeyGateView:
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	gate.auto_sign_in = false
	gate.sdk = bed.sdk
	gate.activation.sign_in_dialog.redirect_options = {"loopback": true, "browser": false}
	(Engine.get_main_loop() as SceneTree).root.add_child(gate)
	gate.show_state({"status": "needs-activation"})
	return gate


## Deliver the browser's return to the dialog's running native sign-in.
func _return_to(bed: B, dialog: PKeySignInDialog) -> void:
	var s := dialog._session
	var body := String(bed.push_requests.back()["body"])
	var state := ""
	for part in body.split("&"):
		if part.begins_with("state="):
			state = part.substr(6)
	var url := "%s?code=C0DE&state=%s&iss=%s&request=%s" % [s.redirect_uri, state, _root(bed).uri_encode(), RQ]
	s.handle_redirect(url)


func _controller(t: PKeyTestContext) -> void:
	var ctl := PKeyGateController
	t.check("link kit: kinds name their provider", ctl.link_provider("google") == "Google" and ctl.link_provider("apple") == "Apple"
		and ctl.link_provider("gamecenter") == "Game Center" and ctl.link_provider("pgs") == "Google Play Games" and ctl.link_provider("x") == "")
	t.check("link kit: reach is global, developer or unknown", ctl.link_reach({"reach": "global"}) == "global"
		and ctl.link_reach({"reach": "developer"}) == "developer" and ctl.link_reach({"reach": null}) == "unknown" and ctl.link_reach({}) == "unknown")
	t.check("link kit: a linked answer is link-done", ctl.link_next(PKeyLinkResult.linked("google", null)) == "link-done")
	t.check("link kit: a conflict is link-conflict", ctl.link_next(PKeyLinkResult.refused(PKeyConstants.ErrorCode.LINK_CONFLICT, 409)) == "link-conflict")
	var stale := PKeyLinkResult.refused(PKeyConstants.ErrorCode.STEP_UP_REQUIRED, 401)
	t.check("link kit: any other answer keeps the offer", ctl.link_next(stale) == "link-offer"
		and ctl.link_next(PKeyLinkResult.failed(PKeyErrors.NETWORK, "x")) == "link-offer" and ctl.link_next(PKeyLinkResult.unavailable()) == "link-offer")
	t.check("link kit: a stale sign-in is stale, with its own line", ctl.link_problem(stale) == "stale" and ctl.link_problem_key("stale") == "signin.linkOffer.stale")
	t.check("link kit: a refusal (not_found, invalid_grant) or a refused proof is refused",
		ctl.link_problem(PKeyLinkResult.refused(PKeyConstants.ErrorCode.NOT_FOUND, 404)) == "refused"
		and ctl.link_problem(PKeyLinkResult.refused(PKeyConstants.ErrorCode.INVALID_GRANT, 400)) == "refused"
		and ctl.link_problem(PKeyLinkResult.failed(PKeyErrors.SIGN_IN_FAILED, "x")) == "refused" and ctl.link_problem_key("refused") == "signin.linkOffer.failed")
	t.check("link kit: no answer or a server failure is the network line", ctl.link_problem(PKeyLinkResult.failed(PKeyErrors.NETWORK, "x")) == "network"
		and ctl.link_problem(PKeyLinkResult.failed(PKeyErrors.SERVER_ERROR, "x")) == "network" and ctl.link_problem_key("network") == "core.codes.network.message")
	t.check("link kit: unavailable ends quietly; a conflict or a link is no problem", ctl.link_problem(PKeyLinkResult.unavailable()) == "unavailable"
		and ctl.link_problem(PKeyLinkResult.refused(PKeyConstants.ErrorCode.LINK_CONFLICT, 409)) == "" and ctl.link_problem(PKeyLinkResult.linked("google", null)) == ""
		and ctl.link_problem_key("unavailable") == "")


func _dialog_native(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await _bed()
	var d := PKeySignInDialog.new()
	d.auto_sdk = false
	d.sdk = bed.sdk
	d.redirect_options = {"loopback": true, "browser": false}
	tree.root.add_child(d)
	var ended := []
	var closed := []
	d.finished.connect(func(r): ended.append(r))
	d.closed.connect(func(): closed.append(true))
	d.begin()
	# The person is on Cancel (the only button while the sign-in starts) with the keyboard or a pad.
	await tree.process_frame
	d._cancel_btn.grab_focus()
	await B.until(func(): return d.state == "redirect")
	await B.until(func(): return d.get_viewport().gui_get_focus_owner() == d._open, 30)
	t.check("link kit: the browser wait opens with Open browser again focused, never Cancel", d.get_viewport().gui_get_focus_owner() == d._open)
	t.check("link kit: on a desktop the dialog starts the native redirect, not a code", d.state == "redirect" and d._session != null
		and d._session.channel == &"redirect" and d._session.redirect_class == "loopback" and bed.starts.is_empty() and bed.push_requests.size() == 1)
	t.check("link kit: the redirect state shows the browser wait, Open browser again, Use a code instead and Cancel",
		d._open.visible and d._open.text == String(PKeyUiView.catalog().format("signin.handoff.again"))
		and d._use_code.visible and d._use_code.text == String(PKeyUiView.catalog().format("signin.handoff.useCode"))
		and d._cancel_btn.visible and not d._continue.visible and not d._try_again.visible, d._open.text)
	t.check("link kit: the browser could not open here (browser: false), so the link is named and can be copied",
		d.browser_failed and d._copy.visible and d._title.text == String(PKeyUiView.catalog().format("signin.handoff.noBrowser")))
	t.check("link kit: no code or QR code shows", d._code.text == "" and not d._qr.visible)
	d._session.opened = true
	d.show_redirect(d._session)
	t.check("link kit: with the browser open the wait shows Finish in your browser", not d.browser_failed and not d._copy.visible
		and d._title.text == String(PKeyUiView.catalog().format("signin.handoff.title")) and d._instructions.visible)
	# Open browser again reopens the same authorize page while the request lives.
	var url_before := d._session.authorize_url
	d._on_open()
	t.check("link kit: Open browser again keeps the same authorize page", d._session.authorize_url == url_before and bed.push_requests.size() == 1)
	_return_to(bed, d)
	await B.until(func(): return ended.size() == 1)
	t.check("link kit: the browser's return signs in", ended.size() == 1 and ended[0].kind == PKeySignInOutcome.KIND_SIGNED_IN and d.state == "ended", str(ended))
	t.check("link kit: a redirect sign-in opens the link offer", bed.sdk.identity.link.pending)
	d.queue_free()
	bed.free_all()

	# Cancel ends the session and closes the dialog.
	bed = await _bed()
	d = PKeySignInDialog.new()
	d.auto_sdk = false
	d.sdk = bed.sdk
	d.redirect_options = {"loopback": true, "browser": false}
	tree.root.add_child(d)
	closed.clear()
	d.closed.connect(func(): closed.append(true))
	d.begin()
	await B.until(func(): return d.state == "redirect")
	var listener = d._session._native.listener
	d._on_cancel()
	await B.until(func(): return d.state == "cancelled")
	t.check("link kit: Cancel ends the native session and releases the listener", d._session._cancelled and listener.is_closed() and d.state == "cancelled")
	await B.until(func(): return not closed.is_empty(), 600)
	t.check("link kit: …and closes the dialog", closed.size() == 1, str(closed.size()))
	if is_instance_valid(d):
		d.queue_free()
	bed.free_all()

	# Use a code instead: the redirect is cancelled and the device code runs, without closing the dialog.
	bed = await _bed()
	bed.starts = [B.started()]
	d = PKeySignInDialog.new()
	d.auto_sdk = false
	d.sdk = bed.sdk
	d.redirect_options = {"loopback": true, "browser": false}
	tree.root.add_child(d)
	closed.clear()
	d.closed.connect(func(): closed.append(true))
	d.begin()
	await B.until(func(): return d.state == "redirect")
	var first = d._session
	d._on_use_code()
	await B.until(func(): return d.state == "pending")
	t.check("link kit: Use a code instead cancels the redirect and shows the code", d.state == "pending" and first._cancelled and d._session != first
		and d._session.channel == &"device-code" and closed.is_empty() and d._code.text != "")
	d.queue_free()
	bed.free_all()


func _dialog_fallbacks(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# Where the SDK answers redirect-unavailable (a phone, the web, a product with no native class) the code runs.
	for row in [["a phone", "ios", true], ["no native class in discovery", "desktop", false]]:
		var bed := await _bed(row[2])
		bed.sdk.identity.native_platform = row[1]
		bed.starts = [B.started()]
		var d := PKeySignInDialog.new()
		d.auto_sdk = false
		d.sdk = bed.sdk
		d.redirect_options = {"browser": false}
		tree.root.add_child(d)
		d.begin()
		await B.until(func(): return d.state == "pending")
		t.check("link kit: %s answers redirect-unavailable, so the device code runs" % row[0], d.state == "pending" and d._session.channel == &"device-code"
			and bed.push_requests.is_empty() and d._code.visible, d.state)
		d.queue_free()
		bed.free_all()
	# The game can keep the code everywhere.
	var off := await _bed()
	off.starts = [B.started()]
	var d2 := PKeySignInDialog.new()
	d2.auto_sdk = false
	d2.sdk = off.sdk
	d2.use_native_redirect = false
	tree.root.add_child(d2)
	d2.begin()
	await B.until(func(): return d2.state == "pending")
	t.check("link kit: use_native_redirect = false keeps the device code", d2._session.channel == &"device-code" and off.push_requests.is_empty())
	d2.queue_free()
	off.free_all()


func _offer_step(bed: B, gate: PKeyGateView) -> bool:
	gate.activation._on_sign_in()
	var dialog: PKeySignInDialog = gate.activation.sign_in_dialog
	await B.until(func(): return dialog.state == "redirect")
	_return_to(bed, dialog)
	await B.until(func(): return gate._auto_state == "link-offer", 900)
	return gate._auto_state == "link-offer"


func _fake_google(bed: B) -> void:
	var p := GA.FakeProvider.new()
	p.kind = "google"
	bed.sdk.identity.install_platform_provider(p)


func _gate_offer(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await _bed()
	_fake_google(bed)
	var gate := _stage_gate(bed)
	var usable := []
	gate.usable.connect(func(): usable.append(true))
	var shown := await _offer_step(bed, gate)
	await tree.process_frame
	t.check("link kit: a sign-in this device started ends on the link offer", shown and gate.auto_step.visible and gate.auto_step.step == "link-offer"
		and gate.auto_step.provider == "Google" and gate.auto_step.reach == "global")
	t.check("link kit: the gate holds under the offer (no usable)", gate.visible and usable.is_empty() and not gate.activation.visible)
	t.check("link kit: the offer asked the route once with the device token", bed.link_requests.size() == 1 and bed.link_requests[0]["method"] == "GET"
		and bed.link_requests[0]["headers"].get("authorization", "") == "Bearer " + TOKEN_NEW)
	t.check("link kit: the step names the model's primary and decline", gate.auto_step.model.get("decisions", {}).get("primary") == "signin.linkOffer.primary"
		and gate.auto_step._primary.text.begins_with("Link ") and gate.auto_step._primary.text.contains("Google")
		and gate.auto_step._secondary.text == String(PKeyUiView.catalog().format("signin.linkOffer.decline")),
		gate.auto_step._primary.text)
	# Linking: the handle the exchange left is sent, then link-done.
	bed.sdk.identity.link._hold(HANDLE, int(bed.clock[0]) + 600)
	# While Link runs, neither button can be pressed.
	gate.auto_step.busy = true
	t.check("link kit: while linking, Link and No thanks are disabled", gate.auto_step._primary.disabled and gate.auto_step._secondary.disabled)
	gate.auto_step.busy = false
	t.check("link kit: …and enabled again after", not gate.auto_step._primary.disabled and not gate.auto_step._secondary.disabled)
	# No answer: the network line, Link stays.
	bed.links = [B.json(500, {})]
	gate._on_auto_primary("link-offer")
	await B.until(func(): return gate.auto_step.error_key != "")
	t.check("link kit: a network failure keeps Link under the network line", gate._auto_state == "link-offer" and gate.auto_step.error_key == "core.codes.network.message"
		and gate.auto_step._error.visible and gate.auto_step._primary.text.begins_with("Link ") and gate.auto_step._secondary.visible and not gate.auto_step.busy)
	t.check("link kit: after a failed Link the primary has the focus again", gate.get_viewport().gui_get_focus_owner() == gate.auto_step._primary)
	t.check("link kit: the problem line is a polite live region", not ("accessibility_live" in gate.auto_step._error) or int(gate.auto_step._error.get("accessibility_live")) == 1)
	# Escape or B while Link runs does nothing.
	gate._completing = true
	t.check("link kit: Escape while Link is in flight changes nothing", gate._cancel() and gate.auto_step.visible and gate._auto_state == "link-offer")
	gate._completing = false
	bed.links = [B.json(200, {"linked": {"kind": "google", "reach": "global"}})]
	gate._on_auto_primary("link-offer")
	await B.until(func(): return gate._auto_state == "link-done")
	var post: Dictionary = bed.link_requests.back()
	t.check("link kit: Link sends the handle with a proof and moves to link-done", gate._auto_state == "link-done" and post["method"] == "POST"
		and post["body"].get("linkHandle") == HANDLE and post["body"].has("proof") and gate.auto_step.step == "link-done" and gate.auto_step.error_key == "")
	t.check("link kit: link-done is one decision, Done", gate.auto_step.model.get("decisions", {}).get("primary") == "common.done" and not gate.auto_step._secondary.visible)
	var presses := []
	gate.auto_step.primary_pressed.connect(func(step): presses.append(step))
	gate._on_auto_primary("link-done")
	t.check("link kit: after Done the finishing card shows, busy, with no control", gate.auto_step.step == "finishing" and gate.auto_step.busy
		and not gate.auto_step._primary.visible and not gate.auto_step._secondary.visible and not gate.auto_step._secondary2.visible)
	gate.auto_step._on_primary()
	gate._on_auto_primary("link-done")
	t.check("link kit: a second Enter or A after Done does nothing", presses.is_empty() and gate._link_finishing and gate._cancel())
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: Done ends the offer and closes it without a decline", gate._auto_state == "" and not bed.sdk.identity.link.pending and bed.sdk.identity.link.store.hashes() == [])
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _gate_hold(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await _bed()
	_fake_google(bed)
	var gate := _stage_gate(bed)
	# The link GET is held: the fake Worker answers it, then stops until resumed.
	bed.links = [func(_req) -> Dictionary:
		bed.server.set_process(false)
		return B.json(200, OFFER)]
	gate.activation._on_sign_in()
	var dialog: PKeySignInDialog = gate.activation.sign_in_dialog
	await B.until(func(): return dialog.state == "redirect")
	_return_to(bed, dialog)
	# Every frame from the finished sign-in to the request being held: the finished dialog never shows.
	var stale_shown := 0
	var seen_ended := false
	for i in 900:
		await tree.process_frame
		if dialog.state == "ended":
			seen_ended = true
		if seen_ended and gate.activation.is_visible_in_tree():
			stale_shown += 1
		if not bed.link_requests.is_empty():
			break
	await tree.process_frame
	await tree.process_frame
	t.check("link kit: the finished sign-in dialog never shows while the offer is asked for", seen_ended and stale_shown == 0 and not bed.link_requests.is_empty(), str(stale_shown))
	t.check("link kit: the busy Finishing card stands in, with no action and nothing focused", not gate.activation.visible and gate.auto_step.visible
		and gate.auto_step.step == "finishing" and gate.auto_step.busy and not gate.auto_step._primary.visible and not gate.auto_step._secondary.visible
		and gate.get_viewport().gui_get_focus_owner() == null and gate.visible)
	t.check("link kit: Escape changes nothing while the offer is asked for", gate._cancel() and not gate.activation.is_visible_in_tree() and gate.auto_step.visible)
	bed.links = [B.json(200, OFFER)]
	bed.server.set_process(true)
	await B.until(func(): return gate._auto_state == "link-offer", 900)
	t.check("link kit: then the offer shows", gate._auto_state == "link-offer" and gate.auto_step.step == "link-offer")
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _gate_failures(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var bed := await _bed()
	_fake_google(bed)
	var gate := _stage_gate(bed)
	await _offer_step(bed, gate)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	link._hold(HANDLE, int(bed.clock[0]) + 600)
	# Too old a sign-in: the same step, the stale line, Sign in again as the primary, No thanks beside it.
	bed.links = [B.json(401, {"error": {"code": "step_up_required"}})]
	gate._on_auto_primary("link-offer")
	await B.until(func(): return gate.auto_step.error_key != "")
	var again := String(PKeyUiView.catalog().format("signin.again"))
	t.check("link kit: a stale step-up keeps the offer with the stale line and Sign in again", gate._auto_state == "link-offer"
		and gate.auto_step.error_key == "signin.linkOffer.stale" and gate.auto_step._error.visible and gate.auto_step._error.text.contains("Google")
		and gate.auto_step._primary.text == again and gate.auto_step._secondary.visible, gate.auto_step._primary.text)
	# Sign in again runs a fresh sign-in; the hold and the handle stay; the offer returns.
	bed.links = [B.json(200, OFFER)]
	gate._on_auto_primary("link-offer")
	var dialog: PKeySignInDialog = gate.activation.sign_in_dialog
	await B.until(func(): return dialog.state == "redirect")
	t.check("link kit: Sign in again starts the sign-in with the hold and the handle kept", gate.activation.visible and not gate.auto_step.visible
		and gate._link_hold and link._handle == HANDLE and bed.push_requests.size() == 2)
	_return_to(bed, dialog)
	await B.until(func(): return gate._auto_state == "link-offer", 900)
	t.check("link kit: when it finishes the offer is back with Link one tap away", gate._auto_state == "link-offer" and gate.auto_step.error_key == ""
		and gate.auto_step._primary.text.begins_with("Link ") and link._handle == HANDLE and link.pending)
	# A refusal: Link goes, No thanks is the primary and declines.
	# (The SDK tries the platform provider when a handle was refused, so the refusal is set as the gate would on it;
	# the answer-to-problem mapping is the controller test's.)
	gate._link_problem = "refused"
	gate.auto_step.error_key = PKeyGateController.link_problem_key("refused")
	var no_thanks := String(PKeyUiView.catalog().format("signin.linkOffer.decline"))
	t.check("link kit: a refusal shows the failed line, drops Link and makes No thanks the primary", gate._auto_state == "link-offer"
		and gate.auto_step.error_key == "signin.linkOffer.failed" and gate.auto_step._primary.text == no_thanks and not gate.auto_step._secondary.visible)
	gate._on_auto_primary("link-offer")
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: No thanks there declines for the account", link.store.hashes().size() == 1 and not link.pending and gate._auto_state == "")
	gate.queue_free()
	await tree.process_frame
	bed.free_all()

	# Unavailable (no offer is open any more) ends quietly: no step, no line.
	bed = await _bed()
	_fake_google(bed)
	gate = _stage_gate(bed)
	await _offer_step(bed, gate)
	bed.sdk.identity.link.dismiss()
	gate._on_auto_primary("link-offer")
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: an offer that is gone ends quietly", gate._auto_state == "" and gate.auto_step.error_key == "" and not gate.auto_step.visible)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()

	# Cancelling Sign in again lets the offer go and the gate carries on.
	bed = await _bed()
	_fake_google(bed)
	gate = _stage_gate(bed)
	await _offer_step(bed, gate)
	bed.sdk.identity.link._hold(HANDLE, int(bed.clock[0]) + 600)
	bed.links = [B.json(401, {"error": {"code": "step_up_required"}})]
	gate._on_auto_primary("link-offer")
	await B.until(func(): return gate.auto_step.error_key != "")
	gate._on_auto_primary("link-offer")
	dialog = gate.activation.sign_in_dialog
	await B.until(func(): return dialog.state == "redirect")
	dialog._on_cancel()
	await B.until(func(): return not gate._link_hold, 600)
	t.check("link kit: cancelling Sign in again lets the offer go", not gate._link_hold and not gate._link_resign and not bed.sdk.identity.link.pending)
	if is_instance_valid(gate):
		gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _gate_conflict_and_decline(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# link_conflict: its own step, the identity is remembered as declined for this account.
	var bed := await _bed()
	_fake_google(bed)
	var gate := _stage_gate(bed)
	await _offer_step(bed, gate)
	bed.sdk.identity.link._hold(HANDLE, int(bed.clock[0]) + 600)
	bed.links = [B.json(409, {"error": {"code": "link_conflict"}})]
	gate._on_auto_primary("link-offer")
	await B.until(func(): return gate._auto_state == "link-conflict")
	t.check("link kit: another account's identity is link-conflict with Done and Join accounts", gate._auto_state == "link-conflict"
		and gate.auto_step.model.get("decisions", {}).get("primary") == "common.done" and gate.auto_step._secondary.visible
		and gate.auto_step._secondary.text == String(PKeyUiView.catalog().format("signin.linkOffer.join")))
	t.check("link kit: the account stays signed in under the conflict", bed.sdk.core.tokens.current() == TOKEN_NEW)
	gate._on_auto_primary("link-conflict")
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: Done leaves the conflict", gate._auto_state == "" and not gate.auto_step.visible)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()

	# No thanks declines: the hash is kept and the next offer for the account is unavailable with no request.
	bed = await _bed()
	_fake_google(bed)
	gate = _stage_gate(bed)
	await _offer_step(bed, gate)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	gate._on_auto_secondary("link-offer")
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: No thanks declines for this account on this device", link.store.hashes().size() == 1 and not link.pending and gate._auto_state == "")
	var before := bed.link_requests.size()
	var again := await link.offer()
	t.check("link kit: …and a declined account is offered nothing, with no request", again.kind == PKeyLinkResult.KIND_UNAVAILABLE and bed.link_requests.size() == before)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()

	# Escape closes the offer without remembering a decline.
	bed = await _bed()
	_fake_google(bed)
	gate = _stage_gate(bed)
	await _offer_step(bed, gate)
	t.check("link kit: Escape on the offer is handled", gate._cancel())
	await B.until(func(): return not gate.auto_step.visible)
	t.check("link kit: …it is no decline", bed.sdk.identity.link.store.hashes() == [] and not bed.sdk.identity.link.pending)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()


func _no_offer(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# Nothing this device can accept (no provider, no handle): no step, the gate goes on as before.
	var bed := await _bed()
	var gate := _stage_gate(bed)
	gate.activation._on_sign_in()
	var dialog: PKeySignInDialog = gate.activation.sign_in_dialog
	await B.until(func(): return dialog.state == "redirect")
	var done := []
	dialog.finished.connect(func(r): done.append(r))
	_return_to(bed, dialog)
	await B.until(func(): return done.size() == 1)
	await B.until(func(): return not bed.sdk.identity.link.pending, 120)
	t.check("link kit: with nothing to link here the offer is closed and no step shows", not gate.auto_step.visible and gate._auto_state == "" and not gate._link_hold
		and not bed.sdk.identity.link.pending)
	gate.queue_free()
	await tree.process_frame
	bed.free_all()

	# A device-code sign-in never asks.
	bed = await _bed(false)
	_fake_google(bed)
	bed.starts = [B.started()]
	bed.polls = [B.state("ready", {"token": B.TOKEN, "schemaVersion": 1})]
	gate = _stage_gate(bed)
	gate.activation._on_sign_in()
	await B.until(func(): return gate.activation.sign_in_dialog.state == "ended", 900)
	await tree.process_frame
	t.check("link kit: a device-code sign-in shows no link offer and sends no link request", not gate.auto_step.visible and bed.link_requests.is_empty())
	gate.queue_free()
	await tree.process_frame
	bed.free_all()
