extends RefCounted
# @pkey-feature identity.link
# `identity.link` (I-48.13): when the offer opens, the bearer rule on the redirect token request, the
# link proof, the handle's life, the typed refusals, the decline record and what never prints. The recorded
# conversations (link-offer, link-errors, link-game) are the transcripts suite's.

const B := preload("res://tests/identity/support.gd")

const REDIRECT := "https://app.example/auth/callback"
const HANDLE := "lh_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const NONCE := "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"
const PLATFORM_TOKEN := "platform.id.token.SECRET"
const TOKEN_NEW := "pkeyt_LINKEDLINKEDLINKEDLINKEDLINKEDLINKED0"
const SUBJECT := "ps_abc"
const TOKEN_OK := {
	"access_token": TOKEN_NEW, "token_type": "Bearer", "scope": "profile email", "schemaVersion": 1,
	"device": {"id": "D"}, "license": {"id": "lic_1"}, "subject": SUBJECT,
}
const OFFER := {"offer": [{"kind": "google", "reach": null}, {"kind": "apple", "reach": null}, {"kind": "bogus", "reach": "global"}]}


func run(t: PKeyTestContext) -> void:
	await _closed_until_a_sign_in_this_device_started(t)
	await _bearer_on_the_redirect_token_request(t)
	await _no_subject_opens_nothing(t)
	await _offer(t)
	await _accept_with_the_held_handle(t)
	await _stale_step_up_keeps_the_handle(t)
	await _provider_path(t)
	await _conflict_is_remembered(t)
	await _decline_record(t)
	await _decline_without_an_offer(t)
	await _closing(t)
	await _nothing_prints(t)
	await _sealed_record(t)


func _keys() -> PKeyDeviceKeyStore:
	return PKeyDeviceKeyStore.for_tests("djdl", "user://pkey_test_link_%d" % Time.get_ticks_usec())


## A started SDK with the redirect, exchange, nonce and link routes in its discovery.
func _bed(token := "") -> B:
	var bed := B.new()
	bed.device_keys = _keys()
	var sdk := await bed.make_sdk(token)
	sdk.identity.redirect_acquisition_sync = false
	sdk.identity.link.store = PKeyLinkDeclinedStore.for_tests("djdl", "user://pkey_test_link_rec_%d" % Time.get_ticks_usec(), true)
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {
		"enabled": true, "configured": true, "issuer": root,
		"exchange": {"kinds": ["google", "apple"], "google": {"serverClientId": "g.apps"}},
		"endpoints": {"authorize": root + "/authorize", "token": root + "/token", "nonce": root + "/nonce", "link": root + "/link"},
	}}}
	bed.tokens = [B.json(200, TOKEN_OK)]
	return bed


## A redirect sign-in the person started here, completed.
func _sign_in(bed: B) -> PKeySignInOutcome:
	var s: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT})
	var q := s.authorize_url.substr(s.authorize_url.find("?") + 1)
	var state := ""
	for part in q.split("&"):
		if part.begins_with("state="):
			state = part.substr(6)
	var cb := "%s?code=C0DE&state=%s&iss=%s" % [REDIRECT, state, ("%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]).uri_encode()]
	return await s.complete(cb)


func _link_count(bed: B) -> int:
	return bed.link_requests.size()


func _closed_until_a_sign_in_this_device_started(t: PKeyTestContext) -> void:
	var bed := await _bed(B.TOKEN)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	var o := await link.offer()
	var a := await link.accept(HANDLE)
	t.check("link: no sign-in yet, offer() and accept() are unavailable", o.kind == PKeyLinkResult.KIND_UNAVAILABLE and a.kind == PKeyLinkResult.KIND_UNAVAILABLE and not link.pending)
	t.check("link: nothing is sent while closed", _link_count(bed) == 0)
	# A platform exchange is not a sign-in the person started in the browser.
	bed.nonces = [B.json(200, {"nonce": NONCE, "expiresIn": 300})]
	bed.tokens = [B.json(200, TOKEN_OK)]
	var x: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("link: an exchange sign-in does not open the offer", x.kind == PKeyExchangeResult.KIND_SIGNED_IN and not link.pending)
	var after := await link.offer()
	t.check("link: after an exchange the offer is still unavailable, with no request", after.kind == PKeyLinkResult.KIND_UNAVAILABLE and _link_count(bed) == 0)
	bed.free_all()
	# A device-code sign-in does not open it either.
	bed = await _bed()
	bed.starts = [B.started()]
	bed.polls = [B.state("ready", {"token": B.TOKEN, "schemaVersion": 1})]
	var session: PKeySignInSession = await bed.sdk.identity.sign_in.start({})
	var settled: PKeySignInOutcome = await session.wait()
	t.check("link: a device-code sign-in does not open the offer", not bed.sdk.identity.link.pending, str(settled))
	bed.free_all()


func _bearer_on_the_redirect_token_request(t: PKeyTestContext) -> void:
	# On product, with a token held: the held token is the bearer.
	var bed := await _bed(B.TOKEN)
	var done := await _sign_in(bed)
	var req: Dictionary = bed.token_requests[0] if bed.token_requests.size() == 1 else {"headers": {}}
	t.check("link: the redirect token request carries the held device token to an on-product endpoint",
		done.kind == PKeySignInOutcome.KIND_SIGNED_IN
		and req["headers"].get("authorization", "") == "Bearer " + B.TOKEN, str(done))
	bed.free_all()
	# On product, no token held: no bearer.
	bed = await _bed()
	await _sign_in(bed)
	t.check("link: with no token held the request carries no bearer", bed.token_requests.size() == 1 and not bed.token_requests[0]["headers"].has("authorization"))
	bed.free_all()
	# Off product: the same held token never goes to a token endpoint on another origin.
	bed = await _bed(B.TOKEN)
	var seen: Array = []
	var other := PKeyTestFixtures.new_server(func(r: Dictionary) -> Dictionary:
		seen.append(r["headers"])
		return B.json(200, TOKEN_OK))
	var pending := {
		"authorize_url": "", "state": "tidewater-state-0123456789", "code_verifier": "transcript-verifier-0123456789-abcdefghijklmnopqrst",
		"redirect_uri": REDIRECT, "client_id": "djdl", "issuer": "https://key.plrs.im/djdl/identity",
		"token_endpoint": other.base_url() + "/djdl/identity/token", "license_choice": false,
	}
	var session := PKeySignInSession.new(true)
	session.channel = &"redirect"
	session._identity = bed.sdk.identity
	var off: PKeySignInOutcome = await bed.sdk.identity._redeem(session, pending, "C0DE")
	t.check("link: the request reached the off-product endpoint", seen.size() == 1, str(off))
	t.check("link: an off-product token endpoint gets no bearer", seen.size() == 1 and not seen[0].has("authorization"))
	other.queue_free()
	bed.free_all()
	# Same origin, a token endpoint outside this product: no bearer either.
	bed = await _bed(B.TOKEN)
	var near := {
		"authorize_url": "", "state": "tidewater-state-0123456789", "code_verifier": "transcript-verifier-0123456789-abcdefghijklmnopqrst",
		"redirect_uri": REDIRECT, "client_id": "djdl", "issuer": "https://key.plrs.im/djdl/identity",
		"token_endpoint": "%s/other/identity/token" % bed.server.base_url(), "license_choice": false,
	}
	var near_session := PKeySignInSession.new(true)
	near_session.channel = &"redirect"
	near_session._identity = bed.sdk.identity
	await bed.sdk.identity._redeem(near_session, near, "C0DE")
	t.check("link: a same-origin token endpoint outside the product gets no bearer",
		bed.token_requests.size() == 1 and not bed.token_requests[0]["headers"].has("authorization"), str(bed.token_requests.size()))
	bed.free_all()


func _no_subject_opens_nothing(t: PKeyTestContext) -> void:
	var bed := await _bed(B.TOKEN)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	link._open("")
	t.check("link: a sign-in that named no subject does not open the offer", not link.pending)
	link._choice_pending("sg_x")
	link._choice_completed("sg_x", "")
	t.check("link: nor does a licence choice that named none", not link.pending)
	var none := await link.offer()
	t.check("link: and the offer is unavailable with no request", none.kind == PKeyLinkResult.KIND_UNAVAILABLE and _link_count(bed) == 0)
	bed.free_all()


func _offer(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	t.check("link: a redirect sign-in with a subject opens the offer", link.pending)
	bed.links = [B.json(200, OFFER)]
	var o := await link.offer()
	var req: Dictionary = bed.link_requests[0] if bed.link_requests.size() == 1 else {"headers": {}, "method": ""}
	t.check("link: offer() reads the kinds the account could add, dropping unknown ones",
		o.kind == PKeyLinkResult.KIND_OFFER
		and o.ok
		and o.kinds == [{"kind": "google", "reach": null}, {"kind": "apple", "reach": null}], str(o) + str(o.kinds))
	t.check("link: offer() is a GET with the device token as the bearer", req["method"] == "GET" and req["headers"].get("authorization", "") == "Bearer " + TOKEN_NEW)
	bed.links = [B.json(404, {"error": {"code": "not_found"}})]
	var gone := await link.offer()
	t.check("link: a 404 on the route is unavailable", gone.kind == PKeyLinkResult.KIND_UNAVAILABLE)
	bed.links = [B.json(500, {})]
	var down := await link.offer()
	t.check("link: a 500 is a failure with the server-error code", down.kind == PKeyLinkResult.KIND_FAILED and down.code == PKeyErrors.SERVER_ERROR)
	bed.free_all()
	# A product with no link route has no offer.
	bed = await _bed()
	await _sign_in(bed)
	var m: Dictionary = bed.sdk.core.discovery_manifest
	m["services"]["identity"]["endpoints"].erase("link")
	var none: PKeyLinkResult = await bed.sdk.identity.link.offer()
	t.check("link: no link route, no offer, nothing sent", none.kind == PKeyLinkResult.KIND_UNAVAILABLE and _link_count(bed) == 0)
	bed.free_all()
	# A link route off the product is refused before the token goes anywhere.
	bed = await _bed()
	await _sign_in(bed)
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["link"] = "https://evil.example/djdl/identity/link"
	var off: PKeyLinkResult = await bed.sdk.identity.link.offer()
	t.check("link: an off-product link route is invalid-response and sends nothing", off.kind == PKeyLinkResult.KIND_FAILED and off.code == PKeyErrors.INVALID_RESPONSE and _link_count(bed) == 0)
	bed.free_all()
	# Same origin, a path outside this product: refused the same way, and no bearer goes to it.
	bed = await _bed()
	await _sign_in(bed)
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["link"] = "%s/other/identity/link" % bed.server.base_url()
	var sibling: PKeyLinkResult = await bed.sdk.identity.link.offer()
	t.check("link: a same-origin link route outside the product is invalid-response and sends nothing",
		sibling.kind == PKeyLinkResult.KIND_FAILED and sibling.code == PKeyErrors.INVALID_RESPONSE and _link_count(bed) == 0)
	# A product whose name only starts with this one's is not under it (the trailing slash).
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["link"] = "%s/%sx/identity/link" % [bed.server.base_url(), bed.F["product"]]
	var prefix: PKeyLinkResult = await bed.sdk.identity.link.offer()
	t.check("link: a route under a longer product name is refused", prefix.kind == PKeyLinkResult.KIND_FAILED and _link_count(bed) == 0)
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["link"] = "%s/%s/../other/identity/link" % [bed.server.base_url(), bed.F["product"]]
	var dots: PKeyLinkResult = await bed.sdk.identity.link.offer()
	t.check("link: a route with a dot segment is refused", dots.kind == PKeyLinkResult.KIND_FAILED and _link_count(bed) == 0)
	bed.free_all()


func _accept_with_the_held_handle(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.nonces = [B.json(200, {"nonce": NONCE, "expiresIn": 300})]
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "no_link", "url": "https://key.plrs.im/djdl/identity/authorize", "linkHandle": HANDLE, "expiresIn": 600})]
	var x: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("link: the exchange left a handle", x.kind == PKeyExchangeResult.KIND_NEEDS_SIGN_IN and x.link_handle == HANDLE)
	bed.tokens = [B.json(200, TOKEN_OK)]
	await _sign_in(bed)
	bed.links = [B.json(200, {"linked": {"kind": "google", "reach": "global"}})]
	var link: PKeyIdentityLink = bed.sdk.identity.link
	var r := await link.accept()
	var req: Dictionary = bed.link_requests[0] if bed.link_requests.size() == 1 else {"headers": {}, "method": "", "body": {}}
	t.check("link: accept() with the held handle links, with no provider prompt", r.kind == PKeyLinkResult.KIND_LINKED and r.ok and r.linked_kind == "google" and r.reach == "global", str(r))
	t.check("link: it is a POST with the bearer, the handle and a proof",
		req["method"] == "POST"
		and req["headers"].get("authorization", "") == "Bearer " + TOKEN_NEW
		and req["body"].get("linkHandle") == HANDLE
		and req["body"].has("proof"))
	var keys: PKeyResult = bed.device_keys.public_keys()
	var proof := {"purpose": "link", "product": "djdl", "device_id": bed.F["device_id"], "value": HANDLE, "token_hash": "-", "sign_key": keys.detail["sign_key"], "sig": req["body"].get("proof", "")}
	t.check("link: the proof is pkey-proof/1 purpose link over the handle", PKeyDeviceProof.verify(proof))
	var wrong := proof.duplicate()
	wrong["value"] = HANDLE.replace("BBBB", "CCCC")
	t.check("link: the proof does not cover another handle", not PKeyDeviceProof.verify(wrong))
	t.check("link: linking spends the handle; the offer stays open until dismissed", link._handle == "" and link.pending)
	bed.free_all()


func _stale_step_up_keeps_the_handle(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	bed.links = [B.json(401, {"error": {"code": "step_up_required"}}), B.json(200, {"linked": {"kind": "apple", "reach": "developer"}})]
	var first := await link.accept(HANDLE)
	t.check("link: a stale step-up is refused and typed", first.kind == PKeyLinkResult.KIND_REFUSED and first.code == &"step_up_required" and first.http_status == 401 and not first.ok)
	var second := await link.accept(HANDLE)
	t.check("link: the same handle is sent again after a fresh sign-in",
		second.kind == PKeyLinkResult.KIND_LINKED
		and bed.link_requests.size() == 2
		and bed.link_requests[1]["body"]["linkHandle"] == HANDLE)
	bed.links = [B.json(400, {"error": {"code": "invalid_grant"}})]
	var bad := await link.accept(HANDLE)
	t.check("link: invalid_grant is typed", bad.kind == PKeyLinkResult.KIND_REFUSED and bad.code == &"invalid_grant")
	bed.links = [B.json(404, {"error": {"code": "not_found"}})]
	var lost := await link.accept(HANDLE)
	t.check("link: not_found is typed", lost.kind == PKeyLinkResult.KIND_REFUSED and lost.code == &"not_found")
	var before := bed.link_requests.size()
	var malformed := await link.accept("lh_short")
	t.check("link: a malformed handle is not_found with nothing sent", malformed.kind == PKeyLinkResult.KIND_REFUSED and malformed.code == &"not_found" and bed.link_requests.size() == before)
	bed.free_all()


func _provider_path(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var fake := FakeProvider.new()
	fake.kind = "google"
	fake.token = PLATFORM_TOKEN
	bed.sdk.identity.install_platform_provider(fake)
	bed.nonces = [B.json(200, {"nonce": NONCE, "expiresIn": 300})]
	bed.links = [B.json(200, {"linked": {"kind": "google", "reach": "global"}})]
	var r: PKeyLinkResult = await bed.sdk.identity.link.accept()
	var req: Dictionary = bed.link_requests[0] if bed.link_requests.size() == 1 else {"body": {}}
	var body: Dictionary = req["body"]
	t.check("link: with no handle the provider is asked once over a fresh nonce", r.kind == PKeyLinkResult.KIND_LINKED and fake.asked == [NONCE] and bed.nonce_requests.size() == 1, str(r))
	t.check("link: the body names the token, its type, the nonce, both keys and a proof",
		body.get("subjectToken") == PLATFORM_TOKEN
		and body.get("subjectTokenType") == "urn:ietf:params:oauth:token-type:id_token"
		and body.get("nonce") == NONCE
		and body.has("signKey")
		and body.has("agreeKey"))
	var proof := {
		"purpose": "link", "product": "djdl", "device_id": bed.F["device_id"],
		"value": "%s.%s" % [NONCE, body.get("signKey", "")],
		"token_hash": PKeyB64Url.encode(PLATFORM_TOKEN.sha256_buffer()),
		"sign_key": body.get("signKey", ""), "sig": body.get("proof", ""),
	}
	t.check("link: the proof covers the nonce, the signing key and the token's hash", PKeyDeviceProof.verify(proof))
	bed.free_all()
	# No provider, no handle: unavailable.
	bed = await _bed()
	await _sign_in(bed)
	var none: PKeyLinkResult = await bed.sdk.identity.link.accept()
	t.check("link: no handle and no provider is unavailable", none.kind == PKeyLinkResult.KIND_UNAVAILABLE and _link_count(bed) == 0)
	bed.free_all()


func _conflict_is_remembered(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	bed.links = [B.json(409, {"error": {"code": "link_conflict"}})]
	var r := await link.accept(HANDLE)
	t.check("link: an identity another account holds is link_conflict", r.kind == PKeyLinkResult.KIND_REFUSED and r.code == &"link_conflict" and r.http_status == 409)
	var before := bed.link_requests.size()
	var again := await link.offer()
	t.check("link: the account is not offered again here", again.kind == PKeyLinkResult.KIND_UNAVAILABLE and bed.link_requests.size() == before)
	bed.free_all()


func _decline_record(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	await link.decline()
	var issuer := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	var want := PKeyB64Url.encode((issuer + SUBJECT).sha256_buffer())
	t.check("link: decline() keeps sha256(issuer || sub) and nothing else", link.store.hashes() == [want], str(link.store.hashes()))
	var raw := link.store._mem.get_string_from_utf8()
	t.check("link: the record holds neither the subject nor the issuer", raw == want and not raw.contains(SUBJECT) and not raw.contains("djdl"))
	t.check("link: decline() closes the offer", not link.pending)
	# The same account signs in again: it gets no offer and no request.
	await _sign_in(bed)
	var r := await link.offer()
	t.check("link: a declined account gets unavailable with no request", r.kind == PKeyLinkResult.KIND_UNAVAILABLE and _link_count(bed) == 0)
	# Another account is offered.
	var other := PKeyB64Url.encode((issuer + "ps_other").sha256_buffer())
	t.check("link: another account is not declined", not link.store.is_declined(other))
	bed.free_all()
	# The record outlives the process: a new store over the same files reads it.
	var root := "user://pkey_test_link_persist_%d" % Time.get_ticks_usec()
	var a := PKeyLinkDeclinedStore.for_tests("djdl", root)
	var k := PKeyB64Url.encode("k".sha256_buffer())
	t.check("link: a record is written", a.remember(k).ok and a.persistence() == "durable")
	var b := PKeyLinkDeclinedStore.for_tests("djdl", root)
	t.check("link: a new store reads it", b.is_declined(k) and b.hashes() == [k])
	t.check("link: remember() twice keeps one", b.remember(k).ok and b.hashes() == [k])
	for i in PKeyLinkDeclinedStore.CAP + 5:
		b.remember(PKeyB64Url.encode(("n%d" % i).sha256_buffer()))
	t.check("link: the record is capped, oldest out", b.hashes().size() == PKeyLinkDeclinedStore.CAP and not b.is_declined(k))
	t.check("link: clear() removes it", b.clear().ok and b.hashes() == [])
	# A record that cannot be read declines, closed.
	var broken := PKeyLinkDeclinedStore.for_tests("djdl", root)
	DirAccess.make_dir_recursive_absolute(broken.dir)
	var f := FileAccess.open(broken.dir.path_join(PKeyLinkDeclinedStore.FILE), FileAccess.WRITE)
	f.store_string("not a hash")
	f.close()
	t.check("link: an unreadable record reads as declined", broken.is_declined(k))
	t.check("link: and remember() replaces it", broken.remember(k).ok and broken.hashes() == [k])
	broken.clear()


func _decline_without_an_offer(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.sdk.core.cache.set_subject(SUBJECT)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	await link.decline()
	t.check("link: decline() with no open offer records nothing", link.store.hashes() == [] and link._memory_declined.is_empty())
	await _sign_in(bed)
	bed.links = [B.json(200, OFFER)]
	var o := await link.offer()
	t.check("link: and a later offer for the signed-in account is still made", o.kind == PKeyLinkResult.KIND_OFFER, str(o))
	bed.free_all()


func _closing(t: PKeyTestContext) -> void:
	var bed := await _bed()
	await _sign_in(bed)
	var link: PKeyIdentityLink = bed.sdk.identity.link
	link.dismiss()
	t.check("link: dismiss() closes the offer without a decline", not link.pending and link.store.hashes() == [])
	await _sign_in(bed)
	# Another account signed in on the device closes an offer made for the first.
	bed.sdk.core.cache.set_subject("ps_other")
	var r := await link.offer()
	t.check("link: an offer for another account is closed", r.kind == PKeyLinkResult.KIND_UNAVAILABLE and not link.pending and _link_count(bed) == 0)
	await _sign_in(bed)
	bed.sdk.identity.link._reset()
	t.check("link: a reset forgets the offer and its handle", not link.pending and link._handle == "")
	bed.free_all()


func _nothing_prints(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.nonces = [B.json(200, {"nonce": NONCE, "expiresIn": 300})]
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "no_link", "url": "https://key.plrs.im/djdl/identity/authorize", "linkHandle": HANDLE, "expiresIn": 600})]
	await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	bed.tokens = [B.json(200, TOKEN_OK)]
	await _sign_in(bed)
	bed.links = [B.json(401, {"error": {"code": "step_up_required"}}), B.json(200, OFFER)]
	var link: PKeyIdentityLink = bed.sdk.identity.link
	var refused := await link.accept()
	var offer := await link.offer()
	for r in [refused, offer, PKeyLinkResult.failed(&"x", "m")]:
		var text := "%s %s %s %s" % [r, r.message, r.detail, r.code]
		t.check("link: a result never carries the handle, a token or the proof", not text.contains(HANDLE) and not text.contains(TOKEN_NEW) and not text.contains("proof"), text)
	t.check("link: str(link) shows no handle", not str(link).contains(HANDLE))
	bed.free_all()


func _sealed_record(t: PKeyTestContext) -> void:
	var root := "user://pkey_test_link_seal_%d" % Time.get_ticks_usec()
	var sealer := PKeyFakeSealer.new("keystore")
	var store := PKeyLinkDeclinedStore.new("djdl", root, false, sealer)
	var k := PKeyB64Url.encode("sealed".sha256_buffer())
	t.check("link: with a sealer the record is sealed", store.protection() == "keystore-sealed" and store.remember(k).ok)
	var bytes := FileAccess.get_file_as_bytes(store.dir.path_join(PKeyLinkDeclinedStore.FILE))
	t.check("link: the file is PKSL, a version and a blob, without the hash in the clear",
		bytes.slice(0, 4).get_string_from_ascii() == "PKSL"
		and bytes[4] == 1
		and bytes.get_string_from_ascii().find(k) == -1)
	var again := PKeyLinkDeclinedStore.new("djdl", root, false, sealer)
	t.check("link: a sealed record reads back", again.is_declined(k))
	again.clear()


## A platform sign-in that hands back one fixed token and notes the nonce it was asked with.
class FakeProvider extends PKeyPlatformIdentityProvider:
	var token := ""
	var asked: Array = []

	func provider_row(nonce: String, _audience: String) -> Dictionary:
		asked.append(nonce)
		return {"token": token}
