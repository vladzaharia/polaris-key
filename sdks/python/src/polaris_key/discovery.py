"""Product discovery: ``GET /<product>/.well-known/polaris.json`` — wire contract v3.

WHAT CHANGED FROM v2

The v2 document had a ``modules`` object each surface re-derived its own way, so it could
say a capability was on while its routes 404ed. v3 replaces it with a top-level
``services`` map keyed by the five service slugs, every entry a projection of one
authority (the product's ``services_json``), and a disabled service is
``{"enabled": false}`` and NOTHING ELSE — no endpoint list to read a disabled service's
shape out of.

The document is allowed to GROW: this parser validates the fields the SDK consumes and
preserves the rest verbatim, so a product publishing richer onboarding metadata is not
rejected by an SDK that predates it.

FAIL-CLOSED (D-21)

A slug the document omits reads as DISABLED, not as "unknown, assume on". That is the
point of parsing it at all: the SDK gates sub-client availability on this, so a service
that is not advertised must not be reachable. The offline fallback — what a client
believes before it has ever seen a document — is ``expected_services``, resolved in
:meth:`polaris_key.core.context.CoreContext.services`; discovery, once loaded, always wins.

A MALFORMED ``services`` value is a REJECTED DOCUMENT, not "assume defaults": silently
substituting the permissive default is exactly how a fail-closed gate becomes a
fail-open one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

__all__ = [
    "SERVICE_SLUGS",
    "DEFAULT_SERVICES",
    "NO_SERVICES",
    "ServicesMap",
    "copy_services",
    "services_from_list",
    "DiscoveryResult",
    "DiscoveryOk",
    "DiscoveryNotFound",
    "DiscoveryInvalid",
    "DiscoveryError",
    "parse_discovery",
    "discover_product",
    "appcast_url_from",
    "DISCOVERY_PATH",
]

#: The five opt-in services. Core is not a service — it is always on.
SERVICE_SLUGS = ("license", "config", "release", "update", "identity")

#: ``polaris.json`` lives beside the JWKS and the trust manifest under ``.well-known``.
DISCOVERY_PATH = ".well-known/polaris.json"

#: Per-service state as the SDK consumes it: ``{slug: {"enabled": bool}}``.
ServicesMap = Dict[str, Dict[str, bool]]


def _map(**enabled: bool) -> ServicesMap:
    return {slug: {"enabled": enabled.get(slug, False)} for slug in SERVICE_SLUGS}


#: What a client believes when it has neither a discovery document nor a stated
#: expectation: licensing + settings distribution, which is what every product ran before
#: the suite existed. Distribution and identity are OFF, so their sub-clients refuse until
#: something says otherwise — the fail-closed half of D-21 applied to the genuinely new
#: surfaces.
DEFAULT_SERVICES: ServicesMap = _map(license=True, config=True)

#: Everything off. The starting point for :func:`services_from_list`.
NO_SERVICES: ServicesMap = _map()


def copy_services(services: ServicesMap) -> ServicesMap:
    """A deep copy, so a caller holding a capability map cannot mutate a shared constant
    or the client's own resolved state."""
    return {
        slug: {"enabled": bool(services.get(slug, {}).get("enabled", False))}
        for slug in SERVICE_SLUGS
    }


def services_from_list(slugs: Iterable[str]) -> ServicesMap:
    """Turn a host's ``expected_services`` list into a full map — everything unlisted off."""
    out = _map()
    for slug in slugs:
        if slug in out:
            out[slug] = {"enabled": True}
    return out


@dataclass(frozen=True)
class DiscoveryOk:
    manifest: Dict[str, Any]
    services: ServicesMap
    kind: str = "ok"


@dataclass(frozen=True)
class DiscoveryNotFound:
    kind: str = "not-found"


@dataclass(frozen=True)
class DiscoveryInvalid:
    message: str
    kind: str = "invalid"


@dataclass(frozen=True)
class DiscoveryError:
    status: int
    message: str
    kind: str = "error"


DiscoveryResult = Any  # Union of the four above; kept loose for 3.9 compatibility.


def _optional_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _parse_services(value: Any) -> Optional[Dict[str, Dict[str, Any]]]:
    """Read the ``services`` map. Every slug gets an entry: present-and-enabled from the
    document, everything else ``{"enabled": False}``. Returns ``None`` for a malformed
    value, which the caller turns into a rejected document."""
    if not isinstance(value, dict):
        return None
    fragments: Dict[str, Dict[str, Any]] = {}
    for slug in SERVICE_SLUGS:
        raw = value.get(slug)
        if raw is None:
            fragments[slug] = {"enabled": False}
            continue
        if not isinstance(raw, dict):
            return None
        # `enabled` must be a real boolean. A truthy string ("false"!) reading as on is
        # the classic version of this bug.
        fragment = dict(raw)
        fragment["enabled"] = raw.get("enabled") is True
        fragments[slug] = fragment
    return fragments


def parse_discovery(value: Any, expected_product: str) -> DiscoveryResult:
    """Validate a discovery document body against the expected product slug."""
    if not isinstance(value, dict):
        return DiscoveryInvalid("Discovery document must be a JSON object.")
    product_record = value.get("product") if isinstance(value.get("product"), dict) else None
    product = (
        _optional_string(value.get("product"))
        or (_optional_string(product_record.get("slug")) if product_record else None)
        or _optional_string(value.get("slug"))
    )
    if not product:
        return DiscoveryInvalid("Discovery document is missing product.")
    if product != expected_product:
        return DiscoveryInvalid(
            f"Discovery document product {product} does not match {expected_product}."
        )
    fragments = _parse_services(value.get("services"))
    if fragments is None:
        return DiscoveryInvalid("Discovery services must be a map of service fragments.")
    if value.get("trust") is not None and not isinstance(value.get("trust"), dict):
        return DiscoveryInvalid("Discovery trust must be an object.")

    manifest = dict(value)
    manifest["product"] = product
    manifest["services"] = fragments
    return DiscoveryOk(
        manifest=manifest,
        services={slug: {"enabled": f["enabled"] is True} for slug, f in fragments.items()},
    )


def discover_product(
    *,
    base_url: str,
    product: str,
    client: Any,
    timeout: Any = None,
) -> DiscoveryResult:
    """Fetch and parse ``/<product>/.well-known/polaris.json``.

    ``client`` is an ``httpx.Client``-shaped object and ``timeout`` is passed through on
    the request, so discovery obeys the same per-request deadline every other Core call
    does (R4-08).
    """
    root = base_url.rstrip("/")
    url = f"{root}/{product}/{DISCOVERY_PATH}"
    try:
        res = client.get(url, timeout=timeout)
    except Exception as e:  # network error
        return DiscoveryError(status=0, message=str(e))

    if res.status_code == 404:
        return DiscoveryNotFound()
    if res.status_code < 200 or res.status_code >= 300:
        try:
            text = res.text
        except Exception:
            text = ""
        return DiscoveryError(status=res.status_code, message=text)
    try:
        body = res.json()
    except Exception:
        return DiscoveryInvalid("Discovery response is not valid JSON.")
    return parse_discovery(body, product)


def appcast_url_from(
    manifest: Dict[str, Any],
    *,
    channel: Optional[str] = None,
    arch: Optional[str] = None,
) -> Optional[str]:
    """The absolute appcast URL a Sparkle host should feed its updater.

    Taken from Update's PUBLISHED fragment rather than string-built by the caller (§R1
    moved these paths and left permanent aliases; a host that hard-codes one breaks the
    next time they move).
    """
    services = manifest.get("services")
    if not isinstance(services, dict):
        return None
    update = services.get("update")
    if not isinstance(update, dict) or update.get("enabled") is not True:
        return None
    endpoints = update.get("endpoints")
    base = endpoints.get("appcast") if isinstance(endpoints, dict) else None
    if not isinstance(base, str) or not base:
        return None

    parts = urlsplit(base)
    path = parts.path
    if channel and channel != "stable":
        # `/update/<channel>/appcast.xml` is a PATH, not a query parameter (§R1) — the
        # published endpoint is the stable feed, and a channel feed is its sibling.
        suffix = "/appcast.xml"
        if path.endswith(suffix):
            path = path[: -len(suffix)] + f"/{channel}/appcast.xml"
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if arch:
        query["arch"] = arch
    return urlunsplit(
        (parts.scheme, parts.netloc, path, urlencode(query), parts.fragment)
    )
