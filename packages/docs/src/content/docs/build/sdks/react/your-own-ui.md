---
title: "Your own UI (React)"
description: "Build your own screens on @polaris-key/react: the hook for each task, the state table with its words, refresh, the store status, no-React use and tests."
sidebar:
  order: 2
type: "reference"
sdks: ["react"]
lanes: ["library"]
lastReviewed: "2026-10-16"
---

The hooks return state and actions and draw nothing. This page gives the hook for each task, the
states it can be in and the words to show. To take the finished screens instead, see the
[drop-in quickstart](/docs/build/quickstart/react/#3-gate-the-app). Everything renders inside
`<PolarisKeyProvider config={polarisKey}>`, configured as the quickstart does.

## The hook for each task

| Task                  | Hook (`@polaris-key/react`)                   | You read                                                                               |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Gate the app          | `useLicenseGate()`                            | `screen`, `status`, `usable`, `error`, `retry()`                                       |
| License facts         | `useLicense()`                                | `gate` (`graceUntil`, `allowedRange`), `entitledChannels`, `refresh()`                 |
| Key entry and sign-in | `usePolarisAuth()`                            | `submitKey(key)`, `signIn`, `signInWithOidc()`, `profile`, `error`, `supportsKeyEntry` |
| Entitlements          | `useEntitlement(name)`                        | a boolean, false unless the gate is usable                                             |
| Settings              | `useManagedConfig()`, `useConfigSetting(key)` | `get(key, fallback)`, `set`, `clear`, the source and whether the key is locked         |
| Updates               | `useUpdateDecision()`                         | `decision`, `undismissable`, `reason`, `decide()`                                      |
| What the product runs | `useCapabilities()`                           | `has("identity")`                                                                      |
| Release notes         | `useChangelog()`                              | `entries`                                                                              |

`busy` and `error` are per service: a config refresh does not grey out sign-out. `usePolarisKey()`
returns the whole client at once and is deprecated; prefer the hooks above. It has no `getConfig` or `isEntitled`: use `useConfigSetting()` and `useEntitlement()`. The adapters take `expectedServices`, a list of service slugs.

## The state table

`useLicenseGate().screen` is one of these. Times are epoch seconds, except `lastVerifiedAt`.

| Screen           | When                                                         | Show                                                  | Words                                       |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------- |
| `loading`        | The first snapshot has not resolved                          | A placeholder                                         |                                             |
| `ok`             | `status` is `ok`                                             | Your app                                              |                                             |
| `not-applicable` | The product runs no License service                          | Your app, no chrome                                   |                                             |
| `grace`          | Offline or unreachable; `gate.graceUntil` is ahead           | Your app, with a notice counting down to `graceUntil` | `copyMessage(status)`                       |
| `login`          | `needs-activation`                                           | Key entry and sign-in                                 | `copyMessage(status)`                       |
| refused          | `error.activation` is set on the login screen                | The same card, the key kept, the reason               | `describeError(error)`, `activationMessage` |
| signing in       | `signInWithOidc()` returned a handle                         | The code, the address, Cancel                         | `handle.userCode`, `handle.verificationUri` |
| `expired`        | The grace period ended                                       | Renew, or connect; a different key                    | `copyMessage(status)`                       |
| `revoked`        | The device was signed out                                    | Sign in or enter a key again                          | `copyMessage(status)`                       |
| `version-block`  | `version-too-old`, `version-too-new`, `channel-not-entitled` | An update or channel notice from `gate.allowedRange`  | `copyMessage(status)`                       |
| `error`          | The state failed to load                                     | The message and Try again                             | `describeError(error)`                      |

A refused key stays on the login screen: the gate does not move to `error` for it, and a background
refresh does not clear it. It clears when the license becomes usable.

```tsx
import { useState, type ReactNode } from "react";
import {
  copyMessage,
  describeError,
  useLicenseGate,
  usePolarisAuth,
  withManageKey,
  withManageReturn,
  type OidcSignInHandle,
} from "@polaris-key/react";

export function Gate({ children }: { children: ReactNode }) {
  const { screen, status, error, retry } = useLicenseGate();
  switch (screen) {
    case "loading":
      return <p role="status">Loading…</p>;
    case "ok":
    case "not-applicable":
      return <>{children}</>;
    case "grace":
      return (
        <>
          <p role="status">{copyMessage(status)}</p>
          {children}
        </>
      );
    case "login":
      return <SignIn />;
    case "expired":
    case "revoked":
      return <SignIn notice={copyMessage(status)} />;
    case "version-block":
      return <p role="alert">{copyMessage(status)}</p>;
    case "error":
      return (
        <div role="alert">
          <p>{describeError(error)}</p>
          <button onClick={() => void retry()}>Try again</button>
        </div>
      );
  }
}

function SignIn({ notice }: { notice?: string }) {
  const auth = usePolarisAuth();
  const [key, setKey] = useState("");
  const [handle, setHandle] = useState<OidcSignInHandle | null>(null);
  const manageUrl = auth.error?.manageUrl;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // A refusal rejects and also lands in auth.error; show it from there.
        void auth.submitKey(key).catch(() => undefined);
      }}
    >
      {notice && <p>{notice}</p>}
      {auth.supportsKeyEntry && (
        <input value={key} onChange={(e) => setKey(e.target.value)} />
      )}
      {auth.error && <p role="alert">{describeError(auth.error)}</p>}
      {manageUrl && (
        <button
          type="button"
          onClick={() => {
            // Add the page to return to and the key, then open the link in a
            // new tab so this form and the key in it stay put.
            const link = withManageKey(
              withManageReturn(manageUrl, window.location.href),
              key,
            );
            window.open(link, "_blank", "noopener,noreferrer");
          }}
        >
          Replace a device
        </button>
      )}
      {auth.supportsOidcLogin && !handle && (
        <button
          type="button"
          onClick={async () => setHandle((await auth.signInWithOidc()) ?? null)}
        >
          Sign in
        </button>
      )}
      {handle && (
        <p>
          Enter {handle.userCode} at {handle.verificationUri}
          <button
            type="button"
            onClick={() => (handle.cancel?.(), setHandle(null))}
          >
            Cancel
          </button>
        </p>
      )}
    </form>
  );
}
```

`auth.error.manageUrl` is the link that makes room for another device, already validated by the SDK.
`withManageReturn` adds `return=`, the page to come back to, which Polaris Locker follows only for an
origin your product declares. `withManageKey` adds the key as `#key=` on an activate link: a
fragment no server sees. Open the link from a click, and submit the same key again when the person
comes back.

The refusal's `activation.kind` says which one: `deviceLimit` (with `limit`, `deviceCount` and
`manageUrl`), `unauthorized`, `licenseExpired`, `licenseDisabled`, `keyEntryLimit`, `licenseOwned`, `rateLimited` (with
`retryAfterSeconds`), `hardwareMismatch`, `fingerprintRequired`, `enrollClaimed`, `enrollDisabled`,
`attestationRequired`, `refused` (with the server's `code`) and `error`. After a successful
sign-in, `profile` holds the `name` and `email` to show next to a way to sign out
(`auth.signOut()`): anyone with the code can finish a sign-in elsewhere, so name the account.

## Redirect sign-in and the license choice

`usePolarisAuth().signIn.start` also takes `channel: "redirect"`. The verifier waits in `sessionStorage`
across the navigation, so `signIn.complete(callbackUrl)` works on the page the browser returns to. With
`licenseChoice: "app"`, a person who holds licenses settles `choose`, and `useLicenseChoice(grant)`
runs the choice.

```tsx
import { useEffect, useState } from "react";
import { useLicenseChoice, usePolarisAuth } from "@polaris-key/react";

export function SignInButton() {
  const auth = usePolarisAuth();
  return (
    <button
      onClick={async () => {
        const session = await auth.signIn.start({
          channel: "redirect",
          redirectUri: `${window.location.origin}/auth/callback`,
          licenseChoice: "app",
        });
        window.location.assign(session.authorizeUrl);
      }}
    >
      Sign in
    </button>
  );
}

export function Callback() {
  const auth = usePolarisAuth();
  const [grant, setGrant] = useState<string | null>(null);
  useEffect(() => {
    void auth.signIn.complete(window.location.href).then((outcome) => {
      if (outcome.kind === "choose") setGrant(outcome.grant);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return grant ? <Choice grant={grant} /> : <p role="status">Signing in…</p>;
}

function Choice({ grant }: { grant: string }) {
  const choice = useLicenseChoice(grant);
  if (choice.status === "expired") return <p role="alert">Start again.</p>;
  if (!choice.view) return <p role="status">Loading…</p>;
  return (
    <ul>
      {choice.view.choices.map((row) => (
        <li key={row.id}>
          <button
            onClick={() =>
              void choice.complete({ kind: "license", licenseId: row.id })
            }
          >
            {row.name ?? row.tierName}
          </button>
        </li>
      ))}
      {choice.refusal && <li role="alert">{choice.refusal.code}</li>}
    </ul>
  );
}
```

A refusal is state, not a throw: `refusal` holds the last one, and `device_limit` swaps in the fresh
`view`. A key entered with `{ kind: "key", key }` counts as one key entry. `status` is `loading`,
`ready`, `working`, `done`, `cancelled` or `expired` (the grant lives 300 seconds).

`usePolarisAuth()` also has the account calls: `subject()`, `attach({ confirm })`, `openAccount()` and
`signOut()`. They need a browser bearer session or the desktop bridge; otherwise they throw the typed
`UnsupportedError`. A key refused with `keyEntryLimit` (`manageUrl`, `keyEntries`) or `licenseOwned`
(`signInUrl`) arrives as `error.activation`, and neither clears the device's token.

## Entitlements and settings

```tsx
import { useConfigSetting, useEntitlement } from "@polaris-key/react";

export function Export() {
  const pro = useEntitlement("polarisVpn");
  const concurrency = useConfigSetting("run.concurrency");
  if (!pro) return <p>Upgrade to export.</p>;
  return (
    <button disabled={concurrency.locked}>
      Export ({String(concurrency.value ?? 3)} at a time, from{" "}
      {concurrency.source})
    </button>
  );
}
```

Config precedence is the same in every SDK: server-enforced, local override, remote default,
fallback. The environment layer does not exist in a browser.

## Synced settings

With [Cloud Sync](/docs/features/cloud-sync/) on, a person's synced settings follow them to every
browser and device they sign in on. `useConfigSetting()` already does it: while a person is signed
in, `set()` and `clear()` go to the synced copy, and the same code runs with Cloud Sync off.
`useSetting(key)` is `useConfigSetting(key)` plus `sync`, so you can show where the value lives.
`useCloudSync()` is the connection: its `status`, a `flush()` and the sign-in offer. Which keys sync
is the catalog's decision (see [Synced settings](/docs/features/cloud-sync/#synced-settings)); a
locked key never does. Nothing syncs before sign-in, and no value passes through `status` or the
offer.

```tsx
import {
  useCloudSync,
  useRecoveryCode,
  useSetting,
  useSyncLock,
} from "@polaris-key/react";

export function ThemeSetting() {
  const theme = useSetting("ui.theme", "light");
  const cloud = useCloudSync();
  const lock = useSyncLock();
  const ring = useRecoveryCode();

  if (cloud.unsupported)
    return <p>Settings stay on this device ({cloud.unsupported.reason}).</p>;
  return (
    <section>
      <button
        disabled={theme.locked}
        onClick={() =>
          void theme.set(theme.value === "dark" ? "light" : "dark")
        }
      >
        Theme: {theme.value} ({theme.sync})
      </button>
      {cloud.status.state === "pending" && <p>Saving…</p>}
      {cloud.status.state === "offline" && (
        <p>Offline. Changes are saved on this device.</p>
      )}
      {cloud.offer && (
        <p>
          Sign in to sync your settings.{" "}
          {cloud.offer.signInUrl && <a href={cloud.offer.signInUrl}>Sign in</a>}{" "}
          <button onClick={cloud.dismissOffer}>Not now</button>
        </p>
      )}
      {lock.state === "none" && (
        <button onClick={() => void ring.create()}>
          Set up a recovery code
        </button>
      )}
      <button onClick={() => void cloud.flush()}>Save now</button>
    </section>
  );
}
```

`useSetting(key).sync` is one of:

| `sync`    | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `local`   | Stays on this device: nobody is signed in, Cloud Sync is off or the key is `local` |
| `pending` | An edit waits to be sent, or is parked for a quota or an entitlement               |
| `synced`  | The synced copy and this device agree                                              |

`locked` is true for a key the operator locks; the signed value wins and the key never syncs.
`useCloudSync().status.state` is the connection:

| `state`       | Show                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| `idle`        | Nothing                                                                        |
| `pending`     | "Saving…" (`pending` counts the edits)                                         |
| `syncing`     | "Saving…"                                                                      |
| `offline`     | "Offline. Changes are saved on this device."                                   |
| `local`       | Sign-in needed: nobody is signed in, so nothing syncs                          |
| `locked`      | The key ring is locked: `useSyncLock()`, then `useRecoveryCode().unlock(code)` |
| `paused`      | Polaris Key paused writes; edits wait and send later                           |
| `blocked`     | `reason`: `account_required`, `unauthorized`, `attestation` or `forbidden`     |
| `unsupported` | The app requires end-to-end encryption and the server doesn't offer it         |

`cloud.offer` is set when Cloud Sync lost the person (`account_required`, a sign-out or another
person's sign-in) and clears on a sign-in. `signInUrl` is where the Worker says to go, or `null`
for your own sign-in.

Settings are end-to-end encrypted by default. What each side can read is under
[Who can read it](/docs/features/cloud-sync/#who-can-read-it). The key ring decrypts them:
`useSyncLock().state` is `none` (no ring yet), `locked`, `unlocked`, `ring-changed` or `failed`.
`useRecoveryCode()` creates the ring, unlocks it with the code the person typed, replaces the code,
resets and accepts a changed ring. Show a new code once; nothing keeps it, and a person who loses
every device and the code loses their synced settings.

### Where it runs

- **Browser sign-in only.** Cloud Sync in a browser needs the redirect sign-in. A cookie-only page
  and the desktop bridge answer `unsupported` and keep every setting `local`, as does a product
  without the Sync service.
- **Bearer, on your origins.** The page sends the redirect token as a bearer header and never the
  session cookie. The Worker answers Cloud Sync for a page on the product's `web.origins` only,
  without credentialed CORS, and the token works for one device of one product. A cookie-only
  request is `401`. Serve the page from an origin the product lists.
- **Strict CSP.** The key ring's root is a non-extractable key in the browser's vault, so a script
  cannot copy it out, but a script that runs on your page can still ask the page to decrypt. Keep a
  strict `Content-Security-Policy`: no `unsafe-inline` or `unsafe-eval` in `script-src`, and
  `connect-src` limited to your origin and the Polaris Key origin. Sync needs no other source.
  Settings are kept in IndexedDB, one store per product, and shared between tabs; one tab writes at a time.
- **Tabs and unload.** A change in one tab reaches the others. Edits are flushed when the page is
  hidden. If a flush must complete first, `await cloud.flush()`.

A drop-in settings panel, `ConfigPanel`, is planned; until it lands, build the screen from these
hooks.

## Updates

```tsx
import { useUpdateDecision } from "@polaris-key/react";

export function UpdateBanner() {
  const { decision, undismissable } = useUpdateDecision();
  if (!decision || decision.action === "none" || decision.action === "packs")
    return null;
  if (decision.action === "blocked")
    return <p role="alert">{decision.reason}</p>;
  return (
    <p role={undismissable ? "alert" : "status"}>
      Version {decision.release.version} is available.
    </p>
  );
}
```

`useUpdateDecision` needs the Update service and release keys: build the adapter with
`browserAdapter({ update: { pinnedReleaseKeys } })`, then include it in the Provider configuration
as `const testPolarisKey = { ...polarisKey, adapter }`. A mandatory answer and `blocked` are
notices with no dismiss control over an app that keeps running, never a window that covers it. The
unsigned `useLatestVersion()` is the older check.

## Refresh and storage

The provider refreshes on mount. Anything more is yours:

```tsx
import { useEffect } from "react";
import { useLicense } from "@polaris-key/react";

export function RefreshOnFocus() {
  const { refresh } = useLicense();
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  return null;
}
```

`refreshIntervalSeconds` on the provider polls; it is off by default so an integration adds no
traffic until you ask. A refresh that fails is the `error` of `useLicense()`, and the last verified
documents stay in force until `graceUntil`. In bearer mode the device token lives in IndexedDB, which a
browser may evict: `await adapter.storeStatus()` answers `{ backend, degraded }`, and
`navigator.storage.persist()` asks the browser to keep it.

```tsx
import { useContext, useEffect, useState } from "react";
import { PolarisContext } from "@polaris-key/react";

export function StorageNotice() {
  const ctx = useContext(PolarisContext);
  const [degraded, setDegraded] = useState<string | null>(null);
  useEffect(() => {
    void ctx?.adapter
      .storeStatus()
      .then((s) => setDegraded(s?.degraded?.detail ?? null));
  }, [ctx]);
  return degraded ? <p role="status">{degraded}</p> : null;
}
```

## Without React

The Provider is a thin shell over an adapter. Take the adapter on its own for a framework with its
own reactivity, or for a service worker:

```ts
import { browserAdapter } from "@polaris-key/react/browser";
import { polarisKey } from "./polaris.config";

const adapter = browserAdapter({
  ...polarisKey,
  version: APP_VERSION,
});

adapter.subscribe((state) => {
  console.log(state.phase === "loading" ? "loading" : state.status);
});
const { status, gate, profile, config } = adapter.snapshot();
console.log(status, gate.graceUntil, profile, config);
```

In an Electron renderer, `desktopAdapter()` from `@polaris-key/react/desktop` reads
`window.polarisKey` and answers the same snapshot. Call `adapter.dispose()` when you are done.

## Tests

Every seam is an option. A scripted `fetchImpl` runs the real adapter, and the refusal arrives
exactly as the server sends it:

```ts run
import { browserAdapter } from "@polaris-key/react/browser";
import { describeError, PolarisError } from "@polaris-key/react/core";

const adapter = browserAdapter({
  productSlug: "acme",
  baseUrl: "https://key.plrs.im",
  auth: "bearer",
  pageOrigin: "https://app.example.com",
  trust: {
    pinnedKeys: { "acme-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
  },
  autoRegister: false,
  fetchImpl: async (url) =>
    String(url).endsWith("/license/activate")
      ? Response.json(
          { error: "device_limit", limit: 3, deviceCount: 3 },
          { status: 403 },
        )
      : new Response("{}", { status: 404 }),
});

try {
  await adapter.submitKey("pkey_acme_0000");
  throw new Error("expected a refusal");
} catch (e) {
  if (!(e instanceof PolarisError) || e.activation?.kind !== "deviceLimit")
    throw e;
  console.log(describeError(e));
} finally {
  adapter.dispose();
}
```

Make the adapter part of the same configuration: `const testPolarisKey = { ...polarisKey, adapter };`
then render `<PolarisKeyProvider config={testPolarisKey}>`. `now` replaces the clock, in seconds.
