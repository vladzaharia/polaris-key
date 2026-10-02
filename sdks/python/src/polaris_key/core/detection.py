"""Outlet detection — plans/P3-01.md §2.9 "Detection" and §4.7 (``outlet-matrix.json``).

"Where did this install come from?" A pure ``detect_outlet(stamp=…, signals=…)`` maps the
signals a runtime observed, and the build stamp, to ``{"kind", "confidence", "source",
"subkind"}``. Every SDK holds this same function (``detectOutlet`` in TypeScript and Swift), and
``outlet-matrix.json``'s rows pin it in every runner (``tests/test_outlet_matrix.py`` here).
READING the signals is per runtime (``polaris_key.update.outlet``); only this mapping is shared.

The result never goes straight into the decision: the update client passes it to
``resolve_update_outlet`` as ``detected`` (§2.8), where a host value always wins. Detection
chooses an outlet; it never widens what that outlet may do.

No I/O, never raises. Raw signal values never leave the device.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .decide import effective_capabilities
from .outlets import BINARY_UPDATES_ORDER, OUTLET_KINDS, OUTLET_SUBKINDS, OUTLET_UNKNOWN

__all__ = [
    "OUTLET_SIGNALS",
    "OUTLET_PLATFORM_DATA",
    "detect_outlet",
    "detection_stamp",
    "unknown_detection",
    "WEB_DETECTION_STAMP",
]

#: The 25 signals in vocabulary order, with their confidence (``None`` for the two diagnostic
#: signals, which are recorded and never count). ``outlet-matrix.json#/signals``.
OUTLET_SIGNALS: Tuple[Tuple[str, Optional[str]], ...] = (
    ("ios.appDistributor", "attested"),
    ("ios.bundleIdRewrite", "declared"),
    ("ios.provisioningProfile", "heuristic"),
    ("macos.masReceipt", "attested"),
    ("macos.receiptSandbox", "attested"),
    ("macos.signingLeaf", "attested"),
    ("macos.homebrewCask", "heuristic"),
    ("macos.homebrewFormula", "heuristic"),
    ("windows.packageIdentity", "attested"),
    ("windows.signatureKind", "attested"),
    ("windows.appInstallerUri", "attested"),
    ("windows.externalLocation", "attested"),
    ("windows.pathConvention", "heuristic"),
    ("linux.flatpakInfo", "attested"),
    ("linux.snapEnv", "declared"),
    ("linux.appImageEnv", "declared"),
    ("steam.libraryManifest", "declared"),
    ("steam.appIdEnv", "heuristic"),
    ("steam.appIdFile", None),
    ("itch.receipt", "declared"),
    ("itch.appEnv", None),
    ("android.installSource", "declared"),
    ("android.installerMismatch", "declared"),
    ("web.displayMode", "heuristic"),
    ("node.packageManager", "heuristic"),
)

#: The platform facts detection reads (``outlet-matrix.json#/platformData``, less the listing
#: prefixes, which are ``LISTING_URL_PREFIXES``). The two digest and marketplace lists stay
#: empty until P5-06 and P5-05 record them.
OUTLET_PLATFORM_DATA: Mapping[str, Any] = MappingProxyType(
    {
        "playStoreCertSha256s": (),
        "altStorePalMarketplaceIds": (),
        "playPackages": ("com.android.vending",),
        "obtainiumPackages": ("dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"),
        "fdroidClientPackages": (
            "org.fdroid.fdroid",
            "com.looker.droidify",
            "com.machiav3lli.fdroid",
        ),
        "systemInstallerPackages": (
            "com.google.android.packageinstaller",
            "com.android.packageinstaller",
        ),
        "macosStoreLeaves": MappingProxyType(
            {
                "Apple Mac OS Application Signing": "app-store",
                "TestFlight Beta Distribution": "testflight",
            }
        ),
        "deadlineMs": 2000,
    }
)

#: The synthesised stamp of a web runtime (§2.9).
WEB_DETECTION_STAMP: Mapping[str, Any] = MappingProxyType(
    {"outletKind": "web", "subkind": None, "outletIds": MappingProxyType({})}
)

_MARKETPLACE = "marketplace:"


def unknown_detection() -> Dict[str, Any]:
    """``{"kind": "unknown", "confidence": None, "source": None, "subkind": None}``."""
    return {"kind": OUTLET_UNKNOWN, "confidence": None, "source": None, "subkind": None}


def _is_kind(v: Any) -> bool:
    return isinstance(v, str) and v in OUTLET_KINDS


def _is_subkind(v: Any) -> bool:
    return isinstance(v, str) and v in OUTLET_SUBKINDS


def detection_stamp(stamp: Any) -> Optional[Dict[str, Any]]:
    """The detection stamp of a build stamp (P1-11's ``{outlet, outletKind?, outletSubkind?,
    outletIds?}``): the kind as ``resolve_update_outlet`` reads it (``outletKind``, else
    ``outlet``; a kind outside the 17 is no kind), the subkind when it is one of the 8, and the
    string-valued identities. ``None`` when the stamp names no kind."""
    if not isinstance(stamp, Mapping):
        return None
    raw_kind = stamp["outletKind"] if "outletKind" in stamp else stamp.get("outlet")
    if not _is_kind(raw_kind):
        return None
    ids_in = stamp.get("outletIds")
    ids: Dict[str, str] = {}
    if isinstance(ids_in, Mapping):
        ids = {k: v for k, v in ids_in.items() if isinstance(k, str) and isinstance(v, str)}
    sub = stamp["outletSubkind"] if "outletSubkind" in stamp else stamp.get("subkind")
    return {
        "outletKind": raw_kind,
        "subkind": sub if _is_subkind(sub) else None,
        "outletIds": ids,
    }


def _width(kind: str, subkind: Optional[str]) -> int:
    """``binaryUpdates``'s width of a kind narrowed by a subkind (no platform)."""
    return BINARY_UPDATES_ORDER.index(
        effective_capabilities(kind, platform="", subkind=subkind).binaryUpdates
    )


class _Evidence:
    __slots__ = ("signal", "confidence", "names", "vetoes")

    def __init__(self, signal: str, confidence: str) -> None:
        self.signal = signal
        self.confidence = confidence
        self.names: Optional[Tuple[str, Optional[str]]] = None
        self.vetoes: Tuple[str, ...] = ()


def detect_outlet(
    *, stamp: Optional[Mapping[str, Any]] = None, signals: Optional[Mapping[str, Any]] = None
) -> Dict[str, Any]:
    """Detect the outlet from the build stamp and the observed signals, in §2.9's five steps:
    filter (identity conditions, diagnostics), attested naming, the stamp, vetoes, then the
    restricting declared and heuristic signals. A malformed value is no evidence. Never raises
    (``outlet-matrix.json#/rows``)."""
    st = stamp if isinstance(stamp, Mapping) and _is_kind(stamp.get("outletKind")) else None
    sig: Mapping[str, Any] = signals if isinstance(signals, Mapping) else {}
    ids_raw = st.get("outletIds") if st is not None else None
    ids: Mapping[str, Any] = ids_raw if isinstance(ids_raw, Mapping) else {}
    missing = object()

    def v(s: str) -> Any:
        return sig.get(s, missing)

    def field(s: str, key: str) -> Any:
        o = v(s)
        return o.get(key, missing) if isinstance(o, Mapping) else missing

    def names(key: str, value: Any) -> bool:
        # A missing identity never matches; compare strings to strings only.
        want = ids.get(key)
        return isinstance(want, str) and isinstance(value, str) and value == want

    def identity_holds(s: str) -> bool:
        if s == "ios.bundleIdRewrite":
            return names("bundleId", field(s, "altBundleIdentifier"))
        if s == "macos.receiptSandbox":
            return v("macos.masReceipt") is True
        if s == "macos.homebrewCask":
            return names("caskToken", v(s))
        if s == "macos.homebrewFormula":
            return names("homebrewFormula", v(s))
        if s in (
            "windows.packageIdentity",
            "windows.signatureKind",
            "windows.appInstallerUri",
            "windows.externalLocation",
        ):
            return names("msixFamilyName", v("windows.packageIdentity"))
        if s == "linux.flatpakInfo":
            return names("flatpakId", v(s))
        if s == "linux.snapEnv":
            return names("snapName", field(s, "name"))
        if s == "linux.appImageEnv":
            exe, appdir = field(s, "exePath"), field(s, "appDir")
            return isinstance(exe, str) and isinstance(appdir, str) and exe.startswith(appdir)
        if s == "steam.libraryManifest":
            return names("steamAppId", v(s))
        if s == "steam.appIdEnv":
            return names("steamAppId", field(s, "appId"))
        if s == "itch.receipt":
            return names("itchGameId", v(s))
        if s == "android.installSource":
            installer, initiator = field(s, "installer"), field(s, "initiator")
            return (installer is None or isinstance(installer, str)) and installer == initiator
        if s == "node.packageManager":
            return field(s, "packageMatch") is True
        return True

    data = OUTLET_PLATFORM_DATA
    evidence: List[_Evidence] = []
    # 1. Filter, and read each surviving signal's effect.
    for signal, confidence in OUTLET_SIGNALS:
        if confidence is None or signal not in sig or not identity_holds(signal):
            continue
        value = sig[signal]
        e = _Evidence(signal, confidence)
        if signal == "ios.appDistributor":
            if value == "appStore":
                e.names = ("app-store", None)
            elif value == "testFlight":
                e.names = ("testflight", None)
            elif value == "web":
                e.names = ("direct", None)
            elif isinstance(value, str) and value.startswith(_MARKETPLACE):
                if value[len(_MARKETPLACE) :] in data["altStorePalMarketplaceIds"]:
                    e.names = ("altstore-pal", None)
                else:
                    e.vetoes = ("app-store", "testflight")
        elif signal == "ios.bundleIdRewrite":
            e.names = ("altstore", None)
        elif signal == "ios.provisioningProfile":
            if value is True:
                e.vetoes = ("app-store",)
        elif signal == "macos.masReceipt":
            if value is True:
                e.names = (
                    "testflight" if v("macos.receiptSandbox") is True else "app-store",
                    None,
                )
        elif signal == "macos.signingLeaf":
            leaves = data["macosStoreLeaves"]
            if isinstance(value, str) and value in leaves:
                e.names = (leaves[value], None)
            else:
                e.vetoes = ("app-store", "testflight")
        elif signal in ("macos.homebrewCask", "macos.homebrewFormula"):
            e.names = ("direct", "homebrew")
        elif signal == "windows.signatureKind":
            if value == "Store":
                e.names = ("ms-store", None)
            elif value in ("Developer", "Enterprise"):
                e.vetoes = ("ms-store",)
        elif signal == "windows.appInstallerUri":
            if value is not None:
                e.names = ("app-installer", None)
        elif signal == "windows.pathConvention":
            if value == "winget":
                e.names = ("winget", None)
            elif value in ("scoop", "chocolatey"):
                e.names = ("direct", value)
        elif signal == "linux.flatpakInfo":
            if st is not None and st.get("outletKind") == "direct" and st.get("subkind") == "flatpak":
                e.names = ("direct", "flatpak")
            else:
                e.names = ("flathub", None)
        elif signal == "linux.snapEnv":
            revision = field(signal, "revision")
            if isinstance(revision, str) and revision.startswith("x"):
                e.vetoes = ("snap",)
            else:
                e.names = ("snap", None)
        elif signal == "linux.appImageEnv":
            e.names = ("direct", "appimage")
        elif signal in ("steam.libraryManifest", "steam.appIdEnv"):
            e.names = ("steam", None)
        elif signal == "itch.receipt":
            e.names = ("itch", None)
        elif signal == "android.installSource":
            installer = field(signal, "installer")
            if isinstance(installer, str) and installer in data["playPackages"]:
                e.names = ("play", None)
                digest = field(signal, "initiatorCertSha256")
                if isinstance(digest, str) and digest in data["playStoreCertSha256s"]:
                    e.confidence = "attested"
            elif isinstance(installer, str) and installer in data["obtainiumPackages"]:
                e.names = ("obtainium", None)
            elif isinstance(installer, str) and installer in data["fdroidClientPackages"]:
                e.names = ("fdroid-repo", None)
            elif (
                installer is None
                or installer == "com.android.shell"
                or installer in data["systemInstallerPackages"]
            ):
                e.names = ("direct", None)
        elif signal == "android.installerMismatch":
            if value is True:
                e.vetoes = ("play", "play-testing")
        elif signal == "web.displayMode":
            e.names = ("web", None)
        elif signal == "node.packageManager":
            manager = field(signal, "manager")
            if manager in ("npm", "pnpm", "npx"):
                e.names = ("direct", manager)
        evidence.append(e)

    def vetoed(kind: str) -> bool:
        return any(kind in e.vetoes for e in evidence)

    # 2. Attested naming.
    attested = [e for e in evidence if e.confidence == "attested" and e.names is not None]
    if attested:
        first = attested[0]
        assert first.names is not None
        if any(e.names is not None and e.names[0] != first.names[0] for e in attested):
            return unknown_detection()
        if vetoed(first.names[0]):
            return unknown_detection()
        return {
            "kind": first.names[0],
            "confidence": "attested",
            "source": first.signal,
            "subkind": first.names[1],
        }

    # 3. The stamp.
    if st is None:
        return unknown_detection()
    cur_kind: str = st["outletKind"]
    cur_sub = st.get("subkind") if _is_subkind(st.get("subkind")) else None

    # 4. Vetoes.
    if vetoed(cur_kind):
        return unknown_detection()

    # 5. Restricting signals: declared, then heuristic, each in vocabulary order.
    ceiling = _width(cur_kind, cur_sub)
    for conf in ("declared", "heuristic"):
        for e in evidence:
            if e.confidence != conf or e.names is None:
                continue
            kind, sub = e.names
            if _width(kind, sub) > ceiling:
                continue
            return {
                "kind": kind,
                "confidence": conf,
                "source": e.signal,
                "subkind": sub if sub is not None else (cur_sub if kind == cur_kind else None),
            }
    return {"kind": cur_kind, "confidence": "stamp", "source": "stamp", "subkind": cur_sub}
