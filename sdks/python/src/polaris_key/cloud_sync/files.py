"""The Cloud Sync file transport: the :class:`~polaris_key.cloud_sync.transfer.FileTransport` port of the
transfer engine, over bearer HTTP.

A port of ``packages/sdk-node/src/cloudSync/files.ts``. It carries bytes to and from the product's own
``/<p>/sync/files/…`` routes (WIRE-CONTRACT-V5 §13.2, §13.8) and nothing else.

* **Paths.** Every URL is built from validated parts and then tested against a closed list of route shapes
  (:func:`is_files_path`). The collection, the record id and the upload id use the key charset
  (``SYNC_KEY_PATTERN``) and may not be ``.`` or ``..`` (a save id may contain dots); a chunk id is 64
  lowercase hex characters; a part number is 1…9999. A value that fails is a ``TransferError``, never a
  request.
* **Redirects.** None are followed (``follow_redirects=False``): a 3xx is a refusal, so the bearer token
  and the file never leave the product's origin.
* **Bodies.** A request carries ``Content-Digest: sha-256=:…:`` of its body. An answer is read under a cap
  equal to what the call expects: a ranged ``GET`` the length asked for, a chunk ``GET``
  ``SERVER_CHUNK_MAX_STORED_BYTES``, a whole-file ``GET`` the largest stored manifest, a JSON answer 1 MiB,
  an error body 64 KiB. A longer body is abandoned and answered as ``bad_response``.
* **Retries.** None here: the engine owns them. A request that gets no answer raises (the engine retries
  it); an answer is a :class:`FileReply`, with ``Retry-After`` parsed. A 5xx is an answer too (the Worker
  says ``503 unavailable`` with ``Retry-After`` when its limiter is down), never an exception.

The device bearer is read per request and never logged or put in an error. A transport with no bearer
answers ``401 unauthorized`` and sends nothing.
"""

from __future__ import annotations

import base64
import email.utils
import json
import re
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from ..constants_generated import (
    SYNC_CHUNK_ID_PATTERN,
    SYNC_KEY_PATTERN,
    SYNC_MAX_PARTS,
    ErrorCode,
)
from ..core.bounded_body import read_capped_bytes, read_capped_text
from ..core.context import CoreContext
from ..core.errors import PolarisError
from .sign_in_url import sign_in_url_of
from .transfer import FileBody, FileQuery, FileReply, FileTarget, TransferError
from .transfer_codec import SERVER_CHUNK_MAX_STORED_BYTES

__all__ = [
    "FILES_JSON_MAX_BYTES",
    "FILES_ERROR_MAX_BYTES",
    "FILES_MANIFEST_MAX_BYTES",
    "FILES_MIN_BYTES_PER_SECOND",
    "is_files_path",
    "retry_after_seconds",
    "FileRoutes",
]

#: The most a JSON answer of a file route may be.
FILES_JSON_MAX_BYTES = 1_048_576
#: The most an error body is read to.
FILES_ERROR_MAX_BYTES = 65_536
#: The most an unranged file ``GET`` returns: a ``chunks`` file's manifest (786,496 bytes plain, sealed).
FILES_MANIFEST_MAX_BYTES = 2 * 1_048_576
#: A transfer slower than this is cut off: the deadline of a body grows by its size over this rate.
FILES_MIN_BYTES_PER_SECOND = 65_536

_KEY = re.compile(SYNC_KEY_PATTERN)
_CHUNK_ID = re.compile(SYNC_CHUNK_ID_PATTERN)
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_SEGMENT = r"[A-Za-z0-9._:-]{1,128}"
_HEX = r"[0-9a-f]{64}"


def _shapes(product: str) -> "re.Pattern[str]":
    base = f"/{re.escape(product)}/sync/files/{_SEGMENT}"
    rec = f"{base}/{_SEGMENT}"
    upload = f"{rec}/upload/{_SEGMENT}"
    shapes = [
        f"{rec}/(?:begin|finalize|revisions)",
        rec,
        upload,
        f"{upload}/parts/[0-9]{{1,4}}",
        f"{upload}/chunks",
        f"{upload}/chunks/{_HEX}",
        f"{base}/chunks/{_HEX}",
    ]
    return re.compile("(?:" + "|".join(shapes) + r")\Z")


def is_files_path(product: str, path_and_query: str) -> bool:
    """Whether ``path_and_query`` is one of the file routes of §13.2 for ``product``. Dot segments are
    refused outright; the only query is ``version=<digits>`` on the file ``GET``."""
    if _KEY.fullmatch(product) is None:
        return False
    path, _, query = path_and_query.partition("?")
    if any(s in (".", "..") for s in path.split("/")):
        return False
    if _shapes(product).match(path) is None:
        return False
    if query == "" and "?" not in path_and_query:
        return True
    if re.fullmatch(r"version=[0-9]{1,9}", query) is None:
        return False
    # The version query rides only on the file GET (``…/{collection}/{id}``).
    return re.fullmatch(f"/{re.escape(product)}/sync/files/{_SEGMENT}/{_SEGMENT}", path) is not None


def retry_after_seconds(header: Optional[str], now: Optional[float] = None) -> Optional[int]:
    """Whole seconds from a ``Retry-After`` header: delay-seconds or an HTTP date, never negative. ``None``
    when the header is absent or unreadable."""
    if header is None:
        return None
    text = header.strip()
    if text == "":
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return int(-(-float(text) // 1))
    try:
        at = email.utils.parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError):
        return None
    delta = at - (time.time() if now is None else now)
    return max(0, int(-(-delta // 1)))


def _bad(detail: str) -> TransferError:
    return TransferError("rejected", code="bad_path", detail=detail)


def _code_for_status(status: int) -> str:
    if status == 429:
        return ErrorCode.RATE_LIMITED
    if status >= 500:
        return ErrorCode.SERVER_ERROR
    return {
        400: ErrorCode.BAD_REQUEST,
        401: ErrorCode.UNAUTHORIZED,
        403: ErrorCode.FORBIDDEN,
        404: ErrorCode.NOT_FOUND,
        405: ErrorCode.METHOD_NOT_ALLOWED,
        413: ErrorCode.BODY_TOO_LARGE,
    }.get(status, ErrorCode.HTTP_ERROR)


def _no_constant(_: str) -> Any:
    raise ValueError("not JSON")


def _parse_error_body(text: str) -> Tuple[Optional[str], Dict[str, Any]]:
    """The code an error body names (flat ``{"error": "code"}`` or nested ``{"error": {"code": …}}``) and the
    parsed object, ``{}`` when it was not a JSON object."""
    try:
        parsed = json.loads(text, parse_constant=_no_constant)
    except (ValueError, RecursionError):
        return None, {}
    if not isinstance(parsed, dict):
        return None, {}
    err = parsed.get("error")
    nested = err if isinstance(err, dict) else None
    code = err if isinstance(err, str) and err != "" else None
    if code is None and nested is not None:
        c = nested.get("code")
        code = c if isinstance(c, str) and c != "" else None
    return code, parsed


class _Sent:
    __slots__ = ("json", "body", "sha256", "range", "if_match")

    def __init__(
        self,
        *,
        json_body: Any = None,
        body: Optional[bytes] = None,
        sha256: Optional[str] = None,
        range: Optional[Tuple[int, int]] = None,
        if_match: Optional[str] = None,
    ) -> None:
        self.json = json_body
        self.body = body
        self.sha256 = sha256
        self.range = range
        self.if_match = if_match


class _Answer:
    """What one exchange produced: a refusal made locally (no bearer, a redirect), or the status, the
    lowercased headers and what ``read`` returned."""

    __slots__ = ("refusal", "status", "headers", "data")

    def __init__(
        self,
        refusal: Optional[FileReply] = None,
        status: int = 0,
        headers: Optional[Dict[str, str]] = None,
        data: Any = None,
    ) -> None:
        self.refusal = refusal
        self.status = status
        self.headers = headers or {}
        self.data = data


class FileRoutes:
    """The routes of §13.2 as an engine ``FileTransport``. ``token`` is the device bearer now, or ``None``
    when signed out."""

    def __init__(
        self,
        ctx: CoreContext,
        token: Callable[[], Optional[str]],
        on_account_required: Optional[Callable[[Optional[str]], None]] = None,
    ) -> None:
        self._ctx = ctx
        self._token = token
        #: Told when a route answers ``account_required`` (V5 §11.5), with the answer's ``signInUrl``
        #: unvetted. The call still returns its refusal.
        self._on_account_required = on_account_required

    # ── Paths ───────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _seg(value: Any, what: str) -> str:
        if not isinstance(value, str) or _KEY.fullmatch(value) is None or value in (".", ".."):
            raise _bad(what)
        return value

    def _base(self, collection: str) -> str:
        return f"/{self._ctx.product}/sync/files/{self._seg(collection, 'collection')}"

    def _record(self, t: FileTarget) -> str:
        return f"{self._base(t.collection)}/{self._seg(t.record, 'record')}"

    def _upload(self, t: FileTarget, upload_id: str) -> str:
        return f"{self._record(t)}/upload/{self._seg(upload_id, 'uploadId')}"

    @staticmethod
    def _chunk_id(chunk_id: Any) -> str:
        if not isinstance(chunk_id, str) or _CHUNK_ID.fullmatch(chunk_id) is None:
            raise _bad("chunkId")
        return chunk_id

    # ── The exchange ────────────────────────────────────────────────────────────────────────

    def _exchange(
        self,
        method: str,
        path: str,
        cancel: Optional[threading.Event],
        sent: Optional[_Sent] = None,
        expect_bytes: int = 0,
        *,
        read: Callable[["Any"], Any],
    ) -> _Answer:
        """One request. A request that gets no answer raises."""
        ctx = self._ctx
        sent = sent or _Sent()
        if not is_files_path(ctx.product, path):
            raise _bad("route")
        if cancel is not None and cancel.is_set():
            raise TransferError("aborted")
        token = self._token()
        if token is None:
            return _Answer(refusal=FileReply.failure(401, ErrorCode.UNAUTHORIZED))
        headers = ctx.headers(
            {"authorization": f"Bearer {token}", "accept": "application/octet-stream, application/json"}
        )
        kwargs: Dict[str, Any] = {}
        if sent.json is not None:
            headers["content-type"] = "application/json"
            kwargs["content"] = json.dumps(sent.json, separators=(",", ":")).encode("utf-8")
        elif sent.body is not None:
            headers["content-type"] = "application/octet-stream"
            if sent.sha256 is None or _HEX64.fullmatch(sent.sha256) is None:
                raise _bad("digest")
            headers["content-digest"] = "sha-256=:" + base64.b64encode(bytes.fromhex(sent.sha256)).decode("ascii") + ":"
            kwargs["content"] = sent.body
        if sent.range is not None:
            headers["range"] = f"bytes={sent.range[0]}-{sent.range[1] - 1}"
        if sent.if_match is not None:
            headers["if-match"] = sent.if_match
        size = max(expect_bytes, len(sent.body) if sent.body is not None else 0)
        timeout = ctx.timeout
        if timeout is not None:
            timeout = timeout + -(-size // FILES_MIN_BYTES_PER_SECOND)
        try:
            with ctx.http().stream(
                method,
                f"{ctx.base_url}{path}",
                headers=headers,
                timeout=timeout,
                follow_redirects=False,
                **kwargs,
            ) as res:
                status = res.status_code
                out_headers = {k.lower(): v for k, v in res.headers.items()}
                if 300 <= status < 400:
                    return _Answer(refusal=FileReply.failure(status, "redirect_refused"))
                return _Answer(status=status, headers=out_headers, data=read(res))
        except PolarisError as e:
            # Local-only is a refusal to dial, not a network failure: nothing is retried.
            if e.code == ErrorCode.LOCAL_ONLY:
                raise TransferError("rejected", code=e.code) from None
            raise

    def _refusal(self, status: int, headers: Dict[str, str], text: Optional[str]) -> FileReply:
        """The refusal an error answer is: the server's code, ``Retry-After``, and the body's extra members."""
        code, parsed = _parse_error_body(text or "")
        err = parsed.get("error")
        nested = err if isinstance(err, dict) else {}
        top = {k: v for k, v in parsed.items() if k != "error"}
        inner = {k: v for k, v in nested.items() if k not in ("code", "message")}
        if status == 403 and code == ErrorCode.ACCOUNT_REQUIRED and self._on_account_required is not None:
            try:
                self._on_account_required(sign_in_url_of(parsed))
            except Exception:  # noqa: BLE001 - never throws into the route that saw it
                pass
        return FileReply.failure(
            status,
            code or _code_for_status(status),
            retry_after_seconds(headers.get("retry-after")),
            {**top, **inner},
        )

    def _text(self, res: Any) -> Optional[str]:
        return read_capped_text(res, FILES_ERROR_MAX_BYTES if res.status_code >= 300 else FILES_JSON_MAX_BYTES)

    def _empty(
        self, method: str, path: str, cancel: Optional[threading.Event], sent: Optional[_Sent] = None
    ) -> FileReply:
        """A route whose success carries no body."""
        a = self._exchange(method, path, cancel, sent, read=self._text)
        if a.refusal is not None:
            return a.refusal
        if not 200 <= a.status < 300:
            return self._refusal(a.status, a.headers, a.data)
        return FileReply.success(None)

    def _json(
        self,
        method: str,
        path: str,
        cancel: Optional[threading.Event],
        sent: Optional[_Sent] = None,
        accept: Callable[[Dict[str, Any]], bool] = lambda v: True,
    ) -> FileReply:
        """A route whose success is a JSON object under the cap."""
        a = self._exchange(method, path, cancel, sent, read=self._text)
        if a.refusal is not None:
            return a.refusal
        if not 200 <= a.status < 300:
            return self._refusal(a.status, a.headers, a.data)
        value: Any = None
        if a.data is not None:
            try:
                value = json.loads(a.data, parse_constant=_no_constant)
            except (ValueError, RecursionError):
                value = None
        if not isinstance(value, dict) or not accept(value):
            return FileReply.failure(a.status, ErrorCode.BAD_RESPONSE)
        return FileReply.success(value)

    # ── FileTransport ───────────────────────────────────────────────────────────────────────

    def begin(
        self, target: FileTarget, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply:
        path = f"{self._record(target)}/begin"

        def accept(v: Dict[str, Any]) -> bool:
            up = v.get("uploadId")
            pb = v.get("partBytes")
            ex = v.get("expiresAt")
            return (
                isinstance(up, str)
                and _KEY.fullmatch(up) is not None
                and up not in (".", "..")
                and v.get("mode") in ("single", "multipart", "chunks")
                and isinstance(ex, (int, float))
                and not isinstance(ex, bool)
                and (pb is None or (isinstance(pb, (int, float)) and not isinstance(pb, bool)))
            )

        return self._json("POST", path, cancel, _Sent(json_body=request), accept)

    def status(self, target: FileTarget, upload_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        return self._json(
            "GET", self._upload(target, upload_id), cancel, None, lambda v: isinstance(v.get("mode"), str)
        )

    def put_single(
        self, target: FileTarget, upload_id: str, body: bytes, sha256: str, cancel: Optional[threading.Event] = None
    ) -> FileReply:
        return self._empty("PUT", self._upload(target, upload_id), cancel, _Sent(body=body, sha256=sha256))

    def put_part(
        self,
        target: FileTarget,
        upload_id: str,
        n: int,
        body: bytes,
        sha256: str,
        cancel: Optional[threading.Event] = None,
    ) -> FileReply:
        if not isinstance(n, int) or isinstance(n, bool) or n < 1 or n > SYNC_MAX_PARTS:
            raise _bad("part")
        path = f"{self._upload(target, upload_id)}/parts/{n}"
        return self._empty("PUT", path, cancel, _Sent(body=body, sha256=sha256))

    def abort(self, target: FileTarget, upload_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        return self._empty("DELETE", self._upload(target, upload_id), cancel)

    def finalize(
        self, target: FileTarget, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply:
        def accept(v: Dict[str, Any]) -> bool:
            def whole(x: Any) -> bool:
                return isinstance(x, int) and not isinstance(x, bool)

            return (
                whole(v.get("version"))
                and whole(v.get("size"))
                and isinstance(v.get("sha256"), str)
                and v.get("format") in ("whole", "chunks")
            )

        return self._json("POST", f"{self._record(target)}/finalize", cancel, _Sent(json_body=request), accept)

    def plan_chunks(
        self, target: FileTarget, upload_id: str, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply:
        path = f"{self._upload(target, upload_id)}/chunks"
        return self._json("POST", path, cancel, _Sent(json_body=request))

    def put_chunk(
        self,
        target: FileTarget,
        upload_id: str,
        chunk_id: str,
        body: bytes,
        sha256: str,
        cancel: Optional[threading.Event] = None,
    ) -> FileReply:
        if len(body) > SERVER_CHUNK_MAX_STORED_BYTES:
            raise _bad("chunk")
        path = f"{self._upload(target, upload_id)}/chunks/{self._chunk_id(chunk_id)}"
        return self._empty("PUT", path, cancel, _Sent(body=body, sha256=sha256))

    def get_file(self, target: FileTarget, query: FileQuery, cancel: Optional[threading.Event] = None) -> FileReply:
        rng = query.range
        if rng is not None:
            start, end = rng
            if not (
                isinstance(start, int) and isinstance(end, int) and not isinstance(start, bool) and 0 <= start < end
            ):
                raise _bad("range")
        v = query.version
        if v is not None and not (isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**9):
            raise _bad("version")
        path = self._record(target) + (f"?version={v}" if v is not None else "")
        # The body is bounded by the range asked, even for a 200 (a server that ignores ``Range`` and sends
        # more is refused, never buffered).
        cap = rng[1] - rng[0] if rng is not None else FILES_MANIFEST_MAX_BYTES
        a = self._exchange(
            "GET",
            path,
            cancel,
            _Sent(range=rng, if_match=query.if_match),
            cap,
            read=lambda res: read_capped_bytes(res, cap) if res.status_code in (200, 206) else self._text(res),
        )
        if a.refusal is not None:
            return a.refusal
        if a.status not in (200, 206):
            if 200 <= a.status < 300:
                return FileReply.failure(a.status, ErrorCode.BAD_RESPONSE)
            return self._refusal(a.status, a.headers, a.data)
        if a.data is None:
            return FileReply.failure(a.status, ErrorCode.BAD_RESPONSE)
        m = re.fullmatch(r"bytes ([0-9]{1,15})-([0-9]{1,15})/([0-9]{1,15})", a.headers.get("content-range", ""))
        return FileReply.success(
            FileBody(
                status=a.status,
                data=a.data,
                etag=a.headers.get("etag"),
                content_range=(int(m.group(1)), int(m.group(2)) + 1, int(m.group(3))) if m else None,
            )
        )

    def revisions(self, target: FileTarget, cancel: Optional[threading.Event] = None) -> FileReply:
        return self._json(
            "GET",
            f"{self._record(target)}/revisions",
            cancel,
            None,
            lambda v: isinstance(v.get("revisions"), list),
        )

    def get_chunk(self, collection: str, chunk_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        path = f"{self._base(collection)}/chunks/{self._chunk_id(chunk_id)}"
        cap = SERVER_CHUNK_MAX_STORED_BYTES
        a = self._exchange(
            "GET",
            path,
            cancel,
            None,
            cap,
            read=lambda res: read_capped_bytes(res, cap) if res.status_code == 200 else self._text(res),
        )
        if a.refusal is not None:
            return a.refusal
        if a.status != 200:
            if 200 <= a.status < 300:
                return FileReply.failure(a.status, ErrorCode.BAD_RESPONSE)
            return self._refusal(a.status, a.headers, a.data)
        if a.data is None:
            return FileReply.failure(a.status, ErrorCode.BAD_RESPONSE)
        return FileReply.success(a.data)
