---
title: "Your own UI (Node)"
description: "Draw your own screens on @polaris-key/node: the state model, each call with the words to show, a CLI, an Electron renderer without React, and tests."
sidebar:
  order: 2
---

The library returns typed results and draws nothing. This page gives, for each screen you build, the
call, the states it can answer and the words to show. To take the finished screens instead, see the
[drop-in quickstart](/docs/build/quickstart/node/#pick-a-lane). Create the `client` as the
quickstart does; every snippet here takes it as a parameter.

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

```ts
import { copy, type PolarisKeyClient } from "@polaris-key/node";

export function gateScreen(client: PolarisKeyClient) {
  const { status, graceUntil } = client.status();
  switch (status) {
    case "ok":
    case "not-applicable":
      return { show: "app" } as const;
    case "grace":
      return {
        show: "app",
        notice: copy.message(status),
        until: graceUntil,
      } as const;
    case "needs-activation":
    case "revoked":
    case "expired":
      return { show: "activate", message: copy.message(status) } as const;
    default:
      return { show: "update", message: copy.message(status) } as const;
  }
}
```

`client.isLicensed()` is true for `ok`, `grace` and `not-applicable`: use it where you only need to
gate. Times are epoch seconds, except `lastVerifiedAt`, which is milliseconds.

## First activation and refusals

`activateWithKey` never throws for a refusal: it answers an `ActivationResult` whose `kind` says
which. `copy.activation(kind)` is the sentence for each; `refused` and `error` carry the server's
`code`.

```ts
import {
  copy,
  withManageReturn,
  type ActivationResult,
  type PolarisKeyClient,
} from "@polaris-key/node";

type Refusal = Exclude<ActivationResult, { kind: "ok" }>;

export function refusalScreen(r: Refusal) {
  const message = copy.activation(r.kind, { code: r.code });
  switch (r.kind) {
    case "device-limit":
      // Replace a device: the portal frees a seat. Nothing was wiped.
      return {
        message,
        link: r.manageUrl && withManageReturn(r.manageUrl, "myapp://activated"),
      };
    case "rate-limited":
      return { message, retryAfterSeconds: r.retryAfterSeconds };
    case "enroll-claimed": // the free license now belongs to an account
      return { message, next: "sign-in" };
    case "license-expired":
      return { message, next: "renew" };
    default:
      return { message };
  }
}

export async function activate(client: PolarisKeyClient, key: string) {
  const r = await client.license.activateWithKey(key);
  return r.kind === "ok" ? null : refusalScreen(r);
}
```

| `kind`                                                              | Meaning                                        | Offer                                |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| `unauthorized`                                                      | The key was not accepted                       | Retry                                |
| `device-limit`                                                      | Every seat is taken                            | `manageUrl`, then retry the same key |
| `license-expired`, `license-disabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer      |
| `hardware-mismatch`, `fingerprint-required`, `attestation-required` | The device check failed                        | Retry; `changed` lists what moved    |
| `enroll-disabled`, `enroll-claimed`                                 | No free license, or it is on an account        | Key entry, or sign in                |
| `rate-limited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`             |
| `refused`, `error`                                                  | Any other refusal; a network or server failure | Show `copy.activation` and `code`    |

A seat that a key holds is also freed from a device that still has a credential
(`client.deauthorizeDevice(id)`); the new device has none. See the
[device-limit recipe](/docs/build/recipes/device-limit/).

## Sign-in and who signed in

```ts
import { qr, type PolarisKeyClient } from "@polaris-key/node";

export async function signIn(client: PolarisKeyClient, signal: AbortSignal) {
  const prompt = await client.identity.beginSignIn({
    deviceName: "Living-room PC",
  });
  // Show prompt.userCode large, prompt.verificationUri as the short address, and the QR
  // of prompt.verificationUriComplete. Never show prompt.deviceCode.
  console.log(prompt.userCode, prompt.verificationUri);
  console.log(qr.terminal(prompt.verificationUriComplete));

  const result = await client.identity.waitForSignIn(prompt, { signal });
  if (result.status !== "ready") return result.status; // "expired" or an error
  // Anyone holding the code can finish the sign-in elsewhere: say who signed in.
  const profile = client.license.getProfile();
  return `Signed in as ${profile?.name ?? ""} ${profile?.email ?? ""}`.trim();
}
```

`signInWithBrowser()` does the same and opens the system browser. Sign-in needs the Identity
service; with it off, every call throws `service-unavailable` before any request.
`client.identity.signOut()` and `client.license.deactivate()` end the session.

## Status, offline and refresh

`create()` and `status()` need no network. Call `client.sync()` to refresh, or let the client do it:

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export function keepFresh(client: PolarisKeyClient) {
  client.startRefresh(); // hourly, at once after a wake, backing off while offline
  client.events.on("license", () => console.log(client.status().status));
  client.events.on("config", () => console.log("settings changed"));
}
```

Events are `license`, `config`, `updateAvailable`, `packs` and `store`. A sync that fails offline
leaves the last verified documents in force until `graceUntil`; `await client.storeStatus()` says
whether the token is in the OS keyring or in a `0600` file. A machine with no network at all
activates from a signed file: `client.importBundle(jws)`.

## An update offer

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export async function updateNotice(client: PolarisKeyClient) {
  const { decision } = await client.update.decide();
  switch (decision.action) {
    case "binary":
    case "store":
    case "platform":
    case "code-ready":
      return {
        version: decision.release.version,
        blocking: decision.action !== "code-ready" && decision.mandatory,
      };
    case "blocked":
      return { version: null, blocking: true, reason: decision.reason };
    default:
      return null; // "none" or "packs"
  }
}
```

`decide()` needs the Update service and `update.pinnedReleaseKeys`, which the generated config
carries. A mandatory answer or `blocked` is a notice with no dismiss control over an app that keeps
running, never a window that covers it.

## CLI

A CLI that draws its own output reads the same states. Run the verbs you want as plain
functions, which answer `{ ok, message, data }`, or call the client as above. A script reads JSON,
never the words:

```ts
import { copy, type PolarisKeyClient } from "@polaris-key/node";

export async function check(client: PolarisKeyClient): Promise<number> {
  const { status } = client.status();
  const usable = client.isLicensed();
  console.log(JSON.stringify({ status, usable }));
  if (!usable) console.error(copy.message(status));
  return usable ? 0 : 1;
}
```

The words (`copy.message`, `copy.activation`) are localised catalog sentences and may change between
releases; the status codes do not. To keep the finished verbs, take
[Terminal (Node)](/docs/build/ui/frameworks/terminal-node/).

## Electron

The main process owns the client and exposes the bridge
([the drop-in setup](/docs/build/quickstart/node/#drop-in-electron)). A renderer that is not React
reads the bridge through the same adapter the React kit uses, and gets the same state model:

```ts
import { desktopAdapter } from "@polaris-key/react/desktop";
import { activationMessage, PolarisError } from "@polaris-key/react/core";

const adapter = desktopAdapter(); // reads window.polarisKey

adapter.subscribe((state) => {
  console.log(state.phase === "loading" ? "loading" : state.status);
});

export async function submit(key: string): Promise<string | null> {
  try {
    await adapter.submitKey(key);
    return null;
  } catch (e) {
    // A refused key: the kind says which, the catalog says it in words.
    if (e instanceof PolarisError && e.activation)
      return activationMessage(e.activation.kind, { code: e.activation.code });
    throw e;
  }
}
```

The adapter's `snapshot()` is a `PolarisState` (`status`, `gate`, `profile`, `config`,
`entitlements`, per-service `busy` and `error`). The device code of a sign-in never leaves the main
process; `adapter.beginSignIn()` hands the renderer only what to show.

## Tests

Every seam is an option: `store: new InMemoryStore()`, `fetchImpl` for the transport and
`license: { fingerprint: false }` to skip reading the machine. A scripted refusal runs the real
client:

```ts run
import { InMemoryStore, PolarisKeyClient, copy } from "@polaris-key/node";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pkey-"));
const client = await PolarisKeyClient.create({
  productSlug: "acme",
  version: "1.0.0",
  trust: {
    pinnedKeys: { "acme-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
  },
  expectedServices: ["license"],
  store: new InMemoryStore(),
  configDir: dir,
  dataDir: dir,
  cacheDir: dir,
  stateDir: dir,
  license: { fingerprint: false },
  fetchImpl: async () =>
    Response.json(
      { error: "device_limit", limit: 3, deviceCount: 3 },
      { status: 403 },
    ),
});

const r = await client.license.activateWithKey("pkey_acme_0000");
if (r.kind !== "device-limit")
  throw new Error(`expected device-limit, got ${r.kind}`);
console.log(copy.activation(r.kind));
```

`client.status(now)` takes the clock as an argument, so a test moves time without touching the
system clock. Reset a test's state by giving it a fresh directory.
