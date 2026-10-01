"""``polaris_key.identity`` — device-code sign-in (RFC 8628).

See :mod:`polaris_key.identity.client`.
"""

from .client import (
    SLOW_DOWN_STEP_SECONDS,
    IdentityClient,
    SignInPoll,
    SignInPrompt,
    SignInResult,
)

__all__ = [
    "IdentityClient",
    "SignInPoll",
    "SignInPrompt",
    "SignInResult",
    "SLOW_DOWN_STEP_SECONDS",
]
