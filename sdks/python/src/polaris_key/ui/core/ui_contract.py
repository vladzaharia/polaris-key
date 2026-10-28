"""The JSON-shaped contract shared by Python UI view models.

This is the Python port of ``@polaris-key/ui-core``'s vocabulary and input helpers.  It deliberately
uses ordinary mappings: ``conformance/corpus/v2/ui-matrix.json`` is the cross-language contract,
and each Python UI adapter maps its SDK state to that shape before a view model reads it.  No Qt,
terminal, network, or SDK client import belongs here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from ...constants_generated import UI_MATRIX_VERSION

__all__ = [
    "ACTIONS",
    "ACTION_KEYS",
    "COMPONENTS",
    "DEFAULT_CAPABILITIES",
    "FORM_FACTORS",
    "HIDDEN",
    "OS",
    "SERVICES",
    "UI_MATRIX_VERSION",
    "Context",
    "can_browse",
    "coarse_pointer",
    "context_of",
    "platform_class",
    "services_without",
    "system_confirm",
]

# UI-KITS.md §4.1.  Keep this closed list in lockstep with ui-matrix.json's vocabulary.
COMPONENTS: Tuple[str, ...] = (
    "PolarisKeyGate",
    "Boot",
    "Welcome",
    "SignIn",
    "SignInHandoff",
    "NearbyApproval",
    "Activate",
    "OfflineActivation",
    "DeviceLimit",
    "LicenseChoice",
    "Devices",
    "UpdatePrompt",
    "UpdateProgress",
    "ReleaseNotes",
    "StatusScreen",
    "GraceBanner",
    "AccountAndLicense",
    "Settings",
    "Paywall",
    "EntitlementGate",
    "CloudSyncStatus",
    "UnlockSync",
    "RecoveryCode",
    "RingChange",
    "About",
    "ChannelPicker",
    "Toast",
)

# A component whose required service is off renders nothing in the drop-in and an empty styled part.
HIDDEN = "hidden"

ACTIONS: Tuple[str, ...] = (
    "open-card",
    "open-browser",
    "replace-in-browser",
    "open-manage-url",
    "start-sign-in",
    "copy-link",
    "retry",
    "cancel",
    "unlock",
    "start-over",
    "confirm-start-over",
    "accept-ring-change",
    "use-recovery-code",
    "copy-code",
)

# The controls whose catalog keys perform an action.  Views derive actions from their copy so a
# renderer can never show an action that the model does not name.
ACTION_KEYS: Mapping[str, Tuple[str, ...]] = {
    "open-card": ("signin.desktop.continue", "signin.email.continue"),
    "open-browser": ("signin.handoff.again", "signin.handoff.openBrowser"),
    "replace-in-browser": (),
    "open-manage-url": (
        "deviceLimit.openBrowser",
        "devices.manage",
        "signin.key.addInLocker",
        "signin.deviceLimit.replace",
    ),
    "start-sign-in": ("signin.key.ownedSignIn", "signin.key.signIn"),
    "copy-link": ("signin.handoff.copyLink", "a11y.copyAddress"),
    "retry": (
        "common.tryAgain",
        "common.reconnect",
        "signin.again",
        "signInHandoff.newCode",
    ),
    "cancel": ("common.cancel",),
    "unlock": ("unlockSync.unlock", "cloudSync.unlock"),
    "start-over": ("unlockSync.startOver",),
    "confirm-start-over": ("unlockSync.startOverConfirm",),
    "accept-ring-change": ("ringChange.accept",),
    "use-recovery-code": ("ringChange.useCode",),
    "copy-code": ("recoveryCode.copy",),
}

# The product services and their transitive dependency rule.  This deliberately mirrors
# tools/services.json without importing Node-generated code into the Python SDK.
SERVICES: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("license", ()),
    ("config", ()),
    ("release", ()),
    ("distribution", ("release",)),
    ("update", ("distribution",)),
    ("identity", ()),
    ("sync", ("config", "identity")),
)

OS: Tuple[str, ...] = (
    "macos",
    "ios",
    "android",
    "windows",
    "linux",
    "web",
    "tvos",
    "visionos",
    "watchos",
)
FORM_FACTORS: Tuple[str, ...] = (
    "iphone",
    "ipad",
    "mac",
    "phone",
    "tablet",
    "computer",
    "tv",
    "other",
)

DEFAULT_CAPABILITIES: Mapping[str, bool] = {
    "signIn": True,
    "keyEntry": True,
    "deviceCode": True,
    "offlineActivation": False,
    "trial": False,
    "restore": False,
    "purchase": False,
    "enroll": False,
}


@dataclass(frozen=True)
class Context:
    """A UI input with its capability, platform and registration defaults resolved once."""

    input: Mapping[str, Any]
    caps: Mapping[str, bool]
    platform: Optional[Mapping[str, Any]]
    registration: str
    enabled: frozenset

    def on(self, slug: str) -> bool:
        """Whether the optional service ``slug`` is enabled for this input."""
        return slug in self.enabled


def context_of(input: Optional[Mapping[str, Any]] = None) -> Context:
    """Resolve one ``ui-matrix.json`` input into the values every view model reads.

    An omitted service list means every service is enabled.  A partial capability object merges
    member-by-member over :data:`DEFAULT_CAPABILITIES`, exactly as the shared runner contract says.
    """
    raw: Mapping[str, Any] = input or {}
    caps: Dict[str, bool] = dict(DEFAULT_CAPABILITIES)
    candidate = raw.get("capabilities")
    if isinstance(candidate, Mapping):
        for key, value in candidate.items():
            if key in caps:
                caps[key] = value is True
    listed = raw.get("services")
    enabled = (
        frozenset(str(v) for v in listed if isinstance(v, str))
        if isinstance(listed, Sequence) and not isinstance(listed, (str, bytes))
        else frozenset(slug for slug, _requires in SERVICES)
    )
    platform = raw.get("platform")
    return Context(
        input=raw,
        caps=caps,
        platform=platform if isinstance(platform, Mapping) else None,
        registration=str(raw.get("registration") or "requires-license"),
        enabled=enabled,
    )


def services_without(*off: str) -> Tuple[str, ...]:
    """Return the enabled services after ``off`` and every dependent service are removed."""
    down = set(off)
    changed = True
    while changed:
        changed = False
        for slug, requires in SERVICES:
            if slug not in down and any(required in down for required in requires):
                down.add(slug)
                changed = True
    return tuple(slug for slug, _requires in SERVICES if slug not in down)


def _field(platform: Optional[Mapping[str, Any]], name: str) -> Optional[str]:
    if platform is None:
        return None
    value = platform.get(name)
    return value if isinstance(value, str) else None


def platform_class(platform: Optional[Mapping[str, Any]]) -> str:
    """Return the layout/input class for a platform (desktop, web, handheld, tv or console)."""
    if platform is None:
        return "desktop"
    form_factor = _field(platform, "formFactor")
    os_name = _field(platform, "os")
    if form_factor == "tv":
        return "tv" if os_name in ("android", "tvos") else "console"
    if os_name == "web":
        return "web"
    if form_factor in ("iphone", "ipad", "phone", "tablet") or os_name in (
        "ios",
        "android",
        "watchos",
        "visionos",
    ):
        return "handheld"
    return "desktop"


def can_browse(platform: Optional[Mapping[str, Any]]) -> bool:
    """Whether this device can open a browser itself (DL14)."""
    return platform_class(platform) not in ("tv", "console")


def coarse_pointer(platform: Optional[Mapping[str, Any]]) -> bool:
    """Whether a field must not take initial focus (DL9)."""
    return platform_class(platform) in ("handheld", "tv", "console")


def system_confirm(platform: Optional[Mapping[str, Any]], presentation: str) -> bool:
    """Whether a destructive Replace uses the platform confirmation (SIGN-IN D-80)."""
    kind = platform_class(platform)
    if kind in ("web", "tv", "console"):
        return False
    return _field(platform, "os") != "windows" or presentation == "inline"
