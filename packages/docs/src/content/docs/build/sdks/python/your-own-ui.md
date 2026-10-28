---
title: "Your own UI (Python)"
description: "Draw your own screens on polaris-key: the state model, each call with the words to show, the headless views, Qt and asyncio, the thread contract and tests."
sidebar:
  order: 2
type: "reference"
sdks: ["python"]
lanes: ["library"]
lastReviewed: "2026-10-16"
---

The library returns typed results and draws nothing. This page gives, for each screen you build,
the call, the states it can answer and the words to show. To take the finished terminal screens
instead, see the [drop-in quickstart](/docs/build/quickstart/python/#4-gate-the-app). Create the
`client` as the quickstart does; every snippet here takes it as a parameter.

## The state model

`client.status()` reads the cached, re-verified documents with no network. It answers a
`LicenseState`: a `status`, plus `graceUntil` (epoch seconds) and `allowedRange`.

| `status`                                                     | Show                                                         | `copy.message(status)`                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `ok`, `not-applicable`                                       | Your app. `not-applicable` means the product runs no License | "Your license is active." / "This app doesn't need a license." |
| `grace`                                                      | Your app, with a notice that counts down to `graceUntil`     | "The licensing service can't be reached…"                      |
| `needs-activation`                                           | Key entry and sign-in                                        | "Enter a license key or sign in to continue."                  |
| `expired`                                                    | Renew, or connect to refresh                                 | "Your license has expired…"                                    |
| `revoked`                                                    | Key entry and sign-in again                                  | "This device was signed out…"                                  |
| `version-too-old`, `version-too-new`, `channel-not-entitled` | An update or channel notice from `allowedRange`              | One sentence each                                              |

```python
from typing import Tuple

from polaris_key import PolarisKeyClient, copy


def gate_screen(client: PolarisKeyClient) -> Tuple[str, str]:
    state = client.status()
    if state.status in ("ok", "not-applicable"):
        return "app", ""
    if state.status == "grace":
        return "app", copy.message("grace")  # count down to state.graceUntil
    if state.status in ("needs-activation", "revoked", "expired"):
        return "activate", copy.message(state.status)
    return "update", copy.message(state.status)
```

`client.is_licensed()` is true for `ok`, `grace` and `not-applicable`: use it where you only need to
gate. Times are epoch seconds. A product that runs no License service is `not-applicable`.

## First activation and refusals

`activate_with_key` never raises for a refusal: it returns an `ActivationResult`, a union of one
class per `kind`. `activation_message(kind)` is the sentence for each; `ActivationRefused` and
`ActivationError` carry the server's `code`. Narrow with `isinstance`: `kind` is a plain `str`.

```python
from typing import Optional

from polaris_key import (
    ActivationDeviceLimit,
    ActivationKeyEntryLimit,
    ActivationLicenseOwned,
    ActivationOk,
    ActivationRateLimited,
    PolarisKeyClient,
    with_manage_return,
)
from polaris_key.copy import activation_message


def activate(client: PolarisKeyClient, key: str) -> Optional[str]:
    """None when activated, else what to show."""
    r = client.license.activate_with_key(key)
    if isinstance(r, ActivationOk):
        return None
    text = activation_message(r.kind, code=r.code)
    if isinstance(r, ActivationDeviceLimit) and r.manage_url:
        # Replace a device: Polaris Locker makes room for another device. Nothing was wiped.
        return f"{text} {with_manage_return(r.manage_url, 'myapp://activated')}"
    if isinstance(r, ActivationKeyEntryLimit) and r.manage_url:
        # The key has no entries left; r.key_entries has used and limit. Nothing was wiped.
        return f"{text} {r.manage_url}"
    if isinstance(r, ActivationLicenseOwned) and r.sign_in_url:
        # The license is in an account and never moves by its key: offer sign-in.
        return f"{text} {r.sign_in_url}"
    if isinstance(r, ActivationRateLimited) and r.retryAfterSeconds:
        return f"{text} ({r.retryAfterSeconds}s)"
    return text
```

| `kind`                                                              | Meaning                                        | Offer                                 |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `unauthorized`                                                      | The key was not accepted                       | Retry                                 |
| `device-limit`                                                      | The device limit is reached                    | `manage_url`, then retry the same key |
| `license-expired`, `license-disabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer       |
| `hardware-mismatch`, `fingerprint-required`, `attestation-required` | The device check failed                        | Retry; `changed` lists what moved     |
| `enroll-disabled`, `enroll-claimed`                                 | No free license, or it is on an account        | Key entry, or sign in                 |
| `key-entry-limit`                                                   | The key has no entries left                    | `manage_url`, or sign-in              |
| `license-owned`                                                     | The license is in an account                   | `sign_in_url`: sign in                |
| `rate-limited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`              |
| `refused`, `error`                                                  | Any other refusal; a network or server failure | Show the message and `code`           |

An empty key is `unauthorized` without a request. Do not call `register()` or `deactivate()` on the
happy path: `register()` is for a product that opens keyless registration, and `deactivate()` ends
the session. See the [device-limit recipe](/docs/build/recipes/device-limit/).

## Sign-in and who signed in

`identity.sign_in.start` is the one way in. The default channel, `device-code`, suits a CLI, a daemon or a build agent:

```python
import threading
from typing import Optional

from polaris_key import PolarisKeyClient


def sign_in(client: PolarisKeyClient, stop: threading.Event) -> Optional[str]:
    session = client.identity.sign_in.start(device_name="Build agent 7")
    # Show session.user_code large, session.verification_uri as the short address, and the QR of
    # session.verification_uri_complete.
    print(session.user_code, session.verification_uri)
    outcome = session.wait(timeout=300, cancel_token=stop)
    if outcome.kind != "signed_in":
        return None  # "expired" or "cancelled"; a refusal raises
    # Anyone holding the code can finish the sign-in elsewhere: say who signed in.
    profile = client.license.get_profile()
    return f"Signed in as {profile.name} <{profile.email}>" if profile else "Signed in"
```

`session.reopen()` opens the system browser. `wait` raises `TimeoutError` when `timeout` runs out and
answers `cancelled` when `session.cancel()` is called or `cancel_token` is set. Sign-in needs the
Identity service; with it off, every call raises `service-unavailable` before any request.

### Redirect sign-in

A host that opens a browser and receives its redirect uses `channel="redirect"`. The session is
single use: keep it until the browser returns.

```python
from typing import Optional

from polaris_key import PolarisKeyClient


def begin(client: PolarisKeyClient):
    session = client.identity.sign_in.start(
        channel="redirect",
        redirect_uri="https://app.example/auth/callback",
        license_choice="app",
    )
    print(session.authorize_url)  # open it in the browser
    return session


def finish(session, callback_url: str) -> Optional[str]:
    outcome = session.complete(callback_url)
    if outcome.kind == "signed_in":
        return outcome.subject
    if outcome.kind == "choose":
        return outcome.grant  # finish with identity.choice, below
    return None  # "cancelled"
```

`complete` checks `state` and the issuer before it sends anything. A refusal raises under the
Worker's code (`invalid_grant`, `rate_limited`, `sign-in-failed`) and leaves the device's token alone.

### The license choice

With `license_choice="app"`, a person who holds licenses settles `choose`. No token is stored until
you finish with `identity.choice`. A refusal is a `ChoiceRefused` result with a `code`, not a raise:

```python
from typing import Optional

from polaris_key import PolarisKeyClient
from polaris_key.identity import ChoiceCompleteOk, ChoiceRefused, ChoiceViewOk


def choose(client: PolarisKeyClient, grant: str) -> Optional[str]:
    view = client.identity.choice.licenses(grant)
    if isinstance(view, ChoiceRefused):
        return view.code
    assert isinstance(view, ChoiceViewOk)
    ids = view.view.license_ids
    if not ids:
        client.identity.choice.cancel(grant)
        return None
    done = client.identity.choice.complete(grant, {"kind": "license", "licenseId": ids[0]})
    if isinstance(done, ChoiceCompleteOk):
        return done.license_id
    # device_limit leaves the grant open and carries manage_url and a fresh view.
    return done.code
```

The grant lives 300 seconds and is a credential: keep it out of logs.
`identity.choice.devices(grant, license_id)` lists the devices on a full license, for **Replace a device**.

### The account

```python
from polaris_key import PolarisKeyClient
from polaris_key.identity import AttachConfirm


def account(client: PolarisKeyClient) -> bool:
    subject = client.identity.subject()  # "ps_…" or None
    preview = client.identity.attach(confirm=False)
    if isinstance(preview, AttachConfirm):
        client.identity.attach(confirm=True)
    client.identity.open_account()  # OpenAccountResult(url, opened)
    print(subject)
    return client.identity.sign_out().released
```

`attach` previews first and writes nothing; `confirm=True` adds the device's license to the account.
A refusal (`account_required`, `license_owned`) is an `AttachRefused` result. `sign_out()` removes the
device token only when `released` is true; a device activated by a key keeps its license. Use
`client.license.deactivate()` to free the device.

## Status, offline and refresh

`create()` and `status()` need no network. Call `client.sync()` to refresh, or ask for a loop:

```python
import polaris_config
from polaris_key import PolarisKeyClient

client = PolarisKeyClient.create(
    **polaris_config.CONFIG,
    version="1.0.0",
    refresh_interval_seconds=3600,  # off unless set
    on_change=lambda state: print("gate is now", state.status),
)
client.subscribe(lambda e: print(e.kind, e.data), kinds=["license", "config"])
```

A sync that fails offline leaves the last verified documents in force until `graceUntil`.
`client.store_status()` says whether the token is in the OS keyring or in a `0600` file. A machine
with no network at all activates from a signed file: `client.import_bundle(text)`.

## Synced settings

With [Cloud Sync](/docs/features/cloud-sync/) on, a person's synced settings follow them to every
device they sign in on. The calls you already use do it: while a person is signed in,
`config.set()` and `config.clear()` go to the synced copy, and the same code runs with Cloud Sync
off. Which keys sync is the catalog's decision (see
[Synced settings](/docs/features/cloud-sync/#synced-settings)); a locked key never does. Nothing
syncs before sign-in: a device activated with a license key keeps its settings on the device and
uploads them at the first sign-in.

Settings are end-to-end encrypted by default. `cloud_sync={"encryption": "server"}` in the client
options opts out; the default is `"e2e"`. What each side can read is under
[Who can read it](/docs/features/cloud-sync/#who-can-read-it). A product that doesn't run the Sync
service answers `client.cloud_sync.status()` with the typed not-applicable error.

```python
from typing import Optional

from polaris_key import PolarisKeyClient


def open_synced_settings(client: PolarisKeyClient) -> Optional[str]:
    # The key ring decrypts the person's settings. On their first device, make it.
    unlocked = client.keyring.unlock()
    if unlocked.kind == "locked" and unlocked.reason == "no-ring":
        ring = client.keyring.create()
        return ring.recovery_code  # show it once; nothing keeps it
    return None


def change_theme(client: PolarisKeyClient) -> None:
    theme = client.config.setting("ui.theme")
    theme.set("dark")  # managed_by_admin when the operator locks the key
    print(theme.value, theme.sync())  # dark pending
    print(client.cloud_sync.status())  # {"state": "pending", "pending": 1}
    client.cloud_sync.flush()  # send now, not after the 2 second debounce
```

### The key ring

`client.keyring` holds the person's encryption key on this device, in memory only. Until it is
unlocked the status is `locked` and edits wait on the device.

| Call                            | Use                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `unlock()`                      | Open this device's copy. `locked` says `no-ring`, `no-wrap` or `unusable-wrap`  |
| `create()`                      | The first device: make the ring. `recovery_code` is shown once and kept nowhere |
| `recover(code)`                 | A new device with no other device at hand: the typed or pasted recovery code    |
| `set_recovery_code()`           | A new code; the old one stops working                                           |
| `accept_ring_change(pin)`       | After the person confirms the `ring-changed` answer from `unlock()`             |
| `reset()`                       | Start over with a new ring                                                      |
| `wrap_to(device_id, agree_key)` | Give another of the person's devices the key, once they approve it nearby       |

Show the recovery code for the person to copy and keep. It opens their settings, and without it
a person who loses every device loses them.

### States

`setting(k).sync()` answers for one key:

| State     | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `local`   | Stays on this device: nobody is signed in, Cloud Sync is off or the key is `local` |
| `pending` | An edit waits to be sent, or is parked for a quota or an entitlement               |
| `synced`  | The synced copy and this device agree                                              |

`setting(k).locked` is true for a key the operator locks; the signed value wins and the key never
syncs. The connection has its own state, `client.cloud_sync.status()["state"]`:

| `state`       | Show                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `idle`        | Nothing                                                                                           |
| `pending`     | "Saving…" (`pending` counts the edits)                                                            |
| `syncing`     | "Saving…"                                                                                         |
| `offline`     | "Offline. Changes are saved on this device."                                                      |
| `local`       | Sign-in needed: nobody is signed in, so nothing syncs                                             |
| `locked`      | The key ring is locked: `unlock()`, or `recover(code)`                                            |
| `paused`      | Polaris Key paused writes; edits wait and send later                                              |
| `blocked`     | `reason`: `account_required`, `unauthorized`, `attestation` or `forbidden`                        |
| `unsupported` | The app requires end-to-end encryption and the server doesn't offer it; nothing leaves the device |

A `reason` of `quota` on `pending` means the person's storage is full; `entitlement` means their
tier doesn't include sync. Either way the edits stay on the device.

### Events and origin

```python
from polaris_key import PolarisKeyClient


def watch_sync(client: PolarisKeyClient) -> None:
    def on_config(e) -> None:
        # origin: "local" this device, "remote" another device, "merge" a conflict resolved,
        # "migration" the one-time import of this device's earlier settings
        if e.data["origin"] != "local":
            print(e.data["key"], "changed elsewhere")

    def on_sync(e) -> None:
        if e.data["type"] == "rejected":
            print("an edit was refused:", e.data["code"])
        elif e.data["type"] == "unsyncedData":
            print(e.data["count"], "edits not sent")
        elif e.data["type"] == "signInOffered":
            print("show sign-in", e.data["signInUrl"])

    client.events.on("config", on_config)
    client.events.on("cloudSync", on_sync)
```

The `cloudSync` events carry a `type`: `change` (with `keys` and `origin`), `rejected`, `signedOut`,
`unsyncedData` and `signInOffered`. They name keys and never carry a value.

### Sign-out and offline

Signing out sends what is waiting (for up to 5 seconds), then deletes the synced copy and the key
ring from this device. The settings stay in the person's account. Edits that could not be sent are
reported once as `unsyncedData` and kept for 30 days, in case the same person signs in again. The
same purge runs when the device is deactivated or a different person signs in.

Offline, `config.set()` still succeeds and reads back at once. The edits are saved on the device
and sent when the network returns, and conflicts resolve by each key's declared policy. For
[limits and quotas](/docs/features/cloud-sync/#pause-and-limits), see the feature page.

## The thread contract

The sync client is thread-safe to call. The refresh loop is one daemon thread, started only when
`refresh_interval_seconds` is set and never in local-only mode. `on_change` and every event
listener run synchronously on the thread that caused the change, which is the refresh thread after
a timed sync, and must not block. A GUI toolkit must hop to its own thread:

```python
import queue
from typing import Any, Callable

from polaris_key import PolarisKeyClient


def to_ui_thread(client: PolarisKeyClient, post: Callable[[Callable[[], None]], None]) -> None:
    """`post` schedules a callable on the toolkit's thread (QTimer, root.after, call_soon_threadsafe)."""
    pending: "queue.Queue[Any]" = queue.Queue()
    client.subscribe(lambda e: post(lambda: pending.put(e)))
```

In `asyncio` hosts use `AsyncClient`, which shares the sync client's core and runs each call off the
loop. A forgotten `await` raises, so `if client.is_licensed():` is a `TypeError`, never a truthy
coroutine:

```python
import asyncio

import polaris_config
from polaris_key import AsyncClient


async def watch() -> None:
    client = await AsyncClient.create(**polaris_config.CONFIG, version="1.0.0")
    outcome = await client.boot()
    print(outcome.outcome)
    async for event in client.events.stream(kinds=["license"]):
        print(event.kind, event.data)


if __name__ == "__main__":
    asyncio.run(watch())
```

## An update offer

```python
from typing import Optional

from polaris_key import PolarisKeyClient
from polaris_key.core.decide import is_undismissable


def update_notice(client: PolarisKeyClient) -> Optional[str]:
    check = client.update.decide()
    d = check.decision
    if d.action in ("none", "packs"):
        return None
    if d.action == "blocked":
        return f"Update required ({d.reason})"
    version = d.release.version if d.release else ""
    return f"{version} is available" + (" (required)" if is_undismissable(d) else "")
```

`decide()` needs the Update service and `pinned_release_keys`, which the generated config carries.
A mandatory answer and `blocked` are notices with no dismiss control over an app that keeps running,
never a window that covers it.

## Headless views

`polaris_key.ui.core.models` maps SDK results to a catalog component, a state and its data, and
`Copy` turns the copy keys into words in the active locale. The terminal kit draws these; draw them
in your own toolkit and get the same steps, states and words as the drop-in:

```python
from polaris_key import PolarisKeyClient
from polaris_key.ui.core import Copy
from polaris_key.ui.core.models import activation_view, gate_view, parse_key


def render(client: PolarisKeyClient, typed: str, now: int) -> None:
    copy = Copy(locale="en")
    state = client.status()
    view = gate_view(state.status, now=now, grace_until=state.graceUntil)
    print(view.component, view.state, view.days_left)
    verdict = parse_key(typed)  # empty, typing, parsed, cut-short, malformed
    print(verdict.state, copy("activate.lede"))
    result = client.license.activate_with_key(typed)
    print(activation_view(result, typed).state)
```

The views are `gate_view`, `parse_key`, `activation_view`, `update_view`, `boot_view`,
`settings_view` and `release_notes_view`, plus the `SignInModel` state machine. `ActivateViewModel` is planned: do not build on it yet.
`run_gate` belongs to the [Qt kit](#qt).

## Qt

The [Qt kit](/docs/build/ui/frameworks/qt/) draws the gate (with activation and sign-in), devices,
settings and account in a Qt Quick view; `run_gate(client, window)` is its drop-in, and calls the
client for you. To draw your own, build the client once, run
`sync()` and the sign-in wait off the GUI thread (a `QThread`, or `AsyncClient` under `qasync`),
deliver results to widgets through signals as in [the thread contract](#the-thread-contract), and
render from `gate_view` and `activation_message` above. Install `polaris-key[keyring]` so the token
is in the OS keyring.

## Tests

Every seam is an option: `store=InMemoryStore()`, an `httpx.Client` over a `MockTransport` for the
transport, `fingerprint=False` to skip reading the machine. A scripted refusal runs the real client:

```python run
import tempfile

import httpx
from polaris_key import ActivationDeviceLimit, InMemoryStore, PolarisKeyClient
from polaris_key.copy import activation_message

tmp = tempfile.mkdtemp()
client = PolarisKeyClient.create(
    product_slug="acme",
    version="1.0.0",
    pinned_keys={"acme-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"},
    expected_services=["license"],
    store=InMemoryStore(),
    config_dir=tmp,
    data_dir=tmp,
    cache_dir=tmp,
    state_dir=tmp,
    fingerprint=False,
    client=httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                403, json={"error": "device_limit", "limit": 3, "deviceCount": 3}
            )
        )
    ),
)

r = client.license.activate_with_key("pkey_acme_0000")
assert isinstance(r, ActivationDeviceLimit), r
print(activation_message(r.kind))
client.close()
```

`client.status(now)` takes the clock as an argument, so a test moves time without touching the
system clock. Give each test a fresh directory.
