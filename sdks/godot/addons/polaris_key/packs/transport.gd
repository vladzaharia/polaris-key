class_name PKeyPackTransport
extends RefCounted
## How a pack's bytes arrive and how the SDK learns what is installed (P4-08; README §5.7): the
## interface P5-08 adds `apple_ba`, `play_pad` and `steam` behind. v1 has two:
##
##   PKeyPackCdnTransport        `pkey-cdn` (and `web`): the pinned record from discovery's
##                               `release.endpoints.record`, objects from
##                               `distribution.endpoints.blobs` (`{sha256}`), Range/If-Range,
##                               the device bearer only to the control plane's origin
##   PKeyPackEmbeddedTransport   `embedded`: packs shipped in the build (`res://pkey_packs/`,
##                               each with its marker); nothing to download
##
## A transport answers `id()`, `fetch_record(sha256)` (a coroutine: {ok: true, body} or {ok:
## false, code}), `fetch_object(req, on_response, on_chunk)` (a coroutine: {status,
## content_range, error}; `req` is {sha256, offset, if_range}; `on_response(status,
## content_range) -> bool` sees the head before any body byte and false aborts; `on_chunk(bytes) ->
## bool` gets the body in order and false aborts) and `embedded()` (the baselines it ships: Array
## of {marker: PackedByteArray, location, payload: {kind, …}}). The base class has nothing.

const EMBEDDED_DIR := "res://pkey_packs"


func id() -> String:
	return ""


func fetch_record(_sha256: String) -> Dictionary:
	return {"ok": false, "code": String(PKeyErrors.SERVICE_UNAVAILABLE)}


func fetch_object(_req: Dictionary, _on_response: Callable, _on_chunk: Callable) -> Dictionary:
	return {"status": 0, "content_range": "", "error": String(PKeyErrors.SERVICE_UNAVAILABLE)}


func embedded() -> Array:
	return []
