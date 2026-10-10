---
title: "Your own UI (Python)"
description: "Draw your own screens on polaris-key: the state model, each call with the words to show, the headless views, Qt and asyncio, the thread contract and tests."
sidebar:
  order: 2
---

The library returns typed results and draws nothing. This page gives, for each screen you build,
the call, the states it can answer and the words to show. To take the finished terminal screens
instead, see the [drop-in quickstart](/docs/build/quickstart/python/#pick-a-lane). Create the
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
        # Replace a device: the portal frees a seat. Nothing was wiped.
        return f"{text} {with_manage_return(r.manage_url, 'myapp://activated')}"
    if isinstance(r, ActivationRateLimited) and r.retryAfterSeconds:
        return f"{text} ({r.retryAfterSeconds}s)"
    return text
```

| `kind`                                                              | Meaning                                        | Offer                                 |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `unauthorized`                                                      | The key was not accepted                       | Retry                                 |
| `device-limit`                                                      | Every seat is taken                            | `manage_url`, then retry the same key |
| `license-expired`, `license-disabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer       |
| `hardware-mismatch`, `fingerprint-required`, `attestation-required` | The device check failed                        | Retry; `changed` lists what moved     |
| `enroll-disabled`, `enroll-claimed`                                 | No free license, or it is on an account        | Key entry, or sign in                 |
| `rate-limited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`              |
| `refused`, `error`                                                  | Any other refusal; a network or server failure | Show the message and `code`           |

An empty key is `unauthorized` without a request. Do not call `register()` or `deactivate()` on the
happy path: `register()` is for a product that opens keyless registration, and `deactivate()` ends
the session. See the [device-limit recipe](/docs/build/recipes/device-limit/).

## Sign-in and who signed in

```python
import threading
from typing import Optional

from polaris_key import PolarisKeyClient


def sign_in(client: PolarisKeyClient, stop: threading.Event) -> Optional[str]:
    prompt = client.identity.begin_sign_in(device_name="Build agent 7")
    # Show prompt.userCode large, prompt.verificationUri as the short address, and the QR of
    # prompt.verificationUriComplete. Never show prompt.deviceCode.
    print(prompt.userCode, prompt.verificationUri)
    result = client.identity.wait_for_sign_in(prompt, timeout=300, cancel=stop)
    if result.status != "ready":
        return None  # "expired", or an error with result.message
    # Anyone holding the code can finish the sign-in elsewhere: say who signed in.
    profile = client.license.get_profile()
    return f"Signed in as {profile.name} <{profile.email}>" if profile else "Signed in"
```

`sign_in_with_browser()` does the same and opens the system browser. `wait_for_sign_in` raises
`TimeoutError` when `timeout` runs out and `PolarisError("cancelled")` when `cancel` is set. Sign-in
needs the Identity service; with it off, every call raises `service-unavailable` before any request.
`client.identity.sign_out()` ends the session.

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
`settings_view` and `release_notes_view`, plus the `SignInModel` state machine. `run_gate` and
`ActivateViewModel` are planned: do not build on them yet.

## Qt

A Qt kit is planned. Until then, draw your own on the library: build the client once, run
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
    trust={"acme-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"},
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
