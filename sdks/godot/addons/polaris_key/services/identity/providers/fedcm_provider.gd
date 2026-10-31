class_name PKeyFedcmProvider
extends PKeyPlatformIdentityProvider
## Google sign-in on the web export through FedCM (I-48.8; the port of ui-core's
## `platformIdentity/fedcm.ts`). No UI of its own: the ladder asks for a token over the Worker's nonce
## and hands it to the exchange.
##
##   PolarisKey.identity.install_platform_provider(PKeyFedcmProvider.new())
##
## A small JavaScript shim, installed once through `JavaScriptBridge.eval`, calls
## `navigator.credentials.get` and reports back through a callback made with `create_callback`:
## the browser's promise never crosses the bridge, only one JSON string does.
##
## What the request carries:
##  - the config URL `https://accounts.google.com/gsi/fedcm.json`;
##  - the nonce at the top level of the provider and again in `params` (Chromium reads both; the
##    spec moved it into `params`, older builds know the top level only);
##  - the product's Google server client id (`audience`, from discovery);
##  - mediation `silent` for rung 3, `optional` for the sheet and the provider row;
##  - an 8 s timeout (`TIMEOUT_MS`): the silent attempt must not hold the page.
##
## What it answers (the port's shapes):
##  - `{token}` only when the id token's own `nonce` claim is the one asked for, checked here before
##    the token goes anywhere; a token for another nonce is refused;
##  - `{cancelled: true}` when the person dismissed the prompt or no account is signed in;
##  - `{unavailable: why}` for everything else: not a web export, no `IdentityCredential` (Safari,
##    Firefox), an insecure context, an iframe without the `identity-credentials-get` permission,
##    no client id, a timeout, a refused token or a browser error.
##
## Sign-out calls `navigator.credentials.preventSilentAccess()` so the browser stops choosing the
## account again. The token and the nonce are never printed.

const CONFIG_URL := "https://accounts.google.com/gsi/fedcm.json"
## The silent attempt gives up after this long.
const TIMEOUT_MS := 8000
const SHIM_GLOBAL := "__pkeyFedcm"

const SHIM_SOURCE := """
(function () {
  if (window.__pkeyFedcm) return;
  var creds = function () { return typeof navigator === 'undefined' ? undefined : navigator.credentials; };
  window.__pkeyFedcm = {
    can_run: function () {
      var c = creds();
      if (typeof window.IdentityCredential === 'undefined' || !c || typeof c.get !== 'function') return 'no-identity-credential';
      if (window.isSecureContext === false) return 'insecure-context';
      try {
        if (window.self !== window.top) {
          var p = document.permissionsPolicy || document.featurePolicy;
          if (p && typeof p.allowsFeature === 'function' && !p.allowsFeature('identity-credentials-get')) return 'no-iframe-permission';
        }
      } catch (e) { return 'no-iframe-permission'; }
      return '';
    },
    start: function (json, cb) {
      var done = false, timedOut = false, timer = null;
      var finish = function (o) {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        try { cb(JSON.stringify(o)); } catch (e) {}
      };
      try {
        var req = JSON.parse(json);
        var ac = new AbortController();
        timer = setTimeout(function () { timedOut = true; ac.abort(); }, req.timeoutMs);
        creds().get({
          identity: { providers: [{ configURL: req.configURL, clientId: req.clientId, nonce: req.nonce, params: req.params }] },
          mediation: req.mediation,
          signal: ac.signal
        }).then(function (cred) {
          var t = cred && cred.token;
          finish(typeof t === 'string' && t !== '' ? { status: 'token', token: t } : { status: 'cancelled' });
        }, function (e) {
          var n = e && e.name;
          finish(timedOut ? { status: 'timeout' } : (n === 'AbortError' || n === 'NotAllowedError') ? { status: 'cancelled' } : { status: 'error' });
        });
      } catch (e) { finish({ status: 'error' }); }
    },
    stop: function () {
      try {
        var c = creds();
        if (c && typeof c.preventSilentAccess === 'function') {
          var r = c.preventSilentAccess();
          if (r && typeof r.catch === 'function') r.catch(function () {});
        }
      } catch (e) {}
    }
  };
})();
"""

## The JavaScript side: an object with `eval(code, global)`, `get_interface(name)` and
## `create_callback(callable)` (the `JavaScriptBridge` singleton). Null on a build that is not a web
## export. A test hands in a fake.
var js: Object = null
var timeout_ms := TIMEOUT_MS

var _installed := false


## Carries one answer from the shim's callback to the coroutine waiting for it.
class Waiter extends RefCounted:
	signal done
	var finished := false
	var raw := ""

	func deliver(args: Array) -> void:
		if finished:
			return
		finished = true
		raw = String(args[0]) if args.size() > 0 and args[0] != null else ""
		done.emit()


func _init(p_js: Object = null) -> void:
	kind = "google"
	js = p_js if p_js != null else _bridge()


## The bridge on a web export, else null.
static func _bridge() -> Object:
	if not OS.has_feature("web") or not Engine.has_singleton("JavaScriptBridge"):
		return null
	return Engine.get_singleton("JavaScriptBridge")


## True where a FedCM attempt can be made here (a web export in a browser with `IdentityCredential`,
## in a secure context, with the iframe permission when framed).
func available() -> bool:
	return _unavailable_reason() == ""


func silent(nonce: String, audience: String) -> Dictionary:
	return await _ask(nonce, audience, "silent")


func sheet(nonce: String, audience: String) -> Dictionary:
	return await _ask(nonce, audience, "optional")


## Sign-out: tell the browser not to choose the account again. Best effort; never fails.
func sign_out_cleanup() -> void:
	var shim = _shim()
	if shim != null:
		shim.stop()


# ── The attempt ──────────────────────────────────────────────────────────────────────────

func _ask(nonce: String, audience: String, mediation: String) -> Dictionary:
	if audience == "":
		return {"unavailable": "This product publishes no Google client id."}
	if nonce == "":
		return {"unavailable": "No nonce."}
	var why := _unavailable_reason()
	if why != "":
		return {"unavailable": why}
	var shim = _shim()
	var waiter := Waiter.new()
	# The callback lives as long as this call: the bridge frees it with its last reference.
	var callback = js.create_callback(waiter.deliver)
	if callback == null:
		return {"unavailable": "The browser bridge could not make a callback."}
	shim.start(PKeyJson.stringify(request(nonce, audience, mediation)), callback)
	if not waiter.finished:
		await waiter.done
	return _answer(waiter.raw, nonce)


## The request the shim sends to `navigator.credentials.get`: the nonce at the top level and in `params`.
func request(nonce: String, audience: String, mediation: String) -> Dictionary:
	return {
		"configURL": CONFIG_URL,
		"clientId": audience,
		"nonce": nonce,
		"params": {"nonce": nonce},
		"mediation": mediation,
		"timeoutMs": timeout_ms,
	}


## The port's answer for the shim's `{status, token?}`.
func _answer(raw: String, nonce: String) -> Dictionary:
	var parsed := PKeyJson.parse(raw)
	var r = parsed["value"] if parsed["ok"] else null
	var out := {"unavailable": "FedCM failed."}
	if not (r is Dictionary):
		out = {"unavailable": "FedCM answered nothing readable."}
	elif r.get("status") == "cancelled":
		out = {"cancelled": true}
	elif r.get("status") == "timeout":
		out = {"unavailable": "FedCM timed out."}
	elif r.get("status") == "token":
		var token = r.get("token")
		if not (token is String) or token == "":
			out = {"cancelled": true}
		elif token_nonce(token) != nonce:
			# The token's own nonce claim, before it goes anywhere: a provider that ignored the nonce is refused.
			out = {"unavailable": "The FedCM token is not for this sign-in."}
		else:
			out = {"token": token}
	return out


## The `nonce` claim of a JWT, read without verifying (the Worker verifies the signature); "" when absent.
static func token_nonce(token: String) -> String:
	var parts := token.split(".")
	if parts.size() < 2:
		return ""
	var bytes = PKeyB64Url.decode_lenient(parts[1])
	if not (bytes is PackedByteArray):
		return ""
	var parsed := PKeyJson.parse_bytes(bytes)
	var claims = parsed["value"] if parsed["ok"] else null
	if claims is Dictionary and claims.get("nonce") is String:
		return claims["nonce"]
	return ""


# ── The shim ─────────────────────────────────────────────────────────────────────────────

## "" when an attempt can be made, else why not.
func _unavailable_reason() -> String:
	var shim = _shim()
	if shim == null:
		return "FedCM is for a web export."
	return String(shim.can_run())


## The shim object, installed on first use; null where there is no bridge.
func _shim() -> Variant:
	if js == null:
		return null
	if not _installed:
		var present = js.eval("typeof window.%s" % SHIM_GLOBAL, true)
		if String(present) != "object":
			js.eval(SHIM_SOURCE, true)
		_installed = true
	return js.get_interface(SHIM_GLOBAL)
