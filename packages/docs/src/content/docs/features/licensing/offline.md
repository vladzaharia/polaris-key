---
title: "Going offline"
description: "The three offline depths, grace, offline activation files and local-only builds, and how a member mints a file."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 6
---

Every client is offline-first. Creating a client loads the device id, the token and the cached signed documents and re-verifies them with no network call, so an app can draw its gate before it has ever reached Polaris Key. Three depths build on that.

## 1. Online with grace

Every signed document has a short `expiresAt` (one hour) and a longer, server-signed `graceUntil` of up to 365 days. Both the Worker and the verifying client cap it, so neither a misconfigured server nor a tampered cache hands out an unbounded window. An online client refreshes before `expiresAt`. An install that loses its connection keeps working until `graceUntil`. This needs no opt-in. See [License document](/docs/reference/protocol/license-document/).

## 2. Offline activation files

An install that never reaches Polaris Key activates from a signed `pkey-bundle+jws` file. The app shows a request code, which is the device id: 32 characters generated on the device. A member mints a file against that code on a device that can reach Polaris Key, and the file crosses the gap by USB stick or ticket attachment. The envelope and its refusal steps are in [Offline bundles](/docs/reference/protocol/bundles/).

Three time bounds ride in one file:

| Bound                       | Length                             | Limits                                            |
| --------------------------- | ---------------------------------- | ------------------------------------------------- |
| Inner document `expiresAt`  | 1 hour, as for an online document  | Nothing file-specific                             |
| Inner document `graceUntil` | 1 to 365 days, the member's choice | How long the install works before re-provisioning |
| File `expiresAt`            | 30 days, fixed                     | How long the file may sit unimported              |

The import window is short on purpose. It bounds how long a stolen file is useful, while grace bounds the install. With no server to revoke against, the grace bound is the revocation lever, so re-issue on an annual cadence rather than by default at the 365-day maximum.

An import is all-or-nothing. The file verifies against the pinned keys, then the inner trust manifest, then each document, and only then is the cache written, atomically. A failure imports nothing and names the step that refused. A file-activated install holds no token.

### Mint a file

Role required: a member who can edit the product. The server stores nothing but one `bundle.minted` audit entry, so a lost file is minted again.

1. **Console** Open **License → Licenses** and the license record, then **More actions → Mint offline bundle…**.
2. Paste the **Device ID** exactly. A mistyped code is refused as a form error.
3. Set **Grace days**, 1 to 365. The default is 365.
4. Optional: clear **Include configuration**. The checkbox appears only when the product runs Config.
5. Select **Download**, or copy the bundle if the browser refuses to save.

Copy the bundle id onto the support ticket. The importing client reports the same id back.

For scripted minting use the CLI with an admin API token. Mint the token under **API tokens** in the console: it is shown once and scoped to `bundles:mint`, so it can't do anything else. Export it as `PKEY_ADMIN_TOKEN`.

```sh title="Terminal"
pkey bundle --product tidewater --device <request code> --grace-days 30
```

The CLI checks the device id, grace range, token shape and `--base-url` (https, or loopback) before sending anything. It writes `<product>-<first 8 of device id>.pkeybundle` with mode `0600`, refuses to overwrite without `--force` and doesn't follow symlinks. A leaked token is revoked from the same screen without ending anyone's console session. Every use is audited under the product, attributed to the token.

## 3. Local-only

Some builds must not open a socket: a lab image, a regulated site, a binary in a network namespace with no route out. The local-only client has no transport. Config resolution, the gate and bundle import work. Every network call, such as activation, enrollment, sync and the update check, rejects at the dial with a `local-only` error before a URL is built. `deactivate()` and device-report telemetry swallow the refusal, as they already did against a dead network.

| SDK    | Already provisioned or config-only                   | Fresh air-gapped install                             |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| Node   | `createLocalClient()` from `@polaris-key/node/local` | `createBundleClient()`                               |
| Python | `create_local_client()` from `polaris_key.local`     | `create_bundle_client()`                             |
| Swift  | `PolarisKeyClient.createLocal(options:)`             | `PolarisKeyClient.createFromBundle(options:bundle:)` |

Swift's local-only is also a link-time fact. Don't link the `PolarisKeyUpdate` product and set no `SUFeedURL`, and the compiled binary generates no update traffic. See [Swift](/docs/build/sdks/swift/).

## Next steps

- [Offline bundles](/docs/reference/protocol/bundles/): the envelope and refusal steps.
- [The license model](/docs/features/licensing/model/): how revocation reaches an offline install.
- [Run Polaris Key locally](/docs/build/local/): `pkey dev offline` drops requests to test grace.
