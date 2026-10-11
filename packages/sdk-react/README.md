# @polaris-key/react

Install the React SDK from Polaris Key's npm feed:

```ini
# .npmrc
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
pnpm add @polaris-key/react react react-dom
```

Gate an app with the provider and the self-starting kit gate:

```tsx
import { PolarisKeyProvider, type PolarisKeyConfig } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";

const polarisKey = {
  productSlug: "acme",
} satisfies PolarisKeyConfig;

export function App() {
  return (
    <PolarisKeyProvider config={polarisKey}>
      <PolarisKeyGate>
        <YourApp />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  );
}
```

For the kit components, theming, server-rendered hosts, headless models and fixture samples, see
[React UI kit](https://key.plrs.im/docs/build/ui/frameworks/react/).

## Installing an update and the boot guard (`update.driver`, `update.bootguard`)

`adapter.installUpdate(decision, { signal?, reload? })` hands a decision to the transport's
driver and answers an `InstallOutcome` (the same kinds `@polaris-key/node` answers):
`restartRequired {version, restart()}`, `handedOff {version}`, `storeOpened {url}` or
`unsupported {reason, detail}`. It answers `unsupported` rather than throwing for anything that
cannot be installed, so a prompt can render the refusal.

- **Web.** A web outlet's decision is `platform` (a page has no binary to install), and its
  driver is the service worker. The page finds its registration's waiting worker (waiting out an
  installing one), posts `{ type: "SKIP_WAITING" }`, which your worker answers with
  `self.skipWaiting()`, waits for it to take control, reloads and answers `handedOff`. A worker
  that has not taken control after 15 seconds (one that never answers the message, say) is
  `unsupported {dependency}` rather than a pending install. `reload: false` answers
  `restartRequired` and leaves the reload to `restart()`, which rejects in that case instead.
  No registration or no waiting worker is `unsupported {dependency}`; no service worker support
  at all is `unsupported {runtime}`; `binary` and `store` decisions are `unsupported {runtime}`.
  Pass `serviceWorker: { container, reload }` to the adapter to control both (tests, a router).
  `update_downloaded` and `update_applied` go through `recordUpdateEvent`; in bearer mode the
  journal is then sent (`devices/report`, best effort, waiting at most 3 seconds) before the
  reload, which would otherwise take it along.
- **Desktop.** The renderer forwards `binary` and `store` decisions to the host's
  `client.update.install()` (`invoke("update", "install", {decision})`, which the host answers
  with its install driver); other decisions are answered as above, without crossing the bridge.
  A `restartRequired` outcome's `restart()` is `invoke("update", "restart")`. An older host
  answers `unsupported {version}`.

`adapter.markBootAttempt()` and `adapter.confirmBoot()` are the app boot guard
(`@polaris-key/node`'s guard, rule for rule). `boot()` runs them as its guard stage and confirms
the launch as the stage matrix says (`waiting`, `blocked` and `offline` at once, `ready` after
`BOOT_OK_SECONDS`, or earlier through your own `confirmBoot()` with `autoConfirm: false`), and its
result carries the `BootAttempt` as `guard`. The first launch of a new `version` moves the slots
(previous ← current ← this version) and resets the count; client-core's `bootGuardAction` decides;
the launch is counted as unconfirmed. After `MAX_FAILED_BOOTS` unconfirmed launches of an
unconfirmed version the guard rolls back, and a version that was ever confirmed is never rolled
back for later crashes.

- **Web.** The slots (`current`, `previous`, `failedBoots`, `confirmed`, `skipVersion`) live in
  `localStorage` under `pkey:<product>:boot-guard` (`bootGuard: { storage }` replaces it; a store
  that throws falls back to memory, which loses the count on reload). A waiting service worker
  counts as a staged update (`action: "apply-staged"`). A page cannot serve its previous build
  itself: pass `bootGuard: { rollback(previous) }` to do it, else the rollback is reported as
  `boot_rolled_back` with code `no-previous`. Either way the failed version is remembered as the
  `skipVersion`, which the boot's `decideUpdate()` passes. The update corpus gives that input one
  job, suppressing a self-updating outlet's `code-ready` and `sidecar-pck` (a skipped version is
  still offered as a download), and a web outlet's decision is `platform`, which answers before
  it is read: on a page, a rolled-back release the feed still offers is offered again.
  It needs the adapter's `version`; without one `markBootAttempt()` throws `not-configured` and
  `boot()` skips the stage. `update_confirmed`, `update_reverted` and `boot_rolled_back` go
  through `recordUpdateEvent` (bearer mode keeps the journal and sends it as soon as a rollback
  or a first confirmation is saved, since no later sync need follow; a cookie page holds none,
  and the guard never fails a launch for it).
- **Desktop.** The host's guard, over `invoke("update", "markBootAttempt")` and
  `invoke("update", "confirmBoot")`; the host's own `boot()` already runs it.

## The local adapter (`core.local`)

`localAdapter({ productSlug, license?, config?, status?, version?, storage? })`
(`@polaris-key/react/local`) is an adapter that never touches the network: it takes no `fetch`
and imports no transport. It serves the documents your build bundles and a fixed licence state
(`status`, default `ok`), is `ready` from construction and does no I/O when built. The gate,
config, `config.local`, `crashTags()`, the boot guard and a whole `boot()` pass work offline;
every verb that would dial (sign-in, activation, devices, the release and update reads, the
verified download) rejects `local-only`, and `supports()` answers a `runtime` N/A for it. Use it
in tests, Storybook previews and kiosk builds:
`<PolarisKeyProvider config={{ productSlug: "acme", adapter: localAdapter({ productSlug: "acme", license }) }}>`.
