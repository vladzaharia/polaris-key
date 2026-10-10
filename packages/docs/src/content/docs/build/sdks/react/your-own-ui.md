---
title: "Your own UI (React)"
description: "Build your own screens on @polaris-key/react: the hook for each task, the state table with its words, refresh, the store status, no-React use and tests."
sidebar:
  order: 2
---

The hooks return state and actions and draw nothing. This page gives the hook for each task, the
states it can be in and the words to show. To take the finished screens instead, see the
[drop-in quickstart](/docs/build/quickstart/react/#drop-in-screens). Everything renders inside
`<PolarisKeyProvider>`, configured as the quickstart does.

## The hook for each task

| Task                  | Hook (`@polaris-key/react`)                   | You read                                                                       |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Gate the app          | `useLicenseGate()`                            | `screen`, `status`, `usable`, `error`, `retry()`                               |
| License facts         | `useLicense()`                                | `gate` (`graceUntil`, `allowedRange`), `entitledChannels`, `refresh()`         |
| Key entry and sign-in | `usePolarisAuth()`                            | `submitKey(key)`, `signInWithOidc()`, `profile`, `error`, `supportsKeyEntry`   |
| Entitlements          | `useEntitlement(name)`                        | a boolean, false unless the gate is usable                                     |
| Settings              | `useManagedConfig()`, `useConfigSetting(key)` | `get(key, fallback)`, `set`, `clear`, the source and whether the key is locked |
| Updates               | `useUpdateDecision()`                         | `decision`, `undismissable`, `reason`, `decide()`                              |
| What the product runs | `useCapabilities()`                           | `has("identity")`                                                              |
| Release notes         | `useChangelog()`                              | `entries`                                                                      |

`busy` and `error` are per service: a config refresh does not grey out sign-out. `usePolarisKey()`
returns the whole client at once and is deprecated; prefer the hooks above.

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
  openManageUrl,
  useLicenseGate,
  usePolarisAuth,
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
        <button type="button" onClick={() => openManageUrl(manageUrl, { key })}>
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

The refusal's `activation.kind` says which one: `deviceLimit` (with `limit`, `deviceCount` and
`manageUrl`), `unauthorized`, `licenseExpired`, `licenseDisabled`, `rateLimited` (with
`retryAfterSeconds`), `hardwareMismatch`, `fingerprintRequired`, `enrollClaimed`, `enrollDisabled`,
`attestationRequired`, `refused` (with the server's `code`) and `error`. After a successful
sign-in, `profile` holds the `name` and `email` to show next to a way to sign out
(`auth.signOut()`): anyone with the code can finish a sign-in elsewhere, so name the account.

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
`browserAdapter({ update: { pinnedReleaseKeys } })` and pass it to the Provider as `adapter`. A
Provider prop for the keys is planned in UK-47. A mandatory answer and `blocked` are notices with no dismiss
control over an app that keeps running, never a window that covers it. The unsigned
`useLatestVersion()` is the older check.

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
import { servicesFromList } from "@polaris-key/react/core";
import { polarisConfig } from "./polaris.config";

const adapter = browserAdapter({
  ...polarisConfig,
  expectServices: servicesFromList(polarisConfig.expectServices),
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

Pass the same adapter to `<PolarisKeyProvider adapter={adapter}>` to render your components against
it. `now` replaces the clock, in seconds.
