"""``polaris_key.identity`` — device-code sign-in (RFC 8628).

See :mod:`polaris_key.identity.client`.
"""

from .access_token import AccessToken
from .account import (
    AttachConfirm,
    AttachLicense,
    AttachOk,
    AttachRefused,
    OpenAccountResult,
    SignOutResult,
)
from .auto_sign_in import (
    AutoSignInNeedsSignIn,
    AutoSignInResult,
    AutoSignInSignedIn,
    AutoSignInUnavailable,
    NearbyNamespace,
)
from .choice import (
    ChoiceCancelOk,
    ChoiceCompleteOk,
    ChoiceRefused,
    ChoiceViewOk,
    LicenseChoiceView,
    ReplaceView,
)
from .client import (
    SLOW_DOWN_STEP_SECONDS,
    IdentityClient,
    SignedInIdentity,
    SignInNamespace,
)
from .redirect import RedirectSession, SignInError
from .sign_in import SignInActivation, SignInOutcome, SignInSession

__all__ = [
    "AccessToken",
    "AutoSignInNeedsSignIn",
    "AutoSignInResult",
    "AutoSignInSignedIn",
    "AutoSignInUnavailable",
    "NearbyNamespace",
    "ChoiceCancelOk",
    "ChoiceCompleteOk",
    "ChoiceRefused",
    "ChoiceViewOk",
    "LicenseChoiceView",
    "RedirectSession",
    "ReplaceView",
    "SignInError",
    "AttachConfirm",
    "AttachLicense",
    "AttachOk",
    "AttachRefused",
    "OpenAccountResult",
    "SignOutResult",
    "IdentityClient",
    "SignedInIdentity",
    "SignInActivation",
    "SignInNamespace",
    "SignInOutcome",
    "SignInSession",
    "SLOW_DOWN_STEP_SECONDS",
]
