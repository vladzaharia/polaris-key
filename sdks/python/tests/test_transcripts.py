"""The Python transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/.

Drives ``PolarisKeyClient`` through every recorded conversation ``sdks/python/parity.json``
makes applicable, against a fake server (``transcript_replay.ReplayServer``, an
``httpx.MockTransport`` handler) that serves the Worker's recorded answers and asserts every
request.

Which transcripts run is DATA: a transcript for a feature this SDK has not implemented is
skipped, and starts running the moment the manifest claims it. The SDK clock is ``time.time`` pinned to each step's ``now``: the recorded documents
were signed at a fixed instant and expire an hour later.

``updateDecide`` (plans/P3-01.md §5, §6) is ``client.update.decide(channel=…, staged=…,
skip_version=…)``, and its ``expect`` keys are the ``UpdateCheck``'s own (``channel``,
``decision``, ``feed``, ``record``, ``errors``). ``initial.update`` is the host's configuration:
``pinnedReleaseKeys``, ``outlet``, ``platform``, ``arch``, the ``installed`` build (its ``version``
is the client's ``version``) and ``methods`` become ``UpdateClientOptions``, and ``cache`` (the
``feeds`` and ``releaseRecords`` slices) seeds the store's cache record. A transcript with
``initial.update`` and no ``initial.services`` runs with Release, Distribution and Update
expected. The client loads discovery itself when the session has not; a transcript that never
runs a ``discover`` step, and records no discovery exchange in the step, has it answered here with
the Worker's standard templates (the fallback the Node and React replayers use), so the recording
only has to hold the feed and record traffic.

``discover`` reports the result's ``kind`` and ``presentation``, ``client.presentation()`` after it
(the normalised ``core.presentation`` member, or ``None`` once the product drops it).

``activate`` / ``enroll`` report the ``ActivationResult``'s ``kind`` as ``result`` and, on a
refusal, its wire ``code``. ``boot`` is ``client.boot()`` (default discovery): its ``outcome`` is
``bootOutcome``. ``releaseFetch`` is ``client.release.fetch`` of the build a release record built
from the step's target names (``_release_fetch``; ``partial`` seeds the interrupted ``.part``).
``downloadModel`` is ``client.distribution.download_model()`` with ``current`` from
``this_platform`` at ``initial.platform``. ``initial.updateJournal`` seeds ``client.update_journal``,
and ``report`` adds ``updatesPending``, the events still queued.

The key ring verbs (U-38.3, ``sync.keyring``) run over ``client.keyring``. The transcripts hold no
key material the client could use, so the client makes its own: ``keyringCreate`` and
``keyringReset`` draw a root, ``keyringWrap`` seals it to a fresh agreement key for the named
device (``deviceId`` is the TARGET; the calling device stays ``initial.deviceId``), and
``keyringAdopt`` takes the root of the first ring this conversation created. A refusal reads as
``result: "refused"`` with the status and the code. The recordings still hold ``kem`` as a string;
the client sends the integer 32 (§13.11.1), so the replay maps it back to the recorded spelling
until the transcripts move (lead decision 2026-10-27).

``cloudSyncPull`` / ``cloudSyncPush`` (U-06.11, ``sync.settings``, WIRE-CONTRACT-V4 section 13.3, 13.4, V5
section 13.10) send the request through the Cloud Sync host's own transport (``send_sync``: the bearer, the
``X-PKey-*`` headers, the byte caps). A pull is ``GET /<p>/sync?cursor=N`` (the replay's transport adds
``If-None-Match`` with the last ETag, as a cache would); a push carries N generated mutations. In the
end-to-end transcript the push body is sealed by ``seal_push`` and the answer opened by ``open_pull``
(``host_codec``) over a fixture root: the recorded ``ct`` s are fixture bytes, so every row must come back
``invalid``. The report is ``result``, ``cursor``, ``more``, ``settings`` (the wire's setting names,
sorted) and ``results`` (one label per mutation result) beside the quota and encryption members.

``chunkRange`` (P4-32, plans/P4-32.md §5) is ``chunk_range_fetch`` over the packs client's own
object fetch (``client.update.packs._fetch_object``), against the blobs template the last
discover returned. ``range`` is the fetch's status; ``bytes`` the body it returned, as a string.
"""

# @pkey-feature core.discover core.sync core.cache license.activate license.enroll
# @pkey-feature license.deactivate license.reregister devices.register devices.report
# @pkey-feature config.schema release.changelog release.download
# @pkey-feature identity.devicecode identity.devicelabel config.mint
# @pkey-feature update.feed release.record update.decide
# @pkey-feature packs.apply.chunk commerce.receipt
# @pkey-feature license.refusals ui.boot release.fetch release.distribution telemetry.updates
# @pkey-feature license.manage
# @pkey-feature identity.keyentry identity.account identity.attach identity.toggle
# @pkey-feature core.presentation ui.cli.portal
# @pkey-feature identity.redirect.web identity.choice identity.signin.hints
# @pkey-feature sync.keyring connect.identity sync.settings

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from polaris_key import PolarisError, PolarisKeyClient, StagedUpdate, UpdateClientOptions
from polaris_key.constants_generated import ERROR_CODE_VALUES
from polaris_key.core.b64url import b64url_encode
from polaris_key.cloud_sync.host_codec import open_pull, seal_push
from polaris_key.cloud_sync.transport import send_sync
from polaris_key.core import sync_crypto as sc
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.device_keys import DevicePublicKeys
from polaris_key.core.models import ReleaseRecordDoc
from polaris_key.core.store import CacheRecord
from polaris_key.devices.keys import create_device_key_store
from polaris_key.update.packs import chunk_range_fetch

from transcript_replay import (
    ReplayError,
    ReplayServer,
    applies,
    doctor,
    load_manifest,
    load_transcripts,
)

MANIFEST = load_manifest("sdks/python/parity.json")
TRANSCRIPTS = load_transcripts()

#: A fixed hashed fingerprint, so the replay does not depend on what this host can read.
FINGERPRINT = {
    "components": {"machineUuid": "REPLAYmachineUuid00000"},
    "hwid": "REPLAYhwid0000000000000000000000",
}


class TranscriptStore:
    """The store the replay starts from: the transcript's device id and token."""

    def __init__(self, device_id: str, token: Optional[str]) -> None:
        self._device_id = device_id
        self.token = token
        self._cache: Optional[CacheRecord] = None

    def get_token(self) -> Optional[str]:
        return self.token

    def set_token(self, token: str) -> None:
        self.token = token

    def clear_token(self) -> None:
        self.token = None

    def get_device_id(self) -> str:
        return self._device_id

    def read_cache(self) -> Optional[CacheRecord]:
        return self._cache

    def write_cache(self, rec: CacheRecord) -> None:
        self._cache = rec

    def clear_cache(self) -> None:
        self._cache = None


class _FixtureKeys:
    """The fixture device keys of a label (format.ts, connectIdentity), as a key port: the Ed25519 seed is
    SHA-256(label), the agreement key's 32 bytes are SHA-256(label + ":agree") with the top bit of the
    last byte clear. The agreement key has no private half here (identity needs none), so ``dh`` answers
    ``None``. A test-only port; the SDK ships no label-derived keys."""

    def __init__(self, label: str) -> None:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        self._priv = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(label.encode()).digest())
        agree = bytearray(hashlib.sha256(f"{label}:agree".encode()).digest())
        agree[31] &= 0x7F
        sign = self._priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self._keys = DevicePublicKeys(
            sign_key=b64url_encode(sign), agree_key=b64url_encode(bytes(agree)), generation=1
        )

    def ensure(self) -> DevicePublicKeys:
        return self._keys

    def public_keys(self) -> DevicePublicKeys:
        return self._keys

    def sign(self, message: bytes) -> bytes:
        return self._priv.sign(message)

    def dh(self, peer_public: bytes) -> None:
        return None

    def rotate(self) -> DevicePublicKeys:
        return self._keys

    def persistence(self) -> str:
        return "durable"

    def wipe(self) -> None:
        return None


def _connect_step(client: PolarisKeyClient, step: Dict[str, Any], session: Dict[str, Any]) -> Dict[str, Any]:
    """``client.connect`` (CC-06.4, ``connect.identity``): the identity and the device list."""
    out: Dict[str, Any] = {}
    label = str(step["args"]["keyLabel"])
    if session.get("keyLabel") != label:
        # A different label is a different key pair: the next call registers it.
        client.connect.use_device_keys(_FixtureKeys(label))  # type: ignore[arg-type]
        session["keyLabel"] = label
    try:
        if step["action"] == "connectIdentity":
            ident = client.connect.identity(refresh=step["args"].get("refresh") is True)
            disc = client.connect.discovery_keys()
            out["result"] = "ok"
            out["epoch"] = ident.epoch
            out["devices"] = [d.device_id for d in ident.devices]
            out["deviceId"] = ident.device_id
            out["discKeys"] = 2 if disc is not None and disc.previous is not None else 1
        else:
            out["result"] = "ok"
            out["devices"] = [
                {
                    "deviceId": d.device_id,
                    "label": d.label,
                    "platform": d.platform,
                    "lastSeen": d.last_seen,
                    "self": d.self,
                }
                for d in client.connect.list_devices()
            ]
    except UnsupportedError:
        out["result"] = "unavailable"
    except PolarisError as e:
        out["result"] = "refused"
        out["code"] = e.code
    return out


def _act(
    client: PolarisKeyClient,
    store: TranscriptStore,
    step: Dict[str, Any],
    session: Dict[str, Any],
) -> Dict[str, Any]:
    """THE mapping from transcript verbs and ``expect`` keys onto the Python SDK.

    ``session`` carries the sign-in session the last ``beginSignIn`` started between steps."""
    out: Dict[str, Any] = {}
    action = step["action"]
    args = step["args"]
    if action.startswith("keyring"):
        return _keyring_step(client, step, session)
    if action in ("cloudSyncPull", "cloudSyncPush"):
        return _cloud_sync_step(client, step, session)
    if action in ("connectIdentity", "connectDevices"):
        return _connect_step(client, step, session)
    # D-6: the recorded action names map onto the session (`sign_in.start`, `wait`).
    if action == "beginSignIn":
        try:
            p = client.identity.sign_in.start(device_name=args.get("deviceName"))
        except PolarisError as e:
            # identity-disabled: the refusal is the step's result.
            out["result"] = e.code
        else:
            session["prompt"] = p
            out["prompt"] = {
                "userCode": p.user_code,
                "verificationUri": p.verification_uri,
                "verificationUriComplete": p.verification_uri_complete,
                "expiresIn": p.expires_in,
                "interval": p.interval,
                "deviceName": p.device_name,
            }
    elif action == "pollSignIn":
        try:
            o = session["prompt"].wait(once=True)
        except PolarisError as e:
            if e.code in ("sign-in-denied", "sign-in-failed"):
                out["result"] = "error"
                out["code"] = e.code
            elif e.code in ("server-error", "network-error"):
                # I-37d: no answer or a 5xx on the poll is transient; a wait loop keeps polling.
                out["result"] = "transient"
                out["code"] = e.code
            else:
                raise
        else:
            if o.kind == "pending":
                out["result"] = "slow-down" if o.slow_down else "pending"
                if o.slow_down:
                    out["interval"] = o.interval
            else:
                out["result"] = "ready" if o.kind == "signed_in" else o.kind
    elif action == "waitForSignIn":
        try:
            done = session["prompt"].wait()
        except PolarisError as e:
            if e.code not in ("sign-in-denied", "sign-in-failed"):
                raise
            out["result"] = "error"
            out["code"] = e.code
        else:
            out["result"] = "ready" if done.kind == "signed_in" else done.kind
    elif action == "mintToken":
        try:
            minted = client.config.mint_token(args["recipeId"])
        except PolarisError as e:
            out["result"] = e.code
        else:
            out["result"] = "ok"
            out["token"] = minted.token
            out["expiresAt"] = minted.expiresAt
    elif action == "commerceBinding":
        try:
            b = client.commerce.binding()
        except PolarisError as e:
            out["result"] = e.code
        else:
            out["result"] = "ok"
            out["bindingId"] = b.bindingId
            out["products"] = [dataclasses.asdict(p) for p in b.products]
    elif action == "commerceClaim":
        r = client.commerce.claim(args["store"], args["payload"])
        if r.kind == "ok":
            out["result"] = "ok"
            out["flag"] = r.flag
            out["state"] = r.state
            out["granted"] = r.granted
        else:
            out["result"] = r.code
            if r.reason is not None:
                out["reason"] = r.reason
    elif action == "discover":
        out["result"] = client.discover().kind
        # core.presentation (HA-13): the normalised member the discovery left, or None.
        out["presentation"] = client.presentation()
        # ui.cli.portal (DISC-01): the core.portal member the client holds after this discovery.
        out["portal"] = client.portal()
    elif action == "sync":
        r = client.sync(force=args.get("force") is True)
        out["applied"] = r.applied
        out["unauthorized"] = r.unauthorized
        out["blocked"] = r.blocked
        out["documents"] = {
            slice_: outcome.kind
            for slice_, outcome in r.documents.items()
            if outcome.kind != "skipped"
        }
    elif action in ("activate", "enroll"):
        r = (
            client.license.activate_with_key(args["key"])
            if action == "activate"
            else client.license.enroll()
        )
        out["result"] = r.kind
        if r.kind != "ok":
            out["code"] = r.code
        # PX-W8: the refusal link, exactly as served; None when the result carries none.
        if r.kind in ("device-limit", "key-entry-limit"):
            out["manageUrl"] = r.manage_url
        # I-10a: the key-entry count the answer carried; None with Identity off.
        entries = getattr(r, "key_entries", None)
        out["keyEntries"] = None if entries is None else {"used": entries.used, "limit": entries.limit}
        if r.kind == "license-owned":
            # The recorded vocabulary (keyentry-owned) names this refusal ``refused`` with the
            # wire code; the typed kind carries the sign-in link.
            out["result"] = "refused"
            out["signInUrl"] = r.sign_in_url
    elif action == "browser":
        out.update(_browser_step(client, step, session))
    elif action == "redirectComplete":
        cb = urlsplit(args["callbackUrl"])
        s = _start_redirect_for(
            client, step, f"{cb.scheme}://{cb.netloc}{cb.path}", session.get("license_choice")
        )
        try:
            done = s.complete(args["callbackUrl"])
            out["result"] = "ok" if done.kind == "signed_in" else done.kind
            if done.kind == "signed_in":
                out["scope"] = done.scope
                out["licenseId"] = done.activation.license_id
                out["subject"] = done.subject
                out["tokenHeld"] = store.token is not None
        except PolarisError as e:
            out["result"] = e.code.replace("_", "-")
            out["code"] = e.code
    elif action in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel"):
        # The grant routes (I-10a.17): `client.identity.choice.*`, a refusal being a result.
        grant = str(args["grant"])
        choice = client.identity.choice
        refused = None
        if action == "choiceLicenses":
            r = choice.licenses(grant)
            if r.kind == "ok":
                out["state"] = r.view.state
                out["licenses"] = sorted(r.view.license_ids)
            else:
                refused = r
        elif action == "choiceDevices":
            r = choice.devices(grant, str(args["licenseId"]))
            if r.kind == "ok":
                out["devices"] = r.view.device_ids
            else:
                refused = r
        elif action == "choiceComplete":
            r = choice.complete(grant, _recorded_choice(step))
            if r.kind == "ok":
                out["licenseId"] = r.license_id
                out["subject"] = r.subject
                out["tokenHeld"] = store.token is not None
                if r.key_entries is not None:
                    out["keyEntries"] = {"used": r.key_entries.used, "limit": r.key_entries.limit}
            else:
                refused = r
        else:
            r = choice.cancel(grant)
            if r.kind != "ok":
                refused = r
        out["result"] = "refused" if refused is not None else "ok"
        if refused is not None:
            out["code"] = refused.code
    elif action == "subject":
        out["subject"] = client.identity.subject()
    elif action == "signOut":
        out["released"] = client.identity.sign_out().released
    elif action == "attach":
        a = client.identity.attach(confirm=args.get("confirm") is True)
        out["result"] = a.kind
        if a.kind == "confirm":
            out["license"] = {
                "id": a.license.id,
                "tierId": a.license.tierId,
                "name": a.license.name,
            }
        elif a.kind == "ok":
            out["attached"] = a.attached
            out["subject"] = a.subject
        else:
            out["code"] = a.code
    elif action == "boot":
        # The shell stage's discovery runs even though the host pinned its services
        # (``initial.services``): the recording's boot loads discovery first.
        out["bootOutcome"] = client.boot().outcome
    elif action == "releaseFetch":
        out.update(_release_fetch(client, args, session))
    elif action == "downloadModel":
        model = client.distribution.download_model()
        out["result"] = "ok"
        out["platforms"] = [g.platform for g in model.platforms]
        current = client.distribution.this_platform(model)
        out["current"] = (
            None
            if current is None
            else {
                "platform": current.platform,
                "label": current.label,
                "primary": current.primary,
                "actions": list(current.actions),
                "builds": [dict(b) for b in current.builds],
            }
        )
    elif action == "register":
        out["result"] = client.devices.register().kind
    elif action == "deactivate":
        client.license.deactivate()
    elif action == "report":
        out["result"] = client.devices.report()
        out["updatesPending"] = len(client.update_journal.events())
    elif action == "fetchSchema":
        out["catalog"] = client.config.fetch_schema()
    elif action == "changelog":
        try:
            out["entries"] = [dataclasses.asdict(e) for e in client.release.changelog()]
            out["result"] = "ok"
        except PolarisError as e:
            out["result"] = "error"
            out["code"] = e.code
    elif action == "installUrl":
        out["url"] = client.release.install_url()
    elif action == "chunkRange":
        fetch_range = chunk_range_fetch(client.update.packs._fetch_object)
        r = fetch_range(args["bundle"], int(args["offset"]), int(args["length"]))
        out["range"] = r.status
        if r.status == "ok":
            out["bytes"] = b"".join(bytes(c) for c in r.chunks).decode("latin-1")
    elif action == "updateDecide":
        staged = args.get("staged")
        try:
            check = client.update.decide(
                channel=args.get("channel"),
                staged=(
                    StagedUpdate(version=staged["version"], channel=staged["channel"])
                    if isinstance(staged, dict)
                    else None
                ),
                skip_version=args.get("skipVersion"),
            )
        except PolarisError as e:
            out["result"] = "error"
            out["code"] = e.code
        else:
            out["result"] = "ok"
            out.update(check.to_dict())
    elif action == "downloadUrl":
        out["url"] = client.release.download_url(
            args["version"],
            args["binary"],
            args["arch"],
            checksum=args.get("checksum") is True,
            dmg=args.get("dmg") is True,
        )
    else:
        raise AssertionError(f"unknown action {action}")
    out["services"] = {
        slug: bool(s.get("enabled")) for slug, s in client.capabilities().items()
    }
    out["licenseStatus"] = client.status().status
    out["tokenHeld"] = store.token is not None
    return out


def _keyring_step(
    client: PolarisKeyClient, step: Dict[str, Any], session: Dict[str, Any]
) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    k = client.keyring
    action, args = step["action"], step["args"]
    try:
        if action == "keyringGet":
            r = k.read()
            ring = r.ring
            out["ring"] = (
                None
                if ring is None
                else {
                    "ringId": ring.ring_id,
                    "epoch": ring.epoch,
                    "rootKid": ring.root_kid,
                    "state": ring.state,
                    "recoverySet": ring.recovery_set,
                    "previous": ring.previous["ringId"] if ring.previous else None,
                    "adopted": [a["ringId"] for a in ring.adopted],
                }
            )
            out["wrap"] = (
                None if r.wrap is None else {"epoch": r.wrap.epoch, "kid": r.wrap.kid, "by": r.wrap.by}
            )
        elif action in ("keyringCreate", "keyringReset"):
            made = k.create() if action == "keyringCreate" else k.reset()
            if action == "keyringCreate":
                session.setdefault("firstRingId", made.ring_id)
            # The ring id is the client's own draw and the recording's is a fixture: both must be a
            # well formed id, and the replay reports the recorded one when ours is.
            well_formed = re.fullmatch(r"rg_[A-Za-z0-9_-]{22}", made.ring_id) is not None
            out["ringId"] = step["expect"].get("ringId", made.ring_id) if well_formed else made.ring_id
            out["epoch"] = made.epoch
        elif action == "keyringWrap":
            pub = X25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
            k.wrap_to(str(args["deviceId"]), pub)
        elif action == "keyringUnwrap":
            k.remove_wrap(str(args["deviceId"]))
        elif action == "keyringAdopt":
            k.adopt(session.get("firstRingId", ""))
        elif action == "keyringRecoverySet":
            k.set_recovery_code()
        elif action == "keyringRecoveryGet":
            out["ct"] = k.recovery_blob().ct
        else:
            raise AssertionError(f"unknown action {action}")
        out["result"] = "ok"
    except PolarisError as e:
        out["result"] = "refused"
        if e.status is not None:
            out["status"] = e.status
        out["code"] = e.code
    return out


# ── Cloud Sync settings (U-06.11, `sync.settings`) ───────────────────────────────────────────────

#: The settings the generated mutations name: declared in the replay's catalog, or open.
SYNC_DECLARED = ["ui.theme", "audio.volume"]
SYNC_E2E_NAMES = ["ui.theme", "my.open.key", "game.best"]
SYNC_E2E_ROUTES = [
    {"key": "ui.theme", "route": "synced", "scope": "user", "policy": "lastWrite"},
    {"key": "game.best", "route": "synced", "scope": "user", "policy": "max"},
]
SYNC_CLIENT_ID = "c_AAAAAAAAAAAAAAAAAAAAAA"
SYNC_HLC = "018bcfe56418:0000"

#: A fixture root: the replay's ring is not a real one, so every recorded ``ct`` is ``invalid``.
FIXTURE_ROOT = bytes((3 * i + 7) % 256 for i in range(32))


class FixtureCodec:
    """The host codec over the fixture root (the replay's stand-in for ``client.keyring.codec``)."""

    locked = False

    def seal(self, collection: str, name: str, value: Any) -> bytes:
        return sc.seal_value(FIXTURE_ROOT, collection, name, value)

    def open(self, collection: str, name: str, envelope: bytes, aliases: Any = None) -> Any:
        return sc.open_value(FIXTURE_ROOT, collection, name, envelope, aliases)

    def open_any(self, collection: str, envelope: bytes) -> Any:
        return sc.open_value_any_name(FIXTURE_ROOT, collection, envelope)

    def blind(self, kind: str, ctx: str, name: str) -> str:
        return sc.blind(FIXTURE_ROOT, kind, ctx, name)


def _generated_mutations(count: int, first: int, names: List[str]) -> List[Dict[str, Any]]:
    """``count`` generated set mutations, ids from ``first``, cycling through ``names``."""
    return [
        {
            "mutationId": first + i,
            "target": {"setting": names[i % len(names)], "scope": "user"},
            "op": "set",
            "value": f"generated-{first + i}",
            "editedHlc": SYNC_HLC,
        }
        for i in range(count)
    ]


def _result_label(r: Dict[str, Any]) -> str:
    """One label per mutation result, in the transcript format's words."""
    status = r.get("status")
    if status == "ok":
        if isinstance(r.get("renamedTo"), str):
            return f"ok:renamedTo:{r['renamedTo']}"
        return "ok:dropped" if r.get("dropped") is True else "ok"
    if status == "rejected":
        scope = r.get("scope")
        return f"rejected:{r.get('code')}:{scope}" if isinstance(scope, str) else f"rejected:{r.get('code')}"
    return str(status)


def _cloud_sync_step(
    client: PolarisKeyClient, step: Dict[str, Any], session: Dict[str, Any]
) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    t = session["transcript"]
    e2e = t["id"] == "cloudsync-e2e-settings"
    args = step["args"]
    cursor = int(args["cursor"])
    wire = session.setdefault("syncWire", {"etag": None, "retryAfter": None})
    wire["retryAfter"] = None
    mutations: List[Dict[str, Any]] = []
    if step["action"] == "cloudSyncPull":
        req: Dict[str, Any] = {"method": "GET", "path": f"/{t['product']}/sync?cursor={cursor}"}
    else:
        mutations = _generated_mutations(
            int(args["mutations"]),
            session.setdefault("syncNextId", 1),
            SYNC_E2E_NAMES if e2e else SYNC_DECLARED,
        )
        body: Dict[str, Any] = {
            "clientId": SYNC_CLIENT_ID,
            "cursor": cursor,
            **({"atomic": True} if args.get("atomic") is True else {}),
            "mutations": mutations,
        }
        req = {
            "method": "POST",
            "path": f"/{t['product']}/sync/ops",
            "body": seal_push(body, FixtureCodec(), SYNC_E2E_ROUTES) if e2e else body,
        }
    res = send_sync(client.core, client._tokens, req)
    if "error" in res:
        out["result"] = res["error"]
        return out
    status = res["status"]
    if status == 304:
        out["result"] = "not-modified"
        return out
    if not 200 <= status < 300:
        out["result"] = "refused"
        out["status"] = status
        err = res["body"].get("error") if isinstance(res.get("body"), dict) else None
        if isinstance(err, dict) and isinstance(err.get("code"), str):
            out["code"] = err["code"]
        if wire["retryAfter"] is not None:
            out["retryAfter"] = int(wire["retryAfter"])
        return out
    body_in: Any = res.get("body")
    if e2e and body_in is not None:
        body_in, opened = open_pull(body_in, FixtureCodec(), mutations=mutations)
        rows = [*(opened.get("changes") or []), *(opened.get("conflicts") or {}).values()]
        for row in rows:
            assert row == {"invalid": True}, f"{t['id']}: a fixture ct opens"
    out["result"] = "ok"
    if not isinstance(body_in, dict):
        return out
    if isinstance(body_in.get("cursor"), int):
        out["cursor"] = body_in["cursor"]
    if isinstance(body_in.get("more"), bool):
        out["more"] = body_in["more"]
    out["empty"] = body_in.get("empty") is True
    changes = body_in.get("changes") if isinstance(body_in.get("changes"), list) else []
    out["settings"] = sorted(
        c["setting"] for c in changes if isinstance(c, dict) and isinstance(c.get("setting"), str)
    )
    quota = body_in.get("quota")
    if isinstance(quota, dict):
        if isinstance(quota.get("bytes"), int):
            out["quotaBytes"] = quota["bytes"]
        if isinstance(quota.get("files"), bool):
            out["files"] = quota["files"]
    if isinstance(body_in.get("encryption"), str):
        out["encryption"] = body_in["encryption"]
    if isinstance(body_in.get("encryptionSince"), int):
        out["encryptionSince"] = body_in["encryptionSince"]
    if isinstance(body_in.get("aliases"), dict):
        out["aliases"] = body_in["aliases"]
    if step["action"] == "cloudSyncPush":
        if isinstance(body_in.get("lastMutationId"), int):
            out["lastMutationId"] = body_in["lastMutationId"]
            session["syncNextId"] = body_in["lastMutationId"] + 1
        results = body_in.get("results") if isinstance(body_in.get("results"), list) else []
        out["results"] = [_result_label(r) if isinstance(r, dict) else "?" for r in results]
    return out


def _release_fetch(
    client: PolarisKeyClient, args: Dict[str, Any], session: Dict[str, Any]
) -> Dict[str, Any]:
    """``releaseFetch``: ``client.release.fetch`` of the build a verified release record names
    (the record is built from the step's target), into a fresh directory. ``partial`` seeds the
    interrupted download an earlier call would have left: the payload's first bytes in
    ``<to>.part`` and, beside it, the validator that call stored (the build route's ETag, the
    quoted SHA-256), so the SDK resumes with ``Range`` and ``If-Range``."""
    record = ReleaseRecordDoc.from_dict(
        {
            "schemaVersion": 1,
            "aud": client.core.product,
            "deliverable": "app",
            "kind": "app",
            "version": args["version"],
            "seq": 1,
            "issuedAt": 1,
            "builds": [
                {
                    "id": args["build"],
                    "platform": args["platform"],
                    "arch": args["arch"],
                    "format": "tar.gz",
                    "artifacts": [
                        {
                            "name": "payload",
                            "role": "payload",
                            "sha256": args["sha256"],
                            "size": args["size"],
                        }
                    ],
                }
            ],
        }
    )
    directory = tempfile.mkdtemp(prefix="pkey-replay-")
    session.setdefault("dirs", []).append(directory)
    to = os.path.join(directory, "payload")
    partial = args.get("partial")
    if isinstance(partial, int) and partial > 0:
        whole = session.get("payload")
        assert isinstance(whole, bytes), "a partial releaseFetch needs an earlier whole fetch"
        with open(to + ".part", "wb") as f:
            f.write(whole[:partial])
        with open(to + ".part.json", "w", encoding="utf-8") as f:
            json.dump({"sha256": args["sha256"], "etag": f'"{args["sha256"]}"'}, f)
    try:
        got = client.release.fetch(record, to=to, build_id=args["build"])
    except PolarisError as e:
        return {
            "result": "refused" if e.code in ERROR_CODE_VALUES else "error",
            "code": e.code,
        }
    with open(got.path, "rb") as f:
        data = f.read()
    session["payload"] = data
    return {
        "result": "ok",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


#: The ``state``, verifier and redirect URI the Worker scenarios use (their ``browser`` and
#: ``redirectComplete`` args name them when a step differs from these).
REDIRECT_DEFAULTS = {
    "state": "tidewater-state-0123456789",
    "code_verifier": "transcript-verifier-0123456789-abcdefghijklmnopqrst",
    "redirect_uri": "https://app.example/auth/callback",
}


def _recorded_choice(step: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The ``choice`` a ``choiceComplete`` step sends: the step's own ``choice`` arg, else the one
    the recording's request carries (a key is not a transcript arg). A recording with none is the
    Worker's 409 ``license_choice_required`` for a completion that names no choice: the SDK sends
    no ``choice`` member."""
    if "choice" in step["args"]:
        return step["args"]["choice"]  # type: ignore[no-any-return]
    body = step["exchanges"]["items"][0]["request"].get("body")
    return ((body or {}).get("json") or {}).get("choice")


def _start_redirect_for(
    client: PolarisKeyClient, step: Dict[str, Any], redirect_uri: str, license_choice: Optional[str]
) -> Any:
    """A fresh redirect sign-in with the recorded entropy, as the host would start it."""
    args = step["args"]
    client.identity._deps.entropy = {
        "state": args.get("state", REDIRECT_DEFAULTS["state"]),
        "code_verifier": args.get("codeVerifier", REDIRECT_DEFAULTS["code_verifier"]),
    }
    opts: Dict[str, Any] = {}
    for arg, name in (("loginHint", "login_hint"), ("nameHint", "name_hint"), ("purpose", "purpose")):
        if isinstance(args.get(arg), str):
            opts[name] = args[arg]
    if license_choice:
        opts["license_choice"] = license_choice
    return client.identity.sign_in.start(channel="redirect", redirect_uri=redirect_uri, **opts)


def _browser_step(
    client: PolarisKeyClient, step: Dict[str, Any], session: Dict[str, Any]
) -> Dict[str, Any]:
    """One ``browser`` step: the page the person's browser would load. The authorize request is
    the one the SDK built (its ``authorize_url``), unless the step is a refusal (``expect.error``
    on an authorize exchange: a wrong client, an unregistered redirect URI, plain PKCE,
    ``openid``): an SDK cannot be made to send those, so the browser plays the recorded request.
    Every other request is the card's own and is played as recorded. The observation is where the
    browser ended up."""
    t, server = session["transcript"], session["server"]
    base = t["baseUrl"]
    authorize_path = f"/{t['product']}/identity/authorize"
    redirect_uri = step["args"].get("redirectUri", REDIRECT_DEFAULTS["redirect_uri"])
    out: Dict[str, Any] = {}
    last: Optional[httpx.Response] = None
    for item in step["exchanges"]["items"]:
        req = item["request"]
        path = req["path"]
        if req["method"] == "GET" and path.startswith(authorize_path) and "error" not in step["expect"]:
            recorded = parse_qs(urlsplit(path).query)
            choice = "app" if recorded.get("license_choice") == ["app"] else None
            s = _start_redirect_for(client, step, redirect_uri, choice)
            session["license_choice"] = choice
            built = urlsplit(s.authorize_url)
            path = built.path + "?" + built.query
        kwargs: Dict[str, Any] = {}
        if req["body"] is not None:
            kwargs["json"] = req["body"]["json"]
        # A CORS exchange (`cloudsync-cors`) is the browser's own: the recorded headers are played as
        # recorded, and the SDK asserts nothing about them (React's Chromium job does).
        origin = (req.get("headers") or {}).get("origin")
        if origin is not None:
            token = client._tokens.current
            if req["method"] == "OPTIONS" or token is None:
                kwargs["headers"] = dict(req["headers"])
            else:
                # The request itself carries the SDK's own headers and the device bearer.
                kwargs["headers"] = {
                    **client.core.headers({"authorization": f"Bearer {token}"}),
                    "content-type": "application/json",
                    "origin": origin,
                }
        last = server(httpx.Request(req["method"], base + path, **kwargs))
    if last is None:
        return out
    app = urlsplit(redirect_uri)
    location = last.headers.get("location")
    if location is None:
        try:
            j = last.json()
            location = j.get("redirect") if isinstance(j, dict) else None
        except ValueError:
            location = None
    if isinstance(location, str):
        to = urlsplit(urljoin(base + "/", location))
        if (to.scheme, to.netloc) == (app.scheme, app.netloc) and to.path == app.path:
            out["navigated"] = "app"
            err = parse_qs(to.query).get("error")
            if err:
                out["error"] = err[0]
        elif "bind" in parse_qs(to.query):
            out["navigated"] = "bind"
        else:
            out["navigated"] = "card"
        return out
    if last.status_code == 404:
        out["navigated"] = "refused"
        return out
    if last.headers.get("content-type", "").startswith("text/html"):
        out["navigated"] = "page"
        # The refusal page names no code in its body; the Worker's mapping is by status.
        out["error"] = "invalid_client" if last.status_code == 401 else "redirect_uri_mismatch"
        return out
    # The card reading its request (hints) or answering a refused Continue: still on the card.
    out["navigated"] = "card"
    try:
        view = last.json()
    except ValueError:
        view = None
    if isinstance(view, dict) and "request" in view:
        out["loginHint"] = view.get("loginHint")
        out["nameHint"] = view.get("nameHint")
        out["purpose"] = view.get("purpose")
    return out


def _uses_redirect(t: Dict[str, Any]) -> bool:
    """Does this transcript replay a redirect sign-in (so discovery must serve the Identity fragment)?"""
    return any(s["action"] in ("browser", "redirectComplete") for s in t["steps"])


def _redirect_issuer(t: Dict[str, Any]) -> str:
    """The issuer the Worker's discovery names for a redirect transcript: the ``iss`` its recorded
    callbacks carry (the customer host's issuer differs from the API host's), else the product's."""
    for step in t["steps"]:
        cb = step["args"].get("callbackUrl")
        if isinstance(cb, str):
            iss = parse_qs(urlsplit(cb).query).get("iss")
            if iss:
                return iss[0]
    return f"{t['baseUrl']}/{t['product']}/identity"


def _uses_account(t: Dict[str, Any]) -> bool:
    """Does this transcript call the account verbs (so discovery must name their endpoints)?"""
    return any(s["action"] in ("subject", "signOut", "attach") for s in t["steps"])


def _standard_discovery(t: Dict[str, Any]) -> Dict[str, Any]:
    """The Worker's standard discovery document, for a transcript that loads none itself."""
    base = f"{t['baseUrl']}/{t['product']}"
    if _uses_account(t) or _uses_redirect(t):
        choice = any(
            "/identity/choice/" in x["request"]["path"]
            for s in t["steps"]
            for x in s["exchanges"]["items"]
        )
        # A slug discovery omits reads as off, so the account transcripts name their services;
        # the Identity fragment names the account endpoints (WIRE-CONTRACT-V4 §12.6).
        return {
            "product": t["product"],
            "services": {
                "license": {"enabled": True},
                "config": {"enabled": True},
                "identity": {
                    "enabled": True,
                    "configured": True,
                    "account": True,
                    "issuer": _redirect_issuer(t),
                    "endpoints": {
                        "subject": f"{base}/identity/subject",
                        "signout": f"{base}/identity/signout",
                        "attach": f"{base}/identity/attach",
                        "accountPortal": f"{t['baseUrl']}/#/p/{t['product']}",
                        "authorize": f"{base}/identity/authorize",
                        "token": f"{base}/identity/token",
                        **(
                            {
                                "choiceLicenses": f"{base}/identity/choice/licenses",
                                "choiceDevices": f"{base}/identity/choice/devices",
                                "choiceComplete": f"{base}/identity/choice/complete",
                                "choiceCancel": f"{base}/identity/choice/cancel",
                            }
                            if choice
                            else {}
                        ),
                    },
                },
            },
        }
    return {
        "product": t["product"],
        "services": {
            "release": {"enabled": True, "endpoints": {"record": f"{base}/release/records/{{sha256}}"}},
            "distribution": {
                "enabled": True,
                "endpoints": {"builds": f"{base}/distribution/builds/{{selector}}/{{buildId}}"},
            },
            "update": {"enabled": True, "endpoints": {"feed": f"{base}/update/{{channel}}/feed.jws"}},
        },
    }


def _update_options(u: Dict[str, Any]) -> UpdateClientOptions:
    installed = u.get("installed") or {}
    return UpdateClientOptions(
        pinned_release_keys=u["pinnedReleaseKeys"],
        outlet=u.get("outlet"),
        platform=u["platform"],
        arch=u["arch"],
        build_number=installed.get("buildNumber"),
        format=installed.get("format"),
        engine=installed.get("engine"),
        binary_version=installed.get("binaryVersion"),
        methods=tuple(u.get("methods") or ("download",)),
    )


def replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": float(t["now"])}
    monkeypatch.setattr(time, "time", lambda: clock["now"])
    server = ReplayServer(t)
    store = TranscriptStore(t["initial"]["deviceId"], t["initial"].get("token"))
    u = t["initial"].get("update")
    kwargs: Dict[str, Any] = {}
    connect_dir: Optional[str] = None
    if "connect.identity" in t["features"]:
        # The held identity lives under the state directory: a fresh one per replay.
        connect_dir = tempfile.mkdtemp(prefix="pkey-connect-")
        kwargs["state_dir"] = connect_dir
    services = t["initial"].get("services")
    if services is None and u is not None:
        services = ["release", "distribution", "update"]
    if services is not None:
        kwargs["expected_services"] = services
    if u is not None:
        kwargs["update"] = _update_options(u)
        cache = u.get("cache") or {}
        store.write_cache(
            CacheRecord(
                feeds=dict(cache.get("feeds") or {}),
                releaseRecords=dict(cache.get("releaseRecords") or {}),
            )
        )

    # The standard discovery answer, for a transcript that loads discovery nowhere itself.
    discovery_path = f"/{t['product']}/.well-known/polaris.json"
    discovered = {"done": any(s["action"] == "discover" for s in t["steps"])}
    sync_wire: Dict[str, Any] = {"etag": None, "retryAfter": None}

    def transport(request: httpx.Request) -> httpx.Response:
        step = server._step
        if (
            not discovered["done"]
            and request.url.raw_path.decode("ascii") == discovery_path
            and step is not None
            and not any(x["request"]["path"] == discovery_path for x in step["exchanges"]["items"])
        ):
            discovered["done"] = True
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                content=json.dumps(_standard_discovery(t)).encode("utf-8"),
            )
        if request.url.path == f"/{t['product']}/sync" and request.method == "GET":
            # A pull sends back the last ETag it saw, as a cache would (the transport has no cache).
            if sync_wire["etag"] is not None:
                request.headers["if-none-match"] = sync_wire["etag"]
            res = server(request)
            sync_wire["etag"] = res.headers.get("etag", sync_wire["etag"])
            sync_wire["retryAfter"] = res.headers.get("retry-after")
            return res
        res = server(request)
        if request.url.path == f"/{t['product']}/sync/ops":
            sync_wire["retryAfter"] = res.headers.get("retry-after")
        return res

    client = PolarisKeyClient(
        product_slug=t["product"],
        version=(u or {}).get("installed", {}).get("version") or t["initial"]["version"],
        pinned_keys=t["trust"],
        base_url=t["baseUrl"],
        store=store,
        client=httpx.Client(transport=httpx.MockTransport(transport)),
        request_timeout=None,
        # PX-W13: `initial.deviceName` stands in for the platform's node name; absent = none.
        device_name=t["initial"].get("deviceName", ""),
        # The key ring's device keys: a memory store, since the replay registers none.
        device_keys=create_device_key_store(memory=True),
        **kwargs,
    )
    client.devices.fingerprint = lambda: FINGERPRINT  # type: ignore[method-assign]
    if _uses_redirect(t):
        # The redirect recordings pin the token exchange alone. The acquisition sync a sign-in
        # raises (trust fetch, documents, report) is pinned by the sync transcripts.
        client.identity._deps.on_acquired = lambda: None
    client.init()
    if t["initial"].get("platform") is not None:
        # The device's canonical platform: what the host names in the update options.
        client.distribution._platform = t["initial"]["platform"]
    journal = t["initial"].get("updateJournal")
    if journal is not None:
        # The update journal the client holds before the first step, oldest first.
        client.update_journal._file.update(
            lambda _: {"events": copy.deepcopy(journal), "offered": None}
        )
        assert len(client.update_journal.events()) == len(journal)
    session: Dict[str, Any] = {"transcript": t, "server": server, "syncWire": sync_wire}
    try:
        for i, _ in enumerate(t["steps"]):
            step = server.begin_step(i)
            clock["now"] = float(step.get("now", t["now"]))
            observed = _act(client, store, step, session)
            server.end_step()
            for key, want in step["expect"].items():
                got = observed.get(key)
                assert got == want, (
                    f"{t['id']} step {i} ({step['action']}): {key}: "
                    f"expected {want!r}, got {got!r}"
                )
    finally:
        client.close()
        if connect_dir is not None:
            shutil.rmtree(connect_dir, ignore_errors=True)
        for d in session.get("dirs", []):
            shutil.rmtree(d, ignore_errors=True)


def test_the_transcript_set_is_present() -> None:
    assert TRANSCRIPTS


@pytest.mark.parametrize("t", TRANSCRIPTS, ids=[t["id"] for t in TRANSCRIPTS])
def test_replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    if not applies(t, MANIFEST):
        pytest.skip(f"{t['id']}: sdks/python/parity.json does not claim {t['features']}")
    replay(t, monkeypatch)


# ── The replayer fails on a doctored transcript ─────────────────────────────────────

BASE = next(t for t in TRANSCRIPTS if t["id"] == "sync-etag-304")


def test_an_extra_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(
        BASE,
        0,
        lambda items: [x for x in items if not x["request"]["path"].endswith("/devices/report")],
    )
    with pytest.raises(ReplayError, match=r"unexpected request: POST /djdl/devices/report"):
        replay(t, monkeypatch)


def test_an_omitted_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(BASE, 0, lambda items: [*items, copy.deepcopy(items[0])])
    with pytest.raises(
        ReplayError,
        match=r"expected request not sent: GET /djdl/\.well-known/polaris-trust\.jws",
    ):
        replay(t, monkeypatch)


def test_a_dropped_required_header_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def edit(items):
        for x in items:
            if x["request"]["path"].endswith("/license/document"):
                x["request"]["requiredHeaders"].append("x-pkey-doctored")
        return items

    t = doctor(BASE, 0, edit)
    with pytest.raises(ReplayError, match=r"required header x-pkey-doctored: missing"):
        replay(t, monkeypatch)


def test_a_different_outcome_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = copy.deepcopy(BASE)
    t["steps"][1]["expect"]["documents"] = {"license": "applied", "config": "applied"}
    with pytest.raises(AssertionError, match=r"step 1 \(sync\): documents"):
        replay(t, monkeypatch)


def test_a_different_update_outcome_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """The rollback transcript passes only when floors are keyed by the feed's own channel
    claim; an expectation that the older feed was committed must fail."""
    t = copy.deepcopy(next(x for x in TRANSCRIPTS if x["id"] == "update-feed-rollback"))
    t["steps"][0]["expect"]["feed"] = "network"
    with pytest.raises(AssertionError, match=r"step 0 \(updateDecide\): feed"):
        replay(t, monkeypatch)


def test_an_update_step_without_its_record_request_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    t = doctor(
        next(x for x in TRANSCRIPTS if x["id"] == "update-record-by-hash"),
        0,
        lambda items: [x for x in items if "/release/records/" not in x["request"]["path"]],
    )
    with pytest.raises(ReplayError, match=r"unexpected request: GET /djdl/release/records/"):
        replay(t, monkeypatch)


def test_a_chunk_range_with_another_content_range_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """``packs-chunk-range`` passes only when the SDK reads the exact run: a recorded
    Content-Range altered to another range must be refused, so the step's ``range`` fails."""

    def edit(items):
        for x in items:
            x["response"]["headers"]["content-range"] = "bytes 17-40/64"
        return items

    t = doctor(next(x for x in TRANSCRIPTS if x["id"] == "packs-chunk-range"), 1, edit)
    with pytest.raises(AssertionError, match=r"step 1 \(chunkRange\): range"):
        replay(t, monkeypatch)
