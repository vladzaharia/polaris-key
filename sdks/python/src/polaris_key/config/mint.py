"""Edge-mint — ``GET /<p>/config/mint/<recipe_id>/token`` (Config, P0-12).

A product declares a recipe (alg, key, claims template, lifetime) and an operator approves
it; the Worker signs a short-lived token for a third party (Apple MusicKit's developer
token is the first instance) for any device of the product that presents its device token.
This is how a catalog secret with ``delivery: "edgeMint"`` reaches a runtime without the
signing key ever leaving the Worker.

THE CACHE IS MEMORY ONLY. A minted token is a live credential for someone else's API, so it
is never written to the cache file or the keyring, and it dies with the process. Within one
process it is reused until ``expiresAt`` minus a 30-second margin. Mirrors
``@polaris-key/node``'s ``config/mint.ts``.

A CACHED TOKEN IS BOUND TO THE DEVICE TOKEN IT WAS MINTED WITH. A hit counts only while the
client still holds that same device token, so ``license.deactivate()``, a cleared or revoked
token, or a different identity signing in all invalidate it: the call then takes the normal
path, which refuses with ``unauthorized`` before any request when no token is held.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, Optional, Tuple

import httpx

from ..constants_generated import Feature
from ..core.errors import PolarisError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..core.context import CoreContext
    from ..core.token import TokenManager

__all__ = ["MintedToken", "MintCache", "MINT_REUSE_MARGIN_SECONDS", "MINT_ID", "mint_token"]

#: A cached token is reused until this many seconds before its ``expiresAt``.
MINT_REUSE_MARGIN_SECONDS = 30

#: The router's recipe-id alphabet (``MINT_ID`` in the Worker's ``services/config/routes.ts``).
#: Anchored with ``\A``/``\Z`` (not ``^``/``$``): Python's ``$`` also matches before a trailing
#: newline, which would let ``"musickit\n"`` past the guard.
MINT_ID = re.compile(r"\A[a-z0-9-]+\Z")


@dataclass(frozen=True)
class MintedToken:
    """What a mint returns. Its ``repr`` leaves ``token`` out."""

    token: str = field(repr=False)
    #: Epoch seconds.
    expiresAt: int


class MintCache:
    """The per-client, per-recipe memory cache. The lock makes two threads that ask for the
    same recipe at once make one request. Each entry is ``(device_token, minted)``: the device
    token that was presented for it."""

    def __init__(self) -> None:
        self.tokens: Dict[str, Tuple[str, MintedToken]] = {}
        self.lock = threading.Lock()


def mint_token(
    ctx: "CoreContext",
    tokens: Optional["TokenManager"],
    cache: MintCache,
    recipe_id: str,
) -> MintedToken:
    ctx.require_service("config", Feature.CONFIG_MINT)
    if not isinstance(recipe_id, str) or not MINT_ID.fullmatch(recipe_id):
        raise PolarisError(
            "bad_request",
            f'"{recipe_id}" is not an edge-mint recipe id (lowercase letters, digits and "-").',
        )
    with cache.lock:
        current = tokens.current if tokens is not None else None
        held = cache.tokens.get(recipe_id)
        if held is not None:
            device_token, minted = held
            if (
                current is not None
                and device_token == current
                and ctx.now() < minted.expiresAt - MINT_REUSE_MARGIN_SECONDS
            ):
                return minted
        cache.tokens.pop(recipe_id, None)
        device_token, minted = _mint_once(ctx, tokens, recipe_id)
        cache.tokens[recipe_id] = (device_token, minted)
        return minted


def _mint_once(
    ctx: "CoreContext", tokens: Optional["TokenManager"], recipe_id: str
) -> Tuple[str, MintedToken]:
    """One mint (with the single re-acquire), and the device token that was presented for it."""
    presented = tokens.current if tokens is not None else None
    res = _get(ctx, presented, recipe_id)
    if res.status_code == 401 and tokens is not None and tokens.reacquire():
        presented = tokens.current
        res = _get(ctx, presented, recipe_id)
    if res.status_code == 200:
        try:
            b = res.json()
        except ValueError:
            b = {}
        tok = b.get("token") if isinstance(b, dict) else None
        exp = b.get("expiresAt") if isinstance(b, dict) else None
        if not isinstance(tok, str) or not isinstance(exp, int) or isinstance(exp, bool):
            raise PolarisError(
                "bad_response", "edge-mint answered without a token and its expiry."
            )
        # ``_get`` refused locally when no token was presented, so it is a string here.
        assert presented is not None
        return presented, MintedToken(token=tok, expiresAt=exp)
    # The server's code and message; a 5xx never gets here (`server-error`, raised by the
    # request), and an answer that names no code is its status's registry code.
    from ..core.context import refusal_error

    raise refusal_error(res, f'edge-mint of "{recipe_id}"')


def _get(ctx: "CoreContext", token: Optional[str], recipe_id: str) -> httpx.Response:
    """One GET, or a local refusal when there is no credential to present."""
    if not token:
        raise PolarisError(
            "unauthorized",
            "edge-mint needs a device token: activate, enrol, sign in or register first.",
        )
    # Raises local-only, network-error or server-error (CoreContext.request).
    return ctx.request(
        "GET",
        ctx.url(f"config/mint/{recipe_id}/token"),
        headers=ctx.headers({"authorization": f"Bearer {token}"}),
    )
