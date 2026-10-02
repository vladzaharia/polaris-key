class_name PKeyOutletAdapter
extends RefCounted
## One outlet's way of acting on a verified update decision (P3-10; README §5.5, §6.3). Adapters
## are keyed on the 17 outlet kinds the plan fixes (plans/P3-01.md §2.9), one script each under
## distribution/outlets/; the updater MECHANISMS (Sparkle, Velopack, WinSparkle, AppImageUpdate,
## the sidecar swap) are not outlets but what `binary {method}` reaches from the direct adapter.
##
##   id()                        the outlet id (the kind unless the product names its own)
##   capabilities(platform, …)   the compiled outlet defaults, narrowed by platform, subkind and
##                               the feed entry (PKeyDecision.effective_capabilities): only ever
##                               narrower, so a store, Steam or itch build can never be talked
##                               into self-updating code
##   describe(decision, ctx)     PURE: what this outlet does for `decision` — {behaviour, action
##                               (a PKeyUiCopy key, "" for none), url, body (a copy key that
##                               replaces the default body, or ""), bridge, fallback_url}.
##                               PKeyUpdatePrompt renders it
##   apply(decision, host, check)  act on it (a coroutine -> PKeyApplyResult): open a link, call a
##                               native hook, stage a sidecar pack, restart, reload, or nothing
##
## `ctx` (from PKeyUpdater.context(), or a prompt without an SDK): {platform, subkind,
## release_url, page_url, build_url, native_bridge, native_available}. `host` is what an adapter
## acts through — PKeyUpdater, or a test's recording fake: open_url(url) -> bool,
## bridge(name) -> PKeyNativeBridge, stage_sidecar(check), restart_to_update() (coroutines
## returning PKeyApplyResult), reload_web() -> bool, context(decision) -> Dictionary.
##
## Every link is https only: `OS.shell_open` would hand a `file:` or custom-scheme URL to a local
## handler, so a store deep link (`itms-apps://`, `market://`, `ms-windows-store://`) is never
## opened; the page fallback (PKeyOptions.update_page_url) takes its place.

## The outlet kind this adapter serves (`unknown` for the silent fallback).
var kind := "unknown"
## The product's own outlet id when it differs from the kind (`itch-beta`), else "".
var outlet_id := ""


func id() -> String:
	return outlet_id if outlet_id != "" else kind


## The effective capabilities on `platform` (see the class doc).
func capabilities(platform := "", subkind: Variant = null, server: Variant = null) -> Dictionary:
	return PKeyDecision.effective_capabilities(kind, {"platform": platform, "subkind": subkind, "server": server})


## The plan for `decision` (see the class doc). The base opens a `store` answer's https listing
## (the decision only gives one to a store outlet; the feed verifier has checked its prefix) and is
## silent for everything else.
func describe(decision: Dictionary, _ctx: Dictionary) -> Dictionary:
	if decision.get("action") == "store":
		return link_or_silent(String(decision["listingUrl"]) if decision.get("listingUrl") is String else "", "update_store")
	return plan(PKeyApplyResult.SILENT)


## Carry out describe()'s plan through `host`. A coroutine.
func apply(decision: Dictionary, host: Object, check: PKeyUpdateCheck = null) -> PKeyApplyResult:
	var ctx: Dictionary = host.context(decision) if host != null and host.has_method("context") else {}
	var p := describe(decision, ctx)
	match p["behaviour"]:
		PKeyApplyResult.LINK:
			return _open(host, p["url"])
		PKeyApplyResult.HOOK:
			var bridge = host.bridge(p["bridge"]) if host != null else null
			var r: PKeyApplyResult = PKeyApplyResult.missing_dependency(p["bridge"])
			if bridge != null:
				r = await bridge.install_and_relaunch()
			if r.ok:
				return r
			# A missing or failing native updater never breaks anything: the download link.
			if p["fallback_url"] != "":
				var link := _open(host, p["fallback_url"])
				link.detail = {"url": p["fallback_url"], "fallback_from": p["bridge"], "hook_code": String(r.code)}
				return link
			return r
		PKeyApplyResult.STAGED:
			if check == null:
				return PKeyApplyResult.failed(PKeyErrors.INVALID_OPTIONS, "Staging a sidecar pack needs the PKeyUpdateCheck (its verified record).")
			return await host.stage_sidecar(check)
		PKeyApplyResult.RESTART:
			return await host.restart_to_update()
		PKeyApplyResult.RELOAD:
			if host != null and host.reload_web():
				return PKeyApplyResult.of(PKeyApplyResult.RELOAD)
			return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "Only a web export can reload its page.", {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.RUNTIME})
	return PKeyApplyResult.of(PKeyApplyResult.SILENT)


## A plan Dictionary with every member present.
static func plan(behaviour: String, action := "", url := "", body := "", bridge := "", fallback_url := "") -> Dictionary:
	return {"behaviour": behaviour, "action": action, "url": url, "body": body, "bridge": bridge, "fallback_url": fallback_url}


## A link plan when `url` is https, else silent with the same body.
static func link_or_silent(url: String, action: String, body := "") -> Dictionary:
	if is_https(url):
		return plan(PKeyApplyResult.LINK, action, url, body)
	return plan(PKeyApplyResult.SILENT, "", "", body)


static func is_https(url: Variant) -> bool:
	return url is String and url.begins_with("https://") and url.length() > 8


## The first https URL among `urls`, or "".
static func first_https(urls: Array) -> String:
	for u in urls:
		if is_https(u):
			return u
	return ""


static func _open(host: Object, url: String) -> PKeyApplyResult:
	if not is_https(url):
		return PKeyApplyResult.of(PKeyApplyResult.SILENT)
	if host != null:
		host.open_url(url)
	return PKeyApplyResult.of(PKeyApplyResult.LINK, {"url": url})
