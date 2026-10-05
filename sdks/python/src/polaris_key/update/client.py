"""The Update sub-client — the FEED over Release's truth store (D-05, §R1), and wire v4's
signed update decision (plans/P3-01.md §2.5–§2.8).

  ``check()``          ``GET /<p>/update/version`` → what the newest build on this channel is,
                       plus whether the running version is behind it. The comparison uses
                       :func:`polaris_key.core.semver.compare_semver`, the same one the
                       server's build gate and every other SDK use — a version check that
                       disagreed with the gate would tell a user to update to a build the gate
                       blocks.
  ``appcast_url()``    the Sparkle feed URL, taken from DISCOVERY rather than string-built
                       here. §R1 moved these paths and left permanent aliases; a host that
                       hard-codes one breaks the next time they move, whereas the discovery
                       document is the product's own statement of where its feed lives.
  ``decide()``         wire v4: the signed channel feed (``pkey-feed+jws``), the release record
                       it pins (``pkey-release+jws``, fetched by hash), and the decision over
                       both — what a desktop tool or a CLI acts on ("verify, then stage").
  ``feed()``           the verified feed ``decide()`` would use, without the record.
  ``release_record()`` one release record by hash, verified against the PINNED release keys.
  ``build_url()``      the route an install downloads a build from (``distribution/builds``).

WHAT THIS MODULE DOES NOT DO

It verifies and decides nothing itself. The verification order, the ``seq`` floors, the
fallback after a refusal and the error map live in :mod:`polaris_key.core.check`
(``run_update_check``, over ``verify_feed``, ``verify_release_record`` and ``decide_update``),
a port of client-core's ``runUpdateCheck``. This module is transport (the discovery endpoints
and two GETs), storage (Core's read-modify-write of the ``feeds`` and ``releaseRecords`` cache
slices) and the mapping of host state onto the decision's inputs.

WHAT IT TRUSTS

* feeds verify against the EFFECTIVE product trust set (pins ∪ verified manifest keys), as
  documents do;
* records verify against ``UpdateClientOptions.pinned_release_keys`` only. That map is compiled
  into the host, never persisted, never merged with the product trust set and never extended
  from the network; a key that is also a trust pin raises ``invalid-options`` at construction;
* the clock is the EFFECTIVE clock, ``max(system, highWaterMark)`` (V3 §4.2), so winding the
  system clock back cannot revive an expired feed;
* the cache holds signed JWSs only. Every entry is re-verified before use, and each channel's
  floor is derived from the committed feed that survives, never read from a stored number.
"""

from __future__ import annotations

import platform as _platform
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

from ..constants_generated import (
    ARCH_VALUES,
    BINARY_METHOD_VALUES,
    MAX_RECORD_JWS_BYTES,
    PLATFORM_VALUES,
    ErrorCode,
    Feature,
    UnsupportedReason,
)
from ..core.b64url import b64url_decode
from ..core.check import FetchOutcome, run_update_check
from ..core.context import CoreContext
from ..core.decide import ResolvedOutlet, feed_target, is_valid_host_outlet, resolve_update_outlet
from ..core.detection import detect_outlet, detection_stamp
from ..core.errors import PolarisError
from ..core.feed import bound_channels, reload_feeds
from ..core.headers import canonical_arch, canonical_platform
from ..core.models import (
    ChannelFeedDoc,
    InstalledBuild,
    ReleaseRecordDoc,
    StagedUpdate,
    UpdateCheck,
    UpdateCheckError,
    UpdateOutlet,
)
from ..core.outlets import OUTLET_KINDS, OUTLET_SUBKINDS, OUTLET_UNKNOWN
from ..core.patterns import _full_match
from ..core.release_record import (
    DELEGATED_KID_PATTERN,
    ReleaseRecordPin,
    reload_release_records,
    verify_release_record,
)
from ..core.semver import compare_semver
from ..core.token import TokenManager
from ..discovery import appcast_url_from, update_endpoints_from
from .outlet import OutletReaderEnvironment, read_outlet_signals
from .packs.client import PacksClient, PacksOptions

__all__ = [
    "VersionCheck",
    "UpdateClient",
    "UpdateClientOptions",
    "UpdateError",
    "FeedCheck",
    "ReleaseRecordCheck",
]


@dataclass(frozen=True)
class VersionCheck:
    #: The newest version on the requested channel.
    version: str
    tag: str
    url: str
    #: Whether the host application's own version is older than ``version``.
    updateAvailable: bool


@dataclass(frozen=True)
class UpdateClientOptions:
    """Wire v4 update inputs (``PolarisKeyClient(update=...)``). The installed VERSION is the
    client's ``version``; everything else the decision needs about this install is here, and
    is validated when the client is constructed (a bad value raises ``invalid-options``).
    """

    #: ``kid`` → raw 32-byte Ed25519 release key, base64url (the trust-set encoding): the ONLY
    #: keys a release record verifies against. Two or more are valid at once during a rotation.
    #: Empty ⇒ ``decide()`` raises ``not-configured``; a key that is also a trust pin ⇒
    #: construction raises ``invalid-options`` (a release key is never a product key).
    pinned_release_keys: Mapping[str, str] = field(default_factory=dict)
    #: Where this install came from: a kind (``"direct"``, ``"steam"``, …), read as
    #: ``{id: kind, kind}``, or the product's outlet id with its kind,
    #: ``{"id": …, "kind": …, "subkind"?: …}``. It wins over ``stamp`` and ``detected``.
    #: Without it the client detects the outlet (``detect``); with no stamp and no attested
    #: evidence the outlet is ``unknown``, which is never offered an update. A pip-installed
    #: tool is ``"direct"`` (with no subkind).
    outlet: Any = None
    #: The build stamp's outlet fields (``outlet``, ``outletKind``, ``outletSubkind``), and
    #: the product's ``outletIds`` that launcher signals must name.
    stamp: Optional[Mapping[str, Any]] = None
    #: An outlet detection result the host computed itself (``{"kind": …, "subkind": …}``).
    #: When it is absent and ``outlet`` is too, the client detects in-process (``detect``).
    detected: Optional[Mapping[str, Any]] = None
    #: Detect the outlet when neither ``outlet`` nor ``detected`` is given: this process's
    #: signals (``read_outlet_signals``) and the stamp, through ``detect_outlet``, whose
    #: result goes to ``resolve_update_outlet`` as ``detected`` (plans/P3-01.md §2.9).
    detect: bool = True
    #: What the readers look at; this process by default (tests pass a fake install).
    outlet_environment: Optional[OutletReaderEnvironment] = None
    #: The installed build's build number (informational in v4).
    build_number: Optional[str] = None
    #: The installed build's format (``"zip"``, ``"dmg"``, ``"whl"``, …): a binary build of
    #: another format is never offered. ``None`` (the default) accepts any format.
    format: Optional[str] = None
    #: What this host can do with a ``binary`` decision. Default ``("download",)``.
    methods: Sequence[str] = ("download",)
    #: The executable's version when it differs from the client's ``version``.
    binary_version: Optional[str] = None
    #: ``godot-<major>.<minor>`` for a host that runs Godot code packs; ``None`` otherwise.
    engine: Optional[str] = None
    #: The install's platform. Defaults to ``platform.system()``'s canonical value.
    platform: Optional[str] = None
    #: The device's architecture. Defaults to ``platform.machine()``'s canonical value.
    arch: Optional[str] = None
    #: Packs (``client.update.packs``, plans/P4-01.md §2.6–§2.9): the content stamp, embedded
    #: baselines, variant preferences and the store directory. Pack records verify against
    #: ``pinned_release_keys``.
    packs: Optional[PacksOptions] = None


class UpdateError(PolarisError):
    """The error ``decide()``, ``feed()`` and ``release_record()`` raise when there is nothing to
    decide from (plans/P3-01.md §2.5's error map): ``feed-rejected`` (with the step as
    ``detail``), ``feed-rollback``, ``record-rejected``, ``record-mismatch``, ``network-error``
    or the Worker's own wire code. The options refusals (``not-configured``,
    ``invalid-options``) and step 1's ``service-unavailable`` are this class too, with a
    ``None`` ``detail``."""

    def __init__(self, code: str, message: str, detail: Optional[str] = None) -> None:
        super().__init__(code, message)
        self.detail = detail


@dataclass(frozen=True)
class FeedCheck:
    """``client.update.feed()``'s answer: the verified feed ``decide()`` would decide from."""

    #: The canonical channel: the feed's own ``channel`` claim.
    channel: str
    feed: ChannelFeedDoc
    #: ``"network"`` when the fetched copy was committed or equals the committed one;
    #: ``"committed"`` when the earlier copy was used instead.
    source: str
    errors: Tuple[UpdateCheckError, ...] = ()


@dataclass(frozen=True)
class ReleaseRecordCheck:
    """``client.update.release_record()``'s answer."""

    sha256: str
    record: ReleaseRecordDoc
    #: ``"network"`` or ``"cache"``.
    source: str
    #: True when a committed feed's target for this platform pins the hash: the record was
    #: cross-checked against that pin and committed to the cache.
    pinned: bool


@dataclass(frozen=True)
class _Configured:
    release_keys: Dict[str, str]
    outlet: ResolvedOutlet
    detected: Optional[Dict[str, Any]]
    methods: Tuple[str, ...]
    opts: UpdateClientOptions


#: A code ``run_update_check`` never produces: ``feed()`` withholds the record fetch with it.
_RECORD_WITHHELD = "record-withheld"


#: ``UpdateClient._feed_menu`` before any check ran or the cache was read.
_UNSET: Any = object()


def _invalid(message: str) -> UpdateError:
    return UpdateError(ErrorCode.INVALID_OPTIONS, message)


def _raw_key(b64url: Any) -> Optional[bytes]:
    """A key's raw 32 bytes, for comparing keys by their bytes; ``None`` when it is not one."""
    if not isinstance(b64url, str):
        return None
    try:
        raw = b64url_decode(b64url)
    except Exception:
        return None
    return raw if len(raw) == 32 else None


def _optional_string(v: Any) -> bool:
    return v is None or isinstance(v, str)


def _coerce_options(opts: Any) -> UpdateClientOptions:
    if isinstance(opts, UpdateClientOptions):
        return opts
    if isinstance(opts, Mapping):
        try:
            return UpdateClientOptions(**dict(opts))
        except TypeError as e:
            raise _invalid(f"update options: {e}") from None
    raise _invalid("update must be UpdateClientOptions or a mapping of its fields.")


def _configure(raw: Any, pinned_trust: Mapping[str, str]) -> _Configured:
    """Validate the update options against the trust pins. Raises ``invalid-options``
    (plans/P3-01.md §2.6, §2.8): an outlet outside the vocabularies, a method outside
    ``BINARY_METHODS``, a platform or arch outside the enums, or a pinned release key whose raw
    bytes are also a trust pin."""
    opts = _coerce_options(raw)
    keys = opts.pinned_release_keys if opts.pinned_release_keys is not None else {}
    if not isinstance(keys, Mapping) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in keys.items()
    ):
        raise _invalid("update.pinned_release_keys must map kid to a base64url key.")
    release_keys = dict(keys)
    # plans/P4-19.md §2.2: a delegated kid is never a pinned release key.
    if any(_full_match(DELEGATED_KID_PATTERN, kid) is not None for kid in release_keys):
        raise _invalid(
            "update.pinned_release_keys names a pkd1- kid: a delegated content key is reached "
            "only through a delegation, never pinned."
        )
    pins = {raw for raw in (_raw_key(k) for k in pinned_trust.values()) if raw is not None}
    for k in release_keys.values():
        raw_key = _raw_key(k)
        if raw_key is not None and raw_key in pins:
            raise _invalid(
                "A pinned release key is also a trust pin; a release key is never a product key."
            )
    if opts.outlet is not None and not is_valid_host_outlet(opts.outlet):
        raise _invalid("update.outlet is not an outlet kind or {id, kind, subkind?}.")
    if opts.detected is not None:
        d = opts.detected
        if (
            not isinstance(d, Mapping)
            or not isinstance(d.get("kind"), str)
            or d["kind"] not in (*OUTLET_KINDS, OUTLET_UNKNOWN)
            or not (d.get("subkind") is None or d.get("subkind") in OUTLET_SUBKINDS)
        ):
            raise _invalid("update.detected is not an outlet detection result.")
    if opts.stamp is not None and not isinstance(opts.stamp, Mapping):
        raise _invalid("update.stamp must be a mapping.")
    methods = opts.methods if opts.methods is not None else ("download",)
    if isinstance(methods, (str, bytes)) or not isinstance(methods, Sequence) or any(
        not isinstance(m, str) or m not in BINARY_METHOD_VALUES for m in methods
    ):
        raise _invalid(f"update.methods must be a subset of {', '.join(BINARY_METHOD_VALUES)}.")
    if opts.platform is not None and opts.platform not in PLATFORM_VALUES:
        raise _invalid(f"update.platform must be one of {', '.join(PLATFORM_VALUES)}.")
    if opts.arch is not None and opts.arch not in ARCH_VALUES:
        raise _invalid(f"update.arch must be one of {', '.join(ARCH_VALUES)}.")
    if not (
        _optional_string(opts.build_number)
        and _optional_string(opts.format)
        and _optional_string(opts.engine)
        and _optional_string(opts.binary_version)
    ):
        raise _invalid("update.build_number, format, engine and binary_version must be strings.")
    if not isinstance(opts.detect, bool):
        raise _invalid("update.detect must be a boolean.")
    if opts.outlet_environment is not None and not isinstance(
        opts.outlet_environment, OutletReaderEnvironment
    ):
        raise _invalid("update.outlet_environment must be an OutletReaderEnvironment.")
    detected: Optional[Dict[str, Any]] = dict(opts.detected) if opts.detected is not None else None
    # §2.9: detection runs at every launch and is never cached; a host value always wins.
    if opts.outlet is None and detected is None and opts.detect:
        stamp = detection_stamp(opts.stamp)
        detected = detect_outlet(
            stamp=stamp,
            signals=read_outlet_signals(
                opts.outlet_environment,
                outlet_ids=stamp["outletIds"] if stamp is not None else None,
            ),
        )
    outlet = resolve_update_outlet(host=opts.outlet, stamp=opts.stamp, detected=detected)
    if outlet is None:
        raise _invalid("update.outlet is not a valid outlet.")
    return _Configured(
        release_keys=release_keys,
        outlet=outlet,
        detected=detected,
        methods=tuple(methods),
        opts=opts,
    )


def _expand(template: str, base_url: str, values: Mapping[str, str]) -> str:
    """Substitute ``{name}`` placeholders, each percent-encoded as ``encodeURIComponent``
    does, and resolve against the control plane (a template is normally absolute already)."""
    out = template
    for k, v in values.items():
        out = out.replace("{" + k + "}", quote(v, safe="-_.!~*'()"))
    return urljoin(base_url.rstrip("/") + "/", out)


def _with_query(url: str, name: str, value: str) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query[name] = value
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _origin(url: str) -> Tuple[str, str]:
    parts = urlsplit(url)
    return (parts.scheme.lower(), parts.netloc.lower())


def _wire_code_of(body: bytes) -> Optional[str]:
    """The wire code a refusal body names (``{"error": {"code"}}`` or ``{"error": "code"}``)."""
    import json

    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    e = parsed.get("error")
    if isinstance(e, str) and e:
        return e
    if isinstance(e, dict) and isinstance(e.get("code"), str) and e["code"]:
        return e["code"]
    return None


#: The updater feeds :meth:`UpdateClient.feed_url` expands (discovery ``update.endpoints``).
FEED_KINDS = ("appcast", "winsparkle", "velopack", "appInstaller", "zsync")


class UpdateClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        discovery: Callable[[], Optional[Dict[str, Any]]],
        *,
        cache: Any = None,
        trust: Any = None,
        discover: Optional[Callable[[], Any]] = None,
        options: Any = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._discovery = discovery
        self._cache = cache
        self._trust = trust
        self._discover_now = discover
        self._configured: Optional[_Configured] = (
            None if options is None else _configure(options, ctx.pinned_trust)
        )
        #: The v4 calls run one at a time: each is a read-modify-write of the cache slices.
        self._lock = threading.RLock()
        #: The update-health journal (SDK parity pass §3.13), set by the facade: a decision
        #: offering a newer build records ``update_offered`` once per release.
        self.journal: Any = None
        #: plans/P4-29.md §2.4 step 1: the delta menu of the most recently committed feed, fresh
        #: or stale (``_UNSET`` until a check ran or the cache was read).
        self._feed_menu: Any = _UNSET
        packs_opts = _coerce_options(options).packs if options is not None else None
        if packs_opts is not None and not isinstance(packs_opts, PacksOptions):
            if isinstance(packs_opts, Mapping):
                try:
                    packs_opts = PacksOptions(**dict(packs_opts))
                except TypeError as e:
                    raise _invalid(f"update.packs: {e}") from None
            else:
                raise _invalid("update.packs must be PacksOptions or a mapping of its fields.")
        #: The pack facet (``ensure``, ``state``, ``register_handler``, progress events).
        self.packs = PacksClient(
            ctx,
            tokens,
            discovery,
            release_keys=lambda: dict(self._configured.release_keys) if self._configured else {},
            discover=discover,
            cache=cache,
            trust=trust,
            options=packs_opts,
            feed_deltas=lambda: None if self._feed_menu is _UNSET else self._feed_menu,
            load_feed_deltas=self._load_feed_menu,
        )

    @property
    def outlet(self) -> Optional[ResolvedOutlet]:
        """The outlet ``decide()`` uses (``resolve_update_outlet``'s answer), or ``None``
        without update options. For support diagnostics and UI."""
        return self._configured.outlet if self._configured else None

    @property
    def detected(self) -> Optional[Dict[str, Any]]:
        """The detection result ``outlet`` was resolved from (in-process, or the host's
        ``detected``); ``None`` when the host named the outlet, turned detection off, or
        configured no updates."""
        c = self._configured
        return dict(c.detected) if c is not None and c.detected is not None else None

    def check(self, *, channel: Optional[str] = None) -> VersionCheck:
        """``GET /<p>/update/version`` — the newest build, and whether we are behind it.

        ``updateAvailable`` is computed from the CoreContext's ``version``, the HOST
        APPLICATION's version, not the SDK's: the SDK ships inside the thing being
        updated.
        """
        self._ctx.require_service("update", Feature.UPDATE_CHECK)
        url = self._ctx.url("update/version")
        if channel:
            parts = urlsplit(url)
            query = dict(parse_qsl(parts.query, keep_blank_values=True))
            query["channel"] = channel
            url = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
            )

        token = self._tokens.current
        extra = {"authorization": f"Bearer {token}"} if token else {}
        res = self._ctx.request("GET", url, headers=self._ctx.headers(extra))
        if res.status_code == 403:
            body = _json_or_empty(res)
            error = body.get("error") if isinstance(body.get("error"), dict) else {}
            raise PolarisError(
                error.get("code") or "forbidden",
                "This build is not entitled to that update channel.",
            )
        if not res.is_success:
            raise PolarisError(
                "not_found", f"update/version failed with status {res.status_code}."
            )
        body = _json_or_empty(res)
        version = str(body.get("version", ""))
        return VersionCheck(
            version=version,
            tag=str(body.get("tag", "")),
            url=str(body.get("url", "")),
            updateAvailable=compare_semver(self._ctx.version, version) < 0,
        )

    def appcast_url(
        self, *, channel: Optional[str] = None, arch: Optional[str] = None
    ) -> Optional[str]:
        """The Sparkle appcast URL for this product, from the discovery document.

        Returns ``None`` when discovery has not been loaded or Update is not enabled —
        the same fail-closed posture the sub-client gate takes, expressed as a VALUE
        because a host asking "where is my feed?" before discovery has run is a sequencing
        question, not an error.
        """
        manifest = self._discovery()
        if manifest is None:
            return None
        return appcast_url_from(manifest, channel=channel, arch=arch)

    def feed_url(
        self,
        kind: str,
        *,
        channel: Optional[str] = None,
        velopack_channel: Optional[str] = None,
        build_id: Optional[str] = None,
        arch: Optional[str] = None,
    ) -> Any:
        """A native updater's feed URL (SDK parity pass §3.7), expanded from discovery's
        ``update.endpoints`` templates: ``kind`` is ``appcast`` (Sparkle; ``arch`` adds
        ``?arch=``), ``winsparkle``, ``velopack`` (``velopack_channel``: the channel the app was
        packed with, e.g. ``win-x64``), ``appInstaller`` or ``zsync`` (``build_id``: an AppImage
        build's artifact-map id). ``channel`` defaults to the client's.

        Returns the URL string, or a typed :class:`~polaris_key.core.caps.Unsupported` with
        reason ``product`` when discovery is not loaded, the product runs no Update service or
        its document names no template for ``kind`` (an older Worker). Raises
        ``invalid-options`` for an unknown ``kind`` or a missing placeholder value."""
        from ..core.caps import Unsupported

        if kind not in FEED_KINDS:
            raise _invalid(f"feed kind must be one of {', '.join(FEED_KINDS)}")
        channel = channel or self._ctx.channel
        manifest = self._discovery()

        def unsupported(why: str) -> Unsupported:
            return Unsupported(Feature.UPDATE_DRIVER, UnsupportedReason.PRODUCT, why)

        if manifest is None:
            return unsupported("discovery has not been loaded (call client.discover())")
        if kind == "appcast":
            url = appcast_url_from(manifest, channel=channel, arch=arch)
            return url if url is not None else unsupported("the product publishes no appcast")
        from ..discovery import service_endpoint

        template = service_endpoint(manifest, "update", kind)
        if template is None:
            return unsupported(f"the product's discovery document names no {kind} feed")
        values = {"channel": channel}
        if "{velopackChannel}" in template:
            if not velopack_channel:
                raise _invalid("a velopack feed needs velopack_channel (e.g. win-x64)")
            values["velopackChannel"] = velopack_channel
        if "{buildId}" in template:
            if not build_id:
                raise _invalid("a zsync feed needs build_id")
            values["buildId"] = build_id
        return _expand(template, self._ctx.base_url, values)

    # ── Wire v4 ─────────────────────────────────────────────────────────────────────────

    def decide(
        self,
        *,
        channel: Optional[str] = None,
        staged: Optional[StagedUpdate] = None,
        skip_version: Optional[str] = None,
    ) -> UpdateCheck:
        """The signed update decision (plans/P3-01.md §2.5 steps 1–18).

        Fetch the channel feed, verify it against the effective product trust set and the
        channel's ``seq`` floor, commit it, fetch the release record it pins for this platform
        (hash before signature, pinned release keys only), and decide. ``channel`` is the name
        to REQUEST (an alias such as ``latest`` is fine; default: the client's channel).
        Returns the :class:`~polaris_key.core.models.UpdateCheck` — ``channel`` (the canonical
        channel a host records as ``StagedUpdate.channel``), ``decision``, ``feed``,
        ``record`` and ``errors``.

        After a refusal it decides from the committed feed, reporting the refusal in
        ``errors``; a record that cannot be fetched or is refused is ``None`` for the call. It
        raises :class:`UpdateError` only when it has nothing to decide from, and for
        ``not-configured`` (no ``pinned_release_keys``), ``service-unavailable`` (the product
        runs no Update service, or its discovery document has no v4 endpoints — fall back to
        :meth:`check`) and ``local-only``.

        A ``mandatory`` decision and every ``blocked`` one is a prompt the player cannot
        dismiss (:func:`polaris_key.core.decide.is_undismissable`): persistent, never covering
        the running app.

        With a content stamp (``UpdateClientOptions.packs``), the check also runs the content
        decision (plans/P4-13.md §2.5, §2.6): the feed's pack sets, floors and revocations, the
        revocations the device stores (learned ones are kept through ``packs``), and the
        ``packs`` answer. Floors never stop play; a CI-signed revocation of a REQUIRED pack does:
        ``blocked {revoked-content}`` (or an offer with ``contentBlock: "revoked-content"``)
        maps to the boot value ``required``.
        """
        with self._lock:
            c = self._require_configured()
            cache, trust = self._require_custody()
            self._ctx.require_service("update", Feature.UPDATE_DECIDE)
            self._ctx.http()  # a local-only client refuses here, before anything is built
            installed = self._installed()
            ep = self._endpoints(feed=True, record=True)
            fetch_feed, fetch_record = self._fetchers(ep, installed.platform)
            slices = cache.update_slices()
            # plans/P4-13.md §2.5: a host with a content stamp runs the content decision. A pack
            # facet that cannot start (an unreadable stamp) decides without it, as before P4-13.
            try:
                content = self.packs.content_input()
            except Exception:
                content = None
            r = run_update_check(
                content=content,
                channel=channel or self._ctx.channel,
                expected_aud=self._ctx.product,
                trust=trust.effective,
                release_keys=c.release_keys,
                # §2.5: the effective clock, max(system, highWaterMark) (V3 §4.2).
                now=self._ctx.now(),
                install_id=self._ctx.device_id or None,
                installed=installed,
                outlet=UpdateOutlet(id=c.outlet.id, kind=c.outlet.kind),
                subkind=c.outlet.subkind,
                staged=staged,
                skip_version=skip_version,
                methods=c.methods,
                cache_feeds=slices["feeds"],
                cache_release_records=slices["releaseRecords"],
                fetch_feed=fetch_feed,
                fetch_record=fetch_record,
            )
            if not r.ok or r.check is None:
                raise self._raise(r.error)
            cache.patch(feeds=r.feeds, release_records=r.release_records)
            self._feed_menu = r.content.deltas if r.content is not None else None
            if r.revocations is not None:
                self.packs.record_revocations(r.revocations)
            self._journal_offer(r.check)
            return r.check

    def _journal_offer(self, check: UpdateCheck) -> None:
        """``update_offered`` for a decision that offers a newer app build (``binary``,
        ``code-ready``, ``store`` or ``platform`` with a release), once per release."""
        journal = self.journal
        d = check.decision
        if journal is None or d.release is None:
            return
        if d.action not in ("binary", "code-ready", "store", "platform"):
            return
        try:
            journal.offered(
                d.release.version, from_release=self._ctx.version, channel=check.channel
            )
        except Exception:
            pass  # telemetry never fails a decision

    def feed(self, *, channel: Optional[str] = None) -> FeedCheck:
        """The verified feed ``decide()`` would decide from (§2.5 steps 1–10), without the
        record. It runs the same steps by the same function, commits an accepted feed the same
        way and falls back to the committed feed the same way; it needs no release keys."""
        with self._lock:
            cache, trust = self._require_custody()
            self._ctx.require_service("update", Feature.UPDATE_FEED)
            self._ctx.http()
            installed = self._installed()
            ep = self._endpoints(feed=True, record=False)
            fetch_feed, _ = self._fetchers(ep, installed.platform)
            slices = cache.update_slices()
            r = run_update_check(
                channel=channel or self._ctx.channel,
                expected_aud=self._ctx.product,
                trust=trust.effective,
                release_keys=dict(self._configured.release_keys) if self._configured else {},
                now=self._ctx.now(),
                install_id=None,
                installed=installed,
                outlet=UpdateOutlet(id=None, kind=OUTLET_UNKNOWN),
                subkind=None,
                methods=(),
                cache_feeds=slices["feeds"],
                cache_release_records=None,
                fetch_feed=fetch_feed,
                fetch_record=lambda _sha: FetchOutcome(ok=False, code=_RECORD_WITHHELD),
            )
            if not r.ok or r.check is None or r.feed is None:
                raise self._raise(r.error)
            cache.patch(feeds=r.feeds)
            self._feed_menu = r.content.deltas if r.content is not None else None
            return FeedCheck(
                channel=r.check.channel,
                feed=r.feed,
                source=r.check.feed,
                errors=tuple(e for e in r.check.errors if e.code != _RECORD_WITHHELD),
            )

    def release_record(self, sha256: str) -> ReleaseRecordCheck:
        """One release record by its lowercase hex SHA-256 (§2.5 steps 11–16): from the cache,
        else ``GET …/release/records/{sha256}``; the body's hash must equal ``sha256`` before
        any signature work, and the signature must come from a PINNED release key. When a
        committed feed's target for this platform pins the hash, the record is cross-checked
        against that pin and committed; otherwise it is verified only. Raises
        ``record-rejected`` (``detail``: ``hash``, ``jws`` or ``claims``), ``record-mismatch``,
        a transport code, ``not-configured`` or ``service-unavailable``."""
        with self._lock:
            c = self._require_configured()
            cache, trust = self._require_custody()
            self._ctx.require_service("release", Feature.RELEASE_RECORD)
            self._ctx.http()
            installed = self._installed()
            ep = self._endpoints(feed=False, record=True)
            _, fetch_record = self._fetchers(ep, installed.platform)
            slices = cache.update_slices()

            # The pin, from a committed feed that still verifies (the reload path).
            committed = reload_feeds(
                slices["feeds"],
                trust=trust.effective,
                expected_aud=self._ctx.product,
                platform=installed.platform,
            )
            pin: Optional[ReleaseRecordPin] = None
            for cf in committed.feeds.values():
                t = feed_target(cf.feed.app.targets, installed.platform)
                if t is not None and t.release.sha256 == sha256:
                    pin = ReleaseRecordPin(
                        deliverable="app", version=t.release.version, seq=t.release.seq
                    )
                    break

            def verify(jws: str):  # type: ignore[no-untyped-def]
                return verify_release_record(
                    jws,
                    release_keys=c.release_keys,
                    product_trust=trust.effective,
                    expected_aud=self._ctx.product,
                    expected_hash=sha256,
                    pin=pin,
                )

            cached = slices["releaseRecords"].get(sha256)
            if cached is not None:
                r = verify(cached)
                if r.ok and r.record is not None:
                    return ReleaseRecordCheck(
                        sha256=sha256, record=r.record, source="cache", pinned=pin is not None
                    )

            got = fetch_record(sha256)
            if not got.ok:
                raise self._raise(UpdateCheckError(code=got.code or ErrorCode.NETWORK_ERROR))
            r = verify(got.body or "")
            if not r.ok or r.record is None:
                raise self._raise(
                    UpdateCheckError(code=ErrorCode.RECORD_MISMATCH)
                    if r.step == "cross-check"
                    else UpdateCheckError(code=ErrorCode.RECORD_REJECTED, detail=r.step)
                )
            if pin is not None:
                cache.patch(
                    release_records={**slices["releaseRecords"], sha256: got.body or ""}
                )
            return ReleaseRecordCheck(
                sha256=sha256, record=r.record, source="network", pinned=pin is not None
            )

    def build_url(self, version: str, build_id: str) -> Optional[str]:
        """A build's download URL (plans/P3-01.md §2.4 "Bytes", decision 5): discovery's
        ``distribution.endpoints.builds``, else Release's ``release.endpoints.builds``, with
        ``{selector}`` = the record's ``version`` and ``{buildId}`` = the build's ``id``, each
        percent-encoded. That route serves the build's payload from every location it has; the
        R2-only blob route is never used. Verify the bytes against the record's ``size`` and
        ``sha256`` before staging. ``None`` when discovery has not been loaded or names neither
        template."""
        template = update_endpoints_from(self._discovery()).builds
        if template is None:
            return None
        return _expand(template, self._ctx.base_url, {"selector": version, "buildId": build_id})

    def reload(self) -> None:
        """The reload path (§2.5 "Reload path") over the stored slices, run by ``init()``
        after the cache load: every committed feed is re-verified (steps 3–6, no freshness,
        its claim equal to its key) and every record against the pinned release keys, kept
        only while a surviving feed pins it. What fails is dropped from the in-memory record.
        Without release keys the records are left for ``decide()`` to judge."""
        with self._lock:
            cache, trust = self._cache, self._trust
            platform = self._platform_value()
            if cache is None or trust is None or platform is None:
                return
            slices = cache.update_slices()
            reloaded = reload_feeds(
                slices["feeds"],
                trust=trust.effective,
                expected_aud=self._ctx.product,
                platform=platform,
            )
            feeds: Dict[str, str] = {}
            pinned = set()
            for k, cf in reloaded.feeds.items():
                feeds[k] = cf.jws
                t = feed_target(cf.feed.app.targets, platform)
                if t is not None:
                    pinned.add(t.release.sha256)
            records = slices["releaseRecords"]
            keys = self._configured.release_keys if self._configured else {}
            if keys:
                kept = reload_release_records(
                    records,
                    release_keys=keys,
                    product_trust=trust.effective,
                    expected_aud=self._ctx.product,
                    pinned=pinned,
                )
                records = {h: cr.jws for h, cr in kept.items()}
            cache.keep_update_slices(feeds=feeds, release_records=records)

    # ── Internals ───────────────────────────────────────────────────────────────────────

    def _load_feed_menu(self) -> None:
        """plans/P4-29.md §2.4 step 1: before any check this process, the menu of the committed
        feed of the configured channel, re-verified on the reload path (no freshness: a stale
        menu only falls back). Never raises; no cache or no committed feed is no menu."""
        if self._feed_menu is not _UNSET:
            return
        try:
            cache, trust = self._require_custody()
            platform = self._platform_value()
            if platform is None:
                return
            committed = reload_feeds(
                cache.update_slices()["feeds"],
                trust=trust.effective,
                expected_aud=self._ctx.product,
                platform=platform,
            )
            if self._feed_menu is not _UNSET:
                return
            for k in bound_channels(self._ctx.channel):
                cf = committed.feeds.get(k)
                if cf is not None:
                    self._feed_menu = cf.content.deltas if cf.content is not None else None
                    return
        except Exception:
            pass  # No menu: the record's deltas only.

    def _require_configured(self) -> _Configured:
        c = self._configured
        if c is None or not c.release_keys:
            raise UpdateError(
                ErrorCode.NOT_CONFIGURED, "Update decisions need update.pinned_release_keys."
            )
        return c

    def _require_custody(self) -> Tuple[Any, Any]:
        if self._cache is None or self._trust is None:
            raise UpdateError(
                ErrorCode.NOT_CONFIGURED,
                "This update client has no cache; construct it through PolarisKeyClient.",
            )
        return self._cache, self._trust

    def _platform_value(self) -> Optional[str]:
        """The install's canonical platform, or ``None`` when this OS has none and the host
        set none."""
        opts = self._configured.opts if self._configured else None
        if opts is not None and opts.platform is not None:
            return opts.platform
        return canonical_platform(_platform.system())

    def _installed(self) -> InstalledBuild:
        opts = self._configured.opts if self._configured else UpdateClientOptions()
        platform_value = self._platform_value()
        arch = opts.arch if opts.arch is not None else canonical_arch(_platform.machine())
        if platform_value is None or arch is None:
            raise UpdateError(
                ErrorCode.NOT_CONFIGURED,
                f"This host's platform or arch ({_platform.system()}/{_platform.machine()}) "
                "has no canonical value; set update.platform and update.arch.",
            )
        return InstalledBuild(
            version=self._ctx.version,
            platform=platform_value,
            arch=arch,
            buildNumber=opts.build_number,
            format=opts.format,
            engine=opts.engine,
            binaryVersion=opts.binary_version,
        )

    def _endpoints(self, *, feed: bool, record: bool) -> Optional[Dict[str, str]]:
        """§2.5 step 1: the feed and record templates from discovery, loading discovery first
        when this session has not. A loaded document that lacks a needed one is refused as
        ``service-unavailable`` before dialling. When discovery itself cannot be reached,
        ``None``: the fetches then fail as a transport failure, and the decision comes from the
        committed feed."""
        doc = self._discovery()
        if doc is None and self._discover_now is not None:
            try:
                self._discover_now()
            except PolarisError as e:
                if e.code == ErrorCode.LOCAL_ONLY:
                    raise
            except Exception:
                pass
            doc = self._discovery()
        if doc is None:
            return None
        ep = update_endpoints_from(doc)
        if (feed and ep.feed is None) or (record and ep.record is None):
            raise UpdateError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "This Worker serves no signed update feed (wire v4); use update.check().",
            )
        return {"feed": ep.feed or "", "record": ep.record or ""}

    def _get_jose(self, url: Optional[str], max_bytes: Optional[int] = None) -> FetchOutcome:
        """One ``application/jose`` GET. Never raises: a transport failure or a non-2xx answer
        is the Worker's wire code when its body names one, else ``network-error``. With
        ``max_bytes``, at most ``max_bytes + 1`` bytes are read (§2.5 step 11): a longer body
        cannot be a record any feed pins, and the verifier refuses the prefix at step ``hash``
        without hashing it. The device bearer goes only to the control plane's own origin, never
        to a host a discovery document named."""
        if url is None:
            return FetchOutcome(ok=False, code=ErrorCode.NETWORK_ERROR)
        try:
            token = self._tokens.current
            same_origin = _origin(url) == _origin(self._ctx.base_url)
            extra = {"accept": "application/jose"}
            if token and same_origin:
                extra["authorization"] = f"Bearer {token}"
            with self._ctx.http().stream(
                "GET", url, headers=self._ctx.headers(extra), timeout=self._ctx.timeout
            ) as res:
                if not res.is_success:
                    return FetchOutcome(
                        ok=False,
                        code=_wire_code_of(res.read()) or ErrorCode.NETWORK_ERROR,
                    )
                if max_bytes is None:
                    data = res.read()
                else:
                    limit = max_bytes + 1
                    chunks: List[bytes] = []
                    total = 0
                    for chunk in res.iter_bytes():
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= limit:
                            break
                    data = b"".join(chunks)[:limit]
            return FetchOutcome(ok=True, body=data.decode("utf-8", errors="replace"))
        except Exception:
            return FetchOutcome(ok=False, code=ErrorCode.NETWORK_ERROR)

    def _fetchers(
        self, ep: Optional[Dict[str, str]], platform: str
    ) -> Tuple[Callable[[str], FetchOutcome], Callable[[str], FetchOutcome]]:
        """§2.5 steps 2 and 11 over the discovered templates (``None``: discovery was
        unreachable)."""
        base = self._ctx.base_url

        def fetch_feed(channel: str) -> FetchOutcome:
            if ep is None:
                return self._get_jose(None)
            url = _expand(ep["feed"], base, {"channel": channel})
            return self._get_jose(_with_query(url, "platform", platform))

        def fetch_record(sha256: str) -> FetchOutcome:
            url = None if ep is None else _expand(ep["record"], base, {"sha256": sha256})
            return self._get_jose(url, MAX_RECORD_JWS_BYTES)

        return fetch_feed, fetch_record

    @staticmethod
    def _raise(error: Optional[UpdateCheckError]) -> UpdateError:
        if error is None:
            return UpdateError(ErrorCode.FEED_REJECTED, "update: feed-rejected")
        message = (
            f"update: {error.code} ({error.detail})" if error.detail else f"update: {error.code}"
        )
        return UpdateError(error.code, message, error.detail)


def _json_or_empty(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}
