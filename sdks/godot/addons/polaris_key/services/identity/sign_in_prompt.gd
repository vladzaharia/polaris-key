class_name PKeySignInPrompt
extends PKeyResult
## What `PolarisKey.identity.begin_sign_in()` returns: the code the player types, the two
## verification URLs, and the poll credential the SDK keeps using (P1b-08's `SignInPrompt`, in
## snake_case). A PKeyResult: when the sign-in could not start, `ok` is false and `code` says why
## (`service-unavailable` before any request when Identity is off or not set up, `rate_limited`,
## `invalid-response`, a transport code, …).
##
## Show the player, from largest to smallest: `user_code`; `verification_uri_complete` as a QR
## code (PKeyQrRect) and as the link "Open browser" opens; `verification_uri` as the short URL to
## type. Never show `device_code`.
##
## `device_code` is the secret that redeems the flow. It never prints: `str(prompt)` and
## `print(prompt)` show `[redacted]` in its place (sdk-node `redactOnPrint`). Do not put it in a
## URL, a log line, `var_to_str` or a save file.

const REDACTED := "[redacted]"

## The poll credential. Never show it, never put it in a URL.
var device_code := ""
## What the player types on the verification page, e.g. `WDJB-MJHT`.
var user_code := ""
## The page the player opens and types the code into.
var verification_uri := ""
## The same page with the code pre-filled: the payload for a QR code or a link.
var verification_uri_complete := ""
## Seconds the code lives for, as the server advertised it (rounded up).
var expires_in := 0
## The minimum seconds between polls, as the server advertised it (rounded up).
var interval := 0
## Epoch seconds on THIS client's clock when the code expires: the start's now plus
## `expires_in`. Polling stops here without asking the server again.
var expires_at := 0.0
## The flow holds at the signed-in identity until the player accepts it on the device
## (`sign_in_confirm`, then `accept_sign_in`), which also offers attaching this device's
## anonymous licence. Set by `begin_sign_in(device_name, confirm_identity)`.
var confirm_identity := false
## The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo, else (an older
## Worker) the label sent; "" when there is none. Show it under the code.
var device_name := ""


func _to_string() -> String:
	if not ok:
		return "PKeySignInPrompt(%s: %s)" % [code, message]
	return "PKeySignInPrompt(user_code=%s, verification_uri_complete=%s, device_code=%s, expires_in=%d, interval=%d)" % [
		user_code, verification_uri_complete, REDACTED, expires_in, interval,
	]
