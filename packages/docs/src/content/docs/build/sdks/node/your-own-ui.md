---
title: "Your own UI (Node)"
description: "Draw your own screens on @polaris-key/node: the state model, each call with the words to show, a CLI, an Electron renderer without React, and tests."
sidebar:
  order: 2
type: "reference"
sdks: ["node"]
lanes: ["library"]
lastReviewed: "2026-10-16"
---

The library returns typed results and draws nothing. This page gives, for each screen you build, the
call, the states it can answer and the words to show. To take the finished screens instead, see the
[drop-in quickstart](/docs/build/quickstart/node/#4-gate-the-app). Create the `client` as the
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
      // Replace a device: Polaris Locker makes room for another device. Nothing was wiped.
      return {
        message,
        link: r.manageUrl && withManageReturn(r.manageUrl, "myapp://activated"),
      };
    case "rate-limited":
      return { message, retryAfterSeconds: r.retryAfterSeconds };
    case "key-entry-limit": // the key has no entries left; nothing was wiped
      return { message, link: r.manageUrl, used: r.keyEntries.used };
    case "license-owned": // the license is in an account; a key never moves it
      return { message, link: r.signInUrl, next: "sign-in" };
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
| `device-limit`                                                      | The device limit is reached                    | `manageUrl`, then retry the same key |
| `license-expired`, `license-disabled`                               | The license ended or an operator disabled it   | Renew, or contact the developer      |
| `hardware-mismatch`, `fingerprint-required`, `attestation-required` | The device check failed                        | Retry; `changed` lists what moved    |
| `enroll-disabled`, `enroll-claimed`                                 | No free license, or it is on an account        | Key entry, or sign in                |
| `key-entry-limit`                                                   | The key has no entries left                    | `manageUrl`, or sign-in              |
| `license-owned`                                                     | The license is in an account                   | `signInUrl`: sign in                 |
| `rate-limited`                                                      | Too many attempts                              | Wait `retryAfterSeconds`             |
| `refused`, `error`                                                  | Any other refusal; a network or server failure | Show `copy.activation` and `code`    |

A device that a key counts is also freed from a device that still has a credential
(`client.deauthorizeDevice(id)`); the new device has none. See the
[device-limit recipe](/docs/build/recipes/device-limit/).

## Sign-in and who signed in

`identity.signIn.start` is the one way in. `channel: "device-code"` suits a CLI, a daemon or a kiosk:

```ts
import { qr, type PolarisKeyClient } from "@polaris-key/node";

export async function signIn(client: PolarisKeyClient, signal: AbortSignal) {
  const session = await client.identity.signIn.start({
    channel: "device-code",
    deviceName: "Living-room PC",
  });
  // Show session.userCode large, session.verificationUri as the short address, and the QR
  // of session.verificationUriComplete. The poll credential is never a field.
  console.log(session.userCode, session.verificationUri);
  console.log(qr.terminal(session.verificationUriComplete));

  const result = await session.wait({ signal });
  if (result.kind !== "signedIn") return result.kind; // "expired" or "cancelled"
  // Anyone holding the code can finish the sign-in elsewhere: say who signed in.
  const who = result.identity;
  return `Signed in as ${who?.name ?? ""} ${who?.email ?? ""}`.trim();
}
```

`session.reopen()` opens the system browser and `session.cancel()` stops the wait. A person's refusal
throws `sign-in-denied`; a failure after approval throws `sign-in-failed`. Sign-in needs the Identity
service; with it off, `signIn.start` throws `service-unavailable` before any request.

### Redirect sign-in

A host that opens a browser and receives its redirect (a desktop app with a registered `https:`
address) uses `channel: "redirect"`. The session is single use: keep it until the browser returns.

```ts
import type { PolarisKeyClient, RedirectSession } from "@polaris-key/node";

export async function begin(client: PolarisKeyClient) {
  const session = await client.identity.signIn.start({
    channel: "redirect",
    redirectUri: "https://app.example/auth/callback",
    licenseChoice: "app",
  });
  return { session, open: session.authorizeUrl }; // open it in the browser
}

export async function finish(session: RedirectSession, callbackUrl: string) {
  const outcome = await session.complete(callbackUrl);
  switch (outcome.kind) {
    case "signedIn":
      return { subject: outcome.subject, licenseId: outcome.licenseId };
    case "choose":
      return { grant: outcome.grant, seconds: outcome.expiresIn }; // see below
    case "cancelled":
      return null;
  }
}
```

`complete` checks `state` and the issuer before it sends anything. A refusal throws under the
Worker's code (`invalid_grant`, `rate_limited`, `sign-in-failed`) and leaves the device's token alone.

### The license choice

With `licenseChoice: "app"`, a person who holds licenses settles `choose`. No token is stored until
you finish with `identity.choice`. A refusal is a result with a `code`, not a throw:

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export async function choose(client: PolarisKeyClient, grant: string) {
  const view = await client.identity.choice.licenses(grant);
  if (view.kind !== "ok") return view.code;
  const first = view.view.choices[0];
  if (!first) return client.identity.choice.cancel(grant);
  const done = await client.identity.choice.complete(grant, {
    kind: "license",
    licenseId: first.id,
  });
  if (done.kind === "ok") return done.licenseId;
  // device_limit leaves the grant open and carries manageUrl and a fresh view.
  return {
    code: done.code,
    manageUrl: done.manageUrl,
    signInUrl: done.signInUrl,
  };
}
```

The grant lives 300 seconds and is a credential: keep it out of logs. `identity.choice.devices(grant,
licenseId)` lists the devices on a full license, for **Replace a device**.

### The account

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export async function account(client: PolarisKeyClient) {
  const subject = await client.identity.subject(); // "ps_…" or null
  const preview = await client.identity.attach({ confirm: false });
  if (preview.status === "confirm")
    await client.identity.attach({ confirm: true });
  await client.identity.openAccount(); // { url, opened }
  const { released } = await client.identity.signOut();
  return { subject, released };
}
```

`attach` previews first and writes nothing; `{ confirm: true }` adds the device's license to the
account. A refusal (`account_required`, `license_owned`) is a `refused` result. `signOut()` removes
the device token only when `released` is true; a device activated by a key keeps its license. Use
`client.license.deactivate()` to free the device. Subscribe with `client.events.on("identity", …)`.

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

Events are `license`, `config`, `identity`, `updateAvailable`, `packs` and `store`. A sync that fails offline
leaves the last verified documents in force until `graceUntil`; `await client.storeStatus()` says
whether the token is in the OS keyring or in a `0600` file. A machine with no network at all
activates from a signed file: `client.importBundle(jws)`.

## Synced settings

With [Cloud Sync](/docs/features/cloud-sync/) on, a person's synced settings follow them to every
device they sign in on. The calls you already use do it: while a person is signed in,
`config.set()` and `config.clear()` go to the synced copy, and the same code runs with Cloud Sync
off. Which keys sync is the catalog's decision (see
[Synced settings](/docs/features/cloud-sync/#synced-settings)); a locked key never does. Nothing
syncs before sign-in: a device activated with a license key keeps its settings on the device and
uploads them at the first sign-in.

Settings are end-to-end encrypted by default. `cloudSync: { encryption: "server" }` in the client
options opts out; the default is `"e2e"`. What each side can read is under
[Who can read it](/docs/features/cloud-sync/#who-can-read-it). A product that doesn't run the Sync
service answers `client.cloudSync.status()` with the typed not-applicable error.

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export async function openSyncedSettings(client: PolarisKeyClient) {
  // The key ring decrypts the person's settings. On their first device, make it.
  const unlocked = await client.keyring.unlock();
  if (unlocked.kind === "locked" && unlocked.reason === "no-ring") {
    const ring = await client.keyring.create();
    return ring.recoveryCode; // show it once; nothing keeps it
  }
  return undefined;
}

export async function changeTheme(client: PolarisKeyClient) {
  const theme = client.config.setting<string>("ui.theme");
  await theme.set("dark"); // managed_by_admin when the operator locks the key
  console.log(theme.value, theme.sync()); // "dark" "pending"
  console.log(client.cloudSync.status()); // { state: "pending", pending: 1 }
  await client.cloudSync.flush(); // send now, not after the 2 second debounce
}
```

### The key ring

`client.keyring` holds the person's encryption key on this device, in memory only. Until it is
unlocked the status is `locked` and edits wait on the device.

| Call                         | Use                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `unlock()`                   | Open this device's copy. `locked` says `no-ring`, `no-wrap` or `unusable-wrap` |
| `create()`                   | The first device: make the ring. `recoveryCode` is shown once and kept nowhere |
| `recover(code)`              | A new device with no other device at hand: the typed or pasted recovery code   |
| `setRecoveryCode()`          | A new code; the old one stops working                                          |
| `acceptRingChange(pin)`      | After the person confirms the `ring-changed` answer from `unlock()`            |
| `reset()`                    | Start over with a new ring                                                     |
| `wrapTo(deviceId, agreeKey)` | Give another of the person's devices the key, once they approve it nearby      |

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
syncs. The connection has its own state, `client.cloudSync.status().state`:

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

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export function watchSync(client: PolarisKeyClient) {
  client.events.on("config", (c) => {
    // origin: "local" this device, "remote" another device, "merge" a conflict resolved,
    // "migration" the one-time import of this device's earlier settings
    if (c.origin !== "local") console.log(`${c.key} changed elsewhere`);
  });
  client.events.on("cloudSync", (e) => {
    if (e.type === "rejected") console.warn(`an edit was refused: ${e.code}`);
    if (e.type === "unsyncedData") console.warn(`${e.count} edits not sent`);
    if (e.type === "signInOffered") console.log("show sign-in", e.signInUrl);
  });
}
```

The `cloudSync` events are `change` (with `keys` and `origin`), `rejected`, `signedOut`,
`unsyncedData` and `signInOffered`. They name keys and never carry a value.

### Sign-out and offline

Signing out sends what is waiting (for up to 5 seconds), then deletes the synced copy and the key
ring from this device. The settings stay in the person's account. Edits that could not be sent are
reported once as `unsyncedData` and kept for 30 days, in case the same person signs in again. The
same purge runs when the device is deactivated or a different person signs in.

Offline, `config.set()` still succeeds and reads back at once. The edits are saved on the device
and sent when the network returns, and conflicts resolve by each key's declared policy. For
[limits and quotas](/docs/features/cloud-sync/#pause-and-limits), see the feature page.

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
([the drop-in setup](/docs/build/quickstart/node/#4-gate-the-app)). A renderer that is not React
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
process; the bridge hands the renderer only what to show.

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
