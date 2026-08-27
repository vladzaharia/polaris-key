"""The error types the transport + orchestration layers raise.

Everything on the VERIFICATION path fails closed by returning ``None`` (see
:mod:`polaris_key.core.jws`, :mod:`polaris_key.core.verify`, :mod:`polaris_key.core.trust`) — an
exception there would be a way to make a caller do something other than "no document".
:class:`PolarisError` exists for the layers built on top, where the caller needs the
server's machine-readable code (or the §7 bundle refusal step, or ``local-only``) rather
than a message to regex.

Mirrors ``@polaris-key/client-core``'s ``errors.ts`` plus ``@polaris-key/node``'s
``InsecureBaseUrlError``.
"""

from __future__ import annotations

__all__ = ["PolarisError", "InsecureBaseUrlError"]


class PolarisError(Exception):
    """A wire/orchestration failure carrying a machine-readable ``code``.

    ``code`` is deliberately a plain ``str`` rather than an enum: the server may
    introduce a code this client predates, and handing the caller the raw value beats
    collapsing it to an opaque "unknown".
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class InsecureBaseUrlError(ValueError):
    """Raised at construction for a ``base_url`` that would carry the device bearer
    token in the clear.

    A plaintext control plane makes trust-set injection (R4-02) a coffee-shop attack
    rather than a local one. ``http://`` is accepted for loopback hosts ONLY, so
    ``wrangler dev`` and integration suites keep working.

    This is the Python half of the parity gap the suite carve closes: the Node SDK has
    refused a non-HTTPS base URL since v3, and this client did not refuse at all.
    """

    code = "insecure-base-url"
