class_name PKeySync
extends RefCounted
## `sync()`, the one Core loop: sdk-node `core/sync.ts`, in the same order.
##
##   1. no token: return at once, ZERO network calls
##   2. re-arm the single re-acquire budget for this pass
##   3. trust refresh on Core's own cadence (§4.2), before and independent of the documents; a
##      failure keeps the old set
##   4. the enabled documents IN PARALLEL (licence and config are independent services with
##      independent ETags), joined on a signal
##   5. each verified against the effective set, with the per-type anti-replay floor taken from
##      the document held now (never from disk), on a worker thread (gameplay)
##   6. ONE cache write folding every changed slice and both unsigned hints: a hard 401 sets
##      `lastSyncUnauthorized` and deletes that slice and its ETag, a 403 build block sets
##      `blocked` and deletes the licence slice, a 200 or 304 clears both hints
##   7. the clock floor rises from whatever verified
##   8. the post-sync hooks (telemetry, P1-05), skipped only on a hard 401 with nothing applied
##
## Per document: ETag/304; a 304 past the half-life (`effectiveNow > expiresAt - 1800`) is
## re-asked unconditionally so the server re-signs the window; a 401 gets one shared
## re-acquire and one retry. No generic retries; a 429 surfaces as `rate-limited`.


## A signal-based join for coroutines started together.
class Join:
	extends RefCounted
	signal done
	var pending := 0
	var results := {}

	func start(key: String, job: Callable) -> void:
		pending += 1
		_run(key, job)

	func _run(key: String, job: Callable) -> void:
		results[key] = await job.call()
		pending -= 1
		if pending == 0:
			done.emit()

	func wait() -> void:
		if pending > 0:
			await done


static func run(core: PKeyCore, force := false) -> PKeySyncResult:
	if not core.started:
		return PKeySyncResult.new(false, PKeyErrors.NOT_CONFIGURED, "Call start() before sync().")
	if core.local_only:
		return PKeySyncResult.new(false, PKeyErrors.LOCAL_ONLY, "This client is local-only; sync is refused.")
	var result := PKeySyncResult.new()
	if not core.tokens.has_token():
		return result
	core.tokens.begin_pass()

	var trust_jws := ""
	if core.trust_refresh:
		trust_jws = await core.refresh_trust()

	var want_license := core.enabled("license")
	var want_config := core.enabled("config")
	var join := Join.new()
	if want_license:
		join.start("license", func(): return await _sync_document(core, "license", force, true))
	if want_config:
		join.start("config", func(): return await _sync_document(core, "config", force, true))
	await join.wait()

	var outcomes: Array = join.results.values()
	var changes := {}
	if trust_jws != "":
		changes["trustJws"] = trust_jws
		# §4.1: a manifest that tombstoned a pin is that tombstone's evidence, in the same write.
		var evidence := core.trust.pin_revocations()
		if not evidence.is_empty():
			changes["pinRevocations"] = evidence
	var unauthorized := false
	var blocked_outcome = null
	var rate_limited := false
	var applied := false
	var unchanged := false
	for o in outcomes:
		match o["kind"]:
			"unauthorized":
				unauthorized = true
			"blocked":
				if blocked_outcome == null:
					blocked_outcome = o
			"rate-limited":
				rate_limited = true
			"applied":
				applied = true
			"unchanged":
				unchanged = true
	var healthy := applied or unchanged
	# The unsigned hints are for display; no verdict depends on them. What makes a revocation (or a
	# build block) hold offline is that the document it answered for is REMOVED in the same write
	# that sets the hint, so clearing a hint yields needs-activation, never a usable document.
	# The token stays, so the gate still reports revoked / the block.
	for slice in join.results:
		var kind: String = join.results[slice]["kind"]
		if kind == "unauthorized" or (slice == "license" and kind == "blocked"):
			core.cache.revoke_slice(slice)
	if unauthorized:
		changes["lastSyncUnauthorized"] = true
	elif healthy:
		changes["lastSyncUnauthorized"] = null
	if blocked_outcome != null:
		changes["blocked"] = blocked_outcome["blocked"]
	elif healthy:
		changes["blocked"] = null
	if not changes.is_empty() or applied or unchanged:
		core.cache.flush(changes)

	result.applied = applied
	result.unauthorized = unauthorized
	result.blocked = blocked_outcome != null
	result.rate_limited = rate_limited
	for slice in join.results:
		var o: Dictionary = join.results[slice]
		result.documents[slice] = o["kind"]
		if o["kind"] == "error":
			result.errors[slice] = {"status": int(o.get("status", 0)), "code": String(o.get("code", ""))}

	if applied or not unauthorized:
		for hook in core.post_sync_hooks:
			if hook.is_valid():
				await hook.call(core, result)
	return result


## One document's fetch -> verify -> stage cycle, with the half-life escalation and the single
## shared re-acquire. Returns {kind, ...}.
static func _sync_document(core: PKeyCore, slice: String, force: bool, allow_reacquire: bool) -> Dictionary:
	var token := core.tokens.current()
	if token == "":
		return {"kind": "skipped"}
	var held = core.cache.license if slice == "license" else core.cache.config
	var res := await core.get_document("%s/document" % slice, token, "" if force else core.cache.etag(slice))
	match res["kind"]:
		"not-modified":
			var expires = held["doc"]["expiresAt"] if held != null else null
			if not force and expires != null and core.clock.now() > float(expires) - PKeyClaims.REFRESH_MARGIN_SECONDS:
				return await _sync_document(core, slice, true, allow_reacquire)
			core.cache.mark_verified()
			return {"kind": "unchanged"}
		"unauthorized":
			if allow_reacquire and await core.tokens.reacquire_once():
				return await _sync_document(core, slice, force, false)
			return {"kind": "unauthorized"}
		"rate-limited":
			return res
		"blocked":
			return {"kind": "blocked", "blocked": res["blocked"]}
		"ok":
			var opts := {
				"trust": core.trust.effective(),
				"expected_aud": core.product,
				"device_id": core.device_id,
				"now": core.clock.now(),
				"offload": true,
			}
			# Required by PKeyVerify: the held document's floor, or an explicit null (none held).
			opts["last_accepted_issued_at"] = held["doc"]["issuedAt"] if held != null else null
			var doc = await PKeyVerify.verify_doc(res["jws"], PKeyClaims.TYP_LICENSE if slice == "license" else PKeyClaims.TYP_CONFIG, opts)
			if doc == null:
				return {"kind": "error", "status": 200, "code": String(PKeyErrors.INVALID_RESPONSE), "message": "the %s document did not verify" % slice}
			if slice == "license":
				core.cache.apply_license(res["jws"], doc, res["etag"])
			else:
				core.cache.apply_config(res["jws"], doc, res["etag"])
			core.cache.mark_verified()
			return {"kind": "applied"}
	return {"kind": "error", "status": res.get("status", 0), "code": res.get("code", ""), "message": res.get("message", "")}
