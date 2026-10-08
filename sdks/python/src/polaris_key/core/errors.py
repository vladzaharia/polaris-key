"""The error types the transport + orchestration layers raise.

Everything on the VERIFICATION path fails closed by returning ``None`` (see
:mod:`polaris_key.core.jws`, :mod:`polaris_key.core.verify`, :mod:`polaris_key.core.trust`) — an
exception there would be a way to make a caller do something other than "no document".
:class:`PolarisError` exists for the layers built on top, where the caller needs the
server's machine-readable code (or the §7 bundle refusal step, or ``local-only``) rather
than a message to regex.

ONE ERROR TYPE. Every exception the SDK raises on purpose is a :class:`PolarisError` with a
registry ``code`` (``conformance/parity/errors.json``), so ``except PolarisError`` catches all of
them; the subclasses only add fields. A transport failure is ``network-error`` with the httpx
exception as ``__cause__``, and a 5xx is ``server-error`` with ``status`` (see
:meth:`polaris_key.core.context.CoreContext.request`): no httpx exception reaches the caller.

Mirrors ``@polaris-key/client-core``'s ``errors.ts`` plus ``@polaris-key/node``'s
``InsecureBaseUrlError``.
"""

from __future__ import annotations

from typing import Optional

from ..constants_generated import ErrorCode

__all__ = ["PolarisError", "InsecureBaseUrlError"]


class PolarisError(Exception):
    """A wire/orchestration failure carrying a machine-readable ``code``.

    ``code`` is deliberately a plain ``str`` rather than an enum: the server may
    introduce a code this client predates, and handing the caller the raw value beats
    collapsing it to an opaque "unknown". ``status`` is the HTTP status when the error is an
    answer (``server-error``, a refusal), and ``None`` for a transport failure or a local
    refusal. ``message`` is the server's own message when it sent one.
    """

    def __init__(self, code: str, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class InsecureBaseUrlError(PolarisError):
    """Raised at construction for a ``base_url`` that would carry the device bearer
    token in the clear.

    A plaintext control plane makes trust-set injection (R4-02) a coffee-shop attack
    rather than a local one. ``http://`` is accepted for loopback hosts ONLY, so
    ``wrangler dev`` and integration suites keep working.
    """

    code = ErrorCode.INSECURE_BASE_URL

    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.INSECURE_BASE_URL, message)
