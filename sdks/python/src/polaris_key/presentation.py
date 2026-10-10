"""Product presentation (WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1, plans/HA-13.md §3), pinned by
``conformance/corpus/v2/presentation-matrix.json``.

Discovery's ``core.presentation`` is UNSIGNED display data: the product's name, its developer, an
accent for light and dark grounds, and an icon given as content-addressed image-host URLs with the
original's hash and each WebP width's hash. No gate, entitlement or trust decision reads it. This
module is a port of ``@polaris-key/client-core/presentation`` (the reference every SDK ports):

    parse_presentation   the member, field by field; a malformed field is dropped and the member
                         never refuses discovery (``parseCases``)
    pick_icon_size       which bytes to fetch for a hero drawn at ``px`` points on a ``scale``
                         screen, given the image types the platform decodes (``pickCases``)
    icon_matches         bytes are shown (and cached) only when their SHA-256 equals the hash the
                         pick names (``verifyCases``)
    usable_url_origin    rule 5: a URL's origin when it is usable, else ``None``
    safe_fetch_url       the fetcher's safe-link rule: usable, https (or loopback http) and on the
                         original's origin
    PresentationSource   the seam the UI kits read (plans/HA-11.md Q7): ``current()``,
                         ``icon(px, scale)``, ``subscribe(fn)``

The member is a plain dict, exactly the JSON client-core emits (``name``, then ``developerName``,
``accent``, ``accentDark`` and ``icon`` when present). Every limit is a generated
``PRESENTATION_*`` constant.

:class:`DiscoveryPresentationSource` is the SDK's implementation of the seam, behind
``client.presentation()``, ``client.presentation_icon(px, scale)`` and
``client.presentation_source``:

* After every successful discovery the member is parsed again: a document without one (or with an
  invalid one) clears it, and a failed discovery keeps the last. Subscribers hear only a change.
* **Fetch.** A plain GET with no ``Authorization``, ``Cookie`` or ``X-PKey-*`` header (the image
  host is public); no redirect is followed (a 3xx is a miss); 200 only; the
  ``PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS`` deadline; the body is streamed and abandoned past
  ``PRESENTATION_ICON_MAX_BYTES``. The URL must be https (or loopback http) and on the original's
  origin. Nothing is retried and no error is surfaced: a failure is ``None``, and the kit shows its
  letter tile. A local-only client never fetches.
* **Verify.** Bytes are returned and cached only when their SHA-256 (``hashlib``) is the pick's
  ``sha256``.
* **Cache.** ``<cache>/presentation/<sha256>`` and the last member as ``presentation.json`` beside
  them, each written to a temporary name and renamed; nothing enters the Core cache record. A
  cached icon is re-hashed on every read and deleted on a mismatch. After each discovery the files
  the member no longer names are removed, keeping at most ``PRESENTATION_CACHE_MAX_FILES`` icons.
  ``presentation.json`` is read back on a cold start only when it names this product and re-parses
  to itself, so an offline start still shows the product and a tampered file is dropped.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import secrets
import threading
import time
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Protocol,
    Union,
    runtime_checkable,
)

from .constants_generated import (
    PRESENTATION_CACHE_MAX_FILES,
    PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS,
    PRESENTATION_ICON_MAX_BYTES,
    PRESENTATION_ICON_MAX_DIMENSION,
    PRESENTATION_ICON_TYPES,
    PRESENTATION_MAX_ICON_SIZES,
    PRESENTATION_MAX_ICON_WIDTH,
    PRESENTATION_TEXT_MAX_BYTES,
    PRESENTATION_URL_MAX_BYTES,
)

if TYPE_CHECKING:  # pragma: no cover
    import httpx

__all__ = [
    "DiscoveryPresentationSource",
    "MEMBER_FILE",
    "PresentationSource",
    "icon_matches",
    "parse_presentation",
    "pick_icon_size",
    "safe_fetch_url",
    "usable_url_origin",
]

#: The last member, beside the icon files.
MEMBER_FILE = "presentation.json"
#: ``presentation.json``'s own format version (local, not a wire value).
MEMBER_FILE_VERSION = 1

_HEX_COLOUR = re.compile(r"#[0-9A-Fa-f]{6}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_DNS_LABEL = re.compile(r"[a-z0-9-]{1,63}")
_ALL_DIGITS = re.compile(r"[0-9]+")
#: WHATWG's ends-in-a-number test: a last label that would parse as an IPv4 number.
_HEX_NUMBER = re.compile(r"0x[0-9a-f]*")
_AUTHORITY_END = re.compile(r"[/?]")
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})
_ICON_TYPES = frozenset(PRESENTATION_ICON_TYPES)
#: Headers an icon request never carries, whatever the host's HTTP client adds.
_REFUSED_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie"})

_MISSING: Any = object()


# ── The parse rules (§5.5) ─────────────────────────────────────────────────────────────────


def _is_record(v: Any) -> bool:
    return isinstance(v, dict)


def _integer(v: Any) -> Optional[int]:
    """``v`` as an int when it is a JSON integer (JavaScript's ``Number.isInteger``: a whole
    float counts, a bool does not), else ``None``."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return None


def _utf8_length(s: str) -> int:
    """UTF-8 byte length of ``s``, or ``-1`` when it holds a lone surrogate (not encodable). A
    Python ``str`` from JSON holds a surrogate only when it was unpaired: ``json`` joins a pair."""
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            return -1
    return len(s.encode("utf-8"))


def _text(v: Any) -> Optional[str]:
    """Rule 2: a display text, or ``None``."""
    if not isinstance(v, str):
        return None
    n = _utf8_length(v)
    if n < 1 or n > PRESENTATION_TEXT_MAX_BYTES:
        return None
    for ch in v:
        c = ord(ch)
        if c <= 0x1F or 0x7F <= c <= 0x9F:
            return None
    return v


def _colour(v: Any) -> Optional[str]:
    """Rule 3: a colour, lower-cased, or ``None``."""
    return v.lower() if isinstance(v, str) and _HEX_COLOUR.fullmatch(v) else None


def _authority_host(authority: str) -> Optional[str]:
    """A lower-cased authority's host when it has a usable host and port, else ``None``."""
    port: Optional[str]
    if authority.startswith("["):
        close = authority.find("]")
        if close == -1:
            return None
        host = authority[: close + 1]
        after = authority[close + 1 :]
        if after != "" and not after.startswith(":"):
            return None
        port = None if after == "" else after[1:]
    else:
        colon = authority.find(":")
        host = authority if colon == -1 else authority[:colon]
        port = None if colon == -1 else authority[colon + 1 :]
    if port is not None and (
        len(port) < 1 or len(port) > 5 or not _ALL_DIGITS.fullmatch(port) or int(port) > 65535
    ):
        return None
    if host in ("[::1]", "127.0.0.1"):
        return host
    labels = host.split(".")
    if not all(_DNS_LABEL.fullmatch(label) for label in labels):
        return None
    last = labels[-1]
    if _ALL_DIGITS.fullmatch(last) or _HEX_NUMBER.fullmatch(last):
        return None
    return host


def usable_url_origin(v: Any) -> Optional[str]:
    """Rule 5: the URL's origin (scheme and authority, lower-cased) when it is usable, else
    ``None``."""
    if not isinstance(v, str):
        return None
    if len(v) < 1 or len(v) > PRESENTATION_URL_MAX_BYTES:
        return None
    for ch in v:
        c = ord(ch)
        if c < 0x21 or c > 0x7E or ch == "#" or ch == "\\":
            return None
    lower = v.lower()
    if lower.startswith("https://"):
        scheme = "https"
    elif lower.startswith("http://"):
        scheme = "http"
    else:
        return None
    rest = lower[len(scheme) + 3 :]
    end = _AUTHORITY_END.search(rest)
    authority = rest if end is None else rest[: end.start()]
    host = _authority_host(authority)
    if host is None:
        return None
    # Only the loopback hosts may be plain http.
    if scheme == "http" and host not in _LOOPBACK_HOSTS:
        return None
    return f"{scheme}://{authority}"


def safe_fetch_url(url: Any, original: Any) -> bool:
    """The fetcher's safe-link rule (plans/HA-13.md §3): ``url`` is usable (so https, or http on a
    loopback host) and on ``original``'s origin, so a ``{w}`` expansion never leaves it."""
    origin = usable_url_origin(url)
    return origin is not None and origin == usable_url_origin(original)


def _sizes(v: Any) -> Optional[List[Dict[str, Any]]]:
    """Rule 4's ``sizes``: the entries, ``[]`` when absent, or ``None`` when any entry is bad."""
    if v is _MISSING:
        return []
    if not isinstance(v, list) or len(v) > PRESENTATION_MAX_ICON_SIZES:
        return None
    out: List[Dict[str, Any]] = []
    last = 0
    for e in v:
        if not _is_record(e):
            return None
        w = _integer(e.get("w", _MISSING))
        if w is None or w < 1 or w > PRESENTATION_MAX_ICON_WIDTH or w <= last:
            return None
        sha = e.get("sha256")
        if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
            return None
        out.append({"w": w, "sha256": sha})
        last = w
    return out


def _dimension(v: Any) -> Optional[int]:
    n = _integer(v)
    return n if n is not None and 1 <= n <= PRESENTATION_ICON_MAX_DIMENSION else None


def _icon(v: Any) -> Optional[Dict[str, Any]]:
    """Rule 4: the icon, or ``None``."""
    if not _is_record(v):
        return None
    sha = v.get("sha256")
    if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
        return None
    content_type = v.get("contentType")
    if not isinstance(content_type, str) or content_type not in _ICON_TYPES:
        return None
    original = v.get("original")
    origin = usable_url_origin(original)
    if origin is None:
        return None
    width = _dimension(v.get("width"))
    height = _dimension(v.get("height"))
    ladder = _sizes(v.get("sizes", _MISSING))
    url = v.get("url")
    templated = (
        ladder is not None
        and len(ladder) > 0
        and isinstance(url, str)
        and len(url) <= PRESENTATION_URL_MAX_BYTES
        and len(url.split("{w}")) == 2
        # `{w}` after the authority: the template begins with the original's own origin.
        and (url.lower().startswith(f"{origin}/") or url.lower().startswith(f"{origin}?"))
        and usable_url_origin(url.replace("{w}", "1", 1)) == origin
    )
    # Members in the contract's order (§5.5), so an emitted member reads as the contract shows it.
    out: Dict[str, Any] = {"sha256": sha, "contentType": content_type}
    if width is not None:
        out["width"] = width
    if height is not None:
        out["height"] = height
    out["original"] = original
    if templated:
        out["url"] = url
    out["sizes"] = ladder if templated and ladder is not None else []
    return out


def parse_presentation(core: Any, doc: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """``core.presentation`` from a discovery document's ``core`` block, normalised (see the
    module docstring), or ``None`` when the member is absent or not an object. ``doc`` supplies
    the fallbacks for the name: its ``name`` (by the same text rule), then its ``product``."""
    if not _is_record(core):
        return None
    raw = core.get("presentation")
    if not _is_record(raw):
        return None
    name = _text(raw.get("name")) or _text(doc.get("name")) or doc.get("product")
    out: Dict[str, Any] = {"name": name}
    developer = _text(raw.get("developerName"))
    if developer is not None:
        out["developerName"] = developer
    accent = _colour(raw.get("accent"))
    if accent is not None:
        out["accent"] = accent
    accent_dark = _colour(raw.get("accentDark"))
    if accent_dark is not None:
        out["accentDark"] = accent_dark
    icon = _icon(raw.get("icon"))
    if icon is not None:
        out["icon"] = icon
    return out


def pick_icon_size(
    icon: Mapping[str, Any], px: float, scale: float, decodable: Iterable[str]
) -> Dict[str, Any]:
    """Which bytes to fetch for a hero drawn at ``px`` points on a ``scale`` screen, given the
    content types the platform decodes. ``need = ceil(px × scale)`` (at least 1):

    1. With sizes and WebP decodable: the smallest ``w ≥ need``, else the largest ``w``.
    2. The original instead when it is decodable, its ``width`` is known and exceeds the largest
       ``w``, and ``need`` exceeds the largest ``w``.
    3. With no usable size: the original, when it is decodable.
    4. Otherwise ``{"source": "none"}``.
    """
    types = set(decodable)
    try:
        product = float(px) * float(scale)
    except (TypeError, ValueError):
        product = math.nan
    need = math.ceil(product) if math.isfinite(product) else 1
    if need < 1:
        need = 1
    original_ok = icon.get("contentType") in types
    original = {"source": "original", "sha256": icon["sha256"], "url": icon["original"]}
    sizes = icon.get("sizes") or []
    url = icon.get("url")
    if len(sizes) > 0 and url is not None and "image/webp" in types:
        largest = sizes[-1]
        fit = next((s for s in sizes if s["w"] >= need), largest)
        width = icon.get("width")
        if original_ok and need > largest["w"] and width is not None and width > largest["w"]:
            return original
        return {
            "source": "size",
            "w": fit["w"],
            "sha256": fit["sha256"],
            "url": url.replace("{w}", str(fit["w"]), 1),
        }
    return original if original_ok else {"source": "none"}


def icon_matches(data: Union[bytes, bytearray, memoryview], sha256: str) -> bool:
    """Whether ``data`` hashes to ``sha256``: its lower-case hex SHA-256 equals it exactly (an
    upper-case expectation never matches). Bytes that do not match are neither shown nor cached."""
    return hashlib.sha256(bytes(data)).hexdigest() == sha256


# ── The seam ───────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class PresentationSource(Protocol):
    """The seam every UI kit reads (plans/HA-11.md Q7). The SDK implements it over its discovery
    client and its icon cache; a kit never fetches discovery or the icon itself."""

    def current(self) -> Optional[Dict[str, Any]]:
        """The last parsed member, or ``None`` (none served, or none known yet)."""
        ...

    def icon(self, px: float, scale: float = 1.0) -> Optional[bytes]:
        """Verified icon bytes for a hero drawn at ``px`` points on a ``scale`` screen, or
        ``None``."""
        ...

    def subscribe(self, fn: Callable[[Optional[Dict[str, Any]]], None]) -> Callable[[], None]:
        """Call ``fn`` with the new member whenever it changes; returns the unsubscribe."""
        ...


class _Pending:
    __slots__ = ("done", "data")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.data: Optional[bytes] = None


class DiscoveryPresentationSource:
    """The SDK's :class:`PresentationSource`: the member from discovery, its icon fetched,
    verified and cached (the module docstring has the rules).

    ``cache_dir`` is where icons and ``presentation.json`` live, or ``None`` to keep them in memory
    for the session only. ``http`` returns the HTTP client to fetch with (the client passes
    ``core.http``, which refuses in local-only mode); ``None`` never fetches. ``decodable`` is the
    content types the host decodes (default: every ``PRESENTATION_ICON_TYPES`` entry; a Qt kit
    passes what ``QImageReader`` reads)."""

    def __init__(
        self,
        product: str,
        *,
        cache_dir: Optional[str] = None,
        http: Optional[Callable[[], "httpx.Client"]] = None,
        decodable: Optional[Iterable[str]] = None,
    ) -> None:
        self.product = product
        self.cache_dir = cache_dir
        self.decodable: List[str] = list(decodable if decodable is not None else PRESENTATION_ICON_TYPES)
        self._http = http
        self._lock = threading.RLock()
        self._current: Optional[Dict[str, Any]] = None
        self._discovered = False
        self._memo: Dict[str, bytes] = {}
        self._pending: Dict[str, _Pending] = {}
        self._listeners: List[Callable[[Optional[Dict[str, Any]]], None]] = []

    # ── The seam ───────────────────────────────────────────────────────────────────────
    def current(self) -> Optional[Dict[str, Any]]:
        """The last parsed member (a copy), or ``None`` when none is known."""
        with self._lock:
            return copy.deepcopy(self._current) if self._current is not None else None

    def subscribe(self, fn: Callable[[Optional[Dict[str, Any]]], None]) -> Callable[[], None]:
        with self._lock:
            self._listeners.append(fn)

        def unsubscribe() -> None:
            with self._lock:
                if fn in self._listeners:
                    self._listeners.remove(fn)

        return unsubscribe

    def icon(
        self, px: float, scale: float = 1.0, *, decodable: Optional[Iterable[str]] = None
    ) -> Optional[bytes]:
        """The verified icon for a hero drawn at ``px`` points on a ``scale`` screen, or ``None``:
        no member, no icon, nothing decodable, or a fetch or hash that failed. Concurrent calls for
        the same bytes share one fetch. Never raises."""
        try:
            return self._icon(px, scale, decodable)
        except Exception:  # never an error state: the kit shows its letter tile
            return None

    def _icon(self, px: float, scale: float, decodable: Optional[Iterable[str]]) -> Optional[bytes]:
        with self._lock:
            m = self._current
            ic = m.get("icon") if m is not None else None
            if not isinstance(ic, dict):
                return None
            pick = pick_icon_size(ic, px, scale, decodable if decodable is not None else self.decodable)
            if pick["source"] == "none":
                return None
            sha: str = pick["sha256"]
            if sha in self._memo:
                return self._memo[sha]
            waiting = self._pending.get(sha)
            mine = waiting is None
            if mine:
                waiting = self._pending[sha] = _Pending()
        assert waiting is not None
        if not mine:
            waiting.done.wait(PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS * 2)
            return waiting.data
        data: Optional[bytes] = None
        try:
            data = self._load(pick, str(ic["original"]))
        finally:
            with self._lock:
                self._pending.pop(sha, None)
                # Only bytes the current member still names are kept for the session.
                if data is not None and sha in named(self._current):
                    self._memo[sha] = data
            waiting.data = data
            waiting.done.set()
        return data

    # ── Discovery ──────────────────────────────────────────────────────────────────────
    def load_cached(self) -> None:
        """Cold start: the last member from ``presentation.json``, unless this session already
        discovered one. A file that does not parse, names another product, or does not read back
        exactly as the parser normalises it is deleted."""
        with self._lock:
            if self._discovered:
                return
        m = self._read_member()
        if m is not None:
            self._set_current(m)

    def accept(self, manifest: Any) -> None:
        """A successful discovery's document: parse, store, prune, and notify subscribers when the
        member differs. No member (or an invalid one) clears it."""
        m: Optional[Dict[str, Any]] = None
        if isinstance(manifest, dict):
            product = manifest.get("product", self.product)
            m = parse_presentation(
                manifest.get("core"),
                {"name": manifest.get("name"), "product": product if isinstance(product, str) else self.product},
            )
        with self._lock:
            self._discovered = True
        self._write_member(m)
        self.prune(m)
        self._set_current(m)

    def _set_current(self, m: Optional[Dict[str, Any]]) -> None:
        with self._lock:
            if _same(m, self._current):
                return
            self._current = copy.deepcopy(m)
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(copy.deepcopy(m))
            except Exception:
                pass  # a subscriber's failure never reaches discovery

    # ── Fetch ──────────────────────────────────────────────────────────────────────────
    def _load(self, pick: Dict[str, Any], original: str) -> Optional[bytes]:
        """The disk cache (re-hashed), else the network; verified, then cached."""
        sha: str = pick["sha256"]
        path = self._path(sha)
        if path is not None and os.path.isfile(path):
            try:
                with open(path, "rb") as f:
                    held = f.read(PRESENTATION_ICON_MAX_BYTES + 1)
            except OSError:
                held = b""
            if len(held) <= PRESENTATION_ICON_MAX_BYTES and icon_matches(held, sha):
                return held
            # Tampered or truncated: gone, and fetched again below.
            _remove(path)
        url = pick["url"]
        if not safe_fetch_url(url, original):
            return None
        body = self._fetch(url)
        if body is None or not icon_matches(body, sha):
            return None
        if self._write(sha, body):
            self._cap_files(sha)
        return body

    def _fetch(self, url: str) -> Optional[bytes]:
        """One plain GET: no credential, no redirect, 200 only, the deadline and the size cap."""
        if self._http is None:
            return None
        try:
            client = self._http()  # refuses (raises) in local-only mode
        except Exception:
            return None
        deadline = time.monotonic() + PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS
        try:
            request = client.build_request("GET", url, timeout=PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS)
            for name in list(request.headers.keys()):
                lower = name.lower()
                if lower in _REFUSED_HEADERS or lower.startswith("x-pkey-"):
                    del request.headers[name]
            response = client.send(request, stream=True, follow_redirects=False, auth=None)
        except Exception:
            return None
        try:
            if response.status_code != 200:
                return None
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > PRESENTATION_ICON_MAX_BYTES:
                return None
            buf = bytearray()
            for chunk in response.iter_bytes():
                buf += chunk
                if len(buf) > PRESENTATION_ICON_MAX_BYTES or time.monotonic() > deadline:
                    return None
            return bytes(buf)
        except Exception:
            return None
        finally:
            try:
                response.close()
            except Exception:
                pass

    # ── Cache files ────────────────────────────────────────────────────────────────────
    def _path(self, name: str) -> Optional[str]:
        return os.path.join(self.cache_dir, name) if self.cache_dir else None

    def cached_files(self) -> List[str]:
        """The icon files in the cache, as names."""
        if not self.cache_dir:
            return []
        try:
            names = os.listdir(self.cache_dir)
        except OSError:
            return []
        return sorted(
            n
            for n in names
            if n != MEMBER_FILE and ".tmp-" not in n and os.path.isfile(os.path.join(self.cache_dir, n))
        )

    def prune(self, member: Optional[Dict[str, Any]]) -> None:
        """Remove every icon file ``member`` does not name (and any interrupted write), then keep
        at most ``PRESENTATION_CACHE_MAX_FILES`` of the rest, newest first."""
        keep = named(member)
        with self._lock:
            for sha in list(self._memo):
                if sha not in keep:
                    del self._memo[sha]
        if not self.cache_dir:
            return
        try:
            names = os.listdir(self.cache_dir)
        except OSError:
            return
        for n in names:
            if n != MEMBER_FILE and n not in keep:
                _remove(os.path.join(self.cache_dir, n))
        self._cap_files("")

    def _cap_files(self, fresh: str) -> None:
        """At most ``PRESENTATION_CACHE_MAX_FILES`` icon files: the oldest go first; ``fresh`` (just
        written) never does."""
        if not self.cache_dir:
            return
        files = []
        for n in self.cached_files():
            if n == fresh:
                continue
            try:
                files.append((os.path.getmtime(os.path.join(self.cache_dir, n)), n))
            except OSError:
                continue
        room = PRESENTATION_CACHE_MAX_FILES - (1 if fresh else 0)
        if len(files) <= room:
            return
        files.sort()
        for _, n in files[: len(files) - room]:
            _remove(os.path.join(self.cache_dir, n))

    def _write(self, name: str, data: bytes) -> bool:
        """Write ``data`` to ``name`` in the cache: a temporary file, renamed over the target."""
        if not self.cache_dir:
            return False
        tmp = os.path.join(self.cache_dir, f"{name}.tmp-{secrets.token_hex(6)}")
        try:
            os.makedirs(self.cache_dir, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, os.path.join(self.cache_dir, name))
            return True
        except OSError:
            _remove(tmp)
            return False

    def _write_member(self, m: Optional[Dict[str, Any]]) -> None:
        path = self._path(MEMBER_FILE)
        if path is None:
            return
        if m is None:
            _remove(path)
            return
        body = json.dumps(
            {"v": MEMBER_FILE_VERSION, "product": self.product, "presentation": m},
            ensure_ascii=True,
            separators=(",", ":"),
        )
        self._write(MEMBER_FILE, body.encode("utf-8"))

    def _read_member(self) -> Optional[Dict[str, Any]]:
        path = self._path(MEMBER_FILE)
        if path is None or not os.path.isfile(path):
            return None
        m: Optional[Dict[str, Any]] = None
        try:
            with open(path, "rb") as f:
                value = json.loads(f.read().decode("utf-8"))
        except (OSError, ValueError):
            value = None
        if (
            isinstance(value, dict)
            and _integer(value.get("v")) == MEMBER_FILE_VERSION
            and value.get("product") == self.product
            and self.product != ""
        ):
            m = parse_presentation({"presentation": value.get("presentation")}, {"product": self.product})
            # Only a member this SDK wrote reads back: the parser's normal form, exactly.
            if m is not None and not _same(m, value.get("presentation")):
                m = None
        if m is None:
            _remove(path)
        return m


def named(member: Optional[Mapping[str, Any]]) -> Dict[str, bool]:
    """The icon hashes ``member`` names: the original's and each size's."""
    out: Dict[str, bool] = {}
    icon = member.get("icon") if isinstance(member, Mapping) else None
    if isinstance(icon, Mapping):
        out[str(icon.get("sha256"))] = True
        for s in icon.get("sizes") or []:
            out[str(s.get("sha256"))] = True
    return out


def _same(a: Any, b: Any) -> bool:
    """Deep equality over JSON-shaped values that tells a bool from a number (``True == 1`` in
    Python, never in JSON)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
