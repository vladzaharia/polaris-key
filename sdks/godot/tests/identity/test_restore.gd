extends RefCounted
# @pkey-feature identity.restore identity.autosignin
# Silent restore (I-49.15): rung 2 of the ladder over a fake platform backup (the redeem, every refusal, the
# Android/Apple difference on `invalid_grant`), enrolment after a sign-in and the daily check on rung 1, the
# sign-out deletion (and the delete owed to a Worker that cannot be reached), the opt-out, and the secret held
# as bytes that are zeroed in place (typed references taken before the call read all zeros after it). The
# recorded conversations are the transcripts suite's.

const B := preload("res://tests/identity/support.gd")
const X := preload("res://tests/identity/test_exchange.gd")

const ID_OLD := "rk_AAAAAAAAAAAAAAAAAAAAAA"
const SECRET_OLD := "rs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const ID_NEW := "rk_BBBBBBBBBBBBBBBBBBBBBB"
const SECRET_NEW := "rs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


## A platform backup in memory: the same interface, every value handed out remembered so a test can check it was zeroed.
class FakeBackup extends PKeyPlatformBackup:
	var text: Variant = null
	var local_only := false
	var fail := false
	var handed: Array = []
	var log: Array = []

	func _init() -> void:
		apple = null

	func is_available() -> bool:
		return not fail

	func deletes_on_refusal() -> bool:
		return local_only

	func _transport(verb: String, _item: String, _product: String, _subject: String, _ring: String, value: String) -> PKeyResult:
		log.append(verb)
		if fail:
			return PKeyResult.unsupported(FEATURE, PKeyConstants.UnsupportedReason.RUNTIME)
		match verb:
			"get":
				return PKeyResult.success({"value": text})
			"set":
				text = value
			_:
				text = null
		return PKeyResult.success()

	func read_restore(product: String) -> PKeyResult:
		var r: PKeyResult = await super.read_restore(product)
		if r.ok and r.detail["value"] != null:
			handed.append(r.detail["value"])
		return r

	func holds(restore_id: String) -> bool:
		return text is String and (text as String).contains(restore_id)


## The restore object with a view of the fresh keys an enrolment hands out, and a gate that holds one enrolment
## on the wire (a sign-out that begins meanwhile).
class SpyRestore extends PKeyIdentityRestore:
	signal go
	var fresh: Array = []
	var gated := false
	var waiting := false

	func enrol_wire(restore_id: String) -> Dictionary:
		if gated:
			waiting = true
			await go
			waiting = false
			var held := PKeyPlatformBackup.RestoreValue.new(ID_NEW, SECRET_NEW)
			fresh.append(held)
			return {"kind": "enrolled", "value": held}
		var e: Dictionary = await super.enrol_wire(restore_id)
		if e["kind"] == "enrolled":
			fresh.append(e["value"])
		return e


func run(t: PKeyTestContext) -> void:
	await _redeem(t)
	await _refusals(t)
	await _confirm_and_enrol(t)
	await _daily(t)
	await _sign_out(t)
	await _sign_out_races(t)
	await _opt_out_and_gates(t)
	_secret_bytes(t)


func _keys() -> PKeyDeviceKeyStore:
	return PKeyDeviceKeyStore.for_tests("djdl", "user://pkey_test_restore_%d" % Time.get_ticks_usec())


## A started SDK on discovery that offers restore (or not), with a fake backup holding the old item.
func _bed(item := true, offered := true, token := "") -> Array:
	var bed := B.new()
	bed.device_keys = _keys()
	var sdk = await bed.make_sdk(token, PackedStringArray(["license", "config", "identity"]))
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	var frag := {
		"enabled": true, "configured": true, "account": true, "issuer": root,
		"endpoints": {"token": root + "/token", "signout": root + "/signout",
			"choiceComplete": root + "/choice/complete", "choiceLicenses": root + "/choice/licenses",
			"choiceDevices": root + "/choice/devices", "choiceCancel": root + "/choice/cancel"},
	}
	if offered:
		frag["restore"] = true
		frag["endpoints"]["restore"] = root + "/restore"
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": frag}}
	var backup := FakeBackup.new()
	if item:
		backup.text = PKeyPlatformBackup.RestoreValue.new(ID_OLD, SECRET_OLD).encoded()
	var spy := SpyRestore.new(sdk.identity)
	sdk.identity.restore = spy
	spy.backup = backup
	spy.state = PKeyRestoreState.new("djdl", "user://pkey_test_restore_state", true)
	return [bed, backup]


static func _form(text: String) -> Dictionary:
	var out := {}
	for part in text.split("&"):
		out[part.get_slice("=", 0).uri_decode()] = part.get_slice("=", 1).uri_decode()
	return out


func _redeem(t: PKeyTestContext) -> void:
	var made := await _bed()
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	bed.restores = [B.json(201, {"restoreId": ID_NEW, "secret": SECRET_NEW})]
	var r = await bed.sdk.identity.auto_sign_in()
	t.check("restore: rung 2 signs in with the backup's key", r.ok and r.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and r.via == "restore" and r.subject == "ps_abc" \
			and r.license_id == "lic_a", str(r))
	var form := _form(bed.token_requests[0]["body"])
	t.check(
		"restore: the grant carries the key, this device's keys and a proof, and no bearer",
		form["grant_type"] == "urn:polaris-key:grant-type:restore" and form["client_id"] == "djdl" and form["restore_id"] == ID_OLD and form["restore_secret"] == SECRET_OLD \
		and form["device_key"].length() == 43 and form["agree_key"].length() == 43 and form["proof"] != "" and not bed.token_requests[0]["headers"].has("authorization"),
		str(form.keys()))
	t.check("restore: the token is stored as a sign-in", bed.sdk.core.tokens.current() == X.TOKEN_NEW and bed.sdk.core.tokens.origin() == "sign_in" and not bed.sdk.core.cache.explicit_sign_out)
	t.check(
		"restore: the consumed key is replaced: enrol with the held id, the new key written",
		bed.restore_requests.size() == 1 and bed.restore_requests[0]["method"] == "POST" and bed.restore_requests[0]["body"] == {"restoreId": ID_OLD} \
		and String(bed.restore_requests[0]["headers"].get("authorization", "")).begins_with("Bearer ") and backup.holds(ID_NEW) and not backup.holds(ID_OLD))
	t.check("restore: the result never shows the key or the token", not (str(r) + r.message).contains(SECRET_OLD) and not str(r).contains(X.TOKEN_NEW))
	# The secret is zeroed in place, not copied: every value the backup handed out reads all zeros now.
	var zeroed := not backup.handed.is_empty()
	for v: PKeyPlatformBackup.RestoreValue in backup.handed:
		var held: PackedByteArray = v.secret_bytes()
		zeroed = zeroed and held.size() > 0 and held.count(0) == held.size() and v.is_wiped()
	t.check("restore: every secret the ladder read is zeroed in place when it is done (typed reference)", zeroed)
	t.check("restore: the key the enrolment was handed is zeroed once written", _all_wiped((bed.sdk.identity.restore as SpyRestore).fresh) and backup.holds(ID_NEW))
	bed.free_all()


func _refusals(t: PKeyTestContext) -> void:
	for case in [
		["invalid_grant", B.json(400, {"error": "invalid_grant"}), false, true],
		["invalid_grant on Android deletes the local item", B.json(400, {"error": "invalid_grant"}), true, false],
		["a 429 leaves it", B.json(429, {"error": "rate_limited", "retryAfter": 86400}), true, true],
		["a 503 leaves it", B.json(503, {"error": "unavailable"}), true, true],
		["the grant gone from the Worker leaves it", B.json(400, {"error": "unsupported_grant_type"}), true, true],
	]:
		var made := await _bed()
		var bed: B = made[0]
		var backup: FakeBackup = made[1]
		backup.local_only = case[2]
		bed.tokens = [case[1]]
		var r = await bed.sdk.identity.auto_sign_in()
		t.check("restore: %s: the ladder goes on (rung 3 has nothing here)" % case[0], r.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and r.reason == "no_credential" \
				and bed.sdk.core.tokens.current() == "", str(r))
		t.check("restore: %s: item %s" % [case[0], "kept" if case[3] else "deleted"], backup.holds(ID_OLD) == case[3])
		t.check("restore: %s: nothing enrolled" % case[0], bed.restore_requests.is_empty())
		var zeroed := true
		for v: PKeyPlatformBackup.RestoreValue in backup.handed:
			zeroed = zeroed and v.is_wiped()
		t.check("restore: %s: the secret is zeroed all the same" % case[0], zeroed and not backup.handed.is_empty())
		bed.free_all()
	# An unavailable store and malformed items are no rung 2.
	var made3 := await _bed()
	(made3[1] as FakeBackup).fail = true
	var none = await made3[0].sdk.identity.auto_sign_in()
	t.check("restore: an unavailable backup is skipped", none.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and made3[0].token_requests.is_empty())
	made3[0].free_all()
	var made4 := await _bed()
	(made4[1] as FakeBackup).text = PKeyPlatformBackup.RestoreValue.new("rk_short", SECRET_OLD).encoded()
	var bad = await made4[0].sdk.identity.auto_sign_in()
	t.check("restore: an item of the wrong shape is never sent", bad.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and made4[0].token_requests.is_empty())
	t.check("restore: …and the item read is zeroed", not (made4[1] as FakeBackup).handed.is_empty() and _all_wiped((made4[1] as FakeBackup).handed))
	made4[0].free_all()


func _confirm_and_enrol(t: PKeyTestContext) -> void:
	var made := await _bed()
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	bed.tokens = [B.json(200, {"status": "confirm", "grant": X.GRANT, "expiresIn": 300, "consent": {
		"client": {"appName": "djdl", "developerName": null, "iconUrl": null, "nameVerified": false},
		"as": {"provider": null, "email": null}, "items": [{"claim": "email"}], "scopeHash": "h", "firstTime": true, "changed": false}})]
	bed.choice_answers["complete"] = B.json(200, X.TOKEN_OK)
	bed.restores = [B.json(201, {"restoreId": ID_NEW, "secret": SECRET_NEW})]
	var r = await bed.sdk.identity.auto_sign_in()
	t.check("restore: a changed consent is the exchange's confirm, with no token yet", r.kind == PKeyAutoSignInResult.KIND_CONFIRM and r.pending["grant"] == X.GRANT \
			and bed.sdk.core.tokens.current() == "" and bed.restore_requests.is_empty(), str(r))
	var done: PKeyChoiceResult = await bed.sdk.identity.choice.complete(X.GRANT, null, {"claims": ["profile", "email"]})
	t.check("restore: enrolment follows choice.complete", done.ok and bed.restore_requests.size() == 1 and backup.holds(ID_NEW), str(done))
	bed.free_all()


func _daily(t: PKeyTestContext) -> void:
	var made := await _bed(false, true, B.TOKEN)
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	await bed.sdk.sync()
	bed.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed.restores = [B.json(201, {"restoreId": ID_OLD, "secret": SECRET_OLD})]
	var r = await bed.sdk.identity.auto_sign_in()
	t.check("restore: rung 1 with no item enrols one (empty body) and writes it", r.via == "stored" and bed.restore_requests.size() == 1 and bed.restore_requests[0]["body"] == {} \
			and backup.holds(ID_OLD))
	await bed.sdk.identity.auto_sign_in()
	t.check("restore: a second launch within 24 hours sends nothing", bed.restore_requests.size() == 1)
	bed.clock[0] += 86401.0
	bed.restores = [B.json(200, {"status": "current"})]
	await bed.sdk.identity.auto_sign_in()
	t.check("restore: after 24 hours the check names the held key and a current answer keeps the item", bed.restore_requests.size() == 2 \
			and bed.restore_requests[1]["body"] == {"restoreId": ID_OLD} and backup.holds(ID_OLD))
	bed.clock[0] += 86401.0
	bed.restores = [B.json(403, {"error": {"code": "account_required"}})]
	await bed.sdk.identity.auto_sign_in()
	t.check("restore: a refused check changes nothing", bed.restore_requests.size() == 3 and backup.holds(ID_OLD))
	bed.free_all()


func _sign_out(t: PKeyTestContext) -> void:
	var made := await _bed(true, true, B.TOKEN)
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	await bed.sdk.sync()
	bed.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed.restores = [B.json(204, "")]
	bed.signouts = [B.json(200, {"released": true})]
	var order := []
	bed.server.requests.clear()
	var out: PKeyResult = await bed.sdk.identity.sign_out()
	for q in bed.server.requests:
		if String(q["path"]).ends_with("/identity/restore") or String(q["path"]).ends_with("/identity/signout"):
			order.append("%s %s" % [q["method"], String(q["path"]).get_file()])
	t.check("restore: sign-out revokes the key first, while the bearer exists, then signs out", out.ok and order == ["DELETE restore", "POST signout"], str(order))
	t.check("restore: sign-out deletes the item and raises the flag", not backup.holds(ID_OLD) and backup.text == null and bed.sdk.core.cache.explicit_sign_out)
	var after = await bed.sdk.identity.auto_sign_in()
	t.check("restore: after sign-out no rung 2 runs and nothing is enrolled", after.reason == "signed_out" and bed.token_requests.is_empty() and bed.restore_requests.size() == 1)
	bed.free_all()
	# The Worker cannot settle the revocation: it is owed, and goes first at the next launch.
	var m2 := await _bed(true, true, B.TOKEN)
	var bed2: B = m2[0]
	await bed2.sdk.sync()
	bed2.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed2.restores = [B.json(503, {"error": "unavailable"})]
	await bed2.sdk.identity.restore.sign_out_prelude()
	t.check("restore: a revocation the Worker could not settle is owed", bed2.sdk.identity.restore.state.pending_delete() and bed2.restore_requests.size() == 1)
	bed2.restores = [B.json(204, "")]
	(m2[1] as FakeBackup).text = null
	await bed2.sdk.identity.auto_sign_in()
	t.check("restore: the owed delete is sent before any other call and cleared", not bed2.sdk.identity.restore.state.pending_delete() and bed2.restore_requests.size() >= 2 \
			and bed2.restore_requests[1]["method"] == "DELETE")
	bed2.free_all()
	# The Worker's own sign-out deletes the key in the same request: nothing is owed after it.
	var m4 := await _bed(true, true, B.TOKEN)
	var bed4: B = m4[0]
	await bed4.sdk.sync()
	bed4.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed4.restores = [B.json(503, {"error": "unavailable"})]
	bed4.signouts = [B.json(200, {"released": false})]
	await bed4.sdk.identity.sign_out()
	t.check("restore: an accepted sign-out clears the owed delete", not bed4.sdk.identity.restore.state.pending_delete() and bed4.sdk.core.cache.explicit_sign_out)
	bed4.free_all()
	# No item on this device (a sibling deleted it): this device's key may still live, so sign-out still revokes.
	var m3 := await _bed(false, true, B.TOKEN)
	var bed3: B = m3[0]
	await bed3.sdk.sync()
	bed3.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed3.restores = [B.json(204, "")]
	bed3.signouts = [B.json(200, {"released": true})]
	await bed3.sdk.identity.sign_out()
	t.check("restore: no item, sign-out still sends DELETE", bed3.restore_requests.size() == 1 and bed3.restore_requests[0]["method"] == "DELETE")
	bed3.free_all()
	# The Worker refuses the sign-out: the item is already gone, the delete is owed, the check clock is clear.
	var m5 := await _bed(true, true, B.TOKEN)
	var bed5: B = m5[0]
	await bed5.sdk.sync()
	bed5.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed5.sdk.identity.restore.state.stamp(1000)
	bed5.restores = [B.json(503, {"error": "unavailable"})]
	bed5.signouts = [B.json(503, {"error": "unavailable"})]
	await bed5.sdk.identity.sign_out()
	t.check("restore: the item is deleted before the Worker answers, whatever it answers", (m5[1] as FakeBackup).text == null and bed5.sdk.identity.restore.state.checked_at() == 0 \
			and bed5.sdk.identity.restore.state.pending_delete())
	bed5.free_all()
	# after_sign_out on an item still there (a sign-out with no session): dropped, owed, and the read is zeroed.
	var m6 := await _bed(true, true, B.TOKEN)
	var bed6: B = m6[0]
	await bed6.sdk.identity.restore.after_sign_out(false)
	t.check("restore: after_sign_out drops a held item, owes its delete and zeroes the read", (m6[1] as FakeBackup).text == null and bed6.sdk.identity.restore.state.pending_delete() \
			and not (m6[1] as FakeBackup).handed.is_empty() and _all_wiped((m6[1] as FakeBackup).handed))
	bed6.free_all()


## A sign-out that begins while an enrolment is on the wire: the enrolment must not write the item back.
func _sign_out_races(t: PKeyTestContext) -> void:
	var made := await _bed(true, true, B.TOKEN)
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	await bed.sdk.sync()
	bed.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	var spy: SpyRestore = bed.sdk.identity.restore
	spy.gated = true
	bed.restores = [B.json(204, "")]
	bed.signouts = [B.json(200, {"released": true})]
	spy.enrol(true)
	t.check("restore: (race) the enrolment is on the wire", spy.waiting)
	var holder := {}
	_sign_out_into(bed, holder)
	spy.go.emit()
	while not holder.has("res"):
		await (Engine.get_main_loop() as SceneTree).process_frame
	var res: PKeyResult = holder["res"]
	await spy.await_idle()
	# The log is the interim state: a write at any point (after_sign_out would hide it) means the guard failed.
	t.check("restore: an enrolment in flight cannot write the item back after sign-out", res.ok and backup.text == null and spy.state.checked_at() == 0 and _all_wiped(spy.fresh) \
			and not spy.fresh.is_empty() and not backup.log.has("set"), str(backup.log))
	bed.free_all()


## Run a sign-out as its own coroutine so the caller can release the gated enrolment meanwhile.
func _sign_out_into(bed: B, holder: Dictionary) -> void:
	holder["res"] = await bed.sdk.identity.sign_out()


static func _all_wiped(values: Array) -> bool:
	for v: PKeyPlatformBackup.RestoreValue in values:
		if not v.is_wiped():
			return false
	return true


func _opt_out_and_gates(t: PKeyTestContext) -> void:
	var made := await _bed(true, true, B.TOKEN)
	var bed: B = made[0]
	var backup: FakeBackup = made[1]
	await bed.sdk.sync()
	bed.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bed.restores = [B.json(204, "")]
	var r = await bed.sdk.identity.auto_sign_in({"restore": false})
	t.check("restore: restore=false revokes the key, drops the item and enrols nothing", r.via == "stored" and bed.restore_requests.size() == 1 \
			and bed.restore_requests[0]["method"] == "DELETE" and backup.text == null)
	t.check("restore: …and the item it read is zeroed", not backup.handed.is_empty() and _all_wiped(backup.handed))
	bed.free_all()
	# No item but a check on record (a sibling deleted the item): the key still lives, so it is revoked.
	var mc := await _bed(false, true, B.TOKEN)
	var bedc: B = mc[0]
	await bedc.sdk.sync()
	bedc.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	bedc.sdk.identity.restore.state.stamp(1000)
	bedc.restores = [B.json(204, "")]
	await bedc.sdk.identity.auto_sign_in({"restore": false})
	t.check("restore: restore=false with no item but a check on record still revokes", bedc.restore_requests.size() == 1 and bedc.restore_requests[0]["method"] == "DELETE" \
			and bedc.sdk.identity.restore.state.checked_at() == 0)
	bedc.free_all()
	var mn := await _bed(false, true, B.TOKEN)
	var bedn: B = mn[0]
	await bedn.sdk.sync()
	bedn.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	await bedn.sdk.identity.auto_sign_in({"restore": false})
	t.check("restore: restore=false with neither item nor check sends nothing", bedn.restore_requests.is_empty())
	bedn.free_all()
	# Discovery without the member: nothing is sent, rung 3 is next.
	var m2 := await _bed(true, false)
	var bed2: B = m2[0]
	var none = await bed2.sdk.identity.auto_sign_in()
	t.check("restore: discovery without the member sends nothing", none.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and bed2.token_requests.is_empty() and (m2[1] as FakeBackup).holds(ID_OLD))
	t.check("restore: …and the item it read is zeroed", not (m2[1] as FakeBackup).handed.is_empty() and _all_wiped((m2[1] as FakeBackup).handed))
	bed2.free_all()
	# The sign-out flag stops rung 2 for an automatic run.
	var m3 := await _bed()
	var bed3: B = m3[0]
	bed3.sdk.core.cache.set_explicit_sign_out(true)
	var quiet = await bed3.sdk.identity.auto_sign_in()
	t.check("restore: the sign-out flag keeps rung 2 quiet", quiet.reason == "signed_out" and bed3.token_requests.is_empty())
	bed3.free_all()


func _secret_bytes(t: PKeyTestContext) -> void:
	var v := PKeyPlatformBackup.RestoreValue.decode(PKeyPlatformBackup.RestoreValue.new(ID_OLD, SECRET_OLD).encoded())
	var held: PackedByteArray = v.secret_bytes()
	t.check("restore: the value holds the secret as bytes, not printed", v != null and held.get_string_from_utf8() == SECRET_OLD and not str(v).contains(SECRET_OLD))
	v.wipe()
	t.check("restore: wipe zeroes the buffer taken before it, in place", held.count(0) == held.size() and held.size() == SECRET_OLD.length() and v.is_wiped())
