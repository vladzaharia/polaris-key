class_name PKeyIdentityAutoSignIn
extends RefCounted
## `PolarisKey.identity.auto_sign_in(opts)`: the automatic sign-in ladder (CC-01-auto-sign-in §1, I-48.2).
## The port of Swift `AutoSignIn.swift` and Kotlin `AutoSignIn.kt`.
##
##   rung 1  a stored token the device holds as a sign-in, and a licence: `signed_in`, no network
##   rung 2  silent restore (I-49): skipped here
##   rung 3  each installed platform provider, silently, over a fresh Worker nonce, then `exchange`
##   rung 4  the provider's one account sheet (`prompt = "optional"` only), then `exchange`
##   rung 5+ are the app's: the regular sign-in form is `needs_sign_in` / `unavailable`
##
##   var r := await PolarisKey.identity.auto_sign_in()
##   match r.kind:
##       &"signed_in": ...       # the session is there (r.via, r.sync_key)
##       &"confirm": ...         # show r.pending.consent, then identity.choice.complete(
##                               #   r.pending.grant, null, {claims = [...]})
##       &"choose": ...          # the licence choice (r.pending.view)
##       &"needs_sign_in": ...   # the regular form (r.reason; r.link_handle feeds the link offer)
##       &"device_limit": ...    # every seat is taken (r.view, r.manage_url)
##       &"unavailable": ...     # no exchange here: the regular form
##
## `opts.row` (an exchange kind) is the sign-in form's own button for that platform (Apple's plain
## account sheet, Google's "Sign in with Google"): rungs 1, 3 and 4 are skipped, the provider's
## `provider_row` runs once, and the person's dismissal is `needs_sign_in(cancelled)`. Pass `explicit`
## with it. The kit's sign-in dialog does this on iOS, macOS and Android.
##
## `opts`: prompt ("never", the default, or "optional"), kinds (an Array of exchange kinds to try),
## providers (use these instead of the installed ones), license_choice ("app", the default, or "card"),
## device_name, explicit (true: the person pressed a sign-in button, so the sign-out flag is lowered
## first).
##
## Providers (PKeyPlatformIdentityProvider) come from `identity.install_platform_provider()`. The
## ladder tries the kinds discovery publishes, that a provider is installed for and `opts.kinds` allows,
## games first: gamecenter, pgs, google, apple. At most one account sheet is shown per run.
##
## Sign-out rules:
##  - `sign_out()` bumps the sign-out generation, then (once the Worker accepted it) sets
##    `explicit_sign_out` (the cache record, fails closed) and runs each provider's
##    `sign_out_cleanup()`. While the flag is set rungs 3 and 4 do not run. Only a sign-in the person
##    started (redirect, device code, `choice.complete`, `exchange` called from the sign-in form,
##    `opts.explicit`) lowers it; the ladder's own exchange never does.
##  - The ladder captures the generation when it starts. The check and the token store happen with no
##    await between them (PKeyTokenManager.set_token_unless_signed_out), so a sign-out during the
##    platform prompt or the exchange makes it store nothing and answer `needs_sign_in(signed_out)`.
##  - Rung 1 counts only a token the device holds as a sign-in (`tokenOrigin` is `sign_in`): not a
##    key activation, an enrolment or a registration, and not a device an account sign-out left
##    activated.
##  - A provider that reports its credential revoked at launch (Sign in with Apple, scenario 11)
##    signs the device out through `sign_out()`. If the Worker cannot be reached the flag stays unset
##    and the check repeats at the next launch.
##  - Device keys are the device's identity, not account state: sign-out keeps them.
##
## Nothing here logs, prints or keeps a token, a grant or a link handle beyond the call.
## Not instantiated by a game: PKeyIdentity owns one.

## Games first (Q-2), then the account providers.
const KIND_ORDER := ["gamecenter", "pgs", "google", "apple"]

var _identity_ref: WeakRef = null
## grant -> {provider, info}: a platform session the Worker accepted but the person has not finished
## (confirm, choose). The provider hears of it when `choice.complete` ends it.
var _held: Dictionary = {}


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


## Run the ladder. A refusal is a result; nothing throws. A coroutine.
func run(opts := {}) -> PKeyAutoSignInResult:
	var identity := _identity()
	var core := identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyAutoSignInResult.unavailable(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if opts.get("explicit") == true:
		core.cache.set_explicit_sign_out(false)
	var installed := _installed(identity, opts)
	await check_revoked(installed)
	var generation := core.tokens.sign_out_generation
	if opts.get("row") is String:
		return await _row(core, installed, opts, generation)
	var early = await _quiet_result(core, installed)
	if early != null:
		return early
	var plan := await _plan(core, installed, opts, generation)
	if plan.has("result"):
		return plan["result"]
	return await _rungs_three_and_four(plan["candidates"], plan["ctx"])


## The form's own button for `opts.row`: the provider of that kind, through `provider_row`, once.
func _row(core: PKeyCore, installed: Array, opts: Dictionary, generation: int) -> PKeyAutoSignInResult:
	var only := opts.duplicate()
	only["kinds"] = [opts["row"]]
	var plan := await _plan(core, installed, only, generation)
	if plan.has("result"):
		return plan["result"]
	var ctx: Dictionary = plan["ctx"]
	var step := await _attempt(plan["candidates"][0], "row", ctx)
	if step.get("result") != null:
		return step["result"]
	if step.get("cancelled") == true:
		return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_CANCELLED, "", String(opts["row"]))
	if ctx["failure"] != null:
		return ctx["failure"]
	return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_NO_CREDENTIAL, "", String(opts["row"]))


## Rungs 1 and 2, and the cases with no platform identity: the answer, or null to go on. A coroutine.
func _quiet_result(core: PKeyCore, installed: Array) -> Variant:
	# Rung 1: a token the device holds as a sign-in, with a licence.
	if core.tokens.has_token() and core.tokens.origin() == PKeyTokenManager.ORIGIN_SIGN_IN and core.cache.license != null:
		var doc = core.cache.license["doc"]
		var lic: String = doc["licenseId"] if doc is Dictionary and doc.get("licenseId") is String else ""
		return await _with_sync_key(PKeyAutoSignInResult.signed_in("stored", core.cache.subject, lic))
	# Signed out on purpose: rungs 3 and 4 stay quiet.
	if core.cache.explicit_sign_out:
		return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_SIGNED_OUT)
	# No platform identity here (Linux, Windows, or nothing installed): the regular form is next.
	if installed.is_empty():
		return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_NO_CREDENTIAL)
	return null


## Discovery and the candidate providers: {result} when the ladder ends here, else {ctx, candidates}.
func _plan(core: PKeyCore, installed: Array, opts: Dictionary, generation: int) -> Dictionary:
	if core.discovery_manifest == null:
		await core.discover()
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	if not core.enabled("identity") or fragment.is_empty() or fragment.get("exchange", {}).is_empty():
		return {"result": PKeyAutoSignInResult.unavailable(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "This product publishes no platform sign-in.")}
	var candidates := _candidates(installed, fragment["exchange"]["kinds"], opts.get("kinds"))
	if candidates.is_empty():
		return {"result": PKeyAutoSignInResult.unavailable(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "No installed provider matches the product's platform sign-in.")}
	return {"candidates": candidates, "ctx": {"generation": generation, "fragment": fragment, "opts": opts, "failure": null}}


func _rungs_three_and_four(candidates: Array, ctx: Dictionary) -> PKeyAutoSignInResult:
	var opts: Dictionary = ctx["opts"]
	# Rung 3: silent.
	for p in candidates:
		if not _flag(p, "has_silent"):
			continue
		var step := await _attempt(p, "silent", ctx)
		if step.get("result") != null:
			return step["result"]
	# Rung 4: the one sheet.
	if opts.get("prompt") == "optional":
		for p in candidates:
			if not _flag(p, "has_sheet"):
				continue
			var step := await _attempt(p, "sheet", ctx)
			if step.get("result") != null:
				return step["result"]
			if step.get("shown") == true:
				break  # at most one sheet per run, whether it ended in a token or a dismissal
	if ctx["failure"] != null:
		return ctx["failure"]
	return PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_NO_CREDENTIAL)


## Scenario 11: a provider whose platform says the person revoked this app's credential signs the
## device out (the regular sign-out, with every provider's cleanup). With no session, only the local
## state changes. A Worker that cannot be reached leaves the flag unset, so the next launch checks again.
## `providers`: the ones to ask (default: the installed ones). A coroutine.
func check_revoked(providers := []) -> void:
	var identity := _identity()
	var asked: Array = providers if not providers.is_empty() else identity.platform_providers()
	for p in asked:
		if not p.has_method("credential_revoked"):
			continue
		if bool(await p.credential_revoked()):
			if identity._core().tokens.has_token():
				await identity.sign_out()
			else:
				await identity._mark_signed_out()
			return


## `choice.complete` made a session from `grant`: the provider that signed it in hears of it.
func session_completed(grant: String) -> void:
	var held = _held.get(grant)
	_held.erase(grant)
	if held is Dictionary and held["provider"].has_method("session_started"):
		await held["provider"].session_started(held["info"])


func session_dropped(grant: String) -> void:
	_held.erase(grant)


# ── Rungs 3 and 4 ────────────────────────────────────────────────────────────────────────

## One attempt with one provider. {result: PKeyAutoSignInResult} ends the ladder; {shown: true} says a
## sheet was put up; nothing else means "try the next provider".
func _attempt(p: Object, mode: String, ctx: Dictionary) -> Dictionary:
	var identity := _identity()
	var core := identity._core()
	var kind := String(p.get("kind"))
	var opts: Dictionary = ctx["opts"]
	var nonce := await identity.exchange.nonce(kind)
	if not nonce.ok:
		_note_failure(ctx, PKeyAutoSignInResult.unavailable(nonce.code, nonce.message, kind))
		return {}
	var audience := String(ctx["fragment"]["exchange"].get("%s_server_client_id" % kind, ""))
	var answer: Variant
	if mode == "silent":
		answer = await p.silent(nonce.nonce, audience)
	elif mode == "row":
		answer = await p.provider_row(nonce.nonce, audience) if p.has_method("provider_row") else await p.sheet(nonce.nonce, audience)
	else:
		answer = await p.sheet(nonce.nonce, audience)
	var shown: bool = mode != "silent" and not (answer is Dictionary and answer.has("unavailable"))
	if not (answer is Dictionary) or not (answer.get("token") is String) or answer["token"] == "":
		# cancelled, unavailable or malformed: nothing to exchange
		return {"shown": shown, "cancelled": answer is Dictionary and answer.get("cancelled") == true}
	# A sign-out while the platform was prompting wins.
	if core.tokens.sign_out_generation != ctx["generation"] or core.cache.explicit_sign_out:
		return {"result": PKeyAutoSignInResult.needs_sign_in(PKeyAutoSignInResult.REASON_SIGNED_OUT, "", kind), "shown": shown}
	var info := {"user_id": answer["user_id"]} if answer.get("user_id") is String and answer["user_id"] != "" else {}
	var x_opts := {"license_choice": opts.get("license_choice", "app"), "ladder_generation": ctx["generation"]}
	if opts.get("device_name") is String:
		x_opts["device_name"] = opts["device_name"]
	var r := await identity.exchange.exchange(kind, answer["token"], nonce.nonce, x_opts)
	return await _outcome(r, p, info, ctx, shown)


func _outcome(r: PKeyExchangeResult, p: Object, info: Dictionary, ctx: Dictionary, shown: bool) -> Dictionary:
	var kind := String(p.get("kind"))
	match r.kind:
		PKeyExchangeResult.KIND_SIGNED_IN:
			await _started(p, info)
			var done := PKeyAutoSignInResult.signed_in("platform", r.subject, r.license_id, kind)
			return {"result": await _with_sync_key(done), "shown": shown}
		PKeyExchangeResult.KIND_CONFIRM:
			_hold(r.grant, p, info)
			return {"result": PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CONFIRM, {
				"grant": r.grant, "expires_in": r.expires_in, "expires_at": r.expires_at, "consent": r.consent}, kind), "shown": shown}
		PKeyExchangeResult.KIND_CHOOSE:
			_hold(r.grant, p, info)
			return {"result": PKeyAutoSignInResult.pending_answer(PKeyAutoSignInResult.KIND_CHOOSE, {
				"grant": r.grant, "expires_in": r.expires_in, "expires_at": r.expires_at, "view": r.view}, kind), "shown": shown}
		PKeyExchangeResult.KIND_NEEDS_SIGN_IN:
			var reason := r.reason if r.reason in ["terms", "signed_out"] else PKeyAutoSignInResult.REASON_NO_LINK
			return {"result": PKeyAutoSignInResult.needs_sign_in(reason, r.link_handle, kind), "shown": shown}
		PKeyExchangeResult.KIND_REFUSED:
			if r.code == PKeyConstants.ErrorCode.DEVICE_LIMIT:
				return {"result": PKeyAutoSignInResult.device_limit(r.view, r.manage_url, kind), "shown": shown}
			# An older Worker does not know the grant: this provider failed, the form still works.
			if r.code != &"unsupported_grant_type":
				_note_failure(ctx, PKeyAutoSignInResult.unavailable(r.code, r.message, kind))
		_:
			_note_failure(ctx, PKeyAutoSignInResult.unavailable(r.code, r.message, kind))
	return {"shown": shown}


func _note_failure(ctx: Dictionary, failure: PKeyAutoSignInResult) -> void:
	if ctx["failure"] == null:
		ctx["failure"] = failure


func _hold(grant: String, p: Object, info: Dictionary) -> void:
	_held[grant] = {"provider": p, "info": info}


## The Worker accepted the token as a session: the provider keeps what its launch check needs.
func _started(p: Object, info: Dictionary) -> void:
	if p.has_method("session_started"):
		await p.session_started(info)


# ── Providers and order ──────────────────────────────────────────────────────────────────

## The providers in play: `opts.providers`, else the installed ones.
static func _installed(identity: PKeyIdentity, opts: Dictionary) -> Array:
	var given = opts.get("providers")
	return (given as Array).duplicate() if given is Array else identity.platform_providers()


## Providers whose kind discovery published and `kinds` allows, in KIND_ORDER (then as installed).
static func _candidates(installed: Array, published: Array, kinds: Variant) -> Array:
	var out: Array = []
	for p in installed:
		var kind = p.get("kind")
		if not (kind is String) or not PKeyIdentityExchange.TOKEN_TYPES.has(kind) or not (kind in published):
			continue
		if kinds is Array and not (kind in kinds):
			continue
		out.append(p)
	out.sort_custom(func(a, b): return KIND_ORDER.find(a.get("kind")) < KIND_ORDER.find(b.get("kind")))
	return out


static func _flag(p: Object, method: String) -> bool:
	return not p.has_method(method) or bool(p.call(method))


## `present` or `needed` from the key ring when Cloud Sync's encryption is on here, else null.
func _with_sync_key(r: PKeyAutoSignInResult) -> PKeyAutoSignInResult:
	var identity := _identity()
	var host = identity._host if identity._host != null and is_instance_valid(identity._host) else null
	var ring = host.get("keyring") if host != null else null
	if ring == null or not identity._core().enabled("sync"):
		return r
	var status: PKeyResult = await ring.status()
	if status.ok and status.detail is Dictionary:
		r.sync_key = "present" if status.detail.get("unlocked") == true else "needed"
	return r
