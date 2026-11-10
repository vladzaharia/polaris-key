class_name PKeyIdentityRestore
extends RefCounted
## Silent restore, rung 2 of the automatic sign-in ladder (WIRE-CONTRACT-V5 12.11.8, I-49.15). The port of
## Swift `Restore.swift`. A device that was signed in keeps a restore key in an end-to-end platform backup
## (iCloud Keychain on Apple, Block Store on Android: PKeyPlatformBackup). A new device of the same person
## redeems it, once, and is signed in with no click.
##
##   rung 2   read the item; the `restore` grant with proof value `<restore_id>.<device_key>` and the
##            SHA-256 of the secret on line 6; `200` is a sign-in, `confirm` and `choose` are the
##            exchange's results and enrolment follows `choice.complete`
##   enrol    after any completed sign-in, from any rung, and on rung 1 at most once every 24 hours:
##            `POST restore {restoreId of the item}`; the item is written only on a `201`
##   sign-out `DELETE restore` (queued for the next launch when the Worker cannot be reached), the item,
##            and the explicit-sign-out flag (the cache record, outside every backup): while the flag is
##            set rung 2 does not run and nothing is enrolled
##
## Rules this file keeps:
##  - A refusal leaves the item alone on Apple (a synchronizable delete reaches every device and a newer
##    write may be on its way); on Android `invalid_grant` deletes the local item. `429`, `5xx`, a network
##    failure and an unavailable store leave it too, and the ladder goes on to rung 3.
##  - A key that was consumed and then refused (`terms`, `device_limit`, `not_entitled`) falls to rung 3;
##    the next enrolment replaces the dead key.
##  - The secret is held as bytes (PKeyPlatformBackup.RestoreValue) and zeroed in place when the redeem is
##    over, whatever its outcome; the request body buffer is zeroed too. Nothing logs it; the result and
##    the value redact it. (The one String copy of the item is the plugin boundary's.)
##  - Revocation (`DELETE`) is never gated: discovery leaves `restore` out while the feature is off, and the
##    route still answers `204`.
##
## Not instantiated by a game: PKeyIdentity owns one (`identity.restore`).

## Emitted when the last enrolment or check in flight finishes.
signal idle_reached

const GRANT_TYPE := "urn:polaris-key:grant-type:restore"
## A rung-1 launch checks the key at most this often.
const CHECK_SECONDS := 86400
## The longest `retryAfter` a refusal reports (a day's limit lapses at midnight; a week is the ceiling).
const MAX_RETRY_SECONDS := 604800

static var _id_re: RegEx
static var _secret_re: RegEx

## Use exactly this backup store (tests, hosts with a store of their own). Null: the platform's.
var backup: PKeyPlatformBackup = null
## Where the check clock and the owed delete live. Null: memory only.
var state: PKeyRestoreState = null
## `auto_sign_in(opts.restore)`: false skips rung 2, never enrols, and revokes what is enrolled.
var enabled := true
## `auto_sign_in(opts.backup_access_group)`: the Keychain access group of the item (Apple), "" for the app's own.
var access_group := ""

var _identity_ref: WeakRef = null
var _lazy: PKeyPlatformBackup = null
var _fallback_state: PKeyRestoreState = null
## Enrolments and checks in flight; sign-out waits for them (an enrolment finishing after the item was
## deleted would write it back).
var _busy := 0


static func _static_init() -> void:
	_id_re = RegEx.create_from_string("\\Ark_[A-Za-z0-9_-]{22}\\z")
	_secret_re = RegEx.create_from_string("\\Ars_[A-Za-z0-9_-]{43}\\z")


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


func _core() -> PKeyCore:
	var identity := _identity()
	return identity._core() if identity != null else null


static func id_ok(s: String) -> bool:
	return _id_re.search(s) != null


static func secret_ok(s: String) -> bool:
	return _secret_re.search(s) != null


## True for a version-1 item whose id and secret have the wire shapes.
static func item_ok(v: PKeyPlatformBackup.RestoreValue) -> bool:
	return v != null and id_ok(v.restore_id) and secret_ok(v.secret_bytes().get_string_from_utf8())


## Read the ladder's options: `restore` (default true) and `backup_access_group`.
func configure(opts: Dictionary) -> void:
	enabled = opts.get("restore", true) != false
	access_group = String(opts.get("backup_access_group", "")) if opts.get("backup_access_group") is String else ""


## The platform backup store, or null where none can answer (desktop, web, a direct Android build).
func store() -> PKeyPlatformBackup:
	if backup != null:
		return backup
	if not (OS.has_feature("ios") or OS.has_feature("macos") or OS.has_feature("android")):
		return null
	if _lazy == null or _lazy.access_group != access_group:
		_lazy = PKeyPlatformBackup.new(null, access_group, PKeyAndroid.shared() if OS.has_feature("android") else null)
	return _lazy if _lazy.is_available() else null


func _state() -> PKeyRestoreState:
	if state != null:
		return state
	if _fallback_state == null:
		_fallback_state = PKeyRestoreState.new(_core().product, "user://pkey", true)
	return _fallback_state


func _explicit_sign_out() -> bool:
	return _core().cache.explicit_sign_out


# ── Discovery ────────────────────────────────────────────────────────────────────────────

## Discovery names the restore member and its endpoint. A coroutine. With `load` it fetches discovery when
## none is loaded; without, only a loaded document counts, so an enrolment after a sign-in never causes a
## discovery request of its own.
func available(load := true) -> bool:
	var core := _core()
	if core == null or not core.started:
		return false
	if core.discovery_manifest == null:
		if not load:
			return false
		await core.discover()
	if not core.enabled("identity"):
		return false
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	return fragment.get("restore") == true


## The restore endpoint on this product. A revocation also works with no `restore` member (discovery leaves
## it out while the feature is off, but `DELETE` is answered whatever the gates say): it is then the token
## endpoint's sibling.
func _restore_url(derive: bool) -> String:
	var core := _core()
	var identity := _identity()
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var url: String = fragment.get("restore_endpoint", "")
	if url != "" and identity._own(url) and (fragment.get("restore") == true or derive):
		return url
	var token: String = fragment.get("token", "")
	if derive and token != "" and token.ends_with("/token") and identity._own(token):
		return token.substr(0, token.length() - "token".length()) + "restore"
	return ""


# ── Rung 2 ───────────────────────────────────────────────────────────────────────────────

## The ladder's rung 2: a PKeyAutoSignInResult, or null to go on to rung 3. A coroutine.
func rung(generation: int) -> Variant:
	var item: PKeyPlatformBackup.RestoreValue = await _rung_item()
	if item == null:
		return null
	var x := await redeem(item, {"ladder_generation": generation})
	return await _rung_answer(x)


## The item rung 2 redeems, or null when there is none to try (no store, opted out, signed out, unreadable,
## malformed, or discovery does not offer restore). A coroutine.
func _rung_item() -> PKeyPlatformBackup.RestoreValue:
	var s := store()
	if s == null or not enabled or _explicit_sign_out():
		return null
	var item: PKeyPlatformBackup.RestoreValue = await _read_item(s)
	if item != null and (not item_ok(item) or not await available(true)):
		item.wipe()
		return null
	return item


func _rung_answer(x: PKeyExchangeResult) -> Variant:
	var ladder := _identity().ladder
	match x.kind:
		PKeyExchangeResult.KIND_SIGNED_IN:
			await after_sign_in()
			return await ladder._with_sync_key(PKeyAutoSignInResult.signed_in("restore", x.subject, x.license_id))
		PKeyExchangeResult.KIND_CONFIRM:
			ladder._hold_restore(x.grant)
			return PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CONFIRM, {
				"grant": x.grant, "expires_in": x.expires_in, "expires_at": x.expires_at, "consent": x.consent})
		PKeyExchangeResult.KIND_CHOOSE:
			ladder._hold_restore(x.grant)
			return PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CHOOSE, {
				"grant": x.grant, "expires_in": x.expires_in, "expires_at": x.expires_at, "view": x.view})
		PKeyExchangeResult.KIND_NEEDS_SIGN_IN:
			if x.reason == PKeyAutoSignInResult.REASON_SIGNED_OUT:
				return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_SIGNED_OUT)
		PKeyExchangeResult.KIND_REFUSED:
			# Android's local item goes with a key the Worker does not know; Apple's stays (see the header).
			var s := store()
			if x.code == PKeyConstants.ErrorCode.INVALID_GRANT and s != null and s.deletes_on_refusal():
				await s.delete_restore(_core().product)
	# `429`, a Worker or network failure, `terms`, `device_limit`, ...: the item stays and rung 3 is next.
	return null


## The `restore` grant (V5 12.11.8). `value` is wiped when this returns, whatever the outcome. `opts`:
## ladder_generation (store the token only if no sign-out happened since, and never lower the flag),
## proof_value, product and token_url (conformance only: replace `<restore_id>.<device_key>`, the product the
## key is presented to and its token endpoint). A coroutine answering a
## PKeyExchangeResult (signed_in, confirm, choose, needs_sign_in, unavailable, refused or failed).
func redeem(value: PKeyPlatformBackup.RestoreValue, opts := {}) -> PKeyExchangeResult:
	var out := await _redeem(value, opts)
	value.wipe()
	return out


func _redeem(value: PKeyPlatformBackup.RestoreValue, opts: Dictionary) -> PKeyExchangeResult:
	var ctx: Variant = await _redeem_context(value, opts)
	if ctx is PKeyExchangeResult:
		return ctx
	var identity := _identity()
	var core := _core()
	var proof := PKeyDeviceKeys.sign_device_proof(ctx["port"], {
		"purpose": "restore",
		"product": ctx["product"],
		"device_id": core.device_id,
		"value": opts.get("proof_value", "%s.%s" % [value.restore_id, ctx["sign_key"]]),
		"token_hash": PKeyB64Url.encode(_sha256(value.secret_bytes())),
	})
	if not proof.ok:
		return PKeyExchangeResult.failed(proof.code, proof.message)
	var body := _form(value, ctx["product"], ctx["sign_key"], ctx["agree_key"], proof.detail["sig"], opts)
	var sent: Variant = await identity.exchange._send(ctx["token_url"], PKeyIdentityRedirect.TOKEN_CONTENT_TYPE, body, false, MAX_RETRY_SECONDS)
	body.fill(0)
	if sent is PKeyExchangeResult:
		return sent
	return await identity.exchange._outcome(sent["status"], sent["body"], sent["response"], opts)


static func _guard(core: PKeyCore, value: PKeyPlatformBackup.RestoreValue) -> PKeyExchangeResult:
	if core == null or not core.started:
		return PKeyExchangeResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if not item_ok(value):
		return PKeyExchangeResult.failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "The restore item is malformed.")
	return null


## What a redeem needs before it signs: {token_url, product, port, sign_key, agree_key}, or the
## PKeyExchangeResult that ends the attempt. A coroutine.
func _redeem_context(value: PKeyPlatformBackup.RestoreValue, opts: Dictionary) -> Variant:
	var identity := _identity()
	var core := _core()
	var early := _guard(core, value)
	if early != null:
		return early
	var off := PKeyExchangeResult.unavailable(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "No silent restore for %s." % core.product)
	if not await available(true):
		return off
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var token_url: String = opts.get("token_url", fragment.get("token", ""))
	if token_url == "":
		return off
	if not identity._own(token_url):
		return PKeyExchangeResult.failed(PKeyErrors.INVALID_RESPONSE, "An identity endpoint points outside this product.")
	var port: Object = identity.device_keys
	# Keys that die with the process would bind the device to a key it cannot present again.
	var keys: PKeyResult = port.ensure() if port != null and port.persistence() != "memory" else null
	if keys == null or not keys.ok:
		return off
	return {"token_url": token_url, "product": opts.get("product", core.product), "port": port, "sign_key": keys.detail["sign_key"], "agree_key": keys.detail["agree_key"]}


## The form body as bytes, so the secret goes in from the held buffer and the whole body can be zeroed.
func _form(value: PKeyPlatformBackup.RestoreValue, product: String, sign_key: String, agree_key: String, sig: String, opts: Dictionary) -> PackedByteArray:
	var body := PackedByteArray()
	var head: Array = [["grant_type", GRANT_TYPE], ["client_id", product], ["restore_id", value.restore_id]]
	var tail: Array = [["device_key", sign_key], ["agree_key", agree_key], ["proof", sig]]
	if opts.get("license_choice") in ["app", "card"]:
		tail.append(["license_choice", opts["license_choice"]])
	if opts.get("device_name") is String and opts["device_name"] != "":
		tail.append(["device_name", opts["device_name"]])
	for pair in head:
		body.append_array(("%s=%s&" % [PKeyUri.form(pair[0]), PKeyUri.form(pair[1])]).to_utf8_buffer())
	# The secret is `rs_` and base64url: nothing in it needs form escaping.
	body.append_array("restore_secret=".to_utf8_buffer())
	body.append_array(value.secret_bytes())
	for pair in tail:
		body.append_array(("&%s=%s" % [PKeyUri.form(pair[0]), PKeyUri.form(pair[1])]).to_utf8_buffer())
	return body


static func _sha256(bytes: PackedByteArray) -> PackedByteArray:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(bytes)
	return h.finish()


# ── Enrolment ────────────────────────────────────────────────────────────────────────────

## `POST restore` with the device bearer and `{}` or `{restoreId}`. A coroutine answering
## {kind: "enrolled", value: RestoreValue (the caller wipes it)} | {kind: "current"} | {kind: "unavailable"} |
## {kind: "refused", code, status} | {kind: "failed"}.
func enrol_wire(restore_id: String) -> Dictionary:
	var core := _core()
	if not await available(true) or _restore_url(false) == "":
		return {"kind": "unavailable"}
	var payload := {}
	if restore_id != "":
		payload["restoreId"] = restore_id
	var headers := core.headers({"Authorization": "Bearer %s" % core.tokens.current(), "Content-Type": "application/json"})
	var r := await core.transport.request("POST", _restore_url(false), headers, PKeyJson.stringify(payload).to_utf8_buffer())
	return _enrol_answer(r) if r.ok else {"kind": "failed"}


static func _enrol_answer(r: PKeyResult) -> Dictionary:
	var status: int = r.detail["status"]
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var answer = parsed["value"] if parsed["ok"] else null
	var ok_body: bool = answer is Dictionary
	if status == 404:
		return {"kind": "unavailable"}
	if status == 201 and ok_body and answer.get("restoreId") is String and answer.get("secret") is String and id_ok(answer["restoreId"]) and secret_ok(answer["secret"]):
		return {"kind": "enrolled", "value": PKeyPlatformBackup.RestoreValue.new(answer["restoreId"], answer["secret"])}
	if status == 200 and ok_body and answer.get("status") == "current":
		return {"kind": "current"}
	if status == 200 or status == 201 or status >= 500:
		return {"kind": "failed"}
	var refusal := PKeyIdentityExchange._refusal(status, r, answer, MAX_RETRY_SECONDS)
	return {"kind": "refused", "code": refusal.code, "status": status}


## Enrol or check this device's key and write a new one to the backup. Quiet: nothing here fails a caller.
## `load` lets it fetch discovery when none is loaded. A sign-out that begins while this runs stops the
## write, and waits for this to finish. A coroutine.
func enrol(load: bool) -> void:
	var core := _core()
	if core == null:
		return
	var generation := core.tokens.sign_out_generation
	_busy += 1
	await _enrol(load, generation)
	_busy -= 1
	if _busy == 0:
		idle_reached.emit()


func _enrol(load: bool, generation: int) -> void:
	var s := store()
	var core := _core()
	if s == null or not core.tokens.has_token():
		return
	var held := ""
	var read := await s.read_restore(core.product)
	if not read.ok:
		return
	var item: PKeyPlatformBackup.RestoreValue = read.detail["value"] if read.detail is Dictionary else null
	if item != null:
		held = item.restore_id if id_ok(item.restore_id) else ""
		item.wipe()
	if not await available(load):
		return
	await flush_pending()
	var e := await enrol_wire(held)
	# A sign-out since this began: the item stays deleted and the check clock stays clear.
	var stopped := core.tokens.sign_out_generation != generation or _explicit_sign_out()
	match e["kind"]:
		"enrolled":
			var fresh: PKeyPlatformBackup.RestoreValue = e["value"]
			if stopped:
				fresh.wipe()
				return
			var w := await s.write_restore(core.product, fresh.restore_id, fresh.secret_bytes().get_string_from_utf8())
			fresh.wipe()
			if w.ok and core.tokens.sign_out_generation == generation and not _explicit_sign_out():
				_state().stamp(core.clock.system_now())
		"current":
			if not stopped:
				_state().stamp(core.clock.system_now())


## Wait for the enrolment or check in flight, if any. A coroutine.
func await_idle() -> void:
	while _busy > 0:
		await idle_reached


## After any completed sign-in, from any rung (a person-started one included): enrol.
func after_sign_in() -> void:
	var core := _core()
	if not enabled or core == null or not core.started or store() == null or _explicit_sign_out():
		return
	await enrol(false)


## Rung 1: at most once every 24 hours, check the key and enrol when there is none.
func daily_check() -> void:
	var core := _core()
	if not enabled or store() == null or _explicit_sign_out():
		return
	var now := core.clock.system_now()
	var last := _state().checked_at()
	if last > 0 and last <= now and now - last < CHECK_SECONDS:
		return
	await enrol(true)


# ── Deletion ─────────────────────────────────────────────────────────────────────────────

## `DELETE restore`: true when it is settled (`204`, or an answer no retry would change), false for a `429`,
## a `5xx` or a network failure. It runs whatever the state of Identity and the gates. A coroutine.
func delete_wire() -> bool:
	var core := _core()
	if core.discovery_manifest == null:
		await core.discover()
	if core.discovery_manifest == null:
		return false
	var url := _restore_url(true)
	if url == "":
		return true
	var r := await core.transport.request("DELETE", url, core.headers({"Authorization": "Bearer %s" % core.tokens.current()}), PackedByteArray())
	if not r.ok:
		return false
	var status: int = r.detail["status"]
	return not (status == 429 or status >= 500)


## Send `DELETE restore`; queue it when it cannot be settled (no bearer, no Worker). A coroutine.
func send_delete() -> void:
	var core := _core()
	if not core.tokens.has_token():
		_state().set_pending_delete(true)
		return
	_state().set_pending_delete(not await delete_wire())


## A delete queued by an earlier launch goes first, before any other call. A coroutine.
func flush_pending() -> void:
	if _state().pending_delete() and _core().tokens.has_token():
		await send_delete()


## Sign-out, before the Worker's `signout` (the bearer is still there): the item goes first, the check clock
## clears and the delete is owed, then it is sent; the owed flag stays when the Worker cannot settle it. This
## runs whenever a store exists: the item may be gone (a sibling deleted it) while this device's key lives on.
## Waits for an enrolment in flight so that it cannot write the item back. A coroutine.
func sign_out_prelude() -> void:
	var s := store()
	if s == null:
		return
	await await_idle()
	await s.delete_restore(_core().product)
	_state().clear_checked()
	_state().set_pending_delete(true)
	await send_delete()


## Sign-out, once it is decided: the item goes (every device on the Apple ID loses it; their next daily
## check enrols their own), and so does the check clock. `server_revoked` is true when the Worker's
## `signout` ran, which deleted the key in the same request. A coroutine.
func after_sign_out(server_revoked: bool) -> void:
	await await_idle()
	var s := store()
	var had_item := false
	if s != null:
		var held: PKeyPlatformBackup.RestoreValue = await _read_item(s)
		had_item = held != null
		if held != null:
			held.wipe()
		await s.delete_restore(_core().product)
	_state().clear_checked()
	if server_revoked:
		_state().set_pending_delete(false)
	elif had_item:
		_state().set_pending_delete(true)


## `auto_sign_in(restore: false)`: never enrol, revoke what is enrolled and drop the item. A device whose item
## a sibling deleted still holds a key of its own: its check clock says so. A coroutine.
func opt_out() -> void:
	var s := store()
	if s == null:
		return
	await await_idle()
	var held: PKeyPlatformBackup.RestoreValue = await _read_item(s)
	var had_check := _state().checked_at() != 0
	if held == null and not had_check:
		return
	if held != null:
		held.wipe()
	await send_delete()
	await s.delete_restore(_core().product)
	_state().clear_checked()


## The item, or null when absent, unreadable or the store is unavailable. A coroutine.
func _read_item(s: PKeyPlatformBackup) -> PKeyPlatformBackup.RestoreValue:
	var r := await s.read_restore(_core().product)
	if not r.ok or not (r.detail is Dictionary):
		return null
	return r.detail.get("value")
