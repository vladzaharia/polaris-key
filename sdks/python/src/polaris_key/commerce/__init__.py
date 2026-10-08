"""``client.commerce`` — store purchases become licence flags (P6-01; SDK parity pass §3.9).

The store sells; the Worker verifies the purchase with the store and puts the mapped flag on
the player's licence for every release of the deliverable, until a refund or revocation. The
device only forwards what its store handed it, so this is plain HTTP and needs no store SDK:

* :meth:`CommerceClient.binding` — ``GET /<p>/distribution/commerce/binding``: the licence's
  opaque purchase binding and the store products on sale. Call it BEFORE buying and hand
  ``bindingId`` to the store (Steam: ``GetAuthTicketForWebApi(bindingId)``; Play:
  ``obfuscatedAccountId``; App Store: ``appAccountToken``).
* :meth:`CommerceClient.claim` — ``POST /<p>/distribution/commerce/claim``: forward one
  purchase. A :class:`ClaimOk` means the next licence document carries the flag; ``claim``
  itself does not sync (the host decides when), the one-call helpers below do.
* :meth:`CommerceClient.claim_steam`, :meth:`~CommerceClient.claim_play`,
  :meth:`~CommerceClient.claim_app_store` — build the store's payload, claim, and on success
  run ``sync(force=True)`` so the flag is live when they return.

Refusals keep the server's code and ``reason``: :class:`ClaimNotOwned` (``forbidden`` +
``not_owned``), :class:`ClaimAttestationRequired` (``attestation_required``; CPython has no
attestation service, so this is final here) and :class:`ClaimRefused` for everything else
(``not_entitled`` + ``no_license`` — enrol first; ``forbidden`` + ``binding_mismatch`` /
``bound_elsewhere`` / ``unbound``; ``bad_request`` + a store reason such as
``invalid_ticket``; ``unavailable`` — the store could not be reached, retry later;
``not_found`` — commerce is not set up for this store). Nothing is retried automatically.

Both calls need the License and Distribution services (``service-unavailable`` otherwise) and a
device token (``no-token``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple, Union

import httpx

from ..constants_generated import Feature
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.token import TokenManager

__all__ = [
    "CommerceClient",
    "CommerceBinding",
    "CommerceProduct",
    "ClaimOk",
    "ClaimNotOwned",
    "ClaimAttestationRequired",
    "ClaimRefused",
    "ClaimResult",
    "STORES",
    "hidden_on",
]

#: The stores the claim route accepts.
STORES = ("app-store", "play", "steam")
#: The outlet kinds whose purchases go through the App Store's in-app purchase.
APPLE_OUTLETS = ("app-store", "testflight")

_UUID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")


@dataclass(frozen=True)
class CommerceProduct:
    """One store product the operator mapped to a licence flag."""

    store: str
    productId: str
    flag: str
    deliverable: str = "app"


@dataclass(frozen=True)
class CommerceBinding:
    """The licence's purchase binding (a lowercase UUID) and the products on sale."""

    bindingId: str
    products: Tuple[CommerceProduct, ...] = ()


@dataclass(frozen=True)
class ClaimOk:
    """The Worker recorded the purchase and granted (or kept) the flag."""

    store: str
    productId: str
    flag: str
    deliverable: str
    state: str
    granted: bool
    changed: bool
    #: Whether the one-call helper's ``sync(force=True)`` ran after the claim.
    synced: bool = False
    raw: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)
    kind: str = "ok"


@dataclass(frozen=True)
class ClaimNotOwned:
    """The store does not report this account as the owner (403 ``forbidden`` +
    ``not_owned``)."""

    code: str = "forbidden"
    reason: str = "not_owned"
    message: str = ""
    kind: str = "not-owned"


@dataclass(frozen=True)
class ClaimAttestationRequired:
    """The product requires an attested device for commerce claims (403
    ``attestation_required``)."""

    code: str = "attestation_required"
    reason: Optional[str] = None
    message: str = ""
    kind: str = "attestation-required"


@dataclass(frozen=True)
class ClaimRefused:
    """Any other refusal: the server's ``code``, its ``reason`` when it sent one, the HTTP
    ``status`` and ``message``."""

    code: str
    status: int
    reason: Optional[str] = None
    message: str = ""
    kind: str = "refused"


ClaimResult = Union[ClaimOk, ClaimNotOwned, ClaimAttestationRequired, ClaimRefused]


def hidden_on(flag: str, products: Any) -> bool:
    """App Store 3.1.3(b): a flag that is sold somewhere but not as an App Store product is
    hidden on an Apple outlet. A flag sold nowhere (an operator's grant) is not."""
    sold = False
    for p in products or ():
        store = getattr(p, "store", None) if not isinstance(p, Mapping) else p.get("store")
        pflag = getattr(p, "flag", None) if not isinstance(p, Mapping) else p.get("flag")
        if pflag == flag:
            if store == "app-store":
                return False
            sold = True
    return sold


class CommerceClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        *,
        sync: Optional[Callable[[], Any]] = None,
        is_entitled: Optional[Callable[[str], bool]] = None,
        outlet_kind: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._sync = sync
        self._is_entitled = is_entitled
        self._outlet_kind = outlet_kind
        #: The product list from the last successful :meth:`binding`.
        self.products: Tuple[CommerceProduct, ...] = ()
        #: The binding from the last successful :meth:`binding` (``None`` until then).
        self.binding_id: Optional[str] = None

    # ── The two routes ───────────────────────────────────────────────────────────────
    def binding(self) -> CommerceBinding:
        """The licence's purchase binding and the products on sale.

        Raises ``service-unavailable`` (no License or Distribution), ``no-token``,
        ``network-error``, ``server-error``, ``bad_response`` (no binding UUID), or the Worker's
        code for a refusal (``not_entitled`` before the device holds a licence, …)."""
        token = self._require()
        res = self._send("GET", "distribution/commerce/binding", token)
        body = _json(res)
        if res.status_code != 200:
            raise PolarisError(
                _code(body) or "http-error",
                _message(body) or f"commerce/binding refused (status {res.status_code}).",
                status=res.status_code,
            )
        bid = body.get("bindingId")
        if not isinstance(bid, str) or not _UUID.match(bid):
            raise PolarisError("bad_response", "commerce/binding answered no binding UUID.")
        products: List[CommerceProduct] = []
        for p in body.get("products") or ():
            if (
                isinstance(p, dict)
                and isinstance(p.get("store"), str)
                and isinstance(p.get("productId"), str)
                and isinstance(p.get("flag"), str)
            ):
                d = p.get("deliverable")
                products.append(
                    CommerceProduct(
                        store=p["store"],
                        productId=p["productId"],
                        flag=p["flag"],
                        deliverable=d if isinstance(d, str) else "app",
                    )
                )
        self.binding_id = bid.lower()
        self.products = tuple(products)
        return CommerceBinding(bindingId=self.binding_id, products=self.products)

    def claim(self, store: str, payload: Mapping[str, Any]) -> ClaimResult:
        """Forward one store purchase. ``store`` is ``"steam"`` (``{"ticket": hex,
        "dlcAppId": "…"}``), ``"play"`` (``{"productId", "purchaseToken"}``) or
        ``"app-store"`` (``{"signedTransaction": jws}``). Does not sync.

        Raises ``invalid-options`` for a store or payload the route would refuse unread, and
        ``service-unavailable``, ``no-token``, ``network-error`` or ``server-error`` (a 5xx) before
        an answer."""
        body = _claim_body(store, payload)
        token = self._require()
        res = self._send("POST", "distribution/commerce/claim", token, body)
        b = _json(res)
        if res.status_code == 200:
            if b.get("ok") is not True:
                raise PolarisError("bad_response", "commerce/claim answered a body that is not a claim.")
            return ClaimOk(
                store=str(b.get("store", store)),
                productId=str(b.get("productId", "")),
                flag=str(b.get("flag", "")),
                deliverable=str(b.get("deliverable", "app")),
                state=str(b.get("state", "")),
                granted=b.get("granted") is True,
                changed=b.get("changed") is True,
                raw=b,
            )
        code = _code(b) or "http-error"
        reason = b.get("reason") if isinstance(b.get("reason"), str) else None
        message = _message(b)
        if code == "forbidden" and reason == "not_owned":
            return ClaimNotOwned(message=message)
        if code == "attestation_required":
            return ClaimAttestationRequired(reason=reason, message=message)
        return ClaimRefused(code=code, status=res.status_code, reason=reason, message=message)

    # ── One-call helpers ─────────────────────────────────────────────────────────────
    def claim_steam(self, ticket_hex: str, dlc_app_id: Union[str, int]) -> ClaimResult:
        """Claim a Steam DLC: ``ticket_hex`` is the hex of ``GetAuthTicketForWebApi(bindingId)``
        from any Steamworks binding (steamworks.py, SteamworksPy, GodotSteam's, …), so this SDK
        needs no Steam dependency. Syncs on success."""
        return self._then_sync(self.claim("steam", {"ticket": ticket_hex, "dlcAppId": str(dlc_app_id)}))

    def claim_play(self, product_id: str, purchase_token: str) -> ClaimResult:
        """Claim a Google Play purchase. Acknowledge it in Play only after this answered ok.
        Syncs on success."""
        return self._then_sync(
            self.claim("play", {"productId": product_id, "purchaseToken": purchase_token})
        )

    def claim_app_store(self, signed_transaction: str) -> ClaimResult:
        """Claim a StoreKit transaction (its JWS). Finish the transaction only after this
        answered ok. Syncs on success."""
        return self._then_sync(self.claim("app-store", {"signedTransaction": signed_transaction}))

    def hidden_here(self, flag: str) -> bool:
        """Whether this build's outlet must not unlock ``flag`` although the licence holds it
        (App Store 3.1.3(b)), judged from the last :meth:`binding`'s product list."""
        kind = self._outlet_kind() if self._outlet_kind is not None else None
        return kind in APPLE_OUTLETS and hidden_on(flag, self.products)

    def is_unlocked(self, flag: str) -> bool:
        """The licence grants ``flag`` (and the gate is usable) and the outlet does not hide
        it."""
        entitled = self._is_entitled(flag) if self._is_entitled is not None else False
        return bool(entitled) and not self.hidden_here(flag)

    # ── Internals ────────────────────────────────────────────────────────────────────
    def _then_sync(self, r: ClaimResult) -> ClaimResult:
        if isinstance(r, ClaimOk) and self._sync is not None:
            try:
                self._sync()
            except Exception:
                return r
            return replace(r, synced=True)
        return r

    def _require(self) -> str:
        for slug in ("license", "distribution"):
            self._ctx.require_service(slug, Feature.COMMERCE_RECEIPT)
        token = self._tokens.current
        if not token:
            raise PolarisError("no-token", "Activate, enrol or register before claiming purchases.")
        return token

    def _send(self, method: str, path: str, token: str, body: Optional[Dict[str, Any]] = None) -> httpx.Response:
        headers = {"authorization": f"Bearer {token}"}
        if body is not None:
            headers["content-type"] = "application/json"
        kwargs: Dict[str, Any] = {} if body is None else {"json": body}
        # Raises local-only, network-error or server-error (CoreContext.request).
        return self._ctx.request(method, self._ctx.url(path), headers=self._ctx.headers(headers), **kwargs)


def _claim_body(store: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
    p = payload if isinstance(payload, Mapping) else {}
    if store == "app-store":
        if not isinstance(p.get("signedTransaction"), str):
            raise PolarisError("invalid-options", "An App Store claim needs signedTransaction (the StoreKit JWS).")
        return {"store": store, "signedTransaction": p["signedTransaction"]}
    if store == "play":
        if not isinstance(p.get("productId"), str) or not isinstance(p.get("purchaseToken"), str):
            raise PolarisError("invalid-options", "A Play claim needs productId and purchaseToken.")
        return {"store": store, "productId": p["productId"], "purchaseToken": p["purchaseToken"]}
    if store == "steam":
        dlc = p.get("dlcAppId")
        if not isinstance(p.get("ticket"), str) or not (
            isinstance(dlc, str) or (isinstance(dlc, int) and not isinstance(dlc, bool))
        ):
            raise PolarisError("invalid-options", "A Steam claim needs ticket (hex) and dlcAppId.")
        return {"store": store, "ticket": p["ticket"], "dlcAppId": str(dlc)}
    raise PolarisError("invalid-options", "store must be app-store, play or steam.")


def _json(res: httpx.Response) -> Dict[str, Any]:
    try:
        b = res.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def _code(b: Dict[str, Any]) -> Optional[str]:
    e = b.get("error")
    if isinstance(e, str) and e:
        return e
    if isinstance(e, dict) and isinstance(e.get("code"), str) and e["code"]:
        return e["code"]
    return None


def _message(b: Dict[str, Any]) -> str:
    m = b.get("message")
    return m if isinstance(m, str) else ""
