extends RefCounted
# @pkey-feature identity.devicecode.choice
# UK-42.22.11: the device start's four members behind discovery's `deviceChoice` gate, and the
# poll's `choose` answer (WIRE-CONTRACT-V5 §12.10.1) against a fake Worker.

const B := preload("res://tests/identity/support.gd")
const GRANT := "sg_zHJxy622rv-G2aVc7AICUGPiDyr1JKWi_odsBXibVlw"
const OPTS := {"login_hint": "ada@example.com", "name_hint": "Ada", "purpose": "attach", "license_choice": "app"}


func run(t: PKeyTestContext) -> void:
	var bed := B.new()
	if not t.check("device_choice: sync fixtures present", not bed.F.is_empty()):
		bed.free_all()
		return
	await _gate(t, bed)
	await _choose(t, bed)
	await _unrequested(t, bed)
	bed.free_all()


static func _discovery(product: String, device_choice: bool, endpoints := true) -> Dictionary:
	var e := {"authorize": "https://x/a", "token": "https://x/t"}
	if endpoints:
		e.merge({"choiceLicenses": "https://x/l", "choiceDevices": "https://x/d", "choiceComplete": "https://x/c", "choiceCancel": "https://x/x"})
	var identity := {"enabled": true, "configured": true, "endpoints": e}
	if device_choice:
		identity["deviceChoice"] = true
	return {"product": product, "services": {"identity": identity}}


func _start_body(bed: B, manifest: Variant, opts: Dictionary) -> Dictionary:
	bed.flow_requests.clear()
	bed.starts = [B.started(2)]
	var sdk = await bed.make_sdk()
	sdk.core.discovery_manifest = manifest
	var session: PKeySignInSession = await sdk.identity.sign_in.start(opts)
	session.cancel()
	var sent: Array = bed.flow_requests.filter(func(r): return String(r["path"]).ends_with("/start"))
	return sent[0]["body"] if session.ok and not sent.is_empty() else {}


static func _bare(body: Dictionary) -> bool:
	var keys := body.keys()
	keys.erase("deviceName")
	return keys == ["deviceId"]


func _gate(t: PKeyTestContext, bed: B) -> void:
	var product: String = bed.F["product"]
	var on: Dictionary = await _start_body(bed, _discovery(product, true), OPTS)
	t.check("gate passes: all four members", on.get("loginHint") == "ada@example.com" and on.get("nameHint") == "Ada" \
			and on.get("purpose") == "attach" and on.get("licenseChoice") == "app", str(on))
	var no_flag: Dictionary = await _start_body(bed, _discovery(product, false), OPTS)
	t.check("no deviceChoice: hints and purpose only", not no_flag.has("licenseChoice") and no_flag.get("purpose") == "attach" and no_flag.get("loginHint") == "ada@example.com", str(no_flag))
	var no_endpoints: Dictionary = await _start_body(bed, _discovery(product, true, false), OPTS)
	t.check("no choice endpoints: no licenseChoice", not no_endpoints.has("licenseChoice"), str(no_endpoints))
	var plain: Dictionary = await _start_body(bed, _discovery(product, true), {})
	t.check("nothing asked: the body is the old one", _bare(plain), str(plain))
	var bad: Dictionary = await _start_body(bed, _discovery(product, true), {"purpose": "bogus", "login_hint": 5})
	t.check("invalid members are dropped", _bare(bad), str(bad))


func _choose(t: PKeyTestContext, bed: B) -> void:
	bed.flow_requests.clear()
	bed.starts = [B.started(2)]
	bed.polls = [B.state("pending"), B.state("choose", {"grant": GRANT, "expiresIn": 300, "choices": {"state": "choose", "choices": [], "keep": true}})]
	var sdk = await bed.make_sdk()
	sdk.core.discovery_manifest = _discovery(bed.F["product"], true)
	var session: PKeySignInSession = await sdk.identity.sign_in.start(OPTS)
	t.check("choose: the session asked for the app's choice", session.ok and session.license_choice)
	var o: PKeySignInOutcome = await session.wait()
	t.check("choose: the poll's choose settles as license_choice", o.kind == PKeySignInOutcome.KIND_LICENSE_CHOICE and o.grant == GRANT \
			and o.expires_in == 300.0 and o.choices.get("keep") == true, str(o.kind))
	t.check("choose: no token stored", not sdk.core.tokens.has_token())


func _unrequested(t: PKeyTestContext, bed: B) -> void:
	bed.flow_requests.clear()
	bed.starts = [B.started(2)]
	bed.polls = [B.state("choose", {"grant": GRANT, "expiresIn": 300, "choices": {"state": "choose"}})]
	var sdk = await bed.make_sdk()
	sdk.core.discovery_manifest = _discovery(bed.F["product"], false)
	var session: PKeySignInSession = await sdk.identity.sign_in.start(OPTS)
	var o: PKeySignInOutcome = await session.wait()
	t.check("unrequested choose is an invalid response", o.kind == PKeySignInOutcome.KIND_ERROR and o.code == PKeyErrors.INVALID_RESPONSE, str(o.kind))
