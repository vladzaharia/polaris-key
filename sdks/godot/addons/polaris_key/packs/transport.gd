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
## bool` gets the body in order and false aborts), `open_range(req)` (P4-11's chunk strategy: a
## coroutine making ONE single-range request, `req` {sha256, offset, length, if_range}, answering
## {status, content_range, etag, error, body} with the body unread: `await body.take(n)` pulls it,
## `body.close()` releases it; PKeyPackChunks.chunk_range_fetch decides whether it is read; only a
## transport whose `supports_range()` is true gets chunk plans) and
## `embedded()` (the baselines it ships: Array of {marker: PackedByteArray, location, payload:
## {kind, …}}). The base class has nothing.

const EMBEDDED_DIR := "res://pkey_packs"


func id() -> String:
	return ""


func fetch_record(_sha256: String) -> Dictionary:
	return {"ok": false, "code": String(PKeyErrors.SERVICE_UNAVAILABLE)}


func fetch_object(_req: Dictionary, _on_response: Callable, _on_chunk: Callable) -> Dictionary:
	return {"status": 0, "content_range": "", "error": String(PKeyErrors.SERVICE_UNAVAILABLE)}


## Whether this transport makes single-range requests (`open_range`). The engine plans `chunk`
## only when it says true; the base class (and a transport that cannot) says false.
func supports_range() -> bool:
	return false


## Without range support every ranged open is refused (a 501, body never read), so a caller that
## tries anyway falls back to the next strategy rather than reading it as an interrupted transfer.
func open_range(_req: Dictionary) -> Dictionary:
	return {"status": 501, "content_range": "", "etag": null, "error": "", "body": null}


func embedded() -> Array:
	return []
