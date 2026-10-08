"""The Devices sub-client — the Core device principal's own surface (wire contract v3 §6).

``register()`` is the headline: until v3 the only way to become a device was to present a
licence key, which made "device" a licensing concept. D-08 undoes that — a config-only
product's installs need an identity to fetch a document AS and a credential to fetch it
WITH, and ``POST /<p>/devices/register`` is where they get one, keylessly, under the
``open`` registration policy.

The rest (``list``/``rename``/``deauthorize``/``report``) are Core surfaces available under
every policy, which is why they live here rather than under License: a device roster is a
property of the product's fleet, not of any one grant.

THIS IS THE OTHER HALF OF THE PYTHON PARITY GAP. The pre-suite client raised
``DeviceManagementUnsupportedError`` from ``list_devices``/``deauthorize_device``
unconditionally — the endpoints existed on the Worker and this SDK simply did not call
them. They are real calls now; the error survives, but only for its honest meaning: there
is no credential, so there is no roster to ask for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union

from ..core.cache import CacheManager
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.telemetry import build_snapshot, report_snapshot
from ..core.token import TokenManager
from .facts import ProbeDeclaration
from .fingerprint import collect_fingerprint

__all__ = [
    "AccountDevice",
    "RegisterOk",
    "RegisterClosed",
    "RegisterRateLimited",
    "RegisterNotConfigured",
    "RegisterRefused",
    "RegisterError",
    "RegisterResult",
    "DeviceManagementUnsupportedError",
    "DeviceRefusedError",
    "DevicesClient",
    "REGISTER_PATH",
    "DEVICES_PATH",
]

REGISTER_PATH = "devices/register"
DEVICES_PATH = "devices"


@dataclass(frozen=True)
class AccountDevice:
    """One device as the server reports it."""

    id: str
    status: str = "ok"
    current: bool = False
    licenseId: Optional[str] = None
    label: Optional[str] = None
    firstSeen: Optional[int] = None
    lastSeen: Optional[int] = None
    platform: Optional[str] = None
    arch: Optional[str] = None
    appVersion: Optional[str] = None
    sdkName: Optional[str] = None
    sdkVersion: Optional[str] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "AccountDevice":
        return AccountDevice(
            id=str(d.get("id", "")),
            status=str(d.get("status", "ok")),
            current=d.get("current") is True,
            licenseId=d.get("licenseId"),
            label=d.get("label"),
            firstSeen=d.get("firstSeen"),
            lastSeen=d.get("lastSeen"),
            platform=d.get("platform"),
            arch=d.get("arch"),
            appVersion=d.get("appVersion"),
            sdkName=d.get("sdkName"),
            sdkVersion=d.get("sdkVersion"),
        )


@dataclass(frozen=True)
class RegisterOk:
    """200: the device token was minted (and stored by ``register()``); never in the ``repr``."""

    token: str = field(repr=False)
    deviceId: str
    kind: str = "ok"


@dataclass(frozen=True)
class RegisterClosed:
    """The product's policy is ``requires-license`` or ``requires-identity``: activation
    (or a sign-in) is the mint path, and the endpoint refuses without telling you which."""

    kind: str = "registration-closed"


@dataclass(frozen=True)
class RegisterRateLimited:
    kind: str = "rate-limited"


@dataclass(frozen=True)
class RegisterNotConfigured:
    kind: str = "not-configured"


@dataclass(frozen=True)
class RegisterRefused:
    """Any other 4xx (``attestation_required``, ``bad_request``, …): the server's own
    ``code`` and HTTP ``status``, never folded into ``registration-closed``."""

    code: str
    status: int
    message: str = ""
    kind: str = "refused"


@dataclass(frozen=True)
class RegisterError:
    message: str
    kind: str = "error"


RegisterResult = Union[
    RegisterOk,
    RegisterClosed,
    RegisterRateLimited,
    RegisterNotConfigured,
    RegisterRefused,
    RegisterError,
]


class DeviceManagementUnsupportedError(RuntimeError):
    code = "device-management-unsupported"


class DeviceRefusedError(PolarisError):
    """A roster call (list, rename, deauthorize) the server refused. ``code`` is the server's
    own code (``unauthorized``, ``forbidden``, ``not_found``, ``rate_limited``, …); only an
    answer that names none falls back to the call's ``device_*_failed`` code. ``status`` is the
    HTTP status."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(code, message)
        self.status = status


def _refusal(res: Any, fallback: str, what: str) -> DeviceRefusedError:
    body = _json_or_empty(res)
    raw = body.get("error")
    code = raw if isinstance(raw, str) and raw else (
        raw.get("code") if isinstance(raw, dict) and isinstance(raw.get("code"), str) else None
    )
    return DeviceRefusedError(
        code or fallback, f"{what} failed: {res.status_code}", res.status_code
    )


class DevicesClient:
    def __init__(
        self,
        ctx: CoreContext,
        cache: CacheManager,
        tokens: TokenManager,
        *,
        probes: Optional[List[ProbeDeclaration]] = None,
        fingerprint: bool = True,
        caps: Optional[Callable[[], List[str]]] = None,
    ) -> None:
        self._caps = caps
        #: The active pack set's id for the report's ``content`` (P4-07), set by the facade.
        self.pack_set_id: Callable[[], Optional[str]] = lambda: None
        #: The report's ``gate``, ``outlet`` and ``packInstalls`` sources, set by the facade
        #: (SDK parity pass §3.13). ``None`` leaves the key out.
        self.gate_status: Optional[Callable[[], Optional[str]]] = None
        self.outlet_id: Optional[Callable[[], Optional[str]]] = None
        self.pack_installs: Optional[Callable[[], List[Dict[str, Any]]]] = None
        #: The update-health journal whose pending events ride ``updates``; the events a
        #: report the Worker accepted carried are marked sent.
        self.journal: Any = None
        self._ctx = ctx
        self._cache = cache
        self._tokens = tokens
        self._probes: List[ProbeDeclaration] = list(probes or [])
        self._fingerprint_enabled = fingerprint

    def fingerprint(self) -> Optional[dict]:
        """This machine's hashed hardware components, or ``None`` when collection is
        disabled or nothing could be read. Raw hardware values never leave the device."""
        if not self._fingerprint_enabled:
            return None
        try:
            return collect_fingerprint(self._ctx.product)
        except Exception:
            # Best-effort: a host that refuses every probe still registers, and the
            # server records it as unverified.
            return None

    # ── Registration (§6) ───────────────────────────────────────────────────────────
    def register(self) -> RegisterResult:
        """``POST /<p>/devices/register`` — the keyless mint path.

        No ``Authorization`` header is sent even when a stale token is held: a client
        re-registering is asking for a FRESH credential, not authenticating with the old
        one. On success the new token replaces whatever was stored.
        """
        r = self.request_registration()
        if isinstance(r, RegisterOk):
            self._tokens.set(r.token, "register")
        return r

    def request_registration(self) -> RegisterResult:
        """The registration request alone, without storing the token.

        :meth:`register` stores it; the §5 re-register on 401 (P1b-06) lets
        ``TokenManager.reacquire_once`` store it instead, so the one request is identical on
        both paths: the fingerprint when enabled, never a bearer. Internal.
        """
        fingerprint = self.fingerprint()
        # Outside the try — a local-only refusal is a configuration error the host can
        # fix, not a transport outcome to be reported as one.
        self._ctx.http()
        # PX-W13 §8 Q2: the device label rides along, seeding the device's name in the lists.
        label = self._ctx.device_label()
        body: dict = {}
        if fingerprint:
            body["fingerprint"] = fingerprint
        if label:
            body["deviceName"] = label
        try:
            if body:
                res = self._ctx.request(
                    "POST",
                    self._ctx.url(REGISTER_PATH),
                    headers=self._ctx.headers({"content-type": "application/json"}),
                    json=body,
                )
            else:
                res = self._ctx.request(
                    "POST", self._ctx.url(REGISTER_PATH), headers=self._ctx.headers()
                )
        except PolarisError:
            raise
        except Exception as e:
            return RegisterError(message=str(e))

        if res.status_code == 200:
            body = _json_or_empty(res)
            token = body.get("token")
            device_id = body.get("deviceId")
            if not isinstance(token, str) or not isinstance(device_id, str):
                return RegisterError(message="registration response was malformed")
            return RegisterOk(token=token, deviceId=device_id)
        if res.status_code == 403:
            code = _code_of(res)
            if code in (None, "registration_closed"):
                return RegisterClosed()
            return RegisterRefused(code=code, status=403, message=_message_of(res))
        if res.status_code == 429:
            return RegisterRateLimited()
        if res.status_code == 404:
            return RegisterNotConfigured()
        if 400 <= res.status_code < 500:
            return RegisterRefused(
                code=_code_of(res) or "http-error",
                status=res.status_code,
                message=_message_of(res),
            )
        return RegisterError(message=_text_or_empty(res))

    # ── Roster ──────────────────────────────────────────────────────────────────────
    def list(self) -> List[AccountDevice]:
        """``GET /<p>/devices`` — the product's roster for this credential."""
        token = self._require_token()
        res = self._ctx.request(
            "GET",
            self._ctx.url(DEVICES_PATH),
            headers=self._ctx.headers({"authorization": f"Bearer {token}"}),
        )
        if not res.is_success:
            # Fallback code "device_list_failed" when the answer names none.
            raise _refusal(res, "device_list_failed", "device list")
        body = _json_or_empty(res)
        devices = body.get("devices")
        if not isinstance(devices, list):
            return []
        return [AccountDevice.from_dict(d) for d in devices if isinstance(d, dict)]

    def rename(self, device_id: str, label: Optional[str]) -> None:
        """``PATCH /<p>/devices/:id`` — rename (self-only, server-enforced)."""
        token = self._require_token()
        res = self._ctx.request(
            "PATCH",
            self._ctx.url(f"{DEVICES_PATH}/{_quote(device_id)}"),
            headers=self._ctx.headers(
                {
                    "authorization": f"Bearer {token}",
                    "content-type": "application/json",
                }
            ),
            json={"label": label},
        )
        if not res.is_success:
            raise _refusal(res, "device_rename_failed", "device rename")

    def deauthorize(self, device_id: str) -> None:
        """``DELETE /<p>/devices/:id`` — release another device's seat."""
        token = self._require_token()
        res = self._ctx.request(
            "DELETE",
            self._ctx.url(f"{DEVICES_PATH}/{_quote(device_id)}"),
            headers=self._ctx.headers({"authorization": f"Bearer {token}"}),
        )
        if not res.is_success:
            raise _refusal(res, "device_deauthorize_failed", "device deauthorize")

    # ── Telemetry ───────────────────────────────────────────────────────────────────
    def report(self) -> bool:
        """``POST /<p>/devices/report`` — best-effort telemetry built from re-verified
        documents."""
        token = self._tokens.current
        if not token:
            return False
        journal = self.journal
        snapshot = self.snapshot()
        ok = report_snapshot(self._ctx, token, snapshot)
        carried = snapshot.get("updates")
        if ok and journal is not None and isinstance(carried, list):
            journal.mark_sent([e.get("eventId") for e in carried if isinstance(e, dict)])
        return ok

    def snapshot(self) -> Dict[str, Any]:
        """The body :meth:`report` sends, without sending it (for diagnostics and tests)."""
        journal = self.journal
        return build_snapshot(
            self._cache,
            self._probes,
            self._caps,
            self.pack_set_id,
            gate=self.gate_status,
            outlet=self.outlet_id,
            updates=journal.pending if journal is not None else None,
            pack_installs=self.pack_installs,
        )

    def _require_token(self) -> str:
        token = self._tokens.current
        if not token:
            raise DeviceManagementUnsupportedError(
                "Activate or register before managing devices."
            )
        return token


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


def _json_or_empty(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _text_or_empty(res: Any) -> str:
    try:
        return res.text
    except Exception:
        return ""


def _code_of(res: Any) -> Optional[str]:
    raw = _json_or_empty(res).get("error")
    if isinstance(raw, str) and raw:
        return raw
    if isinstance(raw, dict) and isinstance(raw.get("code"), str) and raw["code"]:
        return raw["code"]
    return None


def _message_of(res: Any) -> str:
    m = _json_or_empty(res).get("message")
    return m if isinstance(m, str) else ""
